create table public.cash_reconciliations (
  id uuid primary key,
  business public.business not null default 'palatto' check (business = 'palatto'),
  cash_balance integer not null,
  transfer_balance integer not null,
  reconciled_by uuid not null references public.profiles(id),
  reconciled_at timestamptz not null default now()
);

create index cash_reconciliations_reconciled_at_idx on public.cash_reconciliations(reconciled_at desc);
alter table public.cash_reconciliations enable row level security;
create policy read_cash_reconciliations on public.cash_reconciliations
  for select to authenticated using (public.current_app_role() in ('superadmin','administrador'));
revoke all on public.cash_reconciliations from anon, authenticated;
grant select on public.cash_reconciliations to authenticated;

create function public.reconcile_cash(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_cash integer; v_transfer integer;
begin
  if coalesce(public.current_app_role() not in ('superadmin','administrador'),true) then
    raise exception 'Solo administración puede cuadrar la caja.';
  end if;
  perform pg_advisory_xact_lock(81001);
  select coalesce(sum(amount) filter (where method='efectivo'),0)::integer,
         coalesce(sum(amount) filter (where method='transferencia'),0)::integer
    into v_cash,v_transfer
    from public.movements where business='palatto';
  insert into public.cash_reconciliations(id,business,cash_balance,transfer_balance,reconciled_by)
    values(p_id,'palatto',v_cash,v_transfer,auth.uid());
  return jsonb_build_object('id',p_id,'cash_balance',v_cash,'transfer_balance',v_transfer);
end $$;
revoke all on function public.reconcile_cash(uuid) from public,anon,authenticated;
grant execute on function public.reconcile_cash(uuid) to authenticated;
