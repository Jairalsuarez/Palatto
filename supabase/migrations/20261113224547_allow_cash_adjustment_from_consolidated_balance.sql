-- The main cash screen shows a consolidated balance across both businesses.
-- Validate expenses and withdrawals against that same per-method balance.
create or replace function public.cash_movement(
  p_business public.business,
  p_amount integer,
  p_method public.payment_method,
  p_reason text,
  p_kind text default null,
  p_receipt text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  balance bigint;
  kind text := nullif(trim(coalesce(p_kind,'')), '');
begin
  if not public.can_manage_cash(p_business) then
    raise exception 'No tienes permiso para ajustar esta caja.';
  end if;

  perform pg_advisory_xact_lock(81001);

  if p_amount is null or p_amount = 0 or abs(p_amount::bigint) > 100000000 then
    raise exception 'Importe inválido.';
  end if;
  if kind is null then kind := case when p_amount > 0 then 'ingreso' else 'gasto' end; end if;
  if kind not in ('ingreso','gasto','retiro') then
    raise exception 'Tipo de movimiento inválido.';
  end if;
  if kind = 'ingreso' and p_amount < 0 then
    raise exception 'El ingreso debe ser un importe positivo.';
  end if;
  if kind in ('gasto','retiro') and p_amount > 0 then
    raise exception 'El gasto o retiro debe ser un importe negativo.';
  end if;

  select coalesce(sum(amount), 0)
    into balance
    from public.movements
   where method = p_method
     and (p_business = 'palatto' or business = p_business);

  if balance + p_amount < 0 then
    raise exception 'El retiro supera el saldo disponible de ese medio de pago.';
  end if;

  if p_receipt is not null then perform public.check_receipt(p_receipt); end if;

  insert into public.movements(business, amount, method, reason, actor, kind, receipt)
  values(p_business, p_amount, p_method, trim(p_reason), auth.uid(), kind, p_receipt);
end $$;
