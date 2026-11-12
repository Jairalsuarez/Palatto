export type Role = 'superadmin' | 'administrador' | 'cocinero' | 'mesera' | 'visualizador'
export type Business = 'palatto' | 'carreta'
export type Method = 'efectivo' | 'transferencia'
export type MovementKind = 'ingreso' | 'gasto' | 'retiro' | 'cobro' | 'correccion' | 'transferencia'
export interface Profile { id: string; name: string; role: Role; active: boolean }
export interface Product { takeaway_fee?: number; image_path?: string | null; id: string; name: string; price: number; business: Business; category: string; active: boolean }
export interface Item { base_price?: number; takeaway_fee?: number; product_id: string; name: string; price: number; quantity: number; business: Business }
export interface Order { takeaway?: boolean; split_payment?: boolean; id: string; number: number; customer: string; notes: string; items: Item[]; status: 'en_proceso' | 'completado'; paid: boolean; method: Method | null; receipt: string | null; created_at: string; version: number }
export interface Shift { id: string; business: Business; opened_at: string; closed_at: string | null }
export interface Movement { id: string; business: Business; amount: number; method: Method; reason: string; kind: MovementKind; order_id: string | null; created_at: string; actor?: string }
export interface OrderPayment { id: string; order_id: string; label: string; items: Item[]; amount: number; method: Method; receipt: string | null; created_by: string; created_at: string }
export interface Audit { id: string; order_id: string; reason: string; created_at: string; actor: string }
export interface Data { products: Product[]; orders: Order[]; shifts: Shift[]; movements: Movement[]; order_payments: OrderPayment[]; profiles: Profile[]; audits: Audit[] }
export const roles: Role[] = ['superadmin', 'administrador', 'cocinero', 'mesera', 'visualizador']
export const labels: Record<Role, string> = { superadmin: 'Superadmin', administrador: 'Administrador', cocinero: 'Cocinero', mesera: 'Mesera', visualizador: 'Visualizador' }
export const businessLabel = (b: Business) => b === 'palatto' ? 'Palatto' : 'Aguas y colas'
export const registerLabel = (b: Business) => b === 'palatto' ? 'Caja principal' : 'Caja de aguas y colas'
export const money = (cents: number) => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(cents / 100)
export const cents = (value: string) => Math.round(Number(value) * 100)
export const total = (items: Item[], business?: Business) => items.filter(i => !business || i.business === business).reduce((sum, i) => sum + i.price * i.quantity, 0)
export const canWrite = (role: Role) => role !== 'visualizador'
export const canMenu = (role: Role) => ['superadmin', 'administrador'].includes(role)
export const canCash = (role: Role, _b: Business) => role === 'superadmin' || role === 'administrador'
export const isOpen = (_data: Data, _b: Business) => true
export const available = (data: Data) => data.products.filter(p => p.active)
export const canEdit = (role: Role, order: Order) => canWrite(role) && (role !== 'cocinero' || order.paid)
export function validatePayment(amount: number, method: Method, received: number, receipt: string | null) {
  if (method === 'efectivo' && amount > 0 && (!Number.isSafeInteger(received) || received < amount)) throw new Error('El efectivo recibido no cubre el importe.')
  if (method === 'transferencia' && !receipt) throw new Error('Sube la foto del comprobante antes de confirmar.')
}
export function split(items: Item[]) { return { palatto: total(items, 'palatto'), carreta: total(items, 'carreta') } }

export function priceForService(items: Item[], takeaway: boolean): Item[] { return items.map(item=>({...item,base_price:item.base_price??item.price,price:(item.base_price??item.price)+(takeaway?(item.takeaway_fee??0):0)})) }
