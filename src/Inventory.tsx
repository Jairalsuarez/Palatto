import { useMemo, useState } from 'react'
import { Boxes, ClipboardList, Minus, PackageOpen, Pencil, Plus, Search, Settings2, TriangleAlert } from 'lucide-react'
import { Modal } from './Modal'
import type { FormEvent } from 'react'
import type { Restaurant } from './lib/useRestaurant'
import { canWrite, cents, money } from './lib/domain'
import { applyMovement, inventoryValue, isLowStock, movementIcons, movementLabels, unitLabel, units, useInventory } from './lib/inventory'
import type { MovementKind, Supply, SupplyInput, SupplyUnit } from './lib/inventory'

function SupplyForm({ supply, onSave, close }: { supply?: Supply; onSave: (input: SupplyInput, id?: string) => Promise<boolean>; close: () => void }) {
  const [name, setName] = useState(supply?.name || '')
  const [category, setCategory] = useState(supply?.category || '')
  const [unit, setUnit] = useState<SupplyUnit>(supply?.unit || 'kg')
  const [minStock, setMinStock] = useState(supply ? String(supply.min_stock) : '')
  const [cost, setCost] = useState(supply ? String(supply.cost_per_unit / 100) : '')
  return <Modal title={supply ? 'Editar insumo' : 'Nuevo insumo'} close={close}>
    <form className="form-stack" onSubmit={async (event: FormEvent) => {
      event.preventDefault()
      const ok = await onSave({
        name,
        category,
        unit,
        min_stock: Math.max(0, Number(minStock) || 0),
        cost_per_unit: Math.max(0, cents(cost || '0')),
        active: true,
      }, supply?.id)
      if (ok) close()
    }}>
      <label>Nombre del insumo<input required autoFocus maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Ej. Carne de res"/></label>
      <div className="form-columns">
        <label>Categoría<input maxLength={60} value={category} onChange={e => setCategory(e.target.value)} placeholder="Carnes, Verduras…"/></label>
        <label>Unidad<select value={unit} onChange={e => setUnit(e.target.value as SupplyUnit)}>{units.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <div className="form-columns">
        <label>Stock mínimo<span className="optional">Aviso de reposición</span><input type="number" inputMode="decimal" min="0" step="0.001" value={minStock} onChange={e => setMinStock(e.target.value)} placeholder="0"/></label>
        <label>Costo por {unitLabel(unit)} ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} placeholder="0.00"/></label>
      </div>
      <p className="tiny">El stock inicial es 0. Después registra una entrada con la cantidad real.</p>
      <button className="btn btn-primary btn-block">{supply ? 'Guardar cambios' : 'Crear insumo'}</button>
    </form>
  </Modal>
}

function MovementForm({ supply, kind: initialKind, onSave, close }: { supply: Supply; kind: MovementKind; onSave: (id: string, kind: MovementKind, quantity: number, reason: string) => Promise<boolean>; close: () => void }) {
  const [kind, setKind] = useState<MovementKind>(initialKind)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const value = Number(quantity) || 0
  let preview = supply.stock
  try { preview = applyMovement(supply, kind, value).stock } catch { preview = supply.stock }
  return <Modal title={`${movementLabels[kind]} · ${supply.name}`} close={close}>
    <form className="form-stack" onSubmit={async (event: FormEvent) => {
      event.preventDefault()
      if (await onSave(supply.id, kind, value, reason)) close()
    }}>
      <div className="movement-summary">
        <span>Stock actual</span><strong>{supply.stock} {unitLabel(supply.unit)}</strong>
      </div>
      <div className="segmented" role="group" aria-label="Tipo de movimiento">
        {(['entrada', 'salida', 'ajuste'] as MovementKind[]).map(option => <button type="button" key={option} className={kind === option ? 'active' : ''} aria-pressed={kind === option} onClick={() => setKind(option)}>{movementIcons[option]} {movementLabels[option]}</button>)}
      </div>
      <label>{kind === 'ajuste' ? 'Stock real contado' : 'Cantidad'} ({unitLabel(supply.unit)})<input required autoFocus type="number" inputMode="decimal" min={kind === 'ajuste' ? '0' : '0.001'} step="0.001" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="0"/></label>
      <label>Motivo<span className="optional">Obligatorio</span><input required minLength={3} maxLength={300} value={reason} onChange={e => setReason(e.target.value)} placeholder={kind === 'entrada' ? 'Compra a proveedor' : kind === 'salida' ? 'Consumo del turno' : 'Conteo físico'}/></label>
      <div className={`movement-preview ${preview < 0 ? 'negative' : ''}`}><span>Quedará en</span><strong>{Math.max(0, preview)} {unitLabel(supply.unit)}</strong></div>
      <button className="btn btn-primary btn-block" disabled={kind !== 'ajuste' && value <= 0}>Registrar {movementLabels[kind].toLowerCase()}</button>
    </form>
  </Modal>
}

export function Inventory({ app }: { app: Restaurant }) {
  const inventory = useInventory(app.profile, app.role)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'todos' | 'bajo'>('todos')
  const [editing, setEditing] = useState<Supply | 'new' | null>(null)
  const [movement, setMovement] = useState<{ supply: Supply; kind: MovementKind } | null>(null)
  const canEdit = canWrite(app.role)
  const lowStock = inventory.supplies.filter(isLowStock)
  const filtered = useMemo(() => inventory.supplies.filter(supply => {
    if (filter === 'bajo' && !isLowStock(supply)) return false
    return `${supply.name} ${supply.category}`.toLowerCase().includes(search.toLowerCase())
  }), [inventory.supplies, filter, search])
  const supplyName = new Map(inventory.supplies.map(supply => [supply.id, supply]))

  return <>
    <div className="page-heading">
      <div><h1>Insumos</h1><p>Carne, papa y todo lo que entra y sale de la cocina.</p></div>
      {canEdit && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={18}/>Agregar insumo</button>}
    </div>

    {inventory.setupNeeded && canEdit && <div className="setup-note" role="status">
      <Settings2 size={19}/>
      <div><strong>Guardando en este dispositivo</strong><p>Para compartir el inventario entre teléfonos, aplica la migración <code>20261111120000_inventory.sql</code> en Supabase. Mientras tanto, todo funciona en este equipo.</p></div>
    </div>}

    <div className="inventory-summary">
      <div className="inventory-stat"><span className="inventory-stat-icon"><Boxes size={21}/></span><div><small>Insumos</small><strong>{inventory.supplies.length}</strong></div></div>
      <div className={`inventory-stat ${lowStock.length ? 'warning' : ''}`}><span className="inventory-stat-icon"><TriangleAlert size={21}/></span><div><small>Para reponer</small><strong>{lowStock.length}</strong></div></div>
      <div className="inventory-stat"><span className="inventory-stat-icon"><ClipboardList size={21}/></span><div><small>Valor del inventario</small><strong>{money(inventoryValue(inventory.supplies))}</strong></div></div>
    </div>

    <div className="inventory-toolbar">
      <div className="segmented inventory-filter" role="group" aria-label="Filtrar insumos">
        <button className={filter === 'todos' ? 'active' : ''} aria-pressed={filter === 'todos'} onClick={() => setFilter('todos')}>Todos</button>
        <button className={filter === 'bajo' ? 'active' : ''} aria-pressed={filter === 'bajo'} onClick={() => setFilter('bajo')}>Bajo stock {lowStock.length > 0 && <b>{lowStock.length}</b>}</button>
      </div>
      <div className="search"><Search size={17}/><input aria-label="Buscar insumo" placeholder="Buscar insumo" value={search} onChange={e => setSearch(e.target.value)}/></div>
    </div>

    {inventory.error && <div className="alert alert-error" role="alert">{inventory.error}</div>}
    {inventory.notice && <div className="alert alert-success" role="status">{inventory.notice}</div>}

    {inventory.loading ? <p className="muted">Cargando inventario…</p> : !filtered.length ? <div className="empty">
      <div className="empty-icon"><PackageOpen size={30}/></div>
      <h3>{inventory.supplies.length ? 'No hay insumos en este filtro' : 'Tu inventario está vacío'}</h3>
      <p>{inventory.supplies.length ? 'Prueba con otra búsqueda o muestra todos.' : 'Agrega carne, papa, pan y lo que uses cada día para controlar entradas y consumo.'}</p>
      {canEdit && !inventory.supplies.length && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={17}/>Agregar el primero</button>}
    </div> : <div className="supply-list">
      {filtered.map(supply => <div className={`supply-row ${isLowStock(supply) ? 'low' : ''}`} key={supply.id}>
        <div className="supply-main">
          <strong>{supply.name}</strong>
          <small>{supply.category || 'General'} · mín. {supply.min_stock} {unitLabel(supply.unit)}{supply.cost_per_unit > 0 ? ` · ${money(supply.cost_per_unit)}/${unitLabel(supply.unit)}` : ''}</small>
          {isLowStock(supply) && <span className="low-pill"><TriangleAlert size={12}/>{supply.stock <= 0 ? 'Agotado' : 'Reponer'}</span>}
        </div>
        <div className="supply-stock"><strong>{supply.stock}</strong><span>{unitLabel(supply.unit)}</span></div>
        {canEdit && <div className="supply-actions">
          <button className="supply-action entry" onClick={() => setMovement({ supply, kind: 'entrada' })}><Plus size={16}/>Entrada</button>
          <button className="supply-action exit" onClick={() => setMovement({ supply, kind: 'salida' })}><Minus size={16}/>Consumo</button>
          <button className="icon-button" aria-label={`Ajustar ${supply.name}`} onClick={() => setMovement({ supply, kind: 'ajuste' })}><Settings2 size={17}/></button>
          <button className="icon-button" aria-label={`Editar ${supply.name}`} onClick={() => setEditing(supply)}><Pencil size={17}/></button>
        </div>}
      </div>)}
    </div>}

    <section className="movement-log">
      <div className="section-heading"><h2>Últimos movimientos</h2><span className="pill">{inventory.movements.length}</span></div>
      {!inventory.movements.length ? <p className="muted tiny">Aquí verás cada entrada, consumo y ajuste con su fecha y motivo.</p> : <div className="movement-list">
        {inventory.movements.slice(0, 20).map(movement => <div className="movement" key={movement.id}>
          <span className={`movement-icon ${movement.kind === 'salida' ? 'out' : movement.kind === 'ajuste' ? 'adjust' : ''}`}>{movementIcons[movement.kind]}</span>
          <div><strong>{supplyName.get(movement.supply_id)?.name || 'Insumo'} · {movementLabels[movement.kind]}</strong><small>{new Date(movement.created_at).toLocaleString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {movement.reason}</small></div>
          <b className={movement.kind === 'salida' ? 'negative' : 'positive'}>{movement.kind === 'salida' ? '−' : movement.kind === 'entrada' ? '+' : '='}{movement.quantity}</b>
        </div>)}
      </div>}
    </section>

    {editing && <SupplyForm key={editing === 'new' ? 'new' : editing.id} supply={editing === 'new' ? undefined : editing} onSave={inventory.saveSupply} close={() => setEditing(null)}/>}
    {movement && <MovementForm key={`${movement.supply.id}-${movement.kind}`} supply={movement.supply} kind={movement.kind} onSave={inventory.registerMovement} close={() => setMovement(null)}/>}
  </>
}
