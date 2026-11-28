create or replace function public.update_profile_name(p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare cleaned text := trim(coalesce(p_name,''));
begin
  if auth.uid() is null then raise exception 'Inicia sesión para cambiar el nombre.'; end if;
  if length(cleaned) not between 2 and 60 then raise exception 'El nombre debe tener entre 2 y 60 caracteres.'; end if;
  update public.profiles set name=cleaned where id=auth.uid() and active=true;
  if not found then raise exception 'No se encontró una cuenta activa para actualizar.'; end if;
end $$;
revoke all on function public.update_profile_name(text) from public,anon;
grant execute on function public.update_profile_name(text) to authenticated;

create or replace function public.set_order_pickup_code(p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare o public.orders; code text;
begin
  perform public.require_writer();
  select * into o from public.orders where id=p_id for update;
  if not found then raise exception 'El pedido no existe.'; end if;
  if o.created_by is distinct from auth.uid() and public.current_app_role() not in ('superadmin','administrador','cocinero') then
    raise exception 'Solo quien creó el pedido o cocina y administración pueden asignarle un código.';
  end if;
  if not exists(select 1 from jsonb_array_elements(o.items) i where coalesce((i->>'takeaway_quantity')::integer,0)>0) then
    raise exception 'El pedido no tiene productos para llevar.';
  end if;
  if o.security_code_enabled and o.security_code is not null then return o.security_code; end if;
  code:=lpad(floor(random()*100)::integer::text,2,'0');
  update public.orders set security_code_enabled=true,security_code=code,version=version+1 where id=p_id;
  insert into public.audits(order_id,actor,reason,before_data,after_data)
    values(p_id,auth.uid(),'Código de retiro asignado',to_jsonb(o),jsonb_build_object('security_code_enabled',true));
  return code;
end $$;
revoke all on function public.set_order_pickup_code(uuid) from public,anon;
grant execute on function public.set_order_pickup_code(uuid) to authenticated;
notify pgrst,'reload schema';
