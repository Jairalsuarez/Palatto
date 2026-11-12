alter type public.app_role add value if not exists 'mesero';

create or replace function public.edit_order(
 p_id uuid,p_version integer,p_customer text,p_notes text,p_items jsonb,p_reason text,
 p_received integer default 0,p_receipt text default null,p_takeaway boolean default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; resolved jsonb; net integer;
begin
 perform public.require_writer();
 perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Un pedido cobrado no se puede editar. Registra el ajuste como un movimiento de caja aparte.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then
  raise exception 'Este pedido tiene pagos parciales y no se puede editar.';
 end if;
 if length(trim(p_reason))<3 then raise exception 'Escribe el motivo del cambio.'; end if;
 resolved := public.resolve_items(p_items,o.items,coalesce(p_takeaway,o.takeaway));
 select (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(resolved) i)
  - (select sum((i->>'price')::integer*(i->>'quantity')::integer) from jsonb_array_elements(o.items) i) into net;
 update public.orders set customer=trim(p_customer),notes=left(p_notes,2000),items=resolved,
  takeaway=coalesce(p_takeaway,o.takeaway),version=version+1 where id=p_id;
 insert into public.audits(order_id,actor,reason,before_data,after_data)
 values(p_id,auth.uid(),p_reason,to_jsonb(o),
  jsonb_build_object('takeaway',coalesce(p_takeaway,o.takeaway),'items',resolved,'customer',p_customer,'notes',p_notes,'delta',net));
end $$;

create table if not exists public.supply_purchases (
 id uuid primary key default gen_random_uuid(),
 supply_id uuid not null references public.supplies(id) on delete restrict,
 quantity numeric(12,3) not null check(quantity>0),
 unit_cost integer not null check(unit_cost>0),
 total_amount integer not null check(total_amount>0),
 supplier text not null default '' check(length(supplier)<=120),
 paid boolean not null default false,
 payment_method public.payment_method,
 received boolean not null default false,
 ledger_movement_id uuid references public.movements(id),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default now(),
 paid_at timestamptz,
 received_at timestamptz,
 check((paid and payment_method is not null and ledger_movement_id is not null and paid_at is not null) or (not paid and payment_method is null and ledger_movement_id is null and paid_at is null)),
 check((received and received_at is not null) or (not received and received_at is null))
);
create index if not exists supply_purchases_recent on public.supply_purchases(created_at desc);
create index if not exists supply_purchases_open on public.supply_purchases(paid,received,created_at desc) where not paid or not received;
alter table public.supply_purchases enable row level security;
create policy read_supply_purchases on public.supply_purchases for select to authenticated using((select public.current_app_role()) is not null);
revoke all on public.supply_purchases from anon,authenticated;
grant select on public.supply_purchases to authenticated;

create or replace function public.register_supply_purchase(
 p_supply uuid,p_quantity numeric,p_unit_cost integer,p_supplier text,p_paid boolean,p_method public.payment_method,p_received boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.supplies; purchase_id uuid := gen_random_uuid(); amount integer; movement_id uuid;
begin
 if public.current_app_role() is null or public.current_app_role()='visualizador' then raise exception 'Tu rol solo puede consultar el inventario.'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity>1000000 or p_unit_cost is null or p_unit_cost<=0 then raise exception 'Cantidad y costo unitario deben ser mayores a cero.'; end if;
 if length(trim(coalesce(p_supplier,'')))>120 then raise exception 'El proveedor no puede superar 120 caracteres.'; end if;
 if p_paid and p_method is null then raise exception 'Selecciona cómo se pagó la compra.'; end if;
 amount := round(p_quantity*p_unit_cost)::integer;
 if amount<=0 or amount>100000000 then raise exception 'El total de la compra no es válido.'; end if;
 perform pg_advisory_xact_lock(81002);
 select * into s from public.supplies where id=p_supply and active for update;
 if not found then raise exception 'El insumo no existe o está inactivo.'; end if;
 if p_paid then
  insert into public.movements(business,amount,method,reason,actor,kind)
  values('palatto',-amount,p_method,'Compra de insumos · '||coalesce(nullif(trim(p_supplier),''),s.name),auth.uid(),'gasto') returning id into movement_id;
 end if;
 insert into public.supply_purchases(id,supply_id,quantity,unit_cost,total_amount,supplier,paid,payment_method,received,ledger_movement_id,created_by,paid_at,received_at)
 values(purchase_id,p_supply,p_quantity,p_unit_cost,amount,trim(coalesce(p_supplier,'')),coalesce(p_paid,false),case when p_paid then p_method else null end,coalesce(p_received,false),movement_id,auth.uid(),case when p_paid then now() else null end,case when p_received then now() else null end);
 if p_received then
  update public.supplies set stock=stock+p_quantity,updated_at=now() where id=p_supply;
  insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
  values(p_supply,'entrada',p_quantity,'Compra recibida · '||coalesce(nullif(trim(p_supplier),''),s.name),auth.uid());
 end if;
 return purchase_id;
end $$;

create or replace function public.update_supply_purchase(p_id uuid,p_action text,p_method public.payment_method default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.supply_purchases; s public.supplies; movement_id uuid;
begin
 if public.current_app_role() is null or public.current_app_role()='visualizador' then raise exception 'Tu rol solo puede consultar el inventario.'; end if;
 if p_action not in ('paid','unpaid','received') then raise exception 'Acción de compra inválida.'; end if;
 perform pg_advisory_xact_lock(81002);
 select * into p from public.supply_purchases where id=p_id for update;
 if not found then raise exception 'La compra no existe.'; end if;
 if p_action='paid' and not p.paid then
  if p_method is null then raise exception 'Selecciona cómo se pagó la compra.'; end if;
  insert into public.movements(business,amount,method,reason,actor,kind)
  select 'palatto',-p.total_amount,p_method,'Compra de insumos · '||coalesce(nullif(p.supplier,''),s.name),auth.uid(),'gasto'
  from public.supplies s where s.id=p.supply_id returning id into movement_id;
  update public.supply_purchases set paid=true,payment_method=p_method,ledger_movement_id=movement_id,paid_at=now() where id=p_id;
 elsif p_action='unpaid' and p.paid then
  insert into public.movements(business,amount,method,reason,actor,kind)
  select 'palatto',p.total_amount,p.payment_method,'Reversión de pago · compra de '||coalesce(nullif(p.supplier,''),s.name),auth.uid(),'gasto'
  from public.supplies s where s.id=p.supply_id;
  update public.supply_purchases set paid=false,payment_method=null,ledger_movement_id=null,paid_at=null where id=p_id;
 elsif p_action='received' and not p.received then
  select * into s from public.supplies where id=p.supply_id for update;
  if not found then raise exception 'El insumo ya no existe.'; end if;
  update public.supplies set stock=stock+p.quantity,updated_at=now() where id=p.supply_id;
  insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
  values(p.supply_id,'entrada',p.quantity,'Compra recibida · '||coalesce(nullif(p.supplier,''),s.name),auth.uid());
  update public.supply_purchases set received=true,received_at=now() where id=p_id;
 end if;
end $$;

revoke all on function public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean) from public,anon,authenticated;
revoke all on function public.update_supply_purchase(uuid,text,public.payment_method) from public,anon,authenticated;
grant execute on function public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean) to authenticated;
grant execute on function public.update_supply_purchase(uuid,text,public.payment_method) to authenticated;

do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='supply_purchases') then
  alter publication supabase_realtime add table public.supply_purchases;
 end if;
end $$;
notify pgrst,'reload schema';
