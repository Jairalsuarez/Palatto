import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync,readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

test('Tarifas para llevar: precios del servidor, cantidades, cobros y correcciones',async()=>{
 const db=new PGlite()
 try {
 await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
 alter table storage.objects enable row level security;
 grant usage on schema auth,public,storage to authenticated;grant select,insert on storage.objects to authenticated;
 create publication supabase_realtime;`)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.exec(readFileSync(new URL(f,dir),'utf8'))
 const user='00000000-0000-0000-0000-000000000001',a='10000000-0000-0000-0000-000000000001',b='10000000-0000-0000-0000-000000000002'
 await db.query('insert into auth.users values($1)',[user]);await db.query("insert into profiles(id,name,role) values($1,'Admin','superadmin')",[user])
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated')
 await db.query("select save_product($1,'Producto A',300,'palatto','Comida',true,null,50)",[a])
 await db.query("select save_product($1,'Producto B',200,'carreta','Bebida',true,null,0)",[b])
 await assert.rejects(db.query("select save_product($1,'Producto A',300,'palatto','Comida',true,null,-1)",[a]),/check constraint/)
 const items=JSON.stringify([{product_id:a,quantity:2,price:1,takeaway_fee:0},{product_id:b,quantity:1,takeaway_fee:999}])
 const {rows}=await db.query<{id:string}>("select create_order('Pedido','',$1::jsonb,true) as id",[items]);const id=rows[0].id
 async function order(){return (await db.query<{items:{price:number;takeaway_fee:number}[];takeaway:boolean;version:number;status:string;paid:boolean}>('select items,takeaway,version,status,paid from orders where id=$1',[id])).rows[0]}
 assert.deepEqual((await order()).items.map(i=>i.price),[350,200]);assert.equal((await order()).takeaway,true)
 assert.equal((await order()).status,'en_proceso');assert.equal((await order()).paid,false)
 await assert.rejects(db.query('select advance_order($1,1)',[id]),/does not exist/)

 await assert.rejects(db.query("select pay_order($1,1,'efectivo',800)",[id]),/insuficiente/)
 await db.query("select pay_order($1,1,'efectivo',900)",[id])
 assert.equal((await order()).status,'completado');assert.equal((await order()).paid,true)
 await assert.rejects(db.query("select pay_order($1,2,'efectivo',900)",[id]),/ya está cobrado/)
 assert.deepEqual((await db.query('select business,amount from movements order by amount')).rows,[{business:'carreta',amount:200},{business:'palatto',amount:700}])
 await db.query("select save_product($1,'Producto A',400,'palatto','Comida',true,null,75)",[a])
 await db.query("select edit_order($1,2,'Pedido','',$2::jsonb,'Cambiar a servir',0,null,false)",[id,items])
 assert.deepEqual((await order()).items.map(i=>i.price),[300,200]);assert.equal((await order()).takeaway,false)
 assert.equal((await db.query<{amount:number}>('select amount from movements where amount<0')).rows[0].amount,-100)
 await db.query("select edit_order($1,3,'Pedido','',$2::jsonb,'Cambiar a llevar',100,null,true)",[id,items])
 assert.deepEqual((await order()).items.map(i=>i.price),[350,200])
 await db.query("select create_order('Pedido','',$1::jsonb,false)",[items])
 const latest=(await db.query<{items:{price:number}[]}>('select items from orders order by number desc limit 1')).rows[0]
 assert.deepEqual(latest.items.map(i=>i.price),[400,200])
 const second=(await db.query<{id:string}>("select create_order('Pedido','',$1::jsonb,false) as id",[items])).rows[0].id
 await db.query("select pay_order($1,1,'efectivo',1000)",[second])
 assert.equal((await db.query<{status:string}>('select status from orders where id=$1',[second])).rows[0].status,'completado')
 await db.exec('reset role');await assert.rejects(db.query("update orders set status='en_proceso' where id=$1",[second]),/check constraint/);await db.exec('set role authenticated')

 const transferOrder=(await db.query<{id:string}>("select create_order('Pedido','',$1::jsonb,false) as id",[items])).rows[0].id
 await assert.rejects(db.query("select pay_order($1,1,'transferencia',0)",[transferOrder]),/foto válida/)
 const receipt=user+'/transfer.jpg'
 await db.query("insert into storage.objects(bucket_id,name) values('receipts',$1)",[receipt])
 await db.query("select pay_order($1,1,'transferencia',0,$2)",[transferOrder,receipt])
 assert.deepEqual((await db.query('select method,status,receipt from orders where id=$1',[transferOrder])).rows,[{method:'transferencia',status:'completado',receipt}])
 assert.deepEqual((await db.query('select business,method,amount from movements where order_id=$1 order by amount',[transferOrder])).rows,[{business:'carreta',method:'transferencia',amount:200},{business:'palatto',method:'transferencia',amount:800}])
 const increased=JSON.stringify([{product_id:a,quantity:3},{product_id:b,quantity:2}])
 await db.query("select edit_order($1,2,'Pedido','',$2::jsonb,'Agrega productos',0,$3,false)",[transferOrder,increased,receipt])
 assert.deepEqual((await db.query("select business,method,amount from movements where order_id=$1 and reason like 'Corrección%' order by amount",[transferOrder])).rows,[{business:'carreta',method:'transferencia',amount:200},{business:'palatto',method:'transferencia',amount:400}])
 await db.query("select edit_order($1,3,'Pedido','',$2::jsonb,'Retira productos',0,$3,false)",[transferOrder,items,receipt])
 assert.equal(Number((await db.query<{balance:number}>("select sum(amount) as balance from movements where order_id=$1 and business='carreta'",[transferOrder])).rows[0].balance),200)
 assert.equal((await db.query("select id from movements where order_id=$1 and business='carreta' and method<>'transferencia'",[transferOrder])).rows.length,0)
 // The manual activation script can also be rerun safely after deployment.
 await db.exec('reset role;create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[])')
 const activation=readFileSync(new URL('../scripts/activate-order-statuses.sql',import.meta.url),'utf8')
 await db.exec(activation);await db.exec(activation)
 assert.equal((await db.query('select version from supabase_migrations.schema_migrations')).rows.length,2)
 await db.query("update profiles set role='visualizador' where id=$1",[user]);await db.exec('set role authenticated')
 await assert.rejects(db.query("select save_product($1,'Producto A',300,'palatto','Comida',true,null,50)",[a]),/Solo administración/)
 await assert.rejects(db.query("select create_order('Pedido','',$1::jsonb,true)",[items]),/permiso/)
 } finally {await db.close()}
})
