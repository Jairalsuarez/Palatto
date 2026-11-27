import { test } from 'node:test'
import assert from 'node:assert/strict'
import { receiptName } from '../src/lib/receipts.ts'
import { analyze } from '../src/lib/analytics.ts'
import type { Order, OrderPayment, Product } from '../src/lib/domain'

test('receiptName normalizes filenames and preserves extensions', () => {
  assert.equal(receiptName('user-1/abc-123.webp', 'Factura · Hielo y Café'), 'factura-hielo-y-cafe.webp')
  assert.equal(receiptName('user-1/xyz.png', 'comprobante-pedido-12'), 'comprobante-pedido-12.png')
  assert.equal(receiptName('noext', 'foto'), 'foto.noext')
})

test('analyze counts paid orders by efectivo and transferencia including split payments', () => {
  const products: Product[] = [
    { id: 'p1', name: 'Hamburguesa', price: 500, business: 'palatto', category: 'Comida', active: true },
  ]
  const orders: Order[] = [
    {
      id: 'o1', number: 1, customer: 'Mesa 1', notes: '',
      items: [{ product_id: 'p1', name: 'Hamburguesa', price: 500, quantity: 1, business: 'palatto' }],
      status: 'completado', paid: true, method: 'efectivo', receipt: null,
      created_at: '2026-11-27T15:00:00Z', paid_at: '2026-11-27T15:10:00Z', version: 1,
    },
    {
      id: 'o2', number: 2, customer: 'Mesa 2', notes: '',
      items: [{ product_id: 'p1', name: 'Hamburguesa', price: 500, quantity: 2, business: 'palatto' }],
      status: 'completado', paid: true, method: null, receipt: null,
      created_at: '2026-11-27T16:00:00Z', paid_at: '2026-11-27T16:20:00Z', version: 1,
    },
  ]
  const payments: OrderPayment[] = [
    {
      id: 'pay1', order_id: 'o2', label: 'Ana',
      items: [{ product_id: 'p1', name: 'Hamburguesa', price: 500, quantity: 1, business: 'palatto' }],
      amount: 500, method: 'efectivo', receipt: null, created_by: 'u1', created_at: '2026-11-27T16:15:00Z',
    },
    {
      id: 'pay2', order_id: 'o2', label: 'Luis',
      items: [{ product_id: 'p1', name: 'Hamburguesa', price: 500, quantity: 1, business: 'palatto' }],
      amount: 500, method: 'transferencia', receipt: 'u1/rec.jpg', created_by: 'u1', created_at: '2026-11-27T16:20:00Z',
    },
  ]

  const result = analyze(orders, products, 'hoy', new Date('2026-11-27T18:00:00Z'), undefined, payments)
  assert.equal(result.orders, 2)
  assert.equal(result.byMethod.efectivo.orders, 2)
  assert.equal(result.byMethod.efectivo.revenue, 1000)
  assert.equal(result.byMethod.transferencia.orders, 1)
  assert.equal(result.byMethod.transferencia.revenue, 500)
})
