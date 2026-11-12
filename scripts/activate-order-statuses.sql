begin;
DO $activate$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_status_matches_payment') then
 execute $migration$alter table public.orders drop constraint orders_status_check;
alter table public.orders alter column status set default 'en_proceso';
update public.orders set status=case when paid then 'completado' else 'en_proceso' end,version=version+1;
alter table public.orders add constraint orders_status_check check(status in ('en_proceso','completado'));
alter table public.orders add constraint orders_status_matches_payment check(status=case when paid then 'completado' else 'en_proceso' end);
drop function public.advance_order(uuid,integer);
create or replace function public.pay_order(p_id uuid,p_version integer,p_method public.payment_method,p_received integer,p_receipt text default null) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; b public.business; amount integer; full_amount integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
 if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
 select sum((i->>'price')::integer*(i->>'quantity')::integer) into full_amount from jsonb_array_elements(o.items) i;
 if p_method='efectivo' and (p_received is null or p_received<full_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
 foreach b in array enum_range(null::public.business) loop
   select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount from jsonb_array_elements(o.items) i where i->>'business'=b::text;
   if amount>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,amount,p_method,'Cobro de pedido #'||o.number,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
 end loop;
 update public.orders set paid=true,status='completado',method=p_method,receipt=case when p_method='transferencia' then p_receipt end,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),jsonb_build_object('status','completado','paid',true,'received',p_received,'change',case when p_method='efectivo' then p_received-full_amount else 0 end));
end $$;
create or replace function public.toggle_shift(p_business public.business) returns void language plpgsql security definer set search_path = '' as $$
declare s public.shifts; r public.app_role := public.current_app_role();
begin
 if r is null or not(r='superadmin' or (p_business='palatto' and r in ('administrador','cocinero')) or (p_business='carreta' and r='carreta')) then raise exception 'No tienes permiso para este turno.'; end if;
 perform pg_advisory_xact_lock(81001);
 select * into s from public.shifts where business=p_business and closed_at is null for update;
 if found then
   if exists(select 1 from public.orders o where not o.paid and exists(select 1 from jsonb_array_elements(o.items) i where i->>'business'=p_business::text)) then raise exception 'Cobra los pedidos de este negocio antes de cerrar.'; end if;
   update public.shifts set closed_at=now(),closed_by=auth.uid() where id=s.id;
 else insert into public.shifts(business,opened_by) values(p_business,auth.uid()); end if;
end $$;
notify pgrst,'reload schema';
$migration$;
 end if;
end $activate$;
insert into supabase_migrations.schema_migrations(version,name,statements) values('20260917170000','two_order_statuses',array[]::text[]) on conflict(version) do nothing;
-- Customer payment method is preserved on orders; Carreta ledger is cash only.
create or replace function public.pay_order(p_id uuid,p_version integer,p_method public.payment_method,p_received integer,p_receipt text default null) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; b public.business; amount integer; full_amount integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
 if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
 select sum((i->>'price')::integer*(i->>'quantity')::integer) into full_amount from jsonb_array_elements(o.items) i;
 if p_method='efectivo' and (p_received is null or p_received<full_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
 foreach b in array enum_range(null::public.business) loop
   select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount from jsonb_array_elements(o.items) i where i->>'business'=b::text;
   if amount>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,amount,case when b='carreta' then 'efectivo'::public.payment_method else p_method end,'Cobro de pedido #'||o.number,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
 end loop;
 update public.orders set paid=true,status='completado',method=p_method,receipt=case when p_method='transferencia' then p_receipt end,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),jsonb_build_object('status','completado','paid',true,'received',p_received,'change',case when p_method='efectivo' then p_received-full_amount else 0 end));
end $$;
create or replace function public.edit_order(p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,p_received integer default 0,p_receipt text default null,p_takeaway boolean default null) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; b public.business; delta integer; net integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if public.current_app_role()='cocinero' and not o.paid then raise exception 'El cocinero solo puede editar pedidos cobrados.'; end if;
 if length(trim(p_reason))<3 then raise exception 'Escribe el motivo de la corrección.'; end if;
 resolved := public.resolve_items(p_items,o.items,coalesce(p_takeaway,o.takeaway));
 select (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i) - (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i) into net;
 if o.paid then
   if o.method='efectivo' and net>0 and (p_received is null or p_received<net) then raise exception 'Registra el efectivo adicional recibido.'; end if;
   if o.method='transferencia' and net<>0 then perform public.check_receipt(p_receipt); end if;
   foreach b in array enum_range(null::public.business) loop
     select coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i where i->>'business'=b::text),0)-coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i where i->>'business'=b::text),0) into delta;
     if delta<>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,delta,case when b='carreta' then 'efectivo'::public.payment_method else o.method end,'Corrección #'||o.number||': '||p_reason,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
   end loop;
 end if;
 update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,takeaway=coalesce(p_takeaway,o.takeaway),version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),p_reason,to_jsonb(o),jsonb_build_object('takeaway',coalesce(p_takeaway,o.takeaway),'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net,'receipt',p_receipt,'received',p_received));
end $$;
notify pgrst,'reload schema';

insert into supabase_migrations.schema_migrations(version,name,statements) values('20260919090000','carreta_payment_allocation',array[]::text[]) on conflict(version) do nothing;
commit;
select proname,position('case when b=''carreta''' in prosrc)>0 as carreta_cash_allocation from pg_proc where pronamespace='public'::regnamespace and proname in ('pay_order','edit_order');
