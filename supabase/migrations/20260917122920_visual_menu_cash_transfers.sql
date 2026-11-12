alter table public.products add column image_path text;
alter table public.movements add column transfer_id uuid;
create unique index movements_transfer_business on public.movements(transfer_id,business) where transfer_id is not null;

create function public.transfer_cash(p_id uuid,p_source public.business,p_amount integer,p_method public.payment_method,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare destination public.business; source_shift uuid; destination_shift uuid; balance bigint;
begin
 if public.current_app_role() is distinct from 'superadmin' then raise exception 'Solo Superadmin puede transferir entre cajas.'; end if;
 if p_id is null or p_source is null or p_method is null or p_amount is null or p_amount<=0 or p_amount>100000000 or p_reason is null or length(trim(p_reason)) not between 3 and 450 then raise exception 'Indica importe y motivo válidos.'; end if;
 perform pg_advisory_xact_lock(81001);
 if exists(select 1 from public.movements where transfer_id=p_id) then raise exception 'Esta transferencia ya fue registrada.'; end if;
 destination := case when p_source='palatto' then 'carreta'::public.business else 'palatto'::public.business end;
 select id into source_shift from public.shifts where business=p_source and closed_at is null;
 select id into destination_shift from public.shifts where business=destination and closed_at is null;
 if source_shift is null or destination_shift is null then raise exception 'Abre ambos turnos para transferir.'; end if;
 select coalesce(sum(amount),0) into balance from public.movements where business=p_source and method=p_method;
 if balance<p_amount then raise exception 'El importe supera el saldo disponible.'; end if;
 insert into public.movements(business,amount,method,reason,shift_id,actor,transfer_id) values
 (p_source,-p_amount,p_method,'Envío a '||destination||': '||trim(p_reason),source_shift,auth.uid(),p_id),
 (destination,p_amount,p_method,'Recibido de '||p_source||': '||trim(p_reason),destination_shift,auth.uid(),p_id);
end $$;
revoke all on function public.transfer_cash(uuid,public.business,integer,public.payment_method,text) from public,anon,authenticated;
grant execute on function public.transfer_cash(uuid,public.business,integer,public.payment_method,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('menu-images','menu-images',true,5242880,array['image/jpeg','image/png','image/webp']);
create policy upload_menu_images on storage.objects for insert to authenticated with check(bucket_id='menu-images' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.current_app_role()) in ('superadmin','administrador'));
create policy view_menu_images on storage.objects for select to authenticated using(bucket_id='menu-images');
drop function public.save_product(uuid,text,integer,public.business,text,boolean);
create function public.save_product(p_id uuid,p_name text,p_price integer,p_business public.business,p_category text,p_active boolean,p_image_path text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then raise exception 'Solo administración puede editar el menú.'; end if;
 if p_image_path is not null and not exists(select 1 from storage.objects where bucket_id='menu-images' and name=p_image_path) then raise exception 'Sube una foto válida del producto.'; end if;
 if lower(p_name||' '||p_category) ~ '(sorbete|frozz?en)' then p_business:='carreta'; end if;
 insert into public.products(id,name,price,business,category,active,image_path) values(coalesce(p_id,gen_random_uuid()),trim(p_name),p_price,p_business,trim(p_category),p_active,p_image_path)
 on conflict(id) do update set name=excluded.name,price=excluded.price,business=excluded.business,category=excluded.category,active=excluded.active,image_path=excluded.image_path;
end $$;
revoke all on function public.save_product(uuid,text,integer,public.business,text,boolean,text) from public,anon,authenticated;
grant execute on function public.save_product(uuid,text,integer,public.business,text,boolean,text) to authenticated;
