export type Role = 'superadmin' | 'administrador' | 'cocinero' | 'mesera' | 'mesero' | 'visualizador'
export type Business = 'palatto' | 'carreta'
export type Method = 'efectivo' | 'transferencia'
export type MovementKind = 'ingreso' | 'gasto' | 'retiro' | 'cobro' | 'correccion' | 'transferencia'
export interface Profile { id: string; name: string; role: Role; active: boolean; email?: string; must_change_password?: boolean }
export interface Product { takeaway_fee?: number; image_path?: string | null; id: string; name: string; price: number; business: Business; category: string; active: boolean; is_drink?: boolean }
export interface Item { base_price?: number; takeaway_fee?: number; takeaway_quantity?: number; is_drink?: boolean; product_id: string; name: string; price: number; quantity: number; business: Business }
export interface Order { takeaway?: boolean; split_payment?: boolean; order_day?: string; paid_at?: string | null; adjustment?: number; adjustment_reason?: string | null; id: string; number: number; customer: string; notes: string; items: Item[]; status: 'en_proceso' | 'completado'; paid: boolean; method: Method | null; receipt: string | null; created_at: string; version: number }
export interface Shift { id: string; business: Business; opened_at: string; closed_at: string | null }
export interface Movement { id: string; business: Business; amount: number; method: Method; reason: string; kind: MovementKind; order_id: string | null; receipt?: string | null; created_at: string; actor?: string }
export interface OrderPayment { id: string; order_id: string; label: string; items: Item[]; amount: number; method: Method; receipt: string | null; created_by: string; created_at: string }
export interface Audit { id: string; order_id: string; reason: string; created_at: string; actor: string }
export interface Data { products: Product[]; orders: Order[]; shifts: Shift[]; movements: Movement[]; order_payments: OrderPayment[]; profiles: Profile[]; audits: Audit[] }
export const roles: Role[] = ['superadmin', 'administrador', 'cocinero', 'mesera', 'mesero', 'visualizador']
export const labels: Record<Role, string> = { superadmin: 'Superadmin', administrador: 'Administrador', cocinero: 'Cocinero', mesera: 'Mesera', mesero: 'Mesero', visualizador: 'Visualizador' }
export const businessLabel = (b: Business) => b === 'palatto' ? 'Palatto' : 'Aguas y colas'
export const registerLabel = (b: Business) => b === 'palatto' ? 'Caja principal' : 'Caja de aguas y colas'
export const money = (cents: number) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(cents / 100)
export const cents = (value: string) => Math.round(Number(value) * 100)
export const itemTotal = (item: Item) => item.price * item.quantity + (item.takeaway_fee || 0) * (item.takeaway_quantity || 0)
export const itemIsDrink = (item: Item) => Boolean(item.is_drink) || item.business === 'carreta'
export const total = (items: Item[], business?: Business) => items.filter(i => !business || i.business === business).reduce((sum, i) => sum + itemTotal(i), 0)
export const canWrite = (role: Role) => role !== 'visualizador'
export const canMenu = (role: Role) => ['superadmin', 'administrador'].includes(role)
export const canCash = (role: Role, _b: Business) => role === 'superadmin' || role === 'administrador'
export const isOpen = (_data: Data, _b: Business) => true
export const available = (data: Data) => data.products.filter(p => p.active)
export const canEdit = (role: Role, order: Order) => canWrite(role) && !order.paid
export function validatePayment(amount: number, method: Method, received: number, receipt: string | null) {
  if (method === 'efectivo' && amount > 0 && (!Number.isSafeInteger(received) || received < amount)) throw new Error('El efectivo recibido no cubre el importe.')
  if (method === 'transferencia' && !receipt) throw new Error('Sube la foto del comprobante antes de confirmar.')
}
export function split(items: Item[]) { return { palatto: total(items, 'palatto'), carreta: total(items, 'carreta') } }
export function orderTotal(order: Order) { return Math.max(0, total(order.items) + (order.adjustment || 0)) }
export function splitTotal(items: Item[], amount: number) {
  const base = split(items)
  const itemsTotal = base.palatto + base.carreta
  if (itemsTotal <= 0 || amount === itemsTotal) return base
  const palatto = Math.round(amount * base.palatto / itemsTotal)
  return { palatto, carreta: amount - palatto }
}
export function orderSplit(order: Order) { return splitTotal(order.items, orderTotal(order)) }

/** Keeps the base price and only changes how many units of a line are takeaway. */
export function priceForService(items: Item[], takeaway: boolean): Item[] {
  return items.map(item => ({
    ...item,
    base_price: item.base_price ?? item.price,
    takeaway_quantity: takeaway ? item.quantity : 0,
  }))
}

export function orderService(order: Order): string {
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0)
  const takeaway = order.items.reduce((sum, item) => sum + Math.min(item.quantity, item.takeaway_quantity || 0), 0)
  if (!takeaway) return 'Para servir'
  if (takeaway >= quantity) return 'Para llevar'
  return `${takeaway} de ${quantity} para llevar`
}

export function hasTakeawayItems(order: Order) {
  return order.items.some(item => (item.takeaway_quantity || 0) > 0)
}

