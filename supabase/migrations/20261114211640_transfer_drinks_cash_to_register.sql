-- Move accumulated beverage sales from the main cash register into its own ledger.
-- Both sides are recorded atomically and only in cash; transfers remain untouched.
create or replace function public.transfer_drinks_cash(
  p_amount integer,
  p_day text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  main_cash bigint;
  movement_transfer_id uuid := gen_random_uuid();
  reason text;
begin
  if not public.can_manage_cash('palatto'::public.business) then
    raise exception 'No tienes permiso para mover dinero de la caja principal.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then
    raise exception 'El importe para trasladar no es válido.';
  end if;
  if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'La fecha del traslado no es válida.';
  end if;

  perform pg_advisory_xact_lock(81001);
  select coalesce(sum(amount), 0)
    into main_cash
    from public.movements
   where business = 'palatto'::public.business
     and method = 'efectivo'::public.payment_method;

  if main_cash < p_amount then
    raise exception 'El efectivo disponible en la caja principal es insuficiente.';
  end if;

  reason := 'Separación aguas y colas · ' || p_day;
  insert into public.movements(transfer_id,business,amount,method,reason,actor,kind)
  values
    (movement_transfer_id,'palatto'::public.business,-p_amount,'efectivo'::public.payment_method,reason,auth.uid(),'transferencia'),
    (movement_transfer_id,'carreta'::public.business,p_amount,'efectivo'::public.payment_method,reason,auth.uid(),'transferencia');
end $$;

revoke all on function public.transfer_drinks_cash(integer,text) from public,anon,authenticated;
grant execute on function public.transfer_drinks_cash(integer,text) to authenticated;

notify pgrst,'reload schema';
