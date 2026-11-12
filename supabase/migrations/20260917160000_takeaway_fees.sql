alter table public.products add column takeaway_fee integer not null default 0 check(takeaway_fee between 0 and 1000000);
alter table public.orders add column takeaway boolean not null default false;
drop function public.create_order(text,text,jsonb);
drop function public.edit_order(uuid,integer,text,text,jsonb,text,integer,text);
drop function public.resolve_items(jsonb,jsonb);
drop function public.save_product(uuid,text,integer,public.business,text,boolean,text);
create function public.resolve_items(p_items jsonb,p_previous jsonb default '[]'::jsonb,p_takeaway boolean default false) returns jsonb language plpgsql security definer set search_path = '' as $$
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
   if old is null or qty>(old->>'quantity')::integer then
     if not p.active or not exists(select 1 from public.shifts where business=p.business and closed_at is null) then raise exception 'El producto no está disponible o su turno está cerrado.'; end if;
   end if;
   result := result || jsonb_build_array(jsonb_build_object('product_id',p.id,'name',coalesce(old->>'name',p.name),'base_price',coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price),'takeaway_fee',case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,0) end,'price',coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price)+case when p_takeaway then case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,0) end else 0 end,'business',coalesce(old->>'business',p.business::text),'quantity',qty));
 end loop;
 return result;
end $$;
create function public.create_order(p_customer text,p_notes text,p_items jsonb,p_takeaway boolean default false) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid; resolved jsonb;
begin
 perform public.require_writer();
 perform pg_advisory_xact_lock(81001);
 resolved := public.resolve_items(p_items,'[]'::jsonb,coalesce(p_takeaway,false));
 insert into public.orders(customer,notes,items,created_by,takeaway) values(trim(p_customer),left(p_notes,2000),resolved,auth.uid(),coalesce(p_takeaway,false)) returning id into oid;
 return oid;
end $$;
create function public.edit_order(p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,p_received integer default 0,p_receipt text default null,p_takeaway boolean default null) returns void language plpgsql security definer set search_path = '' as $$
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
     if delta<>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,delta,o.method,'Corrección #'||o.number||': '||p_reason,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
   end loop;
 end if;
 update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,takeaway=coalesce(p_takeaway,o.takeaway),version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),p_reason,to_jsonb(o),jsonb_build_object('takeaway',coalesce(p_takeaway,o.takeaway),'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net,'receipt',p_receipt,'received',p_received));
end $$;
create function public.save_product(p_id uuid,p_name text,p_price integer,p_business public.business,p_category text,p_active boolean,p_image_path text default null,p_takeaway_fee integer default 0) returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then raise exception 'Solo administración puede editar el menú.'; end if;
 if p_image_path is not null and not exists(select 1 from storage.objects where bucket_id='menu-images' and name=p_image_path) then raise exception 'Sube una foto válida del producto.'; end if;
 if lower(p_name||' '||p_category) ~ '(sorbete|frozz?en)' then p_business:='carreta'; end if;
 insert into public.products(id,name,price,business,category,active,image_path,takeaway_fee) values(coalesce(p_id,gen_random_uuid()),trim(p_name),p_price,p_business,trim(p_category),p_active,p_image_path,p_takeaway_fee)
 on conflict(id) do update set name=excluded.name,price=excluded.price,business=excluded.business,category=excluded.category,active=excluded.active,image_path=excluded.image_path,takeaway_fee=excluded.takeaway_fee;
end $$;
revoke all on function public.resolve_items(jsonb,jsonb,boolean),public.create_order(text,text,jsonb,boolean),public.edit_order(uuid,integer,text,text,jsonb,text,integer,text,boolean),public.save_product(uuid,text,integer,public.business,text,boolean,text,integer) from public,anon,authenticated;
grant execute on function public.create_order(text,text,jsonb,boolean),public.edit_order(uuid,integer,text,text,jsonb,text,integer,text,boolean),public.save_product(uuid,text,integer,public.business,text,boolean,text,integer) to authenticated;
