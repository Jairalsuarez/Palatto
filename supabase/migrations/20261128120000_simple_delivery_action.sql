-- Delivery is an explicit final action after payment. Keep preparation status
-- out of this transition so the order stays in the active list until handed off.
create or replace function public.deliver_order(p_id uuid,p_version integer) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.require_writer();
  select * into o from public.orders where id=p_id for update;
  if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza e inténtalo de nuevo.'; end if;
  if not o.paid then raise exception 'Cobra el pedido antes de marcarlo como entregado.'; end if;
  if o.delivered_at is not null then raise exception 'El pedido ya fue entregado.'; end if;
  update public.orders set delivered_at=now(),status='completado',version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
    values(p_id,auth.uid(),'Pedido entregado',to_jsonb(o),jsonb_build_object('delivered_at',now()));
end $$;
revoke all on function public.deliver_order(uuid,integer) from public,anon;
grant execute on function public.deliver_order(uuid,integer) to authenticated;
notify pgrst,'reload schema';
