import type { Method } from './lib/domain'
import { PichinchaMark } from './PichinchaMark'

export function PaymentMethodIcon({ method }: { method: Method }) {
  return method === 'efectivo'
    ? <span className="method-emoji" aria-hidden="true">💵</span>
    : <PichinchaMark/>
}

export function PaymentMethodTag({ method, label = true, className = '' }: { method: Method; label?: boolean; className?: string }) {
  return <span className={`method-tag ${method} ${className}`.trim()}>
    <PaymentMethodIcon method={method}/>
    {label && <span>{method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</span>}
  </span>
}
