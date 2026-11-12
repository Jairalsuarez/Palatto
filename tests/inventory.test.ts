import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

test('Inventario de insumos: stock, permisos y movimientos', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
    alter table storage.objects enable row level security;
    grant usage on schema auth,public,storage to authenticated;
    grant select,insert on storage.objects to authenticated;
    create publication supabase_realtime;`)
    const dir = new URL('../supabase/migrations/', import.meta.url)
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(file, dir), 'utf8'))

    const admin = '00000000-0000-0000-0000-000000000001'
    const viewer = '00000000-0000-0000-0000-000000000002'
    await db.query('insert into auth.users values($1),($2)', [admin, viewer])
    await db.query("insert into profiles(id,name,role) values($1,'Admin','superadmin'),($2,'Lector','visualizador')", [admin, viewer])

    async function user(id: string) {
      await db.exec('reset role')
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
      await db.exec('set role authenticated')
    }
    async function scalar(sql: string, args: unknown[] = []) {
      const { rows } = await db.query<Record<string, unknown>>(sql, args)
      return Object.values(rows[0])[0]
    }

    await user(admin)
    const meat = await scalar("select save_supply(null::uuid,'Carne de res','Carnes','kg'::public.supply_unit,4,750,true)")
    const potato = await scalar("select save_supply(null::uuid,'Papa','Verduras','kg'::public.supply_unit,5,120,true)")
    assert.ok(meat && potato)
    assert.equal(Number(await scalar('select stock from supplies where id=$1', [meat])), 0)

    await db.query("select register_supply_movement($1,'entrada',12.5,'Compra semanal')", [meat])
    await db.query("select register_supply_movement($1,'salida',4.25,'Consumo del turno')", [meat])
    assert.equal(Number(await scalar('select stock from supplies where id=$1', [meat])), 8.25)
    await db.query("select register_supply_movement($1,'ajuste',8,'Conteo físico')", [meat])
    assert.equal(Number(await scalar('select stock from supplies where id=$1', [meat])), 8)
    assert.equal(await scalar('select count(*)::integer from supply_movements'), 3)

    await assert.rejects(db.query("select register_supply_movement($1,'salida',99,'Consumo del turno')", [meat]), /suficiente stock/)
    await assert.rejects(db.query("select register_supply_movement($1,'entrada',0,'Compra')", [meat]), /mayor a cero/)
    await assert.rejects(db.query("select register_supply_movement($1,'entrada',1,'ok')", [meat]), /motivo/)
    await assert.rejects(db.query("select save_supply(null::uuid,'carne de res','Carnes','kg'::public.supply_unit,4,700,true)"), /Ya existe/)

    await user(viewer)
    assert.equal(await scalar('select count(*)::integer from supplies'), 2)
    await assert.rejects(db.query("select save_supply(null::uuid,'Queso','Lácteos','kg'::public.supply_unit,1,500,true)"), /permiso/)
    await assert.rejects(db.query("select register_supply_movement($1,'salida',1,'Consumo')", [meat]), /permiso/)
    await assert.rejects(db.exec("update supplies set stock=999"), /permission denied/)
    await assert.rejects(db.query("insert into supply_movements(supply_id,kind,quantity,reason,actor) values($1,'entrada',1,'x',$2)", [meat, viewer]), /permission denied/)

    await user(admin)
    await db.query("select save_supply($1::uuid,'Carne de res','Carnes','kg'::public.supply_unit,10,800,false)", [meat])
    assert.equal(Number(await scalar('select min_stock from supplies where id=$1', [meat])), 10)
    assert.equal(await scalar('select active from supplies where id=$1', [meat]), false)
    assert.equal(Number(await scalar('select stock from supplies where id=$1', [meat])), 8)
  } finally {
    await db.close()
  }
})
