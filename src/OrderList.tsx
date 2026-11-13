import { Fragment } from 'react'
import { Banknote, ChevronRight, Users } from 'lucide-react'
import { money, orderService, orderTotal } from './lib/domain'
import type { Order, OrderPayment } from './lib/domain'

const number = (n: number) => String(n)
const time = (value: string) => new Date(value).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })

export function OrderList({ orders, canPay, payments, open, pay }: { orders: Order[]; canPay: boolean; payments: OrderPayment[]; open: (order: Order) => void; pay: (order: Order) => void }) {
  const completed = orders.length > 0 && orders.every(order => order.paid)
  const dateKey = (order: Order) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(order.paid_at || order.created_at))
  const dateLabel = (order: Order) => new Date(order.paid_at || order.created_at).toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return <ul className="order-list" aria-label="Pedidos por orden de llegada">
    {orders.map((order, index) => {
      const separator = completed && (index === 0 || dateKey(orders[index - 1]) !== dateKey(order))
      const items = order.items.reduce((count, item) => count + item.quantity, 0)
      const summary = order.items.map(item => `${item.quantity} × ${item.name}`).join(' · ')
      const payable = !order.paid && canPay
      const split = payments.filter(payment => payment.order_id === order.id)
      const splitPaid = split.reduce((sum, payment) => sum + payment.amount, 0)
      const orderValue = orderTotal(order)
      const remaining = Math.max(0, orderValue - splitPaid)
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
            {orderService(order)} · {time(order.created_at)} · {items} artículo{items === 1 ? '' : 's'}
          </span>
          <span className="order-items">{summary}</span>
          {order.notes && <span className="order-note-line">{order.notes}</span>}
          {!!split.length && <span className="order-split-line"><Users size={14} aria-hidden="true"/>{split.length} {split.length === 1 ? 'pago' : 'pagos'} · falta {money(remaining)}</span>}
        </button>
        <div className="order-foot">
          <span className="order-total">{money(orderValue)}</span>
          {payable
            ? <button type="button" className="btn btn-money btn-sm" onClick={() => pay(order)}>
                <Banknote size={17} aria-hidden="true"/>{split.length ? 'Cobrar resto' : 'Cobrar'}
              </button>
            : <button type="button" className="btn btn-ghost btn-sm" onClick={() => open(order)}>
                Ver<ChevronRight size={16} aria-hidden="true"/>
              </button>}
        </div>
        </li>
      </Fragment>
    })}
  </ul>
}
