import { useMemo, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { Modal } from './Modal'
import type { FormEvent } from 'react'
import type { Restaurant } from './lib/useRestaurant'
import { canWrite, cents, money } from './lib/domain'
import { useInventory } from './lib/inventory'
import type { Supply, SupplyPurchaseInput } from './lib/inventory'

function AddSupplyExpense({ supplies, onSave, close }: { supplies: Supply[]; onSave: (input: SupplyPurchaseInput) => Promise<boolean>; close: () => void }) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [paid, setPaid] = useState(false)
  const [method, setMethod] = useState<'efectivo' | 'transferencia'>('efectivo')
  const value = cents(amount)
  const supply = supplies.find(item => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase() && item.active)
  return <Modal title="Agregar insumo" close={close}>
    <form className="form-stack" onSubmit={async (event: FormEvent) => {
      event.preventDefault()
      if (value <= 0 || !name.trim()) return
      if (await onSave({ supply_id: supply?.id || '', supply_name: name.trim(), quantity: 1, unit_cost: value, supplier: '', paid, payment_method: paid ? method : null, received: false })) close()
    }}>
      <label>Título<input autoFocus required maxLength={120} list="supply-name-options" value={name} onChange={event => setName(event.target.value)} placeholder="Ej. Papa"/></label>
      <datalist id="supply-name-options">{supplies.filter(item => item.active).map(item => <option key={item.id} value={item.name}/>)}</datalist>
      <label>Valor ($)<input required type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00"/></label>
      {paid && <label>Se pagó con<select value={method} onChange={event => setMethod(event.target.value as 'efectivo' | 'transferencia')}><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>}
      <label className="check-row"><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)}/>Ya está pagado</label>
      <button className="btn btn-primary btn-block" disabled={!name.trim() || value <= 0}>Guardar insumo<Check size={18}/></button>
    </form>
  </Modal>
}

export function Inventory({ app }: { app: Restaurant }) {
  const inventory = useInventory(app.profile, app.role)
  const [adding, setAdding] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<Record<string, 'efectivo' | 'transferencia'>>({})
  const [confirmPending, setConfirmPending] = useState<string | null>(null)
  const canEdit = canWrite(app.role)
  const supplyById = useMemo(() => new Map(inventory.supplies.map(supply => [supply.id, supply])), [inventory.supplies])
  const paid = inventory.purchases.filter(item => item.paid)
  const pending = inventory.purchases.filter(item => !item.paid)
  const paidTotal = paid.reduce((sum, item) => sum + item.total_amount, 0)
  const pendingTotal = pending.reduce((sum, item) => sum + item.total_amount, 0)
  const paidBySupply = paid.reduce((totals, item) => totals.set(item.supply_id, (totals.get(item.supply_id) || 0) + item.total_amount), new Map<string, number>())
  return <>
    <div className="page-heading"><div><h1>Insumos</h1><p>Registra cada compra y marca si ya la pagaste.</p></div>{canEdit && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={18}/>Agregar insumo</button>}</div>
    {inventory.error && <div className="alert alert-error" role="alert">{inventory.error}</div>}
    {inventory.notice && <div className="alert alert-success" role="status">{inventory.notice}</div>}
    <div className="inventory-summary simple">
      <div className="inventory-stat"><div><small>Pagado</small><strong>{money(paidTotal)}</strong></div></div>
      <div className="inventory-stat"><div><small>Pendiente</small><strong>{money(pendingTotal)}</strong></div></div>
      <div className="inventory-stat"><div><small>Compras</small><strong>{inventory.purchases.length}</strong></div></div>
    </div>
    <section className="simple-supply-list" aria-label="Lista de insumos">
      {!inventory.purchases.length ? <div className="empty"><h3>Aún no hay insumos</h3><p>Agrega uno con su nombre y valor.</p></div> : inventory.purchases.map(item => {
        const name = supplyById.get(item.supply_id)?.name || 'Insumo'
        return <article className="simple-supply-row" key={item.id}>
          <div className="simple-supply-info"><strong>{name}</strong><small>{new Date(item.created_at).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' })}</small></div>
          <strong className="simple-supply-amount">{money(item.total_amount)}</strong>
          <div className="simple-supply-status"><span className={item.paid ? 'purchase-paid' : 'purchase-pending'}>{item.paid ? 'Pagado' : 'Pendiente'}</span>
            {canEdit && (item.paid
              ? <button className="paid-switch is-paid" type="button" disabled={inventory.busy} role="switch" aria-checked="true" aria-label={`Cambiar ${name} a pendiente`} onClick={() => setConfirmPending(item.id)}><span/></button>
              : <div className="pending-actions"><select aria-label={`Medio de pago de ${name}`} value={paymentMethod[item.id] || 'efectivo'} onChange={event => setPaymentMethod(current => ({ ...current, [item.id]: event.target.value as 'efectivo' | 'transferencia' }))}><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select><button className="paid-switch" type="button" disabled={inventory.busy} role="switch" aria-checked="false" aria-label={`Marcar ${name} como pagado`} onClick={() => void inventory.updatePurchase(item.id, 'paid', paymentMethod[item.id] || 'efectivo')}><span/></button></div>
            )}
          </div>
        </article>
      })}
    </section>
    {paidBySupply.size > 0 && <section className="simple-spend-breakdown"><h2>Gastado por insumo</h2>{[...paidBySupply.entries()].sort((a,b)=>b[1]-a[1]).map(([id,total])=><div key={id}><span>{supplyById.get(id)?.name || 'Insumo'}</span><strong>{money(total)}</strong></div>)}</section>}
    {adding && <AddSupplyExpense supplies={inventory.supplies} onSave={inventory.registerPurchase} close={() => setAdding(false)}/>}
    {confirmPending && <Modal title="¿Cambiar a pendiente?" close={() => setConfirmPending(null)}><div className="form-stack"><p>Este gasto se quitará del total pagado y se revertirá en caja. ¿Estás de acuerdo?</p><div className="form-actions"><button className="btn btn-ghost" onClick={() => setConfirmPending(null)}>Cancelar</button><button className="btn btn-primary" disabled={inventory.busy} onClick={async () => { const ok = await inventory.updatePurchase(confirmPending, 'unpaid'); if (ok) setConfirmPending(null) }}><Check size={17}/>Sí, dejar pendiente</button></div></div></Modal>}
  </>
}

