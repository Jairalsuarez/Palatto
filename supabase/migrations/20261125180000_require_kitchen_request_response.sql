-- Keep a kitchen request pending until the cook accepts or rejects it.
alter table public.orders add column if not exists prep_rejected boolean not null default false;

create or replace function public.kitchen_reject_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  if public.current_app_role() is distinct from 'cocinero' then raise exception 'Solo cocina puede rechazar solicitudes.'; end if;
  perform pg_advisory_xact_lock(81003);
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
  if o.paid or o.status<>'en_proceso' or o.accepted_at is not null or not o.prep_requested then raise exception 'La solicitud ya no está pendiente.'; end if;
  update public.orders set prep_requested=false,prep_rejected=true,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
    values(p_id,auth.uid(),'Solicitud de tiempo rechazada',to_jsonb(o),jsonb_build_object('prep_requested',false,'prep_rejected',true));
end $$;

revoke all on function public.kitchen_reject_order(uuid,integer) from public,anon,authenticated;
grant execute on function public.kitchen_reject_order(uuid,integer) to authenticated;

create or replace function public.guard_pending_kitchen_request_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.prep_requested and public.current_app_role() is distinct from 'cocinero' then
    if tg_op='DELETE' then raise exception 'Espera la respuesta de cocina antes de eliminar este pedido.'; end if;
    if new.paid is distinct from old.paid or new.method is distinct from old.method or new.receipt is distinct from old.receipt
       or new.items is distinct from old.items or new.customer is distinct from old.customer or new.notes is distinct from old.notes
       or new.adjustment is distinct from old.adjustment or new.status is distinct from old.status then
      raise exception 'Espera la respuesta de cocina antes de cambiar o cobrar este pedido.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists guard_pending_kitchen_request_changes on public.orders;
create trigger guard_pending_kitchen_request_changes before update or delete on public.orders
  for each row execute function public.guard_pending_kitchen_request_changes();

create or replace function public.guard_pending_kitchen_split_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.orders where id=new.order_id and prep_requested) then
    raise exception 'Espera la respuesta de cocina antes de cobrar este pedido.';
  end if;
  return new;
end $$;

drop trigger if exists guard_pending_kitchen_split_payment on public.order_payments;
create trigger guard_pending_kitchen_split_payment before insert or update on public.order_payments
  for each row execute function public.guard_pending_kitchen_split_payment();

revoke all on function public.guard_pending_kitchen_request_changes() from public,anon,authenticated;
revoke all on function public.guard_pending_kitchen_split_payment() from public,anon,authenticated;
notify pgrst,'reload schema';
