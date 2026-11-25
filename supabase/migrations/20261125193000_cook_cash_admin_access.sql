-- Allow the kitchen role to perform administration-like cash operations while
-- retaining its separate kitchen workflow and alert behavior.
create or replace function public.can_manage_cash(b public.business) returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce(
  public.current_app_role()='superadmin'
  or public.current_app_role()='administrador'
  or public.current_app_role()='cocinero'
  or (b='carreta' and public.current_app_role()='carreta'),
 false);
$$;

drop policy if exists read_cash_reconciliations on public.cash_reconciliations;
create policy read_cash_reconciliations on public.cash_reconciliations
  for select to authenticated using (public.current_app_role() in ('superadmin','administrador','cocinero'));

create or replace function public.reconcile_cash(p_id uuid,p_counted_cash integer,p_counted_transfer integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_cash integer; v_transfer integer;
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador','cocinero'),true) then
    raise exception 'Solo administración puede cuadrar la caja.';
  end if;
  if p_id is null or p_counted_cash is null or p_counted_cash < 0 or p_counted_transfer is null or p_counted_transfer < 0 then
    raise exception 'Ingresa saldos contados válidos.';
  end if;
  perform pg_advisory_xact_lock(81001);
  select coalesce(sum(amount) filter (where method='efectivo'),0)::integer,
         coalesce(sum(amount) filter (where method='transferencia'),0)::integer
    into v_cash,v_transfer
    from public.movements where business='palatto';
  insert into public.cash_reconciliations(id,business,cash_balance,transfer_balance,counted_cash,counted_transfer,reconciled_by)
    values(p_id,'palatto',v_cash,v_transfer,p_counted_cash,p_counted_transfer,auth.uid());
  return jsonb_build_object('id',p_id,'cash_balance',v_cash,'transfer_balance',v_transfer);
end $$;
revoke all on function public.reconcile_cash(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.reconcile_cash(uuid,integer,integer) to authenticated;

create or replace function public.toggle_shift(p_business public.business) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.shifts; r public.app_role := public.current_app_role();
begin
  if r is null or not(r in ('superadmin','cocinero') or (p_business='palatto' and r='administrador')) then
    raise exception 'No tienes permiso para este turno.';
  end if;
  perform pg_advisory_xact_lock(81001);
  select * into s from public.shifts where business=p_business and closed_at is null for update;
  if found then
    if exists(select 1 from public.orders o where not o.paid and exists(select 1 from jsonb_array_elements(o.items) i where i->>'business'=p_business::text)) then
      raise exception 'Cobra los pedidos de este negocio antes de cerrar.';
    end if;
    update public.shifts set closed_at=now(),closed_by=auth.uid() where id=s.id;
  else
    insert into public.shifts(business,opened_by) values(p_business,auth.uid());
  end if;
end $$;
