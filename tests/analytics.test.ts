import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, dailyTrend, dayKey, hourInTz, paymentTimes, peakHourLabel, rangeDays, salesCsv } from '../src/lib/analytics.ts'
import type { Item, Order, Product } from '../src/lib/domain'

const products: Product[] = [
  { id: 'p1', name: 'Hamburguesa', price: 700, business: 'palatto', category: 'Comida', active: true },
  { id: 'p2', name: 'Sorbete', price: 200, business: 'carreta', category: 'Postres', active: true },
]
const item = (product: Product, quantity: number, price = product.price): Item => ({
  product_id: product.id,
  name: product.name,
  price,
  quantity,
  business: product.business,
})
let counter = 0
function order(at: string, items: Item[], paid = true, method: 'efectivo' | 'transferencia' = 'efectivo'): Order {
  counter += 1
  return {
    id: `o${counter}`,
    number: counter,
    customer: `Mesa ${counter}`,
    notes: '',
    items,
    status: paid ? 'completado' : 'en_proceso',
    paid,
    method: paid ? method : null,
    receipt: null,
    created_at: at,
    version: 1,
  }
}

test('Analítica: zona horaria de Ecuador y rangos de días', () => {
  assert.equal(dayKey('2026-11-11T02:00:00.000Z'), '2026-11-10')
  assert.equal(dayKey('2026-11-11T15:30:00.000Z'), '2026-11-11')
  assert.equal(hourInTz('2026-11-11T15:30:00.000Z'), 10)
  assert.deepEqual(rangeDays('hoy', new Date('2026-11-11T15:00:00Z')), ['2026-11-11'])
  assert.deepEqual(rangeDays('7d', new Date('2026-11-11T15:00:00Z')), [
    '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11',
  ])
  assert.deepEqual(rangeDays('mes', new Date('2026-11-03T15:00:00Z')), ['2026-11-01', '2026-11-02', '2026-11-03'])
  assert.equal(peakHourLabel(20), '20:00 – 21:00')
})

test('Analítica: ventas, negocios, medios de pago, productos y picos por hora', () => {
  const orders = [
    order('2026-11-11T15:10:00Z', [item(products[0], 2), item(products[1], 1)]), // 10:10 Ecuador
    order('2026-11-11T23:40:00Z', [item(products[0], 1, 750)], true, 'transferencia'), // 18:40
    order('2026-11-11T23:50:00Z', [item(products[1], 3)]), // 18:50
    order('2026-11-11T16:00:00Z', [item(products[0], 5)], false), // no cobrado, se ignora
    order('2026-11-10T15:00:00Z', [item(products[0], 9)]), // ayer
  ]
  const today = analyze(orders, products, 'hoy', new Date('2026-11-12T04:00:00Z'))
  assert.equal(today.orders, 3)
  assert.equal(today.revenue, 700 * 2 + 200 + 750 + 200 * 3)
  assert.equal(today.itemsSold, 7)
  assert.equal(today.averageTicket, Math.round(today.revenue / 3))
  assert.deepEqual(today.byBusiness.palatto, { revenue: 2150, orders: 2, items: 3 })
  assert.deepEqual(today.byBusiness.carreta, { revenue: 800, orders: 2, items: 4 })
  assert.deepEqual(today.byMethod.efectivo, { revenue: 2200, orders: 2 })
  assert.deepEqual(today.byMethod.transferencia, { revenue: 750, orders: 1 })
  assert.equal(today.byProduct[0].name, 'Hamburguesa')
  assert.equal(today.byProduct[0].quantity, 3)
  assert.equal(today.byProduct[0].category, 'Comida')
  assert.equal(today.byCategory[0].revenue, 2150)
  assert.equal(today.peakHour?.hour, 10)
  assert.equal(today.byHour[10].revenue, 1600)
  assert.equal(today.byHour[18].revenue, 1350)
  assert.equal(analyze(orders, products, 'todo', new Date('2026-11-12T04:00:00Z')).orders, 4)
  assert.equal(analyze(orders, products, 'ayer', new Date('2026-11-12T04:00:00Z')).revenue, 6300)
})

test('Analítica: la venta cuenta el día y la hora en que se cobró', () => {
  const late = order('2026-11-12T04:30:00Z', [item(products[0], 1)]) // 23:30 del 11
  const paidAt = paymentTimes([
    { id: 'm1', business: 'palatto', amount: 700, method: 'efectivo', reason: 'Cobro de pedido', order_id: late.id, created_at: '2026-11-12T05:30:00Z' }, // 00:30 del 12
  ])
  const now = new Date('2026-11-12T18:00:00Z')
  assert.equal(analyze([late], products, 'hoy', now).orders, 0)
  const today = analyze([late], products, 'hoy', now, paidAt)
  assert.equal(today.orders, 1)
  assert.equal(today.peakHour?.hour, 0)
  assert.equal(dailyTrend([late], 2, now, paidAt)[1].revenue, 700)
  assert.equal(dailyTrend([late], 2, now, paidAt)[0].revenue, 0)
})

test('Analítica: el total ajustado se refleja en ventas, cajas y CSV', () => {
  const adjusted = order('2026-11-11T15:10:00Z', [item(products[0], 2), item(products[1], 1)])
  adjusted.adjustment = -100
  adjusted.adjustment_reason = 'Descuento acordado'
  const today = analyze([adjusted], products, 'hoy', new Date('2026-11-12T04:00:00Z'))
  assert.equal(today.revenue, 1500)
  assert.deepEqual(today.byBusiness.palatto, { revenue: 1313, orders: 1, items: 2 })
  assert.deepEqual(today.byBusiness.carreta, { revenue: 187, orders: 1, items: 1 })
  assert.equal(today.byHour[10].revenue, 1500)
  const csv = salesCsv([adjusted], products, 'hoy', new Date('2026-11-11T18:00:00Z'))
  assert.match(csv, /Ajuste de total/)
  assert.match(csv, /Descuento acordado/)
  assert.match(csv, /"-1.00"/)
})

test('Analítica: tendencia diaria y exportación CSV', () => {
  const orders = [order('2026-11-11T15:10:00Z', [item(products[0], 2), item(products[1], 1)])]
  const trend = dailyTrend(orders, 3, new Date('2026-11-11T18:00:00Z'))
  assert.deepEqual(trend.map(day => day.day), ['2026-11-09', '2026-11-10', '2026-11-11'])
  assert.deepEqual(trend.map(day => day.revenue), [0, 0, 1600])
  const csv = salesCsv(orders, products, 'hoy', new Date('2026-11-11T18:00:00Z'))
  assert.match(csv, /"2026-11-11"/)
  assert.match(csv, /"Hamburguesa","2"/)
  assert.match(csv, /"14.00"/)
  assert.match(csv, /"Transferencia"|"Efectivo"/)
})
