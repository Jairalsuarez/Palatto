-- Correcciones de operación: pago de insumos, edición sin motivo y división exacta.
--
-- 1. El pago de una compra de insumos fallaba por una referencia ambigua
--    (`s.name`) entre la variable de fila y el alias de la tabla. Ahora el
--    gasto se registra siempre y descuenta de la caja única.
-- 2. Editar un pedido ya no exige un motivo ni recibe importes de cobro que
--    no se usaban (un pedido cobrado no se puede editar).
-- 3. La división de cuenta reparte las unidades para llevar y ajusta el último
--    pago al saldo exacto para no dejar centavos pendientes.

create or replace function public.update_supply_purchase(
  p_id uuid,
  p_action text,
  p_method public.payment_method default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.supply_purchases;
  s public.supplies;
  movement_id uuid;
begin
  if public.current_app_role() is null or public.current_app_role() = 'visualizador' then
    raise exception 'Tu rol solo puede consultar el inventario.';
  end if;
  if p_action not in ('paid','unpaid','received') then
    raise exception 'Acción de compra inválida.';
  end if;
  perform pg_advisory_xact_lock(81002);
  select * into p from public.supply_purchases where id = p_id for update;
  if not found then raise exception 'La compra no existe.'; end if;
  select * into s from public.supplies where id = p.supply_id;
  if not found then raise exception 'El insumo ya no existe.'; end if;

  if p_action = 'paid' and not p.paid then
    if p_method is null then raise exception 'Selecciona cómo se pagó la compra.'; end if;
    insert into public.movements(business,amount,method,reason,actor,kind,receipt)
    values('palatto',-p.total_amount,p_method,
      'Compra de insumos · '||coalesce(nullif(p.supplier,''),s.name),
      auth.uid(),'gasto',p.receipt)
    returning id into movement_id;
    update public.supply_purchases
      set paid = true, payment_method = p_method, ledger_movement_id = movement_id, paid_at = now()
      where id = p_id;
  elsif p_action = 'unpaid' and p.paid then
    insert into public.movements(business,amount,method,reason,actor,kind)
    values('palatto',p.total_amount,p.payment_method,
      'Reversión de pago · compra de '||coalesce(nullif(p.supplier,''),s.name),
      auth.uid(),'gasto');
    update public.supply_purchases
      set paid = false, payment_method = null, ledger_movement_id = null, paid_at = null
      where id = p_id;
  elsif p_action = 'received' and not p.received then
    update public.supplies set stock = stock + p.quantity, updated_at = now() where id = p.supply_id;
    insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
    values(p.supply_id,'entrada',p.quantity,
      'Compra recibida · '||coalesce(nullif(p.supplier,''),s.name),auth.uid());
    update public.supply_purchases set received = true, received_at = now() where id = p_id;
  end if;
end $$;

revoke all on function public.update_supply_purchase(uuid,text,public.payment_method) from public,anon,authenticated;
grant execute on function public.update_supply_purchase(uuid,text,public.payment_method) to authenticated;

drop function if exists public.edit_order(uuid,integer,text,text,jsonb,text,integer,text,boolean);

create or replace function public.edit_order(
  p_id uuid,
  p_version integer,
  p_customer text,
  p_notes text,
  p_items jsonb,
  p_takeaway boolean default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
  resolved jsonb;
  net integer;
  all_takeaway boolean;
begin
  perform public.require_writer();
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id = p_id for update;
  if not found or o.version <> p_version then
    raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.';
  end if;
  if o.paid then
    raise exception 'Un pedido cobrado no se puede editar. Registra el ajuste como un movimiento de caja aparte.';
  end if;
  if exists(select 1 from public.order_payments where order_id = p_id) then
    raise exception 'Este pedido tiene pagos parciales y no se puede editar.';
  end if;
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
  update public.orders
    set customer = trim(p_customer), notes = left(p_notes,2000), items = resolved,
        takeaway = all_takeaway, version = version + 1
    where id = p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
  values(p_id,auth.uid(),'Pedido editado',to_jsonb(o),
    jsonb_build_object('takeaway',all_takeaway,'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net));
end $$;

revoke all on function public.edit_order(uuid,integer,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.edit_order(uuid,integer,text,text,jsonb,boolean) to authenticated;

create or replace function public.add_split_payment(
  p_id uuid,
  p_version integer,
  p_label text,
  p_items jsonb,
  p_method public.payment_method,
  p_received integer,
  p_receipt text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
  v jsonb;
  item jsonb;
  label text;
  line_qty integer;
  line_price integer;
  line_fee integer;
  line_tq integer;
  line_assigned_tq integer;
  line_take_qty integer;
  assigned integer;
  available integer;
  asked_qty integer := 0;
  part_amount integer := 0;
  part_items jsonb := '[]'::jsonb;
  total_amount integer;
  total_qty integer;
  assigned_qty integer;
  paid_amount integer;
  new_paid boolean;
begin
  perform public.require_writer();
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id = p_id for update;
  if not found or o.version <> p_version then
    raise exception 'El pedido cambió. Actualiza la pantalla e inténtalo de nuevo.';
  end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
  label := trim(coalesce(p_label,''));
  if length(label) not between 1 and 60 then raise exception 'Escribe el nombre de la persona.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Elige al menos un producto para esta persona.';
  end if;
  if jsonb_array_length(p_items) <> (
    select count(distinct value->>'product_id') from jsonb_array_elements(p_items)
  ) then
    raise exception 'Producto duplicado en la división.';
  end if;

  for v in select * from jsonb_array_elements(p_items) loop
    line_qty := (v->>'quantity')::integer;
    if line_qty is null or line_qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
    select value into item from jsonb_array_elements(o.items) where value->>'product_id' = v->>'product_id';
    if item is null then raise exception 'Ese producto no está en el pedido.'; end if;

    select coalesce(sum((pl->>'quantity')::integer),0)
      into assigned
      from public.order_payments op
      cross join lateral jsonb_array_elements(op.items) pl
      where op.order_id = o.id and pl->>'product_id' = v->>'product_id';
    available := (item->>'quantity')::integer - assigned;
    if line_qty > available then
      raise exception 'Solo quedan % de %.',available,item->>'name';
    end if;

    select coalesce(sum((pl->>'takeaway_quantity')::integer),0)
      into line_assigned_tq
      from public.order_payments op
      cross join lateral jsonb_array_elements(op.items) pl
      where op.order_id = o.id and pl->>'product_id' = v->>'product_id';

    line_price := (item->>'price')::integer;
    line_fee := coalesce((item->>'takeaway_fee')::integer,0);
    line_tq := coalesce((item->>'takeaway_quantity')::integer,0);
    line_take_qty := least(line_qty, greatest(0, line_tq - line_assigned_tq));

    part_amount := part_amount + line_price*line_qty + line_fee*line_take_qty;
    asked_qty := asked_qty + line_qty;
    part_items := part_items || jsonb_build_array(jsonb_build_object(
      'product_id',item->>'product_id','name',item->>'name','price',line_price,
      'base_price',line_price,'takeaway_fee',line_fee,
      'takeaway_quantity',line_take_qty,
      'is_drink',coalesce((item->>'is_drink')::boolean,false),
      'business',item->>'business','quantity',line_qty));
  end loop;

  select coalesce(sum(
    (i->>'price')::integer*(i->>'quantity')::integer
    + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
  ),0), coalesce(sum((i->>'quantity')::integer),0)
    into total_amount,total_qty from jsonb_array_elements(o.items) i;
  select coalesce(sum(amount),0) into paid_amount from public.order_payments where order_id = o.id;
  select coalesce(sum((pl->>'quantity')::integer),0)
    into assigned_qty
    from public.order_payments op
    cross join lateral jsonb_array_elements(op.items) pl
    where op.order_id = o.id;

  -- El último pago cubre exactamente el saldo, sin centavos sueltos.
  if assigned_qty + asked_qty >= total_qty then
    part_amount := total_amount - paid_amount;
  end if;
  if part_amount <= 0 then raise exception 'El importe del pago no es válido.'; end if;
  if part_amount > total_amount - paid_amount then
    raise exception 'El importe supera lo que falta por cobrar.';
  end if;
  if p_method = 'efectivo' and (p_received is null or p_received < part_amount) then
    raise exception 'Efectivo insuficiente.';
  end if;
  if p_method = 'transferencia' then perform public.check_receipt(p_receipt); end if;

  insert into public.order_payments(order_id,label,items,amount,method,receipt,created_by)
  values(o.id,label,part_items,part_amount,p_method,
    case when p_method = 'transferencia' then p_receipt end,auth.uid());

  insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
  values('palatto',part_amount,p_method,'Cobro #'||o.number||' · '||label,o.id,null,auth.uid(),'cobro');

  new_paid := (paid_amount + part_amount) >= total_amount;
  update public.orders set paid = new_paid,
    status = case when new_paid then 'completado' else 'en_proceso' end,
    method = case when new_paid then p_method else o.method end,
    receipt = case when new_paid and p_method = 'transferencia' then p_receipt else o.receipt end,
    paid_at = case when new_paid then now() else o.paid_at end,
    split_payment = true, version = version + 1
    where id = o.id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
  values(o.id,auth.uid(),'Pago dividido: '||label,to_jsonb(o),
    jsonb_build_object('label',label,'items',part_items,'amount',part_amount,'method',p_method,'paid',new_paid));
end $$;

revoke all on function public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) from public,anon,authenticated;
grant execute on function public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) to authenticated;

notify pgrst,'reload schema';
