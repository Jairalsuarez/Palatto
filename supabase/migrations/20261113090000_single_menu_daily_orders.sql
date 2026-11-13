-- Un solo menú, una sola caja, numeración diaria y ajustes operativos.
-- Los productos ya no se separan por negocio ni categoría visible. Solo se
-- marca si son agua/cola para el resumen del día.

-- 1. Productos ---------------------------------------------------------------
alter table public.products
  add column if not exists is_drink boolean not null default false;

update public.products
  set is_drink = (business = 'carreta')
  where is_drink = false and business = 'carreta';

drop function if exists public.save_product(uuid,text,integer,public.business,text,boolean,text);
drop function if exists public.save_product(uuid,text,integer,public.business,text,boolean,text,integer);

create or replace function public.save_product(
  p_id uuid,
  p_name text,
  p_price integer,
  p_active boolean,
  p_is_drink boolean default false,
  p_image_path text default null,
  p_takeaway_fee integer default 0
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then
    raise exception 'Solo administración puede editar el menú.';
  end if;
  if p_image_path is not null and not exists(
    select 1 from storage.objects where bucket_id='menu-images' and name=p_image_path
  ) then
    raise exception 'Sube una foto válida del producto.';
  end if;
  if p_takeaway_fee is null or p_takeaway_fee < 0 or p_takeaway_fee > 1000000 then
    raise exception 'La tarifa para llevar no es válida.';
  end if;
  insert into public.products(id,name,price,business,category,active,image_path,takeaway_fee,is_drink)
  values(
    coalesce(p_id,gen_random_uuid()), trim(p_name), p_price,
    case when coalesce(p_is_drink,false) then 'carreta'::public.business else 'palatto'::public.business end,
    case when coalesce(p_is_drink,false) then 'Aguas y colas' else 'General' end,
    p_active, p_image_path, coalesce(p_takeaway_fee,0), coalesce(p_is_drink,false)
  )
  on conflict(id) do update set
    name=excluded.name, price=excluded.price, business=excluded.business,
    category=excluded.category, active=excluded.active, image_path=excluded.image_path,
    takeaway_fee=excluded.takeaway_fee, is_drink=excluded.is_drink;
end $$;

create or replace function public.delete_product(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then
    raise exception 'Solo administración puede eliminar productos.';
  end if;
  -- Borrado lógico: los pedidos guardan una copia de nombre, precio y tarifa.
  update public.products set active=false where id=p_id;
  if not found then raise exception 'El producto ya no existe.'; end if;
end $$;

-- 2. Pedidos: día, numeración diaria y fecha real de cobro ---------------------
alter table public.orders
  add column if not exists order_day date,
  add column if not exists paid_at timestamptz;

update public.orders
  set order_day = (created_at at time zone 'America/Guayaquil')::date
  where order_day is null;

alter table public.orders alter column order_day set not null;

update public.orders o
  set paid_at = (
    select max(m.created_at)
    from public.movements m
    where m.order_id = o.id and m.kind = 'cobro'
  )
  where o.paid and o.paid_at is null;

alter table public.orders drop constraint if exists orders_number_key;
alter table public.orders alter column number drop identity if exists;
alter table public.orders alter column number type integer using number::integer;
alter table public.orders alter column number set not null;
alter table public.orders add constraint orders_day_number_key unique(order_day, number);

-- Normaliza líneas antiguas al modelo de precio base + cantidad para llevar.
update public.orders o
set items = (
  select jsonb_agg(
    case when item ? 'base_price' then
      jsonb_set(
        jsonb_set(item, '{price}', item->'base_price'),
        '{takeaway_quantity}',
        to_jsonb(case
          when coalesce((item->>'takeaway')::boolean, false) or o.takeaway then (item->>'quantity')::integer
          else 0
        end)
      )
    else
      jsonb_set(item, '{takeaway_quantity}', '0'::jsonb)
    end
    order by ordinal
  )
  from jsonb_array_elements(o.items) with ordinality as t(item, ordinal)
)
where jsonb_typeof(o.items) = 'array';

alter table public.movements add column if not exists receipt text;

-- 3. Resolución de líneas: precio base, tarifa por unidad y agua/cola --------
create or replace function public.resolve_items(
  p_items jsonb,
  p_previous jsonb default '[]'::jsonb,
  p_takeaway boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb := '[]';
  v jsonb;
  p public.products;
  old jsonb;
  qty integer;
  tq integer;
  base integer;
  fee integer;
  is_drink boolean;
begin
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Añade entre 1 y 100 productos.';
  end if;
  if (select count(*) from jsonb_array_elements(p_items)) <> (select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) then
    raise exception 'Producto duplicado.';
  end if;
  for v in select * from jsonb_array_elements(p_items) loop
    qty := (v->>'quantity')::integer;
    if qty is null or qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
    select value into old from jsonb_array_elements(p_previous) where value->>'product_id'=v->>'product_id';
    select * into p from public.products where id=(v->>'product_id')::uuid;
    if not found then raise exception 'El producto no existe.'; end if;
    if (old is null or qty>(old->>'quantity')::integer) and not p.active then
      raise exception 'El producto no está disponible.';
    end if;
    base := coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price);
    fee := case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,p.takeaway_fee) end;
    tq := coalesce((v->>'takeaway_quantity')::integer, case when coalesce(p_takeaway,false) then qty else 0 end);
    if tq < 0 or tq > qty then raise exception 'Cantidad para llevar inválida.'; end if;
    is_drink := coalesce((v->>'is_drink')::boolean, (old->>'is_drink')::boolean, p.is_drink, false);
    result := result || jsonb_build_array(jsonb_build_object(
      'product_id',p.id,
      'name',coalesce(old->>'name',p.name),
      'base_price',base,
      'takeaway_fee',fee,
      'takeaway_quantity',tq,
      'is_drink',is_drink,
      'price',base,
      'business',case when is_drink then 'carreta' else 'palatto' end,
      'quantity',qty
    ));
  end loop;
  return result;
end $$;

-- 4. Crear pedido con número que reinicia cada día ----------------------------
create or replace function public.create_order(
  p_customer text,
  p_notes text,
  p_items jsonb,
  p_takeaway boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  oid uuid;
  resolved jsonb;
  d date := (now() at time zone 'America/Guayaquil')::date;
  n integer;
  all_takeaway boolean;
begin
  perform public.require_writer();
  perform pg_advisory_xact_lock(81001);
  select coalesce(max(number),0)+1 into n from public.orders where order_day=d;
  resolved := public.resolve_items(p_items,'[]'::jsonb,coalesce(p_takeaway,false));
  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false)
    into all_takeaway from jsonb_array_elements(resolved) i;
  insert into public.orders(number,order_day,customer,notes,items,created_by,takeaway)
  values(n,d,trim(p_customer),left(p_notes,2000),resolved,auth.uid(),all_takeaway)
  returning id into oid;
  return oid;
end $$;

-- 5. Editar pedido sin tocar el número ni la fecha de creación ----------------
create or replace function public.edit_order(
  p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,
  p_received integer default 0,p_receipt text default null,p_takeaway boolean default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; net integer; all_takeaway boolean;
begin
  perform public.require_writer(); perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid then raise exception 'Un pedido cobrado no se puede editar. Registra el ajuste como un movimiento de caja aparte.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then
    raise exception 'Este pedido tiene pagos parciales y no se puede editar.';
  end if;
  if length(trim(p_reason))<3 then raise exception 'Escribe el motivo del cambio.'; end if;
  resolved := public.resolve_items(p_items,o.items,coalesce(p_takeaway,o.takeaway));
  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false)
    into all_takeaway from jsonb_array_elements(resolved) i;
  select coalesce(sum(
    (i->>'price')::integer*(i->>'quantity')::integer
    + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
  ),0) into net from jsonb_array_elements(resolved) i;
  net := net - (
    select coalesce(sum(
      (i->>'price')::integer*(i->>'quantity')::integer
      + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
    ),0) from jsonb_array_elements(o.items) i
  );
  update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,
    takeaway=all_takeaway,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
  values(p_id,auth.uid(),p_reason,to_jsonb(o),
    jsonb_build_object('takeaway',all_takeaway,'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net));
end $$;

-- 6. Cobro completo: una sola caja, total ajustable sin motivo obligatorio -----
create or replace function public.pay_order(
  p_id uuid,
  p_version integer,
  p_method public.payment_method,
  p_received integer,
  p_receipt text default null,
  p_total integer default null,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
  full_amount integer;
  final_amount integer;
  v_adjustment integer;
begin
  perform public.require_writer();
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then
    raise exception 'Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.';
  end if;
  if p_method is null then raise exception 'Selecciona el método de pago.'; end if;

  select sum(
    (i->>'price')::integer*(i->>'quantity')::integer
    + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
  ) into full_amount from jsonb_array_elements(o.items) i;
  if full_amount is null or full_amount<=0 then raise exception 'El pedido no tiene un total válido.'; end if;

  final_amount := coalesce(p_total,full_amount);
  if final_amount<=0 or final_amount>100000000 then raise exception 'El total debe ser un importe mayor a cero.'; end if;
  v_adjustment := final_amount-full_amount;

  if p_method='efectivo' and (p_received is null or p_received<final_amount) then raise exception 'Efectivo insuficiente.'; end if;
  if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;

  insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
  values('palatto',final_amount,p_method,'Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro');

  update public.orders set paid=true,status='completado',method=p_method,
    receipt=case when p_method='transferencia' then p_receipt else null end,
    split_payment=false,adjustment=v_adjustment,adjustment_reason=null,
    paid_at=now(),version=version+1 where id=p_id;

  insert into public.audits(order_id,actor,reason,before_data,after_data)
  values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),
    jsonb_build_object(
      'status','completado','paid',true,'received',p_received,
      'change',case when p_method='efectivo' then p_received-final_amount else 0 end,
      'total',final_amount,'original_total',full_amount,'adjustment',v_adjustment
    ));
end $$;

-- 7. Pagos divididos: una sola caja y fecha de cobro final ---------------------
create or replace function public.add_split_payment(
  p_id uuid,p_version integer,p_label text,p_items jsonb,
  p_method public.payment_method,p_received integer,p_receipt text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders; v jsonb; item jsonb;
  label text; line_qty integer; line_price integer; line_fee integer; line_tq integer;
  line_total integer; assigned integer; available integer; unit_amount integer;
  part_amount integer := 0; part_items jsonb := '[]'::jsonb;
  total_amount integer; paid_amount integer; new_paid boolean;
begin
  perform public.require_writer(); perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza la pantalla e inténtalo de nuevo.'; end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
  label := trim(coalesce(p_label,''));
  if length(label) not between 1 and 60 then raise exception 'Escribe el nombre de la persona.'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Elige al menos un producto para esta persona.'; end if;
  if jsonb_array_length(p_items) <> (select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) then
    raise exception 'Producto duplicado en la división.';
  end if;

  for v in select * from jsonb_array_elements(p_items) loop
    line_qty := (v->>'quantity')::integer;
    if line_qty is null or line_qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
    select value into item from jsonb_array_elements(o.items) where value->>'product_id'=v->>'product_id';
    if item is null then raise exception 'Ese producto no está en el pedido.'; end if;
    select coalesce(sum((pl->>'quantity')::integer),0) into assigned
    from public.order_payments op
    cross join lateral jsonb_array_elements(op.items) pl
    where op.order_id=o.id and pl->>'product_id'=v->>'product_id';
    available := (item->>'quantity')::integer - assigned;
    if line_qty > available then raise exception 'Solo quedan % de %.',available,item->>'name'; end if;
    line_price := (item->>'price')::integer;
    line_fee := coalesce((item->>'takeaway_fee')::integer,0);
    line_tq := coalesce((item->>'takeaway_quantity')::integer,0);
    line_total := line_price*(item->>'quantity')::integer + line_fee*line_tq;
    unit_amount := round(line_total::numeric / (item->>'quantity')::integer)::integer;
    part_amount := part_amount + unit_amount*line_qty;
    part_items := part_items || jsonb_build_array(jsonb_build_object(
      'product_id',item->>'product_id','name',item->>'name','price',line_price,
      'base_price',line_price,'takeaway_fee',line_fee,
      'takeaway_quantity',round(line_tq::numeric*line_qty/(item->>'quantity')::integer)::integer,
      'is_drink',coalesce((item->>'is_drink')::boolean,false),
      'business',item->>'business','quantity',line_qty));
  end loop;

  select coalesce(sum(
    (i->>'price')::integer*(i->>'quantity')::integer
    + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
  ),0) into total_amount from jsonb_array_elements(o.items) i;
  select coalesce(sum(amount),0) into paid_amount from public.order_payments where order_id=o.id;
  if part_amount > total_amount-paid_amount then raise exception 'El importe supera lo que falta por cobrar.'; end if;
  if p_method='efectivo' and (p_received is null or p_received<part_amount) then raise exception 'Efectivo insuficiente.'; end if;
  if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;

  insert into public.order_payments(order_id,label,items,amount,method,receipt,created_by)
  values(o.id,label,part_items,part_amount,p_method,
    case when p_method='transferencia' then p_receipt end,auth.uid());

  insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
  values('palatto',part_amount,p_method,'Cobro #'||o.number||' · '||label,o.id,null,auth.uid(),'cobro');

  new_paid := (paid_amount+part_amount) >= total_amount;
  update public.orders set paid=new_paid,
    status=case when new_paid then 'completado' else 'en_proceso' end,
    method=case when new_paid then p_method else o.method end,
    receipt=case when new_paid and p_method='transferencia' then p_receipt else o.receipt end,
    paid_at=case when new_paid then now() else o.paid_at end,
    split_payment=true,version=version+1 where id=o.id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
  values(o.id,auth.uid(),'Pago dividido: '||label,to_jsonb(o),
    jsonb_build_object('label',label,'items',part_items,'amount',part_amount,'method',p_method,'paid',new_paid));
end $$;

-- 8. Movimientos de caja con factura opcional --------------------------------
drop function if exists public.cash_movement(public.business,integer,public.payment_method,text,text);

create or replace function public.cash_movement(
  p_business public.business,
  p_amount integer,
  p_method public.payment_method,
  p_reason text,
  p_kind text default null,
  p_receipt text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare balance bigint; kind text := nullif(trim(coalesce(p_kind,'')),'');
begin
  if not public.can_manage_cash(p_business) then raise exception 'No tienes permiso para ajustar esta caja.'; end if;
  perform pg_advisory_xact_lock(81001);
  if p_amount is null or p_amount=0 or abs(p_amount::bigint)>100000000 then raise exception 'Importe inválido.'; end if;
  if kind is null then kind := case when p_amount>0 then 'ingreso' else 'gasto' end; end if;
  if kind not in ('ingreso','gasto','retiro') then raise exception 'Tipo de movimiento inválido.'; end if;
  if kind='ingreso' and p_amount<0 then raise exception 'El ingreso debe ser un importe positivo.'; end if;
  if kind in ('gasto','retiro') and p_amount>0 then raise exception 'El gasto o retiro debe ser un importe negativo.'; end if;
  select coalesce(sum(amount),0) into balance from public.movements where business=p_business and method=p_method;
  if balance+p_amount<0 then raise exception 'El retiro supera el saldo disponible de ese medio de pago.'; end if;
  if p_receipt is not null then perform public.check_receipt(p_receipt); end if;
  insert into public.movements(business,amount,method,reason,actor,kind,receipt)
  values(p_business,p_amount,p_method,trim(p_reason),auth.uid(),kind,p_receipt);
end $$;

-- 9. Factura opcional en compras de insumos ----------------------------------
alter table public.supply_purchases add column if not exists receipt text;

drop function if exists public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean);

create or replace function public.register_supply_purchase(
  p_supply uuid,p_quantity numeric,p_unit_cost integer,p_supplier text,
  p_paid boolean,p_method public.payment_method,p_received boolean,p_receipt text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.supplies; purchase_id uuid := gen_random_uuid(); amount integer; movement_id uuid;
begin
  if public.current_app_role() is null or public.current_app_role()='visualizador' then raise exception 'Tu rol solo puede consultar el inventario.'; end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>1000000 or p_unit_cost is null or p_unit_cost<=0 then raise exception 'Cantidad y costo unitario deben ser mayores a cero.'; end if;
  if length(trim(coalesce(p_supplier,'')))>120 then raise exception 'El proveedor no puede superar 120 caracteres.'; end if;
  if p_paid and p_method is null then raise exception 'Selecciona cómo se pagó la compra.'; end if;
  if p_receipt is not null then perform public.check_receipt(p_receipt); end if;
  amount := round(p_quantity*p_unit_cost)::integer;
  if amount<=0 or amount>100000000 then raise exception 'El total de la compra no es válido.'; end if;
  perform pg_advisory_xact_lock(81002);
  select * into s from public.supplies where id=p_supply and active for update;
  if not found then raise exception 'El insumo no existe o está inactivo.'; end if;
  if p_paid then
    insert into public.movements(business,amount,method,reason,actor,kind,receipt)
    values('palatto',-amount,p_method,'Compra de insumos · '||coalesce(nullif(trim(p_supplier),''),s.name),auth.uid(),'gasto',p_receipt)
    returning id into movement_id;
  end if;
  insert into public.supply_purchases(id,supply_id,quantity,unit_cost,total_amount,supplier,paid,payment_method,received,ledger_movement_id,created_by,paid_at,received_at,receipt)
  values(purchase_id,p_supply,p_quantity,p_unit_cost,amount,trim(coalesce(p_supplier,'')),coalesce(p_paid,false),
    case when p_paid then p_method else null end,coalesce(p_received,false),movement_id,auth.uid(),
    case when p_paid then now() else null end,case when p_received then now() else null end,p_receipt);
  if p_received then
    update public.supplies set stock=stock+p_quantity,updated_at=now() where id=p_supply;
    insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
    values(p_supply,'entrada',p_quantity,'Compra recibida · '||coalesce(nullif(trim(p_supplier),''),s.name),auth.uid());
  end if;
  return purchase_id;
end $$;

-- 10. Permisos ----------------------------------------------------------------
revoke all on function public.resolve_items(jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.create_order(text,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.edit_order(uuid,integer,text,text,jsonb,text,integer,text,boolean) from public,anon,authenticated;
revoke all on function public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text) from public,anon,authenticated;
revoke all on function public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) from public,anon,authenticated;
revoke all on function public.save_product(uuid,text,integer,boolean,boolean,text,integer) from public,anon,authenticated;
revoke all on function public.delete_product(uuid) from public,anon,authenticated;
revoke all on function public.cash_movement(public.business,integer,public.payment_method,text,text,text) from public,anon,authenticated;
revoke all on function public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean,text) from public,anon,authenticated;

grant execute on function public.create_order(text,text,jsonb,boolean),public.edit_order(uuid,integer,text,text,jsonb,text,integer,text,boolean),
  public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text),
  public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text),
  public.save_product(uuid,text,integer,boolean,boolean,text,integer),public.delete_product(uuid),
  public.cash_movement(public.business,integer,public.payment_method,text,text,text),
  public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean,text)
  to authenticated;

notify pgrst,'reload schema';
