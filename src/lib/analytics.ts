import type { Business, Method, Movement, Order, OrderPayment, Product } from './domain'

export type RangeKey = 'hoy' | 'ayer' | '7d' | 'mes' | 'todo'

export const rangeLabels: Record<RangeKey, string> = {
  hoy: 'Hoy',
  ayer: 'Ayer',
  '7d': '7 días',
  mes: 'Este mes',
  todo: 'Todo',
}

export const TZ = 'America/Guayaquil'

/** Calendar day (YYYY-MM-DD) in the restaurant timezone. */
export function dayKey(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

/** Hour of day (0-23) in the restaurant timezone. */
export function hourInTz(value: string | Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const hour = parts.find(part => part.type === 'hour')?.value ?? '0'
  return Number(hour) % 24
}

export function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

export function rangeDays(range: RangeKey, now = new Date()): string[] {
  const today = dayKey(now)
  if (range === 'hoy') return [today]
  if (range === 'ayer') return [shiftDay(today, -1)]
  if (range === '7d') return Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6))
  if (range === 'mes') {
    const start = `${today.slice(0, 7)}-01`
    const days: string[] = []
    for (let day = start; day <= today; day = shiftDay(day, 1)) days.push(day)
    return days
  }
  return []
}

/** First ledger movement per order is when the customer paid. */
export function paymentTimes(movements: Movement[]): Map<string, string> {
  const times = new Map<string, string>()
  for (const movement of movements) {
    if (!movement.order_id) continue
    const current = times.get(movement.order_id)
    if (!current || movement.created_at < current) times.set(movement.order_id, movement.created_at)
  }
  return times
}

export function paidDate(order: Order, paidAt?: Map<string, string>): string {
  return paidAt?.get(order.id) || order.created_at
}

export function ordersInRange(orders: Order[], range: RangeKey, now = new Date(), paidAt?: Map<string, string>): Order[] {
  const paid = orders.filter(order => order.paid)
  if (range === 'todo') return paid
  const allowed = new Set(rangeDays(range, now))
  return paid.filter(order => allowed.has(dayKey(paidDate(order, paidAt))))
}

export interface ProductSales {
  productId: string
  name: string
  business: Business
  category: string
  quantity: number
  revenue: number
}

export interface BusinessSales {
  revenue: number
  orders: number
  items: number
}

export interface MethodSales {
  revenue: number
  orders: number
}

export interface HourSales {
  hour: number
  revenue: number
  orders: number
}

export interface DailySales {
  day: string
  revenue: number
  orders: number
}

export interface Analytics {
  orders: number
  revenue: number
  itemsSold: number
  averageTicket: number
  byBusiness: Record<Business, BusinessSales>
  byMethod: Record<Method, MethodSales>
  byHour: HourSales[]
  byProduct: ProductSales[]
  byCategory: { category: string; quantity: number; revenue: number }[]
  peakHour: HourSales | null
}

export function analyze(orders: Order[], products: Product[], range: RangeKey, now = new Date(), paidAt?: Map<string, string>, payments: OrderPayment[] = []): Analytics {
  const selected = ordersInRange(orders, range, now, paidAt)
  const categoryByProduct = new Map(products.map(product => [product.id, product.category || 'General']))
  const splitByOrder = new Map<string, OrderPayment[]>()
  for (const payment of payments) {
    const list = splitByOrder.get(payment.order_id) || []
    list.push(payment)
    splitByOrder.set(payment.order_id, list)
  }

  const byBusiness: Record<Business, BusinessSales> = {
    palatto: { revenue: 0, orders: 0, items: 0 },
    carreta: { revenue: 0, orders: 0, items: 0 },
  }
  const byMethod: Record<Method, MethodSales> = {
    efectivo: { revenue: 0, orders: 0 },
    transferencia: { revenue: 0, orders: 0 },
  }
  const methodOrders: Record<Method, Set<string>> = { efectivo: new Set(), transferencia: new Set() }
  const byHour: HourSales[] = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, orders: 0 }))
  const productMap = new Map<string, ProductSales>()
  const categoryMap = new Map<string, { category: string; quantity: number; revenue: number }>()
  let revenue = 0
  let itemsSold = 0

  for (const order of selected) {
    const orderRevenue = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
    revenue += orderRevenue
    const split = splitByOrder.get(order.id)
    if (split?.length) {
      for (const payment of split) {
        byMethod[payment.method].revenue += payment.amount
        methodOrders[payment.method].add(order.id)
      }
    } else if (order.method) {
      byMethod[order.method].revenue += orderRevenue
      methodOrders[order.method].add(order.id)
    }
    const hour = hourInTz(paidDate(order, paidAt))
    byHour[hour].revenue += orderRevenue
    byHour[hour].orders += 1
    const seenBusinesses = new Set<Business>()
    for (const item of order.items) {
      const lineRevenue = item.price * item.quantity
      itemsSold += item.quantity
      const business = byBusiness[item.business]
      business.revenue += lineRevenue
      business.items += item.quantity
      seenBusinesses.add(item.business)

      const category = categoryByProduct.get(item.product_id) || 'Otros'
      const productRow = productMap.get(item.product_id) || {
        productId: item.product_id,
        name: item.name,
        business: item.business,
        category,
        quantity: 0,
        revenue: 0,
      }
      productRow.quantity += item.quantity
      productRow.revenue += lineRevenue
      productMap.set(item.product_id, productRow)

      const categoryRow = categoryMap.get(category) || { category, quantity: 0, revenue: 0 }
      categoryRow.quantity += item.quantity
      categoryRow.revenue += lineRevenue
      categoryMap.set(category, categoryRow)
    }
    for (const business of seenBusinesses) byBusiness[business].orders += 1
  }

  const validHours = byHour.filter(hour => hour.revenue > 0)
  byMethod.efectivo.orders = methodOrders.efectivo.size
  byMethod.transferencia.orders = methodOrders.transferencia.size
  const peakHour = validHours.length
    ? validHours.reduce((best, hour) => (hour.revenue > best.revenue ? hour : best))
    : null

  return {
    orders: selected.length,
    revenue,
    itemsSold,
    averageTicket: selected.length ? Math.round(revenue / selected.length) : 0,
    byBusiness,
    byMethod,
    byHour,
    byProduct: [...productMap.values()].sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity),
    byCategory: [...categoryMap.values()].sort((a, b) => b.revenue - a.revenue),
    peakHour,
  }
}

/** Revenue and orders for the last `days` calendar days, oldest first, zero-filled. */
export function dailyTrend(orders: Order[], days = 14, now = new Date(), paidAt?: Map<string, string>): DailySales[] {
  const keys = Array.from({ length: days }, (_, i) => shiftDay(dayKey(now), i - (days - 1)))
  const index = new Map(keys.map((day, i) => [day, i]))
  const series = keys.map(day => ({ day, revenue: 0, orders: 0 }))
  for (const order of orders) {
    if (!order.paid) continue
    const position = index.get(dayKey(paidDate(order, paidAt)))
    if (position === undefined) continue
    series[position].revenue += order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
    series[position].orders += 1
  }
  return series
}

export function peakHourLabel(hour: number): string {
  const start = String(hour).padStart(2, '0')
  const end = String((hour + 1) % 24).padStart(2, '0')
  return `${start}:00 – ${end}:00`
}

export function salesCsv(orders: Order[], products: Product[], range: RangeKey, now = new Date(), paidAt?: Map<string, string>, payments: OrderPayment[] = []): string {
  const categoryByProduct = new Map(products.map(product => [product.id, product.category || 'General']))
  const splitOrders = new Set(payments.map(payment => payment.order_id))
  const rows = [['Fecha', 'Hora', 'Pedido', 'Cliente', 'Negocio', 'Categoria', 'Producto', 'Cantidad', 'Precio unitario', 'Total', 'Pago']]
  for (const order of ordersInRange(orders, range, now, paidAt)) {
    const paidTime = paidDate(order, paidAt)
    const date = dayKey(paidTime)
    const time = new Intl.DateTimeFormat('es-EC', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(paidTime))
    for (const item of order.items) {
      rows.push([
        date,
        time,
        String(order.number),
        order.customer,
        item.business === 'palatto' ? 'Palatto' : 'Aguas y colas',
        categoryByProduct.get(item.product_id) || 'Otros',
        item.name,
        String(item.quantity),
        (item.price / 100).toFixed(2),
        ((item.price * item.quantity) / 100).toFixed(2),
        splitOrders.has(order.id) ? 'Dividido' : order.method === 'transferencia' ? 'Transferencia' : 'Efectivo',
      ])
    }
  }
  return rows.map(row => row.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\r\n')
}
