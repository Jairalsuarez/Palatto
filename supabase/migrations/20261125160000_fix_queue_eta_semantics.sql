-- Recommendations are total time from queue entry, including the waiting line.
create or replace function public.create_order(
  p_customer text,
  p_notes text,
  p_items jsonb,
  p_takeaway boolean default false,
  p_prep_minutes integer default null,
  p_ask_kitchen boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  oid uuid;
  resolved jsonb;
  d date := (now() at time zone 'America/Guayaquil')::date;
  n integer;
  all_takeaway boolean;
  has_food boolean;
  queued public.orders;
  queue_until timestamptz := now();
  starts_at timestamptz;
  finishes_at timestamptz;
  own_minutes integer;
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
  if has_food and not coalesce(p_ask_kitchen,false) and (p_prep_minutes is null or p_prep_minutes not between 1 and 240) then
    raise exception 'Indica un tiempo de preparación entre 1 y 240 minutos.';
  end if;
  if not has_food then p_prep_minutes := null; p_ask_kitchen := false; end if;
  select coalesce(bool_and((i->>'takeaway_quantity')::integer >= (i->>'quantity')::integer),false)
    into all_takeaway from jsonb_array_elements(resolved) i;

  if has_food and not coalesce(p_ask_kitchen,false) then
    perform pg_advisory_xact_lock(81003);
    for queued in select * from public.orders where not paid and status='en_proceso' order by created_at loop
      if queued.ready_at>now() then
        queue_until := greatest(queue_until,queued.ready_at);
      elsif queued.prep_requested or queued.accepted_at is null then
        select coalesce(max(p.prep_minutes),10) into own_minutes from jsonb_array_elements(queued.items) i
          join public.products p on p.id=(i->>'product_id')::uuid where not coalesce((i->>'is_drink')::boolean,false);
        queue_until := queue_until + make_interval(mins=>coalesce(own_minutes,10));
      end if;
    end loop;
    select coalesce(max(p.prep_minutes),10) into own_minutes from jsonb_array_elements(resolved) i
      join public.products p on p.id=(i->>'product_id')::uuid where not coalesce((i->>'is_drink')::boolean,false);
    finishes_at := greatest(queue_until+make_interval(mins=>coalesce(own_minutes,10)),now()+make_interval(mins=>p_prep_minutes));
    starts_at := greatest(queue_until,finishes_at-make_interval(mins=>coalesce(own_minutes,10)));
    p_prep_minutes := greatest(1,ceil(extract(epoch from (finishes_at-now()))/60)::integer);
  end if;

  insert into public.orders(number,order_day,customer,notes,items,created_by,takeaway,prep_minutes,prep_requested,accepted_at,ready_at)
    values(n,d,trim(p_customer),left(coalesce(p_notes,''),2000),resolved,auth.uid(),all_takeaway,
      case when p_ask_kitchen then null else p_prep_minutes end,p_ask_kitchen,starts_at,finishes_at)
    returning id into oid;
  return oid;
end $$;

create or replace function public.kitchen_accept_order(p_id uuid,p_version integer,p_prep_minutes integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; queued public.orders; new_ready timestamptz; base_start timestamptz := now(); own_minutes integer; queued_minutes integer;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede aceptar pedidos.'; end if;
  if p_prep_minutes is null or p_prep_minutes not between 1 and 240 then raise exception 'El tiempo debe estar entre 1 y 240 minutos.'; end if;
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid or o.status<>'en_proceso' or o.accepted_at is not null or not o.prep_requested then raise exception 'Este pedido ya fue aceptado o no espera una estimación de cocina.'; end if;
  for queued in select * from public.orders where not paid and status='en_proceso' and id<>p_id and created_at<=o.created_at order by created_at loop
    if queued.ready_at>now() then
      base_start := greatest(base_start,queued.ready_at);
    elsif queued.prep_requested or queued.accepted_at is null then
      select coalesce(max(p.prep_minutes),10) into queued_minutes from jsonb_array_elements(queued.items) i
        join public.products p on p.id=(i->>'product_id')::uuid where not coalesce((i->>'is_drink')::boolean,false);
      base_start := base_start + make_interval(mins=>coalesce(queued_minutes,10));
    end if;
  end loop;
  select coalesce(max(p.prep_minutes),10) into own_minutes from jsonb_array_elements(o.items) i
    join public.products p on p.id=(i->>'product_id')::uuid where not coalesce((i->>'is_drink')::boolean,false);
  new_ready := greatest(base_start+make_interval(mins=>coalesce(own_minutes,10)),now()+make_interval(mins=>p_prep_minutes));
  p_prep_minutes := greatest(1,ceil(extract(epoch from (new_ready-now()))/60)::integer);
  update public.orders set accepted_at=greatest(base_start,new_ready-make_interval(mins=>coalesce(own_minutes,10))),prep_minutes=p_prep_minutes,ready_at=new_ready,prep_requested=false,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data) values(p_id,auth.uid(),'Pedido aceptado · listo en '||p_prep_minutes||' min',to_jsonb(o),jsonb_build_object('accepted_at',greatest(base_start,new_ready-make_interval(mins=>coalesce(own_minutes,10))),'ready_at',new_ready,'prep_minutes',p_prep_minutes));
end $$;

notify pgrst,'reload schema';
