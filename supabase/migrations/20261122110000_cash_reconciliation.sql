create table public.cash_reconciliations (
  id uuid primary key,
  business public.business not null default 'palatto' check (business = 'palatto'),
  cash_balance integer not null,
  transfer_balance integer not null,
  counted_cash integer not null check (counted_cash >= 0),
  counted_transfer integer not null check (counted_transfer >= 0),
  reconciled_by uuid not null references public.profiles(id),
  reconciled_at timestamptz not null default now()
);

create index cash_reconciliations_reconciled_at_idx on public.cash_reconciliations(reconciled_at desc);
alter table public.cash_reconciliations enable row level security;
create policy read_cash_reconciliations on public.cash_reconciliations
  for select to authenticated using (public.current_app_role() in ('superadmin','administrador','cocinero'));
revoke all on public.cash_reconciliations from anon, authenticated;
grant select on public.cash_reconciliations to authenticated;

create function public.reconcile_cash(p_id uuid,p_counted_cash integer,p_counted_transfer integer) returns jsonb
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
