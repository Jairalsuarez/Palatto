-- Un solo negocio (Palatto) con dos cajas: principal y aguas/colas.
-- Los turnos dejan de ser obligatorios. Los movimientos de caja distinguen
-- ingreso, gasto y retiro. Las cuentas pueden dividirse en pagos por persona.

-- 1. Tipo de movimiento de caja ------------------------------------------------
alter table public.movements add column if not exists kind text;
update public.movements set kind = case
  when transfer_id is not null then 'transferencia'
  when reason like 'Cobro de pedido%' then 'cobro'
  when reason like 'Correcci%' then 'correccion'
  when amount > 0 then 'ingreso'
  else 'gasto' end
where kind is null;
alter table public.movements alter column kind set default 'ingreso';
alter table public.movements alter column kind set not null;
alter table public.movements drop constraint if exists movements_kind_check;
alter table public.movements add constraint movements_kind_check
  check (kind in ('ingreso','gasto','retiro','cobro','correccion','transferencia'));
create index if not exists movements_kind_created on public.movements(kind,created_at desc);

-- La caja de aguas y colas ya no es "solo efectivo": recibe el medio real del cobro.
drop trigger if exists carreta_cash_only on public.movements;
drop function if exists public.enforce_carreta_cash();

-- 2. Permisos de caja: administración maneja ambas; bebidas solo la suya --------
create or replace function public.can_manage_cash(b public.business) returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce(
  public.current_app_role()='superadmin'
  or public.current_app_role()='administrador'
  or (b='carreta' and public.current_app_role()='carreta'),
 false);
$$;

-- 3. Los productos activos se pueden vender sin abrir turno ---------------------
create or replace function public.resolve_items(p_items jsonb,p_previous jsonb default '[]'::jsonb,p_takeaway boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb := '[]'; v jsonb; p public.products; old jsonb; qty integer;
begin
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Añade entre 1 y 100 productos.'; end if;
 if (select count(*) from jsonb_array_elements(p_items)) <> (select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) then raise exception 'Producto duplicado.'; end if;
 for v in select * from jsonb_array_elements(p_items) loop
  qty := (v->>'quantity')::integer;
  if qty is null or qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
  select value into old from jsonb_array_elements(p_previous) where value->>'product_id'=v->>'product_id';
  select * into p from public.products where id=(v->>'product_id')::uuid;
  if not found then raise exception 'El producto no existe.'; end if;
  if (old is null or qty>(old->>'quantity')::integer) and not p.active then
   raise exception 'El producto no está disponible.';
  end if;
  result := result || jsonb_build_array(jsonb_build_object(
   'product_id',p.id,
   'name',coalesce(old->>'name',p.name),
   'base_price',coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price),
   'takeaway_fee',case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,0) end,
   'price',coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price)+case when p_takeaway then case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,0) end else 0 end,
   'business',coalesce(old->>'business',p.business::text),
   'quantity',qty));
 end loop;
 return result;
end $$;

-- 4. Cobro completo: sin turno, separa por caja y usa el medio real -------------
create or replace function public.pay_order(p_id uuid,p_version integer,p_method public.payment_method,p_received integer,p_receipt text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; b public.business; amount integer; full_amount integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then
  raise exception 'Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.';
 end if;
 if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
 select sum((i->>'price')::integer*(i->>'quantity')::integer) into full_amount from jsonb_array_elements(o.items) i;
 if p_method='efectivo' and (p_received is null or p_received<full_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
 for b in select distinct (i->>'business')::public.business from jsonb_array_elements(o.items) i loop
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount
  from jsonb_array_elements(o.items) i where i->>'business'=b::text;
  if amount>0 then
   insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
   values(b,amount,p_method,'Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro');
  end if;
 end loop;
 update public.orders set paid=true,status='completado',method=p_method,
  receipt=case when p_method='transferencia' then p_receipt else null end,
  split_payment=false,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data)
 values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),
  jsonb_build_object('status','completado','paid',true,'received',p_received,'change',case when p_method='efectivo' then p_received-full_amount else 0 end));
end $$;

-- 5. Correcciones: sin turno, mismo medio por caja y bloqueo si hay división ----
create or replace function public.edit_order(p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,p_received integer default 0,p_receipt text default null,p_takeaway boolean default null) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; b public.business; delta integer; net integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then
  raise exception 'Este pedido tiene pagos divididos y no se edita. Ajusta el cobro desde caja.';
 end if;
 if public.current_app_role()='cocinero' and not o.paid then raise exception 'El cocinero solo puede editar pedidos cobrados.'; end if;
 if length(trim(p_reason))<3 then raise exception 'Escribe el motivo de la corrección.'; end if;
 resolved := public.resolve_items(p_items,o.items,coalesce(p_takeaway,o.takeaway));
 select (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i)
  - (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i) into net;
 if o.paid then
  if o.method='efectivo' and net>0 and (p_received is null or p_received<net) then raise exception 'Registra el efectivo adicional recibido.'; end if;
  if o.method='transferencia' and net<>0 then perform public.check_receipt(p_receipt); end if;
  for b in select distinct (i->>'business')::public.business from jsonb_array_elements(resolved) i loop
   select coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i where i->>'business'=b::text),0)
    - coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i where i->>'business'=b::text),0) into delta;
   if delta<>0 then
    insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
    values(b,delta,o.method,'Corrección #'||o.number||': '||p_reason,p_id,null,auth.uid(),'correccion');
   end if;
  end loop;
 end if;
 update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,
  takeaway=coalesce(p_takeaway,o.takeaway),version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data)
 values(p_id,auth.uid(),p_reason,to_jsonb(o),
  jsonb_build_object('takeaway',coalesce(p_takeaway,o.takeaway),'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net,'receipt',p_receipt,'received',p_received));
end $$;

-- 6. Movimientos manuales: ingreso, gasto y retiro son distintos ----------------
drop function if exists public.cash_movement(public.business,integer,public.payment_method,text);
create function public.cash_movement(p_business public.business,p_amount integer,p_method public.payment_method,p_reason text,p_kind text default null) returns void
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
 insert into public.movements(business,amount,method,reason,actor,kind)
 values(p_business,p_amount,p_method,trim(p_reason),auth.uid(),kind);
end $$;
revoke all on function public.cash_movement(public.business,integer,public.payment_method,text,text) from public,anon,authenticated;
grant execute on function public.cash_movement(public.business,integer,public.payment_method,text,text) to authenticated;

-- 7. Transferencias entre cajas sin turno --------------------------------------
create or replace function public.transfer_cash(p_id uuid,p_source public.business,p_amount integer,p_method public.payment_method,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare destination public.business; balance bigint; destination_name text;
begin
 if public.current_app_role() is distinct from 'superadmin' then raise exception 'Solo Superadmin puede transferir entre cajas.'; end if;
 if p_id is null or p_source is null or p_method is null or p_amount is null or p_amount<=0 or p_amount>100000000 or p_reason is null or length(trim(p_reason)) not between 3 and 450 then raise exception 'Indica importe y motivo válidos.'; end if;
 perform pg_advisory_xact_lock(81001);
 if exists(select 1 from public.movements where transfer_id=p_id) then raise exception 'Esta transferencia ya fue registrada.'; end if;
 destination := case when p_source='palatto' then 'carreta'::public.business else 'palatto'::public.business end;
 destination_name := case when destination='palatto' then 'Caja principal' else 'Aguas y colas' end;
 select coalesce(sum(amount),0) into balance from public.movements where business=p_source and method=p_method;
 if balance<p_amount then raise exception 'El importe supera el saldo disponible.'; end if;
 insert into public.movements(business,amount,method,reason,actor,transfer_id,kind) values
 (p_source,-p_amount,p_method,'Envío a '||destination_name||': '||trim(p_reason),auth.uid(),p_id,'transferencia'),
 (destination,p_amount,p_method,'Recibido de '||case when p_source='palatto' then 'Caja principal' else 'Aguas y colas' end||': '||trim(p_reason),auth.uid(),p_id,'transferencia');
end $$;

-- 8. Pagos divididos por persona ------------------------------------------------
create table if not exists public.order_payments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.orders on delete cascade,
 label text not null check(length(trim(label)) between 1 and 60),
 items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items)>0),
 amount integer not null check(amount>0),
 method public.payment_method not null,
 receipt text,
 created_by uuid not null references public.profiles,
 created_at timestamptz not null default now(),
 check(method<>'transferencia' or receipt is not null)
);
create index if not exists order_payments_order on public.order_payments(order_id);
alter table public.order_payments enable row level security;
drop policy if exists read_order_payments on public.order_payments;
create policy read_order_payments on public.order_payments for select to authenticated
 using (public.current_app_role() is not null);
revoke all on public.order_payments from anon,authenticated;
grant select on public.order_payments to authenticated;

alter table public.orders add column if not exists split_payment boolean not null default false;

create or replace function public.add_split_payment(
 p_id uuid,p_version integer,p_label text,p_items jsonb,
 p_method public.payment_method,p_received integer,p_receipt text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
 o public.orders; v jsonb; item jsonb; b public.business;
 label text; line_qty integer; line_price integer; assigned integer; available integer;
 part_amount integer := 0; part_items jsonb := '[]'::jsonb;
 total_amount integer; paid_amount integer; biz_amount integer; new_paid boolean;
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
  if line_qty > available then
   raise exception 'Solo quedan % de %.',available,item->>'name';
  end if;
  line_price := (item->>'price')::integer;
  part_amount := part_amount + line_price*line_qty;
  part_items := part_items || jsonb_build_array(jsonb_build_object(
   'product_id',item->>'product_id','name',item->>'name','price',line_price,
   'business',item->>'business','quantity',line_qty));
 end loop;

 select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into total_amount from jsonb_array_elements(o.items) i;
 select coalesce(sum(amount),0) into paid_amount from public.order_payments where order_id=o.id;
 if part_amount > total_amount-paid_amount then raise exception 'El importe supera lo que falta por cobrar.'; end if;
 if p_method='efectivo' and (p_received is null or p_received<part_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;

 insert into public.order_payments(order_id,label,items,amount,method,receipt,created_by)
 values(o.id,label,part_items,part_amount,p_method,
  case when p_method='transferencia' then p_receipt end,auth.uid());

 for b in select distinct (i->>'business')::public.business from jsonb_array_elements(part_items) i loop
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into biz_amount
  from jsonb_array_elements(part_items) i where i->>'business'=b::text;
  if biz_amount>0 then
   insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
   values(b,biz_amount,p_method,'Cobro #'||o.number||' · '||label,o.id,null,auth.uid(),'cobro');
  end if;
 end loop;

 new_paid := (paid_amount+part_amount) >= total_amount;
 update public.orders set paid=new_paid,
  status=case when new_paid then 'completado' else 'en_proceso' end,
  method=case when new_paid then p_method else o.method end,
  receipt=case when new_paid and p_method='transferencia' then p_receipt else o.receipt end,
  split_payment=true,version=version+1 where id=o.id;
 insert into public.audits(order_id,actor,reason,before_data,after_data)
 values(o.id,auth.uid(),'Pago dividido: '||label,to_jsonb(o),
  jsonb_build_object('label',label,'items',part_items,'amount',part_amount,'method',p_method,'paid',new_paid));
end $$;
revoke all on function public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) from public,anon,authenticated;
grant execute on function public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) to authenticated;

-- 9. No se elimina un pedido con pagos divididos -------------------------------
create or replace function public.delete_order(p_id uuid,p_version integer,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; amount integer;
begin
 perform public.require_writer();
 if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Escribe el motivo de la eliminación.'; end if;
 perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found then raise exception 'El pedido ya no existe.'; end if;
 if o.version<>p_version then raise exception 'El pedido cambió. Actualiza la pantalla e inténtalo de nuevo.'; end if;
 if o.paid then raise exception 'Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.'; end if;
 if exists(select 1 from public.movements where order_id=p_id) then raise exception 'El pedido tiene cobros registrados y no puede eliminarse.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'El pedido tiene pagos divididos y no puede eliminarse.'; end if;
 select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount from jsonb_array_elements(o.items) i;
 insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by)
 values(o.id,o.number,o.customer,o.items,amount,trim(p_reason),auth.uid());
 delete from public.audits where order_id=p_id;
 delete from public.orders where id=p_id;
end $$;

-- 10. Realtime y recarga del esquema -------------------------------------------
do $$ begin
 if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='order_payments') then
  alter publication supabase_realtime add table public.order_payments;
 end if;
end $$;
notify pgrst,'reload schema';
