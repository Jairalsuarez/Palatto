import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const ids = {
  superadmin: '00000000-0000-0000-0000-000000000001',
  mesera: '00000000-0000-0000-0000-000000000004',
  visualizador: '00000000-0000-0000-0000-000000000005',
}
const burger = '10000000-0000-0000-0000-000000000001'
const items = JSON.stringify([{ product_id: burger, quantity: 2 }])

async function user(role: keyof typeof ids) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids[role]])
  await db.exec('set role authenticated')
}
async function scalar(sql: string, args: unknown[] = []) {
  const { rows } = await db.query<Record<string, unknown>>(sql, args)
  return Object.values(rows[0])[0]
}

after(async () => { await db.close() })

test('Eliminar pedidos: permisos, motivo y rastro', async t => {
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

  const migrations = new URL('../supabase/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  }
  for (const [role, id] of Object.entries(ids)) {
    await db.query('insert into auth.users values($1)', [id])
    await db.query('insert into public.profiles(id,name,role) values($1,$2::text,$2::text::public.app_role)', [id, role])
  }

  await user('superadmin')
  await db.query("select save_product($1,'Hamburguesa',350,'palatto','Comida',true)", [burger])

  await user('mesera')
  const order = await scalar("select create_order('Mesa 9','',$1::jsonb)", [items])

  await t.test('El motivo es obligatorio', async () => {
    await assert.rejects(db.query("select delete_order($1,1,'x')", [order]), /motivo/)
  })

  await t.test('Una versión vieja no elimina el pedido', async () => {
    await assert.rejects(db.query("select delete_order($1,99,'Pedido cancelado')", [order]), /cambió/)
    assert.equal(await scalar('select count(*)::integer from orders'), 1)
  })

  await t.test('Un visualizador no puede eliminar', async () => {
    await user('visualizador')
    await assert.rejects(db.query("select delete_order($1,1,'Pedido cancelado')", [order]), /permiso/)
    assert.equal(await scalar('select count(*)::integer from orders'), 1)
  })

  await t.test('El pedido sin cobrar se elimina y queda registrado', async () => {
    await user('mesera')
    await db.query("select delete_order($1,1,'El cliente se fue')", [order])
    assert.equal(await scalar('select count(*)::integer from orders'), 0)
    // El rastro solo lo leen superadmin y administrador.
    await user('superadmin')
    assert.equal(await scalar('select count(*)::integer from deleted_orders'), 1)
    assert.equal(await scalar('select reason from deleted_orders'), 'El cliente se fue')
    assert.equal(await scalar('select total from deleted_orders'), 700)
  })

  await t.test('Un pedido cobrado no se elimina', async () => {
    await user('mesera')
    const paid = await scalar("select create_order('Mesa 10','',$1::jsonb)", [items])
    const version = await scalar('select version from orders where id=$1', [paid])
    await db.query("select pay_order($1,$2,'efectivo',1000)", [paid, version])
    const afterPay = await scalar('select version from orders where id=$1', [paid])
    await assert.rejects(db.query("select delete_order($1,$2,'Pedido cancelado')", [paid, afterPay]), /cobrado/)
    assert.equal(await scalar('select count(*)::integer from orders'), 1)
    await user('superadmin')
    assert.equal(await scalar('select count(*)::integer from deleted_orders'), 1)
  })
})
