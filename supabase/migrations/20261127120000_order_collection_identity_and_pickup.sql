-- Additive order lifecycle, combined collection, pickup codes, and profile photos.
alter table public.orders
  add column if not exists delivered_at timestamptz,
  add column if not exists security_code_enabled boolean not null default false,
  add column if not exists security_code text,
  add column if not exists mixed_payment boolean not null default false;

alter table public.profiles add column if not exists avatar_path text;
alter table public.notifications add column if not exists movement_id uuid;

-- Legacy payment marked orders as completed; preserve their historical meaning.
update public.orders set delivered_at=coalesce(paid_at,created_at)
where paid and status='completado' and delivered_at is null;

create index if not exists orders_undelivered on public.orders(created_at desc) where delivered_at is null;

create or replace function public.create_order_with_pickup_code(
  p_customer text,p_notes text,p_items jsonb,p_takeaway boolean default false,
  p_prep_minutes integer default null,p_ask_kitchen boolean default false,p_require_pickup_code boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid;
begin
  oid := public.create_order(p_customer,p_notes,p_items,p_takeaway,p_prep_minutes,p_ask_kitchen);
  if coalesce(p_require_pickup_code,false) then
    update public.orders set security_code_enabled=true,security_code=lpad(floor(random()*100)::integer::text,2,'0') where id=oid and created_by=auth.uid();
    if not found then raise exception 'No se pudo asignar el código de retiro.'; end if;
  end if;
  return oid;
end $$;

revoke all on function public.create_order_with_pickup_code(text,text,jsonb,boolean,integer,boolean,boolean) from public,anon;
grant execute on function public.create_order_with_pickup_code(text,text,jsonb,boolean,integer,boolean,boolean) to authenticated;

create or replace function public.collect_order(
  p_id uuid,p_version integer,p_cash_amount integer,p_transfer_amount integer,p_cash_received integer,
  p_transfer_receipt text default null,p_total integer default null,p_deliver boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; full_amount integer; final_amount integer; cash_amount integer; transfer_amount integer;
  palatto_total integer; full_palatto integer; palatto_cash integer; palatto_transfer integer; b public.business;
  allocated integer; reason text;
begin
  perform public.require_writer();
  perform pg_advisory_xact_lock(81001);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza e inténtalo de nuevo.'; end if;
  if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
  if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'Este pedido tiene pagos divididos; cobra el resto desde Dividir cuenta.'; end if;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer+coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0),
         coalesce(sum(case when i->>'business'='palatto' then (i->>'price')::integer*(i->>'quantity')::integer+coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0) else 0 end),0)
    into full_amount,full_palatto from jsonb_array_elements(o.items) i;
  final_amount:=coalesce(p_total,full_amount); cash_amount:=coalesce(p_cash_amount,0); transfer_amount:=coalesce(p_transfer_amount,0);
  if final_amount<=0 or final_amount>100000000 or cash_amount<0 or transfer_amount<0 or cash_amount+transfer_amount<>final_amount then raise exception 'La suma de efectivo y transferencia debe coincidir con el total.'; end if;
  if cash_amount>0 and (p_cash_received is null or p_cash_received<cash_amount) then raise exception 'El efectivo recibido no cubre su parte.'; end if;
  if transfer_amount>0 then perform public.check_receipt(p_transfer_receipt); end if;
  if p_deliver and o.items is not null and exists(select 1 from jsonb_array_elements(o.items) i where coalesce((i->>'is_drink')::boolean,false)=false and i->>'business'<>'carreta') and o.status<>'completado' then
    raise exception 'Marca el pedido como listo antes de entregarlo.';
  end if;
  palatto_total:=case when full_amount<=0 then 0 when full_palatto>=full_amount then final_amount when full_palatto<=0 then 0 else round(final_amount::numeric*full_palatto/full_amount)::integer end;
  palatto_cash:=case when final_amount=0 then 0 else round(cash_amount::numeric*palatto_total/final_amount)::integer end;
  palatto_transfer:=palatto_total-palatto_cash;
  for b in select distinct (i->>'business')::public.business from jsonb_array_elements(o.items) i loop
    allocated:=case when b='palatto' then palatto_cash else cash_amount-palatto_cash end;
    if allocated>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
      values(b,allocated,'efectivo','Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro'); end if;
    allocated:=case when b='palatto' then palatto_transfer else transfer_amount-palatto_transfer end;
    if allocated>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind,receipt)
      values(b,allocated,'transferencia','Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro',p_transfer_receipt); end if;
  end loop;
  reason:=case when cash_amount>0 and transfer_amount>0 then 'efectivo + transferencia' when cash_amount>0 then 'efectivo' else 'transferencia' end;
  update public.orders set paid=true,method=case when transfer_amount>0 and cash_amount=0 then 'transferencia'::public.payment_method else 'efectivo'::public.payment_method end,
    mixed_payment=(cash_amount>0 and transfer_amount>0),receipt=case when transfer_amount>0 then p_transfer_receipt else null end,
    adjustment=final_amount-full_amount,paid_at=now(),delivered_at=case when p_deliver then now() else delivered_at end,
    status=case when p_deliver then 'completado'::text else status end,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Cobro: '||reason,to_jsonb(o),jsonb_build_object('paid',true,'total',final_amount,'cash',cash_amount,'transfer',transfer_amount,'delivered_at',case when p_deliver then now() else null end));
end $$;

revoke all on function public.collect_order(uuid,integer,integer,integer,integer,text,integer,boolean) from public,anon;
grant execute on function public.collect_order(uuid,integer,integer,integer,integer,text,integer,boolean) to authenticated;

create or replace function public.deliver_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.require_writer();
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza e inténtalo de nuevo.'; end if;
  if not o.paid then raise exception 'Cobra el pedido antes de marcarlo como entregado.'; end if;
  if o.delivered_at is not null then raise exception 'El pedido ya fue entregado.'; end if;
  if exists(select 1 from jsonb_array_elements(o.items) i where not coalesce((i->>'is_drink')::boolean,false) and i->>'business'<>'carreta') and o.status<>'completado' then raise exception 'Marca el pedido como listo antes de entregarlo.'; end if;
  update public.orders set delivered_at=now(),status='completado',version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Pedido entregado',to_jsonb(o),jsonb_build_object('delivered_at',now()));
end $$;
revoke all on function public.deliver_order(uuid,integer) from public,anon;
grant execute on function public.deliver_order(uuid,integer) to authenticated;

-- Kitchen must still be able to finish work after the order was paid.
create or replace function public.kitchen_advance_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede finalizar pedidos.'; end if;
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza e inténtalo de nuevo.'; end if;
  if o.accepted_at is null or o.status<>'en_proceso' or o.delivered_at is not null then raise exception 'Este pedido no está en preparación.'; end if;
  update public.orders set status='completado',ready_at=now(),version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Preparación finalizada',to_jsonb(o),jsonb_build_object('status','completado','ready_at',now()));
end $$;
revoke all on function public.kitchen_advance_order(uuid,integer) from public,anon;
grant execute on function public.kitchen_advance_order(uuid,integer) to authenticated;

-- Users may only choose a photo stored under their own uid.
create or replace function public.save_profile_avatar(p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_path is null or p_path !~ ('^'||auth.uid()::text||'/[^/]+$') then raise exception 'Ruta de foto inválida.'; end if;
  if not exists(select 1 from storage.objects where bucket_id='profile-photos' and name=p_path) then raise exception 'No se encontró la foto subida.'; end if;
  update public.profiles set avatar_path=p_path where id=auth.uid();
  if not found then raise exception 'No se encontró tu perfil.'; end if;
end $$;
revoke all on function public.save_profile_avatar(text) from public,anon;
grant execute on function public.save_profile_avatar(text) to authenticated;

drop policy if exists profile_directory_read on public.profiles;
create policy profile_directory_read on public.profiles for select to authenticated using (public.current_app_role() is not null);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-photos','profile-photos',true,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=2097152,allowed_mime_types=array['image/jpeg','image/png','image/webp'];
drop policy if exists profile_photos_insert_own on storage.objects;
create policy profile_photos_insert_own on storage.objects for insert to authenticated with check(bucket_id='profile-photos' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists profile_photos_update_own on storage.objects;
create policy profile_photos_update_own on storage.objects for update to authenticated using(bucket_id='profile-photos' and (storage.foldername(name))[1]=auth.uid()::text) with check(bucket_id='profile-photos' and (storage.foldername(name))[1]=auth.uid()::text);
notify pgrst,'reload schema';
