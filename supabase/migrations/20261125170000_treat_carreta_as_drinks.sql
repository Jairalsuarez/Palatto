-- Carreta products are drinks for kitchen routing even if their legacy flag is false.
create or replace function public.resolve_items(
  p_items jsonb,
  p_previous jsonb default '[]'::jsonb,
  p_takeaway boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb := '[]';
  v jsonb;
  p public.products;
  old jsonb;
  qty integer;
  tq integer;
  base integer;
  fee integer;
  is_drink boolean;
begin
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Añade entre 1 y 100 productos.';
  end if;
  if (select count(*) from jsonb_array_elements(p_items)) <> (select count(distinct value->>'product_id') from jsonb_array_elements(p_items)) then
    raise exception 'Producto duplicado.';
  end if;
  for v in select * from jsonb_array_elements(p_items) loop
    qty := (v->>'quantity')::integer;
    if qty is null or qty not between 1 and 99 then raise exception 'Cantidad inválida.'; end if;
    select value into old from jsonb_array_elements(p_previous) where value->>'product_id'=v->>'product_id';
    select * into p from public.products where id=(v->>'product_id')::uuid;
    if not found then raise exception 'El producto no existe.'; end if;
    if (old is null or qty>(old->>'quantity')::integer) and not p.active then
      raise exception 'El producto no está disponible.';
    end if;
    base := coalesce((old->>'base_price')::integer,(old->>'price')::integer,p.price);
    fee := case when old is null then p.takeaway_fee else coalesce((old->>'takeaway_fee')::integer,p.takeaway_fee) end;
    tq := coalesce((v->>'takeaway_quantity')::integer, case when coalesce(p_takeaway,false) then qty else 0 end);
    if tq < 0 or tq > qty then raise exception 'Cantidad para llevar inválida.'; end if;
    is_drink := coalesce((v->>'is_drink')::boolean, (old->>'is_drink')::boolean, p.is_drink, false) or p.business='carreta';
    result := result || jsonb_build_array(jsonb_build_object(
      'product_id',p.id,
      'name',coalesce(old->>'name',p.name),
      'base_price',base,
      'takeaway_fee',fee,
      'takeaway_quantity',tq,
      'is_drink',is_drink,
      'price',base,
      'business',case when is_drink then 'carreta' else 'palatto' end,
      'quantity',qty
    ));
  end loop;
  return result;
end $$;

notify pgrst,'reload schema';
