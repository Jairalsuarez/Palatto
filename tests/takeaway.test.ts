import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

test('Tarifas para llevar: precios del servidor, una sola caja y numeración diaria', async () => {
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
    for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(new URL(file, dir), 'utf8'))
    }

    const user = '00000000-0000-0000-0000-000000000001'
    const a = '10000000-0000-0000-0000-000000000001'
    const b = '10000000-0000-0000-0000-000000000002'
    await db.query('insert into auth.users values($1)', [user])
    await db.query("insert into profiles(id,name,role) values($1,'Admin','superadmin')", [user])
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
    await db.exec('set role authenticated')

    await db.query("select save_product($1,'Producto A',300,true,false,null,50)", [a])
    await db.query("select save_product($1,'Producto B',200,true,true)", [b])
    await assert.rejects(db.query("select save_product($1,'Producto A',300,true,false,null,-1)", [a]), /tarifa/)

    const items = JSON.stringify([
      { product_id: a, quantity: 2, price: 1, takeaway_fee: 0 },
      { product_id: b, quantity: 1, takeaway_fee: 999 },
    ])
    const { rows } = await db.query<{ id: string }>("select create_order('Pedido','',$1::jsonb,true) as id", [items])
    const id = rows[0].id

    async function order(orderId = id) {
      return (await db.query<{
        items: { price: number; takeaway_fee: number; takeaway_quantity: number; is_drink: boolean }[]
        takeaway: boolean
        version: number
        status: string
        paid: boolean
        paid_at: string | null
      }>('select items,takeaway,version,status,paid,paid_at from orders where id=$1', [orderId])).rows[0]
    }

    assert.deepEqual((await order()).items.map(item => item.price), [300, 200])
    assert.deepEqual((await order()).items.map(item => item.takeaway_quantity), [2, 1])
    assert.deepEqual((await order()).items.map(item => item.is_drink), [false, true])
    assert.equal((await order()).takeaway, true)
    assert.equal((await order()).paid_at, null)

    await assert.rejects(db.query("select pay_order($1,1,'efectivo',800)", [id]), /insuficiente/)
    await db.query("select pay_order($1,1,'efectivo',900)", [id])
    assert.equal((await order()).status, 'completado')
    assert.equal((await order()).paid, true)
    assert.ok((await order()).paid_at)
    await assert.rejects(db.query("select pay_order($1,2,'efectivo',900)", [id]), /ya está cobrado/)
    assert.deepEqual((await db.query("select business,method,amount,kind from movements where order_id=$1", [id])).rows, [
      { business: 'palatto', method: 'efectivo', amount: 900, kind: 'cobro' },
    ])

    await editUnpaidOrder(db, a, b)

    const perLine = (await db.query<{ id: string }>("select create_order('Mesa 3','',$1::jsonb) as id", [
      JSON.stringify([{ product_id: a, quantity: 3, takeaway_quantity: 1 }]),
    ])).rows[0].id
    const perLineOrder = await order(perLine)
    assert.equal(perLineOrder.takeaway, false)
    assert.equal(perLineOrder.items[0].takeaway_quantity, 1)
    await assert.rejects(db.query("select create_order('Mesa 3','',$1::jsonb)", [
      JSON.stringify([{ product_id: a, quantity: 3, takeaway_quantity: 4 }]),
    ]), /para llevar/)

    const transferOrder = (await db.query<{ id: string }>("select create_order('Mesa 4','',$1::jsonb) as id", [items])).rows[0].id
    await assert.rejects(db.query("select pay_order($1,1,'transferencia',0)", [transferOrder]), /foto válida/)
    const receipt = `${user}/transfer.jpg`
    await db.query("insert into storage.objects(bucket_id,name) values('receipts',$1)", [receipt])
    await db.query("select pay_order($1,1,'transferencia',0,$2)", [transferOrder, receipt])
    assert.deepEqual((await db.query('select business,method,amount from movements where order_id=$1', [transferOrder])).rows, [
      { business: 'palatto', method: 'transferencia', amount: 800 },
    ])

    // Cambiar el precio del menú no altera pedidos históricos ni pedidos ya creados.
    await db.query("select save_product($1,'Producto A',400,true,false,null,75)", [a])
    const latest = (await db.query<{ items: { price: number; takeaway_fee: number }[] }>(
      "select items from orders where id=$1", [transferOrder],
    )).rows[0]
    assert.deepEqual(latest.items.map(item => item.price), [300, 200])
    const fresh = (await db.query<{ id: string }>("select create_order('Mesa 5','',$1::jsonb,true) as id", [
      JSON.stringify([{ product_id: a, quantity: 1 }]),
    ])).rows[0].id
    assert.deepEqual((await order(fresh)).items.map(item => [item.price, item.takeaway_fee]), [[400, 75]])

    await db.exec('reset role')
    await db.query("update profiles set role='visualizador' where id=$1", [user])
    await db.exec('set role authenticated')
    await assert.rejects(db.query("select save_product($1,'Producto A',300,true,false,null,50)", [a]), /Solo administración/)
    await assert.rejects(db.query("select create_order('Pedido','',$1::jsonb,true)", [items]), /permiso/)
  } finally {
    await db.close()
  }
})

async function editUnpaidOrder(db: PGlite, a: string, b: string) {
  const items = JSON.stringify([{ product_id: a, quantity: 2 }, { product_id: b, quantity: 1 }])
  const editable = (await db.query<{ id: string }>("select create_order('Mesa 2','',$1::jsonb) as id", [items])).rows[0].id
  await assert.rejects(
    db.query("select edit_order($1,1,'Mesa 2','',$2::jsonb,'x')", [editable, items]),
    /motivo/,
  )
  await db.query(
    "select edit_order($1,1,'Mesa 2','',$2::jsonb,'Cambio a llevar',0,null,null)",
    [editable, JSON.stringify([{ product_id: a, quantity: 2, takeaway_quantity: 2 }, { product_id: b, quantity: 1 }])],
  )
  const edited = (await db.query<{ items: { price: number; takeaway_quantity: number }[]; takeaway: boolean; version: number }>(
    'select items,takeaway,version from orders where id=$1', [editable],
  )).rows[0]
  assert.equal(edited.version, 2)
  assert.equal(edited.takeaway, false)
  assert.equal(edited.items[0].takeaway_quantity, 2)
  await db.query(
    "select edit_order($1,2,'Mesa 2','',$2::jsonb,'Solo llevar',0,null,null)",
    [editable, JSON.stringify([{ product_id: a, quantity: 2, takeaway_quantity: 2 }])],
  )
  const only = (await db.query<{ takeaway: boolean }>('select takeaway from orders where id=$1', [editable])).rows[0]
  assert.equal(only.takeaway, true)
}
