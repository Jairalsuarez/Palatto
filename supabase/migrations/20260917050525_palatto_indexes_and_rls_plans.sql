-- Avoid repeated auth lookups per row; index the foreign-key relationships.
alter policy read_profiles on public.profiles using (id=(select auth.uid()) or (select public.current_app_role())='superadmin');
alter policy read_products on public.products using ((select public.current_app_role()) is not null);
alter policy read_shifts on public.shifts using ((select public.current_app_role()) is not null);
alter policy read_orders on public.orders using ((select public.current_app_role()) is not null);
alter policy read_movements on public.movements using ((select public.current_app_role()) is not null);
alter policy read_audits on public.audits using ((select public.current_app_role()) is not null);
create index shifts_opened_by_idx on public.shifts(opened_by);
create index shifts_closed_by_idx on public.shifts(closed_by);
create index orders_created_by_idx on public.orders(created_by);
create index movements_actor_idx on public.movements(actor);
create index movements_order_id_idx on public.movements(order_id);
create index movements_shift_id_idx on public.movements(shift_id);
create index audits_actor_idx on public.audits(actor);
