-- Historical entries remain intact; all new Carreta entries must use cash.
create function public.enforce_carreta_cash() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.business='carreta' and new.method<>'efectivo' then
  raise exception 'La Carreta solo acepta efectivo. Cobra las órdenes que incluyen Carreta en efectivo.';
 end if;
 return new;
end $$;
revoke all on function public.enforce_carreta_cash() from public,anon,authenticated;
create trigger carreta_cash_only before insert on public.movements
for each row execute function public.enforce_carreta_cash();
