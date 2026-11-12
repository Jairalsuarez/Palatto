-- Los pedidos sin cobrar pueden eliminarse. Queda un registro de lo eliminado.
create table if not exists public.deleted_orders (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null,
 order_number bigint not null,
 customer text not null,
 items jsonb not null,
 total integer not null,
 reason text not null check(length(trim(reason)) between 3 and 300),
 deleted_by uuid not null references public.profiles,
 created_at timestamptz not null default now()
);
create index if not exists deleted_orders_created on public.deleted_orders(created_at desc);
alter table public.deleted_orders enable row level security;
drop policy if exists read_deleted_orders on public.deleted_orders;
create policy read_deleted_orders on public.deleted_orders for select to authenticated
 using (public.current_app_role() in ('superadmin','administrador'));
revoke all on public.deleted_orders from anon,authenticated;
grant select on public.deleted_orders to authenticated;

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
 select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into amount from jsonb_array_elements(o.items) i;
 insert into public.deleted_orders(order_id,order_number,customer,items,total,reason,deleted_by)
 values(o.id,o.number,o.customer,o.items,amount,trim(p_reason),auth.uid());
 delete from public.audits where order_id=p_id;
 delete from public.orders where id=p_id;
end $$;
revoke all on function public.delete_order(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.delete_order(uuid,integer,text) to authenticated;
notify pgrst,'reload schema';
