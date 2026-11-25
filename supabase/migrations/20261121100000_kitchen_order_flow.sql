-- Flujo exclusivo de cocina, aceptación y tiempo estimado persistente.
alter table public.products add column if not exists prep_minutes integer not null default 10;
alter table public.products drop constraint if exists products_prep_minutes_check;
alter table public.products add constraint products_prep_minutes_check check(prep_minutes between 1 and 180);

alter table public.orders add column if not exists accepted_at timestamptz;
alter table public.orders add column if not exists ready_at timestamptz;
alter table public.orders add column if not exists prep_minutes integer;
alter table public.orders drop constraint if exists orders_status_matches_payment;
alter table public.orders add constraint orders_status_matches_payment check(paid or status='en_proceso');

-- Conservar los pedidos activos anteriores y darles una estimación inicial.
update public.orders o set
  accepted_at = coalesce(o.accepted_at,o.created_at),
  prep_minutes = coalesce(o.prep_minutes, greatest(1, coalesce((
    select max(case when coalesce(p.is_drink,false) then 1 else p.prep_minutes end)
    from jsonb_array_elements(o.items) i
    join public.products p on p.id=(i->>'product_id')::uuid
  ), 1))),
  ready_at = coalesce(o.ready_at, o.created_at + make_interval(mins => greatest(1, coalesce((
    select max(case when coalesce(p.is_drink,false) then 1 else p.prep_minutes end)
    from jsonb_array_elements(o.items) i
    join public.products p on p.id=(i->>'product_id')::uuid
  ), 1))))
where not o.paid and o.status='en_proceso';

create index if not exists orders_kitchen_queue on public.orders(created_at,id) where not paid and status='en_proceso';

-- A kitchen user can only mutate kitchen state. Customer-service roles and
-- administrators retain the established order, payment and cash workflows.
create or replace function public.create_order(
  p_customer text,p_notes text,p_items jsonb,p_takeaway boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid; resolved jsonb; d date := (now() at time zone 'America/Guayaquil')::date; n integer; all_takeaway boolean;
begin
  if public.current_app_role() is distinct from 'mesera' and public.current_app_role() is distinct from 'mesero'
     and public.current_app_role() is distinct from 'administrador' and public.current_app_role() is distinct from 'superadmin' then
    raise exception 'No tienes permiso para registrar pedidos.';
  end if;
  perform pg_advisory_xact_lock(81001);
  select coalesce(max(number),0)+1 into n from public.orders where order_day=d;
  resolved := public.resolve_items(p_items,'[]'::jsonb,coalesce(p_takeaway,false));
  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false) into all_takeaway from jsonb_array_elements(resolved) i;
  insert into public.orders(number,order_day,customer,notes,items,created_by,takeaway)
  values(n,d,trim(p_customer),left(p_notes,2000),resolved,auth.uid(),all_takeaway) returning id into oid;
  return oid;
end $$;

create or replace function public.edit_order(
 p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,
 p_received integer default 0,p_receipt text default null,p_takeaway boolean default null
) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; net integer; all_takeaway boolean;
begin
  if public.current_app_role() not in ('mesera','mesero','administrador','superadmin') then raise exception 'No tienes permiso para editar pedidos.'; end if;
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid then raise exception 'Un pedido cobrado no se puede editar. Registra el ajuste como un movimiento de caja aparte.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'Este pedido tiene pagos parciales y no se puede editar.'; end if;
  if length(trim(p_reason))<3 then raise exception 'Escribe el motivo del cambio.'; end if;
  resolved := public.resolve_items(p_items,o.items,coalesce(p_takeaway,o.takeaway));
  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false) into all_takeaway from jsonb_array_elements(resolved) i;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0)
    - coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)) from jsonb_array_elements(o.items) i),0)
    into net from jsonb_array_elements(resolved) i;
  update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,takeaway=all_takeaway,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),p_reason,to_jsonb(o),jsonb_build_object('takeaway',all_takeaway,'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net));
end $$;

create or replace function public.delete_order(p_id uuid,p_version integer,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; amount integer;
begin
  if coalesce(public.current_app_role() not in ('mesera','mesero','administrador','superadmin'),true) then raise exception 'No tienes permiso para eliminar pedidos.'; end if;
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid then raise exception 'Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.'; end if;
  if exists(select 1 from public.movements where order_id=p_id) then raise exception 'El pedido tiene cobros registrados y no puede eliminarse.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'El pedido tiene pagos divididos y no puede eliminarse.'; end if;
  if length(trim(p_reason)) not between 3 and 300 then raise exception 'Escribe un motivo válido para eliminar el pedido.'; end if;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0)
    into amount from jsonb_array_elements(o.items) i;
  insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by) values(o.id,o.number,o.customer,o.items,amount,trim(p_reason),auth.uid());
  delete from public.audits where order_id=p_id;
  delete from public.orders where id=p_id;
end $$;

create or replace function public.set_app_setting(p_key text,p_value text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then raise exception 'Solo administración puede cambiar la configuración.'; end if;
  if p_key is null or length(trim(p_key)) not between 1 and 60 then raise exception 'Clave de configuración inválida.'; end if;
  insert into public.app_settings(key,value,updated_at,updated_by) values(trim(p_key),left(coalesce(p_value,''),500),now(),auth.uid())
  on conflict(key) do update set value=excluded.value,updated_at=now(),updated_by=auth.uid();
end $$;

create or replace function public.save_product(
 p_id uuid,p_name text,p_price integer,p_active boolean,p_is_drink boolean default false,
 p_image_path text default null,p_takeaway_fee integer default 0,p_prep_minutes integer default 10
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then raise exception 'Solo administración puede editar el menú.'; end if;
  if p_image_path is not null and not exists(select 1 from storage.objects where bucket_id='menu-images' and name=p_image_path) then raise exception 'Sube una foto válida del producto.'; end if;
  if p_takeaway_fee is null or p_takeaway_fee<0 or p_takeaway_fee>1000000 then raise exception 'La tarifa para llevar no es válida.'; end if;
  if p_prep_minutes is null or p_prep_minutes not between 1 and 180 then raise exception 'El tiempo debe estar entre 1 y 180 minutos.'; end if;
  insert into public.products(id,name,price,business,category,active,image_path,takeaway_fee,is_drink,prep_minutes)
  values(coalesce(p_id,gen_random_uuid()),trim(p_name),p_price,case when coalesce(p_is_drink,false) then 'carreta'::public.business else 'palatto'::public.business end,
    case when coalesce(p_is_drink,false) then 'Aguas y colas' else 'General' end,p_active,p_image_path,coalesce(p_takeaway_fee,0),coalesce(p_is_drink,false),p_prep_minutes)
  on conflict(id) do update set name=excluded.name,price=excluded.price,business=excluded.business,category=excluded.category,
    active=excluded.active,image_path=excluded.image_path,takeaway_fee=excluded.takeaway_fee,is_drink=excluded.is_drink,prep_minutes=excluded.prep_minutes;
end $$;
drop function if exists public.save_product(uuid,text,integer,boolean,boolean,text,integer);
revoke all on function public.save_product(uuid,text,integer,boolean,boolean,text,integer,integer) from public,anon,authenticated;
grant execute on function public.save_product(uuid,text,integer,boolean,boolean,text,integer,integer) to authenticated;

create or replace function public.kitchen_accept_order(p_id uuid,p_version integer,p_prep_minutes integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; latest_ready timestamptz; new_ready timestamptz; base_start timestamptz;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede aceptar pedidos.'; end if;
  if p_prep_minutes is null or p_prep_minutes not between 1 and 240 then raise exception 'El tiempo debe estar entre 1 y 240 minutos.'; end if;
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid or o.status<>'en_proceso' or o.accepted_at is not null then raise exception 'Este pedido ya fue aceptado o ya no está pendiente.'; end if;
  select max(ready_at) into latest_ready from public.orders where not paid and (status='en_proceso' or status='completado') and accepted_at is not null and id<>p_id and ready_at>now();
  base_start := greatest(now(),coalesce(latest_ready,now()));
  new_ready := base_start + make_interval(mins=>p_prep_minutes);
  update public.orders set accepted_at=now(),prep_minutes=p_prep_minutes,ready_at=new_ready,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Pedido aceptado · listo en '||p_prep_minutes||' min',to_jsonb(o),jsonb_build_object('accepted_at',now(),'ready_at',new_ready,'prep_minutes',p_prep_minutes));
end $$;

create or replace function public.kitchen_estimate_minutes(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare o public.orders; queued_until timestamptz; own_minutes integer;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede consultar la estimación.'; end if;
  select * into o from public.orders where id=p_id;
  if not found or o.paid or o.accepted_at is not null or o.status<>'en_proceso' then raise exception 'El pedido ya no está pendiente.'; end if;
  select coalesce(max(p.prep_minutes),1) into own_minutes
    from jsonb_array_elements(o.items) i join public.products p on p.id=(i->>'product_id')::uuid;
  select max(ready_at) into queued_until from public.orders
    where not paid and accepted_at is not null and ready_at>now() and (status='en_proceso' or status='completado');
  return least(240,greatest(own_minutes,ceil(greatest(0,extract(epoch from (queued_until-now()))/60)::numeric)::integer+own_minutes));
end $$;

create or replace function public.kitchen_advance_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; target text;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede cambiar la preparación.'; end if;
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid or o.accepted_at is null or o.status<>'en_proceso' then raise exception 'Este pedido no está en preparación.'; end if;
  if o.created_at < now()-interval '2 days' then raise exception 'Este pedido es demasiado antiguo para avanzar.'; end if;
  target := 'completado';
  update public.orders set status=target,ready_at=now(),version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Preparación finalizada',to_jsonb(o),jsonb_build_object('status',target,'ready_at',now()));
end $$;

create or replace function public.toggle_shift(p_business public.business) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; r public.app_role := public.current_app_role();
begin
  if r='cocinero' or r is null or not(r='superadmin' or (p_business='palatto' and r='administrador')) then raise exception 'No tienes permiso para este turno.'; end if;
  perform pg_advisory_xact_lock(81001);
  select * into s from public.shifts where business=p_business and closed_at is null for update;
  if found then
    if exists(select 1 from public.orders o where not o.paid and exists(select 1 from jsonb_array_elements(o.items) i where i->>'business'=p_business::text)) then raise exception 'Cobra los pedidos de este negocio antes de cerrar.'; end if;
    update public.shifts set closed_at=now(),closed_by=auth.uid() where id=s.id;
  else insert into public.shifts(business,opened_by) values(p_business,auth.uid()); end if;
end $$;

create or replace function public.pay_order(
 p_id uuid,p_version integer,p_method public.payment_method,p_received integer,p_receipt text default null,
 p_total integer default null,p_reason text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; full_amount integer; final_amount integer; adjustment_amount integer;
begin
  if coalesce(public.current_app_role() not in ('mesera','mesero','administrador','superadmin'),true) then raise exception 'No tienes permiso para cobrar pedidos.'; end if;
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.'; end if;
  if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0)
    into full_amount from jsonb_array_elements(o.items) i;
  final_amount := coalesce(p_total,full_amount);
  if final_amount<=0 or final_amount>100000000 then raise exception 'El total debe ser un importe mayor a cero.'; end if;
  adjustment_amount := final_amount-full_amount;
  if p_method='efectivo' and (p_received is null or p_received<final_amount) then raise exception 'Efectivo insuficiente.'; end if;
  if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
  insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
    values('palatto',final_amount,p_method,'Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro');
  update public.orders set paid=true,status='completado',method=p_method,receipt=case when p_method='transferencia' then p_receipt end,
    split_payment=false,adjustment=adjustment_amount,adjustment_reason=null,paid_at=now(),version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
    values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),jsonb_build_object('status','completado','paid',true,'received',p_received,
      'change',case when p_method='efectivo' then p_received-final_amount else 0 end,'total',final_amount,'original_total',full_amount,'adjustment',adjustment_amount));
end $$;

create or replace function public.add_split_payment(
 p_id uuid,p_version integer,p_label text,p_items jsonb,p_method public.payment_method,p_received integer,p_receipt text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; v jsonb; item jsonb; label text; line_qty integer; assigned integer; available integer; part_amount integer:=0; amount_left integer;
  part_items jsonb:='[]'::jsonb; total_amount integer; paid_amount integer; new_paid boolean; unit_amount integer; line_fee integer; line_take_qty integer; line_assigned_tq integer; asked_qty integer:=0; assigned_qty integer; total_qty integer;
begin
  if coalesce(public.current_app_role() not in ('mesera','mesero','administrador','superadmin'),true) then raise exception 'No tienes permiso para registrar pagos.'; end if;
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza la pantalla e inténtalo de nuevo.'; end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
  label:=trim(coalesce(p_label,'')); if length(label) not between 1 and 60 then raise exception 'Escribe el nombre de la persona.'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Elige al menos un producto para esta persona.'; end if;
  if jsonb_array_length(p_items)<>(select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) then raise exception 'Producto duplicado en la división.'; end if;
  for v in select * from jsonb_array_elements(p_items) loop
    line_qty:=(v->>'quantity')::integer; if line_qty is null or line_qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
    select value into item from jsonb_array_elements(o.items) where value->>'product_id'=v->>'product_id';
    if item is null then raise exception 'Ese producto no está en el pedido.'; end if;
    select coalesce(sum((pl->>'quantity')::integer),0) into assigned from public.order_payments op cross join lateral jsonb_array_elements(op.items) pl where op.order_id=o.id and pl->>'product_id'=v->>'product_id';
    available:=(item->>'quantity')::integer-assigned; if line_qty>available then raise exception 'Solo quedan % de %.',available,item->>'name'; end if;
    line_fee:=coalesce((item->>'takeaway_fee')::integer,0);
    select coalesce(sum((pl->>'takeaway_quantity')::integer),0) into line_assigned_tq
      from public.order_payments op cross join lateral jsonb_array_elements(op.items) pl
      where op.order_id=o.id and pl->>'product_id'=v->>'product_id';
    line_take_qty:=least(line_qty,greatest(0,coalesce((item->>'takeaway_quantity')::integer,0)-line_assigned_tq));
    part_amount:=part_amount+(item->>'price')::integer*line_qty+line_fee*line_take_qty;
    asked_qty:=asked_qty+line_qty;
    part_items:=part_items||jsonb_build_array(jsonb_build_object('product_id',item->>'product_id','name',item->>'name','price',(item->>'price')::integer,
      'base_price',(item->>'price')::integer,'takeaway_fee',coalesce((item->>'takeaway_fee')::integer,0),
      'takeaway_quantity',line_take_qty,
      'is_drink',coalesce((item->>'is_drink')::boolean,false),'business',item->>'business','quantity',line_qty));
  end loop;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer+coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0),coalesce(sum((i->>'quantity')::integer),0)
    into total_amount,total_qty from jsonb_array_elements(o.items) i;
  select coalesce(sum(amount),0) into paid_amount from public.order_payments where order_id=o.id;
  select coalesce(sum((pl->>'quantity')::integer),0) into assigned_qty from public.order_payments op cross join lateral jsonb_array_elements(op.items) pl where op.order_id=o.id;
  amount_left:=total_amount-paid_amount;
  if part_amount>amount_left then raise exception 'El importe supera lo que falta por cobrar.'; end if;
  if assigned_qty+asked_qty>=total_qty then part_amount:=amount_left; end if;
  if part_amount<=0 then raise exception 'El importe del pago no es válido.'; end if;
  if p_method='efectivo' and (p_received is null or p_received<part_amount) then raise exception 'Efectivo insuficiente.'; end if;
  if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
  insert into public.order_payments(order_id,label,items,amount,method,receipt,created_by) values(o.id,label,part_items,part_amount,p_method,case when p_method='transferencia' then p_receipt end,auth.uid());
  insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind) values('palatto',part_amount,p_method,'Cobro #'||o.number||' · '||label,o.id,null,auth.uid(),'cobro');
  new_paid:=(paid_amount+part_amount)>=total_amount or not exists (
    select 1 from jsonb_array_elements(o.items) original
    where (original->>'quantity')::integer > coalesce((
      select sum((assigned_item->>'quantity')::integer)
      from public.order_payments prior
      cross join lateral jsonb_array_elements(prior.items) assigned_item
      where prior.order_id=o.id and assigned_item->>'product_id'=original->>'product_id'
    ),0)
  );
  if new_paid then part_amount:=part_amount+greatest(0,total_amount-(paid_amount+part_amount)); end if;
  update public.orders set paid=new_paid,status=case when new_paid then 'completado' else 'en_proceso' end,
    method=case when new_paid then p_method else method end,receipt=case when new_paid and p_method='transferencia' then p_receipt else receipt end,
    paid_at=case when new_paid then now() else paid_at end,split_payment=true,version=version+1 where id=o.id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(o.id,auth.uid(),'Pago dividido: '||label,to_jsonb(o),jsonb_build_object('label',label,'items',part_items,'amount',part_amount,'method',p_method,'paid',new_paid));
end $$;

revoke all on function public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text),public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) from public,anon,authenticated;
grant execute on function public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text),public.add_split_payment(uuid,integer,text,jsonb,public.payment_method,integer,text) to authenticated;

revoke all on function public.kitchen_accept_order(uuid,integer,integer),public.kitchen_advance_order(uuid,integer),public.kitchen_estimate_minutes(uuid) from public,anon,authenticated;
grant execute on function public.kitchen_accept_order(uuid,integer,integer),public.kitchen_advance_order(uuid,integer),public.kitchen_estimate_minutes(uuid) to authenticated;
notify pgrst,'reload schema';
