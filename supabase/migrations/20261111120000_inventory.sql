-- Inventario de insumos (carne, papa, pan, etc.).
-- Stock in units (numeric, 3 decimals). Costs in US dollar cents.
create type public.supply_unit as enum ('kg','lb','unidad','litro','funda','caja','porcion');

create table public.supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  category text not null default 'General',
  unit public.supply_unit not null default 'unidad',
  stock numeric(12,3) not null default 0 check (stock >= 0),
  min_stock numeric(12,3) not null default 0 check (min_stock >= 0),
  cost_per_unit integer not null default 0 check (cost_per_unit >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index supplies_name_unique on public.supplies(lower(name));
create index supplies_low_stock on public.supplies ((stock <= min_stock)) where min_stock > 0;

create table public.supply_movements (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.supplies(id) on delete restrict,
  kind text not null check (kind in ('entrada','salida','ajuste')),
  quantity numeric(12,3) not null check (quantity >= 0),
  reason text not null check (length(trim(reason)) between 3 and 300),
  actor uuid not null references public.profiles,
  created_at timestamptz not null default now(),
  check (kind = 'ajuste' or quantity > 0)
);
create index supply_movements_supply on public.supply_movements(supply_id, created_at desc);
create index supply_movements_created on public.supply_movements(created_at desc);

alter table public.supplies enable row level security;
alter table public.supply_movements enable row level security;
create policy read_supplies on public.supplies for select to authenticated using (public.current_app_role() is not null);
create policy read_supply_movements on public.supply_movements for select to authenticated using (public.current_app_role() is not null);
revoke all on public.supplies,public.supply_movements from anon,authenticated;
grant select on public.supplies,public.supply_movements to authenticated;

-- Only the RPCs below write to inventory.
create function public.save_supply(
  p_id uuid, p_name text, p_category text, p_unit public.supply_unit,
  p_min_stock numeric, p_cost_per_unit integer, p_active boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if public.current_app_role() is null or public.current_app_role() = 'visualizador' then
    raise exception 'No tienes permiso para editar el inventario.';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 then
    raise exception 'Escribe el nombre del insumo.';
  end if;
  if p_unit is null then raise exception 'Selecciona una unidad.'; end if;
  if p_min_stock is null or p_min_stock < 0 or p_min_stock > 1000000 then
    raise exception 'El stock mínimo no es válido.';
  end if;
  if p_cost_per_unit is null or p_cost_per_unit < 0 or p_cost_per_unit > 100000000 then
    raise exception 'El costo no es válido.';
  end if;
  perform pg_advisory_xact_lock(81002);
  if exists(select 1 from public.supplies where lower(name) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'Ya existe un insumo con ese nombre.';
  end if;
  insert into public.supplies(id,name,category,unit,min_stock,cost_per_unit,active)
  values(coalesce(p_id,gen_random_uuid()),trim(p_name),coalesce(nullif(trim(p_category),''),'General'),p_unit,p_min_stock,p_cost_per_unit,coalesce(p_active,true))
  on conflict(id) do update set
    name=excluded.name, category=excluded.category, unit=excluded.unit,
    min_stock=excluded.min_stock, cost_per_unit=excluded.cost_per_unit,
    active=excluded.active, updated_at=now()
  returning id into result;
  return result;
end $$;

create function public.register_supply_movement(
  p_id uuid, p_kind text, p_quantity numeric, p_reason text
) returns numeric language plpgsql security definer set search_path = '' as $$
declare s public.supplies; next_stock numeric(12,3);
begin
  if public.current_app_role() is null or public.current_app_role() = 'visualizador' then
    raise exception 'No tienes permiso para mover el inventario.';
  end if;
  if p_kind not in ('entrada','salida','ajuste') then raise exception 'Movimiento inválido.'; end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then raise exception 'Cantidad inválida.'; end if;
  if p_kind <> 'ajuste' and p_quantity <= 0 then raise exception 'La cantidad debe ser mayor a cero.'; end if;
  if p_reason is null or length(trim(p_reason)) not between 3 and 300 then
    raise exception 'Escribe el motivo del movimiento.';
  end if;
  perform pg_advisory_xact_lock(81002);
  select * into s from public.supplies where id=p_id for update;
  if not found then raise exception 'El insumo no existe.'; end if;
  next_stock := case p_kind
    when 'entrada' then s.stock + p_quantity
    when 'salida' then s.stock - p_quantity
    else p_quantity
  end;
  if next_stock < 0 then raise exception 'No hay suficiente stock de este insumo.'; end if;
  update public.supplies set stock=next_stock, updated_at=now() where id=p_id;
  insert into public.supply_movements(supply_id,kind,quantity,reason,actor)
  values(p_id,p_kind,p_quantity,trim(p_reason),auth.uid());
  return next_stock;
end $$;

revoke all on function public.save_supply(uuid,text,text,public.supply_unit,numeric,integer,boolean) from public,anon,authenticated;
revoke all on function public.register_supply_movement(uuid,text,numeric,text) from public,anon,authenticated;
grant execute on function public.save_supply(uuid,text,text,public.supply_unit,numeric,integer,boolean) to authenticated;
grant execute on function public.register_supply_movement(uuid,text,numeric,text) to authenticated;

alter publication supabase_realtime add table public.supplies,public.supply_movements;
notify pgrst,'reload schema';
