-- A cook's rejection cancels and archives the waiting order, removing it from the active list.
create or replace function public.kitchen_reject_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; amount integer;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede rechazar solicitudes.'; end if;
  perform pg_advisory_xact_lock(81001);
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid or o.status<>'en_proceso' or o.accepted_at is not null or not o.prep_requested then raise exception 'La solicitud ya no está pendiente.'; end if;
  if exists(select 1 from public.movements where order_id=p_id) or exists(select 1 from public.order_payments where order_id=p_id) then
    raise exception 'El pedido tiene movimientos o pagos y no se puede cancelar desde cocina.';
  end if;
  select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer
      + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0)
    into amount from jsonb_array_elements(o.items) i;
  insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by)
    values(o.id,o.number,o.customer,o.items,amount,'Rechazado y cancelado por cocina',auth.uid());
  delete from public.audits where order_id=p_id;
  delete from public.orders where id=p_id;
end $$;

-- Remove rejections created by the previous response behavior as well.
do $$
declare o public.orders; amount integer;
begin
  perform pg_advisory_xact_lock(81001);
  perform pg_advisory_xact_lock(81003);
  for o in select * from public.orders where prep_rejected and not paid order by created_at for update loop
    if exists(select 1 from public.movements where order_id=o.id) or exists(select 1 from public.order_payments where order_id=o.id) then
      continue;
    end if;
    select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer
        + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)),0)
      into amount from jsonb_array_elements(o.items) i;
    insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by)
      values(o.id,o.number,o.customer,o.items,amount,'Rechazado y cancelado por cocina',o.created_by);
    delete from public.audits where order_id=o.id;
    delete from public.orders where id=o.id;
  end loop;
end $$;

revoke all on function public.kitchen_reject_order(uuid,integer) from public,anon,authenticated;
grant execute on function public.kitchen_reject_order(uuid,integer) to authenticated;
notify pgrst,'reload schema';
