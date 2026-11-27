import { Fragment } from 'react'
import { Banknote, ChevronRight, Download, Image as ImageIcon, Timer, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { displayNumber, displayNumericText, money, orderService, orderTotal } from './lib/domain'
import type { Method, Movement, Order, OrderPayment } from './lib/domain'
import { receiptName } from './lib/receipts'
import type { ReceiptPhoto } from './lib/receipts'
import { PaymentMethodTag } from './PaymentMethodTag'

const number = (n: number) => displayNumber(n)
const time = (value: string) => displayNumericText(new Date(value).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }))

function PrepClock({ order }: { order: Order }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (!order.ready_at) return null
  const start = new Date(order.created_at).getTime()
  const end = new Date(order.ready_at).getTime()
  const duration = Math.max(1, end - start)
  const remaining = end - now
  const progress = Math.max(0, Math.min(1, remaining / duration))
  const seconds = Math.max(0, Math.ceil(remaining / 1000))
  const label = remaining > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Listo'
  return <span className={`prep-clock-group ${remaining <= 5 * 60_000 ? 'is-near' : ''} ${remaining <= 0 ? 'is-ready' : ''}`} role="img" aria-label={remaining > 0 ? `Quedan ${label} para que esté listo` : 'Tiempo estimado cumplido'}>
    <span className="prep-clock" aria-hidden="true"><svg className="prep-clock-ring" viewBox="0 0 40 40"><circle className="prep-clock-track" cx="20" cy="20" r="17"/><circle className="prep-clock-progress" cx="20" cy="20" r="17" style={{ strokeDashoffset: `${107 * (1 - progress)}` }}/></svg><Timer className="prep-clock-icon" size={15}/></span>
    <span className="prep-clock-reading"><b>{label}</b><small>{remaining > 0 ? 'restantes' : 'estimado cumplido'}</small></span>
  </span>
}

export function OrderList({
  orders,
  canPay,
  payments,
  movements = [],
  open,
  pay,
  openPhoto,
  downloadPhoto,
}: {
  orders: Order[]
  canPay: boolean
  payments: OrderPayment[]
  movements?: Movement[]
  open: (order: Order) => void
  pay: (order: Order) => void
  openPhoto?: (photo: ReceiptPhoto) => void
  downloadPhoto?: (path: string, filename: string) => void
}) {
  const completed = orders.length > 0 && orders.every(order => order.paid)
  const dateKey = (order: Order) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(order.paid_at || order.created_at))
  const dateLabel = (order: Order) => displayNumericText(new Date(order.paid_at || order.created_at).toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }))

  return <ul className="order-list" aria-label="Pedidos por orden de llegada">
    {orders.map((order, index) => {
      const separator = completed && (index === 0 || dateKey(orders[index - 1]) !== dateKey(order))
      const items = order.items.reduce((count, item) => count + item.quantity, 0)
      const summary = order.items.map(item => `${displayNumber(item.quantity)} × ${item.name}`).join(' · ')
      const payable = !order.paid && canPay && !order.prep_requested && !order.prep_rejected
      const split = payments.filter(payment => payment.order_id === order.id)
      const splitPaid = split.reduce((sum, payment) => sum + payment.amount, 0)
      const orderValue = orderTotal(order)
      const remaining = Math.max(0, orderValue - splitPaid)
      const movementMethods = movements
        .filter(movement => movement.order_id === order.id && movement.kind === 'cobro')
        .map(movement => movement.method)
      const methods = Array.from(new Set<Method>(order.paid
        ? (split.length
          ? split.map(payment => payment.method)
          : order.method
            ? [order.method]
            : movementMethods)
        : []))
      const receiptEntries: ReceiptPhoto[] = []
      if (order.receipt) {
        receiptEntries.push({
          path: order.receipt,
          title: `Pedido #${number(order.number)}`,
          subtitle: `${order.customer} · ${money(orderValue)}`,
          name: receiptName(order.receipt, `comprobante-pedido-${order.number}`),
        })
      }
      for (const payment of split) {
        if (!payment.receipt) continue
        receiptEntries.push({
          path: payment.receipt,
          title: `Pedido #${number(order.number)} · ${payment.label}`,
          subtitle: `${money(payment.amount)} · Transferencia`,
          name: receiptName(payment.receipt, `comprobante-pedido-${order.number}-${payment.label}`),
        })
      }
      const singlePhoto = receiptEntries.length === 1 ? receiptEntries[0] : null
      return <Fragment key={order.id}>
        {separator && <li className="order-date-separator"><span>{dateLabel(order)}</span></li>}
        <li className={`order-card ${order.paid ? 'paid' : ''}`}>
        <button type="button" className="order-card-main" onClick={() => open(order)} aria-label={`Ver pedido #${number(order.number)}`}>
          <span className="order-top">
            <span className="order-number">#{number(order.number)}</span>
            <span className={`chip ${order.paid ? 'chip-done' : 'chip-live'}`}>
              <i aria-hidden="true"/>{order.paid ? 'Cobrado' : 'En proceso'}
            </span>
            <ChevronRight size={18} className="order-chevron" aria-hidden="true"/>
          </span>
          <span className="order-meta">
            {orderService(order)} · {time(order.created_at)} · {displayNumber(items)} artículo{items === 1 ? '' : 's'}{!order.paid && order.status === 'completado' ? ' · Listo para entregar' : ''}
          </span>
          {order.paid && (methods.length > 0 || receiptEntries.length > 0) && <span className="order-payment-line">
            {methods.map(method => <PaymentMethodTag key={method} method={method}/>)}
            {receiptEntries.length > 0 && <span className="order-photo-flag"><ImageIcon size={13} aria-hidden="true"/>{receiptEntries.length > 1 ? `${displayNumber(receiptEntries.length)} fotos` : 'Con foto'}</span>}
          </span>}
          {!order.paid && order.ready_at && <span className="order-prep-line"><span>Listo {time(order.ready_at)}{order.prep_minutes ? ` · estimado ${order.prep_minutes} min` : ''}</span><PrepClock order={order}/></span>}
          {order.prep_requested && <span className="order-request-status">Esperando respuesta de cocina · acciones bloqueadas</span>}
          {order.prep_rejected && <span className="order-request-rejected">Cocina rechazó el pedido. No se cobrará ni preparará.</span>}
          <span className="order-items">{summary}</span>
          {order.notes && <span className="order-note-line">{order.notes}</span>}
          {!!split.length && <span className="order-split-line"><Users size={14} aria-hidden="true"/>{displayNumber(split.length)} {split.length === 1 ? 'pago' : 'pagos'} · falta {money(remaining)}</span>}
        </button>
        <div className="order-foot">
          <span className="order-total">{money(orderValue)}</span>
          {order.prep_requested
            ? <span className="order-waiting-action">Esperando cocina</span>
            : order.prep_rejected
            ? <span className="order-waiting-action">Rechazado por cocina</span>
            : payable
            ? <button type="button" className="btn btn-money btn-sm" onClick={() => pay(order)}>
                <Banknote size={17} aria-hidden="true"/>{split.length ? 'Cobrar resto' : 'Cobrar'}
              </button>
            : <div className="order-foot-actions">
                {singlePhoto && openPhoto && <button type="button" className="order-photo-btn" onClick={() => openPhoto(singlePhoto)} aria-label={`Ver foto del pedido #${number(order.number)}`}>
                  <ImageIcon size={14} aria-hidden="true"/><span>Foto</span>
                </button>}
                {singlePhoto && downloadPhoto && <button type="button" className="order-photo-btn is-icon" onClick={() => downloadPhoto(singlePhoto.path, singlePhoto.name)} aria-label={`Descargar foto del pedido #${number(order.number)}`} title="Descargar foto">
                  <Download size={14} aria-hidden="true"/>
                </button>}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(order)}>
                  Ver<ChevronRight size={16} aria-hidden="true"/>
                </button>
              </div>}
        </div>
        </li>
      </Fragment>
    })}
  </ul>
}
