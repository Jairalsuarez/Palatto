-- Persist the service-side preparation estimate when a food order is queued.
drop function if exists public.create_order(text,text,jsonb,boolean);

create function public.create_order(
  p_customer text,
  p_notes text,
  p_items jsonb,
  p_takeaway boolean default false,
  p_prep_minutes integer default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  oid uuid;
  resolved jsonb;
  d date := (now() at time zone 'America/Guayaquil')::date;
  n integer;
  all_takeaway boolean;
  has_food boolean;
begin
  if public.current_app_role() is distinct from 'mesera' and public.current_app_role() is distinct from 'mesero'
     and public.current_app_role() is distinct from 'administrador' and public.current_app_role() is distinct from 'superadmin' then
    raise exception 'No tienes permiso para registrar pedidos.';
  end if;
  if p_customer is null or length(trim(p_customer)) not between 1 and 120 then raise exception 'Escribe un nombre o número de mesa válido.'; end if;

  perform pg_advisory_xact_lock(81001);
  select coalesce(max(number),0)+1 into n from public.orders where order_day=d;
  resolved := public.resolve_items(p_items,'[]'::jsonb,coalesce(p_takeaway,false));
  select exists(select 1 from jsonb_array_elements(resolved) i where not coalesce((i->>'is_drink')::boolean,false)) into has_food;
  if has_food and (p_prep_minutes is null or p_prep_minutes not between 1 and 240) then
    raise exception 'Indica un tiempo de preparación entre 1 y 240 minutos.';
  end if;
  if not has_food then p_prep_minutes := null; end if;

  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false)
    into all_takeaway from jsonb_array_elements(resolved) i;
  insert into public.orders(number,order_day,customer,notes,items,created_by,takeaway,prep_minutes)
    values(n,d,trim(p_customer),left(coalesce(p_notes,''),2000),resolved,auth.uid(),all_takeaway,p_prep_minutes)
    returning id into oid;
  return oid;
end $$;

revoke all on function public.create_order(text,text,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.create_order(text,text,jsonb,boolean,integer) to authenticated;
notify pgrst,'reload schema';
