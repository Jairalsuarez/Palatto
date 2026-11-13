-- Consolidación de una sola caja: se desactivan las transferencias entre cajas
-- y el histórico de pedidos eliminados calcula el total con la tarifa para llevar.

revoke all on function public.transfer_cash(uuid,public.business,integer,public.payment_method,text)
  from public,anon,authenticated;

create or replace function public.delete_order(p_id uuid,p_version integer,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders; amount integer;
begin
 perform public.require_writer();
 if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Escribe el motivo de la eliminación.'; end if;
 perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found then raise exception 'El pedido ya no existe.'; end if;
 if o.version<>p_version then raise exception 'El pedido cambió. Actualiza la pantalla e inténtalo de nuevo.'; end if;
 if o.paid then raise exception 'Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.'; end if;
 if exists(select 1 from public.movements where order_id=p_id) then raise exception 'El pedido tiene cobros registrados y no puede eliminarse.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then raise exception 'El pedido tiene pagos divididos y no puede eliminarse.'; end if;
 select coalesce(sum(
   (i->>'price')::integer*(i->>'quantity')::integer
   + coalesce((i->>'takeaway_fee')::integer,0)*coalesce((i->>'takeaway_quantity')::integer,0)
 ),0) into amount from jsonb_array_elements(o.items) i;
 insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by)
 values(o.id,o.number,o.customer,o.items,amount,trim(p_reason),auth.uid());
 delete from public.audits where order_id=p_id;
 delete from public.orders where id=p_id;
end $$;

revoke all on function public.delete_order(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.delete_order(uuid,integer,text) to authenticated;

notify pgrst,'reload schema';
