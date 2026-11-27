-- Link internal notifications with the record they refer to so the bell can
-- open the exact detail. Orders already use order_id; movements now also
-- expose their id to the client.
alter table public.notifications add column if not exists movement_id uuid;

-- cash_movement used to return void. Returning the new movement id lets the
-- client attach it to the notification without an extra round trip.
drop function if exists public.cash_movement(public.business, integer, public.payment_method, text, text, text);

create function public.cash_movement(
  p_business public.business,
  p_amount integer,
  p_method public.payment_method,
  p_reason text,
  p_kind text default null,
  p_receipt text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  balance bigint;
  kind text := nullif(trim(coalesce(p_kind,'')), '');
  movement_id uuid;
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
  values(p_business, p_amount, p_method, trim(p_reason), auth.uid(), kind, p_receipt)
  returning id into movement_id;

  return movement_id;
end $$;

revoke all on function public.cash_movement(public.business, integer, public.payment_method, text, text, text) from public, anon, authenticated;
grant execute on function public.cash_movement(public.business, integer, public.payment_method, text, text, text) to authenticated;

notify pgrst, 'reload schema';
