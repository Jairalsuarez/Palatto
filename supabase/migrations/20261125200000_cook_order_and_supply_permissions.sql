-- Give kitchen staff the same order and supply workflows as service staff,
-- while keeping menu and team administration restricted to administrators.
do $$
declare
  item record;
  definition text;
  updated_definition text;
  replacements integer := 0;
begin
  for item in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('create_order','edit_order','delete_order','pay_order','add_split_payment')
  loop
    definition := pg_get_functiondef(item.oid);
    updated_definition := definition;
    if item.proname='create_order' then
      updated_definition := replace(updated_definition,
        'public.current_app_role() is distinct from ''superadmin'' then',
        'public.current_app_role() is distinct from ''superadmin'' and public.current_app_role() is distinct from ''cocinero'' then');
    else
      updated_definition := replace(updated_definition,
        '(''mesera'',''mesero'',''administrador'',''superadmin'')',
        '(''mesera'',''mesero'',''administrador'',''superadmin'',''cocinero'')');
    end if;
    if updated_definition is distinct from definition then
      execute updated_definition;
      replacements := replacements + 1;
    end if;
  end loop;
  if replacements <> 5 then
    raise exception 'Se esperaban actualizar 5 funciones de pedidos; se actualizaron %.', replacements;
  end if;
end $$;
notify pgrst,'reload schema';
