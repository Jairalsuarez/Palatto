import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const ids = {
  superadmin: '00000000-0000-0000-0000-000000000001',
  administrador: '00000000-0000-0000-0000-000000000002',
  cocinero: '00000000-0000-0000-0000-000000000003',
  mesera: '00000000-0000-0000-0000-000000000004',
  visualizador: '00000000-0000-0000-0000-000000000005',
  carreta: '00000000-0000-0000-0000-000000000006',
}
const burger = '10000000-0000-0000-0000-000000000001'
const drink = '10000000-0000-0000-0000-000000000002'
const mixedItems = JSON.stringify([{ product_id: burger, quantity: 2 }, { product_id: drink, quantity: 1 }])
const burgerItems = JSON.stringify([{ product_id: burger, quantity: 2 }])

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

test('Un solo negocio con dos cajas, pagos divididos y movimientos diferenciados', async t => {
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
  await db.query("select save_product($1,'Hamburguesa',350,'palatto','Comida',true,null,50)", [burger])
  await db.query("select save_product($1,'Agua de coco',200,'palatto','Sorbetes',true)", [drink])

  await t.test('Las aguas y colas se registran aparte del negocio principal', async () => {
    assert.equal(await scalar('select business from products where id=$1', [drink]), 'carreta')
  })

  await t.test('Los productos activos se venden sin abrir turno', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 1','Sin cebolla',$1::jsonb)", [mixedItems])
    assert.ok(order)
  })

  await t.test('Los precios y cantidades vienen del servidor', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 2','',$1::jsonb,true)", [JSON.stringify([{ product_id: burger, quantity: 2, price: 1 }, { product_id: drink, quantity: 1, takeaway_fee: 999 }])])
    const items = await scalar('select items from orders where id=$1', [order]) as { price: number; takeaway_fee: number }[]
    assert.deepEqual(items.map(item => item.price), [400, 200])
    assert.equal(items[0].takeaway_fee, 50)
  })

  await t.test('Cada rol administra solo su caja', async () => {
    const customers = { cocinero: 'Cocinero', mesera: 'Mesera', visualizador: 'Visor' } as const
    for (const [role, reason] of Object.entries(customers)) {
      await user(role as keyof typeof ids)
      await assert.rejects(db.query("select cash_movement('palatto',100,'efectivo',$1)", [reason]), /permiso/)
    }
    await user('carreta')
    await db.query("select cash_movement('carreta',100,'efectivo','Fondo de aguas y colas')")
    await assert.rejects(db.query("select cash_movement('palatto',100,'efectivo','Fondo')"), /permiso/)
    await user('administrador')
    await db.query("select cash_movement('palatto',100,'efectivo','Fondo de caja')")
    await db.query("select cash_movement('carreta',100,'efectivo','Fondo de bebidas')")
  })

  await t.test('Gasto, retiro e ingreso quedan registrados con su tipo', async () => {
    await user('administrador')
    await db.query("select cash_movement('palatto',900,'efectivo','Fondo extra','ingreso')")
    await db.query("select cash_movement('palatto',-150,'efectivo','Compra de pan','gasto')")
    await db.query("select cash_movement('palatto',-250,'efectivo','Retiro del dueño','retiro')")
    assert.deepEqual((await db.query("select kind,amount from movements where business='palatto' and order_id is null order by amount desc")).rows, [
      { kind: 'ingreso', amount: 900 },
      { kind: 'ingreso', amount: 100 },
      { kind: 'gasto', amount: -150 },
      { kind: 'retiro', amount: -250 },
    ])
    await assert.rejects(db.query("select cash_movement('palatto',-99999,'efectivo','Retiro excesivo','retiro')"), /supera el saldo/)
  })

  await t.test('El cobro completo separa caja principal y aguas y colas', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 3','',$1::jsonb)", [mixedItems])
    await db.query("select pay_order($1,1,'efectivo',1000)", [order])
    assert.equal(await scalar('select status from orders where id=$1', [order]), 'completado')
    assert.deepEqual((await db.query("select business,amount,kind from movements where order_id=$1 order by amount", [order])).rows, [
      { business: 'carreta', amount: 200, kind: 'cobro' },
      { business: 'palatto', amount: 700, kind: 'cobro' },
    ])
    await assert.rejects(db.query("select pay_order($1,2,'efectivo',1000)", [order]), /ya está cobrado/)
  })

  await t.test('La caja de aguas y colas acepta transferencia', async () => {
    await user('carreta')
    await db.query("select cash_movement('carreta',175,'transferencia','Venta por transferencia','ingreso')")
    assert.equal(await scalar("select amount from movements where business='carreta' and method='transferencia' and order_id is null"), 175)
  })

  await t.test('La cuenta se divide por persona sin crear otro pedido', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 4','',$1::jsonb)", [burgerItems])
    await db.query("select add_split_payment($1,1,'Ana',$2::jsonb,'efectivo',400)", [order, JSON.stringify([{ product_id: burger, quantity: 1 }])])
    assert.equal(await scalar('select paid from orders where id=$1', [order]), false)
    assert.equal(await scalar('select split_payment from orders where id=$1', [order]), true)
    await db.query("select add_split_payment($1,2,'Luis',$2::jsonb,'efectivo',400)", [order, JSON.stringify([{ product_id: burger, quantity: 1 }])])
    assert.equal(await scalar('select paid from orders where id=$1', [order]), true)
    assert.equal(await scalar('select status from orders where id=$1', [order]), 'completado')
    assert.equal(await scalar('select count(*)::integer from order_payments where order_id=$1', [order]), 2)
    assert.equal(await scalar('select sum(amount)::integer from movements where order_id=$1', [order]), 700)
    assert.equal(await scalar('select count(*)::integer from orders'), 4)
  })

  await t.test('Un pedido con pagos divididos no se cobra, edita ni elimina por otra vía', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 5','',$1::jsonb)", [burgerItems])
    await db.query("select add_split_payment($1,1,'Ana',$2::jsonb,'efectivo',400)", [order, JSON.stringify([{ product_id: burger, quantity: 1 }])])
    await assert.rejects(db.query("select pay_order($1,2,'efectivo',400)", [order]), /pagos divididos/)
    await assert.rejects(db.query("select edit_order($1,2,'Mesa 5','',$2::jsonb,'Cambio',0,null,false)", [order, burgerItems]), /pagos divididos/)
    await assert.rejects(db.query("select delete_order($1,2,'Cliente se fue')", [order]), /cobros registrados|pagos divididos/)
    assert.equal(await scalar('select paid from orders where id=$1', [order]), false)
  })

  await t.test('Las transferencias entre cajas son solo del superadmin', async () => {
    const transferId = '20000000-0000-0000-0000-000000000001'
    for (const role of ['administrador', 'carreta', 'mesera', 'cocinero', 'visualizador'] as const) {
      await user(role)
      await assert.rejects(db.query("select transfer_cash($1,'palatto',100,'efectivo','Cambio de caja')", [transferId]), /Solo Superadmin/)
    }
    await user('superadmin')
    const before = await scalar('select sum(amount)::integer from movements')
    await db.query("select transfer_cash($1,'palatto',100,'efectivo','Cambio de caja')", [transferId])
    assert.equal(await scalar('select sum(amount)::integer from movements'), before)
    assert.deepEqual((await db.query('select amount from movements where transfer_id=$1 order by amount', [transferId])).rows, [{ amount: -100 }, { amount: 100 }])
    await assert.rejects(db.query("select transfer_cash($1,'palatto',100,'efectivo','Cambio de caja')", [transferId]), /ya fue registrada/)
  })

  await t.test('El visualizador solo consulta', async () => {
    await user('visualizador')
    assert.ok(Number(await scalar('select count(*)::integer from orders')) > 0)
    await assert.rejects(db.query("select create_order('Mesa 6','',$1::jsonb)", [mixedItems]), /permiso/)
    await assert.rejects(db.exec('update orders set paid=false'), /permission denied/)
    await assert.rejects(db.exec("update profiles set role='superadmin'"), /permission denied/)
  })

  await t.test('Un comprobante es obligatorio para transferencias', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa 6','',$1::jsonb)", [burgerItems])
    await assert.rejects(db.query("select pay_order($1,1,'transferencia',0)", [order]), /foto válida/)
  })

  await t.test('El cobro ajusta el total con motivo y reparte proporcionalmente', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa ajuste','',$1::jsonb)", [mixedItems])
    await assert.rejects(db.query("select pay_order($1,1,'efectivo',800,null,800,null)", [order]), /motivo del ajuste/)
    await db.query("select pay_order($1,1,'efectivo',800,null,800,'Descuento acordado')", [order])
    assert.equal(await scalar('select adjustment from orders where id=$1', [order]), -100)
    assert.equal(await scalar('select adjustment_reason from orders where id=$1', [order]), 'Descuento acordado')
    assert.deepEqual((await db.query('select business,amount from movements where order_id=$1 order by amount', [order])).rows, [
      { business: 'carreta', amount: 178 },
      { business: 'palatto', amount: 622 },
    ])
    assert.equal(await scalar('select sum(amount)::integer from movements where order_id=$1', [order]), 800)
  })

  await t.test('El cobro acepta un recargo y mantiene el reparto', async () => {
    await user('mesera')
    const order = await scalar("select create_order('Mesa recargo','',$1::jsonb)", [mixedItems])
    const receipt = `${ids.mesera}/comprobante-recargo.jpg`
    await db.query("insert into storage.objects(bucket_id,name) values('receipts',$1)", [receipt])
    await db.query("select pay_order($1,1,'transferencia',0,$2,950,'Servicio adicional')", [order, receipt])
    assert.equal(await scalar('select adjustment from orders where id=$1', [order]), 50)
    assert.deepEqual((await db.query('select business,amount from movements where order_id=$1 order by amount', [order])).rows, [
      { business: 'carreta', amount: 211 },
      { business: 'palatto', amount: 739 },
    ])
  })
})
