-- Money is stored as integer US dollar cents. Ledger entries are append-only.
create type public.app_role as enum ('superadmin','administrador','cocinero','mesera','visualizador','carreta');
create type public.business as enum ('palatto','carreta');
create type public.payment_method as enum ('efectivo','transferencia');
create table public.profiles (
 id uuid primary key references auth.users on delete cascade,
 name text not null check(length(trim(name)) between 1 and 100),
 role public.app_role not null default 'visualizador', active boolean not null default true
);
create table public.products (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 120),
 price integer not null check(price between 1 and 1000000), business public.business not null,
 category text not null default 'General', active boolean not null default true
);
create table public.shifts (
 id uuid primary key default gen_random_uuid(), business public.business not null,
 opened_at timestamptz not null default now(), closed_at timestamptz,
 opened_by uuid not null references public.profiles, closed_by uuid references public.profiles
);
create unique index one_open_shift on public.shifts(business) where closed_at is null;
create table public.orders (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 customer text not null check(length(trim(customer)) between 1 and 120), notes text not null default '',
 items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items)>0),
 status text not null default 'pendiente' check(status in ('pendiente','preparando','listo','entregado')),
 paid boolean not null default false, method public.payment_method, receipt text,
 created_at timestamptz not null default now(), created_by uuid not null references public.profiles,
 version integer not null default 1,
 check(not paid or method is not null), check(not paid or method <> 'transferencia' or receipt is not null)
);
create table public.movements (
 id uuid primary key default gen_random_uuid(), business public.business not null,
 amount integer not null check(amount <> 0), method public.payment_method not null,
 reason text not null check(length(trim(reason)) between 3 and 500),
 order_id uuid references public.orders, shift_id uuid references public.shifts,
 actor uuid not null references public.profiles, created_at timestamptz not null default now()
);
create table public.audits (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders,
 actor uuid not null references public.profiles, reason text not null, before_data jsonb not null,
 after_data jsonb not null, created_at timestamptz not null default now()
);
create index on public.orders(created_at);
create index on public.movements(business,created_at);
create index on public.audits(order_id);

create function public.current_app_role() returns public.app_role language sql stable security definer set search_path = '' as $$
 select role from public.profiles where id=auth.uid() and active;
$$;
create function public.can_manage_cash(b public.business) returns boolean language sql stable security definer set search_path = '' as $$
 select coalesce(public.current_app_role()='superadmin' or (b='palatto' and public.current_app_role()='administrador') or (b='carreta' and public.current_app_role()='carreta'),false);
$$;
create function public.require_writer() returns void language plpgsql security definer set search_path = '' as $$
begin
 if public.current_app_role() is null or public.current_app_role()='visualizador' then raise exception 'No tienes permiso para modificar datos.'; end if;
end $$;

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.shifts enable row level security;
alter table public.orders enable row level security;
alter table public.movements enable row level security;
alter table public.audits enable row level security;
create policy read_profiles on public.profiles for select to authenticated using (id=auth.uid() or public.current_app_role()='superadmin');
create policy read_products on public.products for select to authenticated using (public.current_app_role() is not null);
create policy read_shifts on public.shifts for select to authenticated using (public.current_app_role() is not null);
create policy read_orders on public.orders for select to authenticated using (public.current_app_role() is not null);
create policy read_movements on public.movements for select to authenticated using (public.current_app_role() is not null);
create policy read_audits on public.audits for select to authenticated using (public.current_app_role() is not null);
-- All writes go through validated RPCs or the authenticated management Edge Function.
revoke all on public.profiles,public.products,public.shifts,public.orders,public.movements,public.audits from anon,authenticated;
grant select on public.profiles,public.products,public.shifts,public.orders,public.movements,public.audits to authenticated;

create function public.save_product(p_id uuid,p_name text,p_price integer,p_business public.business,p_category text,p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then raise exception 'Solo administración puede editar el menú.'; end if;
 if lower(p_name || ' ' || p_category) ~ '(sorbete|frozz?en)' then p_business := 'carreta'; end if;
 insert into public.products(id,name,price,business,category,active) values(coalesce(p_id,gen_random_uuid()),trim(p_name),p_price,p_business,trim(p_category),p_active)
 on conflict(id) do update set name=excluded.name,price=excluded.price,business=excluded.business,category=excluded.category,active=excluded.active;
end $$;

create function public.toggle_shift(p_business public.business) returns void language plpgsql security definer set search_path = '' as $$
declare s public.shifts; r public.app_role := public.current_app_role();
begin
 if r is null or not(r='superadmin' or (p_business='palatto' and r in ('administrador','cocinero')) or (p_business='carreta' and r='carreta')) then raise exception 'No tienes permiso para este turno.'; end if;
 perform pg_advisory_xact_lock(81001);
 select * into s from public.shifts where business=p_business and closed_at is null for update;
 if found then
   if exists(select 1 from public.orders o where (not o.paid or o.status<>'entregado') and exists(select 1 from jsonb_array_elements(o.items) i where i->>'business'=p_business::text)) then raise exception 'Entrega y cobra los pedidos de este negocio antes de cerrar.'; end if;
   update public.shifts set closed_at=now(),closed_by=auth.uid() where id=s.id;
 else insert into public.shifts(business,opened_by) values(p_business,auth.uid()); end if;
end $$;

-- Server resolves prices, names, business and shift availability. Never trust browser totals.
create function public.resolve_items(p_items jsonb,p_previous jsonb default '[]'::jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
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
   result := result || jsonb_build_array(jsonb_build_object('product_id',p.id,'name',coalesce(old->>'name',p.name),'price',coalesce((old->>'price')::integer,p.price),'business',coalesce(old->>'business',p.business::text),'quantity',qty));
 end loop;
 return result;
end $$;

create function public.create_order(p_customer text,p_notes text,p_items jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare oid uuid; resolved jsonb;
begin
 perform public.require_writer();
 perform pg_advisory_xact_lock(81001);
 resolved := public.resolve_items(p_items);
 insert into public.orders(customer,notes,items,created_by) values(trim(p_customer),left(p_notes,2000),resolved,auth.uid()) returning id into oid;
 return oid;
end $$;

create function public.advance_order(p_id uuid,p_version integer) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; target text;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.status='entregado' then raise exception 'El pedido ya fue entregado.'; end if;
 if exists(select 1 from public.orders where number<o.number and status<>'entregado') then raise exception 'Atiende primero el pedido más antiguo de la cola.'; end if;
 target := case o.status when 'pendiente' then 'preparando' when 'preparando' then 'listo' else 'entregado' end;
 update public.orders set status=target,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Estado: '||target,to_jsonb(o),jsonb_build_object('status',target));
end $$;

create function public.check_receipt(p_path text) returns void language plpgsql security definer set search_path = '' as $$
begin
 if p_path is null or not exists(select 1 from storage.objects where bucket_id='receipts' and name=p_path and (storage.foldername(name))[1]=auth.uid()::text) then raise exception 'Primero sube una foto válida del comprobante.'; end if;
end $$;

create function public.pay_order(p_id uuid,p_version integer,p_method public.payment_method,p_received integer,p_receipt text default null) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; b public.business; amount integer; full_amount integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
 if o.status not in ('listo','entregado') then raise exception 'Completa la preparación antes de cobrar.'; end if;
 if p_method is null then raise exception 'Selecciona el método de pago.'; end if;
 select sum((i->>'price')::integer*(i->>'quantity')::integer) into full_amount from jsonb_array_elements(o.items) i;
 if p_method='efectivo' and (p_received is null or p_received<full_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;
 foreach b in array enum_range(null::public.business) loop
   select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount from jsonb_array_elements(o.items) i where i->>'business'=b::text;
   if amount>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,amount,p_method,'Cobro de pedido #'||o.number,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
 end loop;
 update public.orders set paid=true,method=p_method,receipt=case when p_method='transferencia' then p_receipt end,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Cobro: '||p_method,to_jsonb(o),jsonb_build_object('paid',true,'received',p_received,'change',case when p_method='efectivo' then p_received-full_amount else 0 end));
end $$;

create function public.edit_order(p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,p_received integer default 0,p_receipt text default null) returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; b public.business; delta integer; net integer;
begin
 perform public.require_writer(); perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if public.current_app_role()='cocinero' and not o.paid then raise exception 'El cocinero solo puede editar pedidos cobrados.'; end if;
 if length(trim(p_reason))<3 then raise exception 'Escribe el motivo de la corrección.'; end if;
 resolved := public.resolve_items(p_items,o.items);
 select (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i) - (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i) into net;
 if o.paid then
   if o.method='efectivo' and net>0 and (p_received is null or p_received<net) then raise exception 'Registra el efectivo adicional recibido.'; end if;
   if o.method='transferencia' and net<>0 then perform public.check_receipt(p_receipt); end if;
   foreach b in array enum_range(null::public.business) loop
     select coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i where i->>'business'=b::text),0)-coalesce((select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i where i->>'business'=b::text),0) into delta;
     if delta<>0 then insert into public.movements(business,amount,method,reason,order_id,shift_id,actor) values(b,delta,o.method,'Corrección #'||o.number||': '||p_reason,p_id,(select id from public.shifts where business=b and closed_at is null),auth.uid()); end if;
   end loop;
 end if;
 update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),p_reason,to_jsonb(o),jsonb_build_object('items',resolved,'customer',p_customer,'notes',p_notes,'delta',net,'receipt',p_receipt,'received',p_received));
end $$;

create function public.cash_movement(p_business public.business,p_amount integer,p_method public.payment_method,p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare sid uuid; balance bigint;
begin
 if not public.can_manage_cash(p_business) then raise exception 'No tienes permiso para ajustar esta caja.'; end if;
 perform pg_advisory_xact_lock(81001);
 select id into sid from public.shifts where business=p_business and closed_at is null;
 if sid is null then raise exception 'Abre el turno antes de mover dinero.'; end if;
 if p_amount is null or p_amount=0 or abs(p_amount::bigint)>100000000 then raise exception 'Importe inválido.'; end if;
 select coalesce(sum(amount),0) into balance from public.movements where business=p_business and method=p_method;
 if balance+p_amount<0 then raise exception 'El retiro supera el saldo disponible de ese medio de pago.'; end if;
 insert into public.movements(business,amount,method,reason,shift_id,actor) values(p_business,p_amount,p_method,trim(p_reason),sid,auth.uid());
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('receipts','receipts',false,5242880,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
create policy upload_receipts on storage.objects for insert to authenticated with check(bucket_id='receipts' and (storage.foldername(name))[1]=auth.uid()::text and public.current_app_role() is not null and public.current_app_role()<>'visualizador');
create policy view_receipts on storage.objects for select to authenticated using(bucket_id='receipts' and public.current_app_role() is not null);

-- Internal helpers cannot be called by clients.
revoke execute on function public.current_app_role(),public.can_manage_cash(public.business),public.require_writer(),public.resolve_items(jsonb,jsonb),public.check_receipt(text),public.save_product(uuid,text,integer,public.business,text,boolean),public.toggle_shift(public.business),public.create_order(text,text,jsonb),public.advance_order(uuid,integer),public.pay_order(uuid,integer,public.payment_method,integer,text),public.edit_order(uuid,integer,text,text,jsonb,text,integer,text),public.cash_movement(public.business,integer,public.payment_method,text) from public,anon,authenticated;
grant execute on function public.current_app_role(),public.can_manage_cash(public.business) to authenticated;
grant execute on function public.save_product(uuid,text,integer,public.business,text,boolean),public.toggle_shift(public.business),public.create_order(text,text,jsonb),public.advance_order(uuid,integer),public.pay_order(uuid,integer,public.payment_method,integer,text),public.edit_order(uuid,integer,text,text,jsonb,text,integer,text),public.cash_movement(public.business,integer,public.payment_method,text) to authenticated;

-- Realtime broadcasts are still subject to SELECT policies.
alter publication supabase_realtime add table public.orders,public.products,public.shifts,public.movements,public.profiles;
