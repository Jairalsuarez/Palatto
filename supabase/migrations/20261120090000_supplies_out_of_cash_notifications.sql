-- Insumos fuera de la caja, reinicio de aguas/colas y notificaciones internas.
--
-- 1. Marcar una compra de insumos como pagada ya no crea ni revierte
--    movimientos de caja. El pago se registra manualmente como gasto o retiro.
--    Se conserva el historial de caja anterior para no alterar saldos pasados.
-- 2. La fecha de reinicio del conteo de aguas y colas se guarda como ajuste.
-- 3. Se agrega la tabla de notificaciones internas de la aplicación.

-- 1. Compras de insumos sin efecto en caja ------------------------------------
alter table public.supply_purchases drop constraint if exists supply_purchases_check;

alter table public.supply_purchases
  add constraint supply_purchases_payment_check check (
    (paid and payment_method is not null and paid_at is not null)
    or (not paid and payment_method is null and paid_at is null)
  );

create or replace function public.register_supply_purchase(
  p_supply uuid,p_quantity numeric,p_unit_cost integer,p_supplier text,
  p_paid boolean,p_method public.payment_method,p_received boolean,p_receipt text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.supplies; purchase_id uuid := gen_random_uuid(); amount integer;
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
  insert into public.supply_purchases(id,supply_id,quantity,unit_cost,total_amount,supplier,paid,payment_method,received,ledger_movement_id,created_by,paid_at,received_at,receipt)
  values(purchase_id,p_supply,p_quantity,p_unit_cost,amount,trim(coalesce(p_supplier,'')),coalesce(p_paid,false),
    case when p_paid then p_method else null end,coalesce(p_received,false),null,auth.uid(),
    case when p_paid then now() else null end,case when p_received then now() else null end,p_receipt);
  if p_received then
    update public.supplies set stock=stock+p_quantity,updated_at=now() where id=p_supply;
    insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
    values(p_supply,'entrada',p_quantity,'Compra recibida · '||coalesce(nullif(trim(p_supplier),''),s.name),auth.uid());
  end if;
  return purchase_id;
end $$;

create or replace function public.update_supply_purchase(
  p_id uuid,
  p_action text,
  p_method public.payment_method default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.supply_purchases;
  s public.supplies;
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
    update public.supply_purchases
      set paid = true, payment_method = p_method, ledger_movement_id = null, paid_at = now()
      where id = p_id;
  elsif p_action = 'unpaid' and p.paid then
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

revoke all on function public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean,text) from public,anon,authenticated;
grant execute on function public.register_supply_purchase(uuid,numeric,integer,text,boolean,public.payment_method,boolean,text) to authenticated;
revoke all on function public.update_supply_purchase(uuid,text,public.payment_method) from public,anon,authenticated;
grant execute on function public.update_supply_purchase(uuid,text,public.payment_method) to authenticated;

-- 2. Ajustes de la aplicación ------------------------------------------------
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
alter table public.app_settings enable row level security;
drop policy if exists read_app_settings on public.app_settings;
create policy read_app_settings on public.app_settings for select to authenticated
  using ((select public.current_app_role()) is not null);
revoke all on public.app_settings from anon,authenticated;
grant select on public.app_settings to authenticated;

create or replace function public.set_app_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'), true) then
    raise exception 'Solo administración puede cambiar la configuración.';
  end if;
  if p_key is null or length(trim(p_key)) not between 1 and 60 then
    raise exception 'Clave de configuración inválida.';
  end if;
  insert into public.app_settings(key,value,updated_at,updated_by)
  values(trim(p_key),left(coalesce(p_value,''),500),now(),auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end $$;

revoke all on function public.set_app_setting(text,text) from public,anon,authenticated;
grant execute on function public.set_app_setting(text,text) to authenticated;

-- 3. Notificaciones internas -------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  title text not null,
  body text not null,
  order_id uuid,
  actor uuid,
  actor_name text,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recent on public.notifications(created_at desc);
alter table public.notifications enable row level security;
drop policy if exists read_notifications on public.notifications;
create policy read_notifications on public.notifications for select to authenticated
  using ((select public.current_app_role()) is not null);
revoke all on public.notifications from anon,authenticated;
grant select on public.notifications to authenticated;

notify pgrst,'reload schema';
