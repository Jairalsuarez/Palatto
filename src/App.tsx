import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Banknote, BarChart3, BookOpen, Check, CheckCheck, ChefHat,
  ChevronLeft, ClipboardList, Coffee, CreditCard, Flame, History, LogOut, Minus, PackageOpen,
  Pencil, Plus, Power, Search, ShieldCheck, ShoppingBag, Trash2, Users, Wallet, X,
} from 'lucide-react'
import { Modal } from './Modal'
import { useRestaurant } from './lib/useRestaurant'
import type { Restaurant } from './lib/useRestaurant'
import { businessLabel, canCash, canEdit, canMenu, canWrite, cents, labels, money, priceForService, registerLabel, roles, total } from './lib/domain'
import type { Business, Item, Method, MovementKind, Order, OrderPayment, Product, Role } from './lib/domain'
import { analyze, paymentTimes } from './lib/analytics'
import { OrderList } from './OrderList'
import { Reports } from './Reports'
import { Inventory } from './Inventory'
import './App.css'

type Page = 'pedidos' | 'nuevo' | 'cajas' | 'menu' | 'equipo' | 'reportes' | 'insumos'

const number = (n: number) => String(n).padStart(4, '0')
const movementKindLabel = (kind: MovementKind) => ({ ingreso: 'Ingreso', gasto: 'Gasto', retiro: 'Retiro', cobro: 'Cobro', correccion: 'Corrección', transferencia: 'Transferencia' }[kind])
const dateTime = (d: string) => new Date(d).toLocaleString('es-EC', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const today = () => new Date().toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty">
    <span className="empty-icon"><ShoppingBag size={26} aria-hidden="true"/></span>
    <h3>{title}</h3>
    <p>{children}</p>
    {action}
  </div>
}

function Login({ app }: { app: Restaurant }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return <main className="signin">
    <section className="signin-card" aria-label="Ingresar a Palatto">
      <img className="signin-logo" src="/palatto-logo.png" alt="Palatto"/>
      <div className="signin-heading">
        <h1>Bienvenido</h1>
        <p>Entra para tomar pedidos y cobrar.</p>
      </div>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void app.login(email, password) }}>
        <label>Correo electrónico
          <input type="email" autoComplete="username" inputMode="email" placeholder="tu@correo.com" value={email} onChange={event => setEmail(event.target.value)} required/>
        </label>
        <label>Contraseña
          <input type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={event => setPassword(event.target.value)} required/>
        </label>
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}>{app.busy ? 'Entrando…' : 'Entrar'}<ArrowRight size={19} aria-hidden="true"/></button>
      </form>
      <p className="signin-foot">Palatto · Cocina y bebidas</p>
    </section>
  </main>
}

export default function App() {
  const app = useRestaurant()
  const [page, setPage] = useState<Page>('pedidos')
  const [editing, setEditing] = useState<Order | undefined>()
  const [cashBusiness, setCashBusiness] = useState<Business | null>(null)
  const [account, setAccount] = useState(false)

  if (app.loading) return <div className="loading"><img src="/palatto-logo.png" alt="Palatto"/><p>Cargando…</p></div>
  if (!app.profile) return <Login app={app}/>

  const pending = app.data.orders.filter(order => !order.paid).length
  const tabs = [
    { id: 'pedidos', label: 'Inicio', icon: ClipboardList },
    { id: 'cajas', label: 'Cajas', icon: Wallet },
    { id: 'nuevo', label: 'Nuevo', icon: Plus },
    { id: 'reportes', label: 'Reportes', icon: BarChart3 },
    { id: 'menu', label: 'Menú', icon: BookOpen },
  ] as const

  function navigate(next: Page) {
    setPage(next)
    setCashBusiness(null)
    setEditing(undefined)
    setAccount(false)
    app.setError('')
  }
  function edit(order: Order) {
    setEditing(order)
    setPage('nuevo')
  }

  return <div className="app-shell">
    <header className="app-bar">
      <button className="app-brand" onClick={() => navigate('pedidos')} aria-label="Ir a inicio">
        <img src="/palatto-logo.png" alt=""/>
        <span><strong>Palatto</strong><small>Pedidos, cajas y cocina</small></span>
      </button>
      <div className="app-bar-right">
        {pending > 0 && page !== 'pedidos' && <span className="pending-dot" aria-label={`${pending} pedidos en proceso`}>{pending}</span>}
        <button className="avatar-button" onClick={() => setAccount(true)} aria-label="Tu cuenta y ajustes">
          {app.profile.name.slice(0, 1)}
        </button>
      </div>
    </header>

    <main className={`app-main ${page === 'nuevo' ? 'app-main-flush' : ''}`}>
      {app.error && <div className="alert alert-error global-alert" role="alert">
        <span>{app.error}</span>
        <button className="icon-button icon-sm" onClick={() => app.setError('')} aria-label="Cerrar aviso"><X size={16}/></button>
      </div>}

      {page === 'pedidos' && <Home app={app} onNew={() => navigate('nuevo')} onReport={() => navigate('reportes')} onCash={business => { setCashBusiness(business); setPage('cajas') }} onEdit={edit}/>}
      {page === 'reportes' && <Reports app={app}/>}
      {page === 'insumos' && <Inventory app={app}/>}
      {page === 'nuevo' && canWrite(app.role) && <OrderEditor key={editing?.id || 'new'} app={app} order={editing} done={() => { setEditing(undefined); setPage('pedidos') }}/>}
      {page === 'cajas' && (cashBusiness
        ? <Cash key={cashBusiness} app={app} business={cashBusiness} back={() => setCashBusiness(null)}/>
        : <CashOverview app={app} open={setCashBusiness}/>)}
      {page === 'menu' && <Menu app={app}/>}
      {page === 'equipo' && app.role === 'superadmin' && <Team app={app}/>}
    </main>

    {page !== 'nuevo' && <nav className="tabbar" aria-label="Navegación principal">
      {tabs.map(tab => <button key={tab.id}
        className={`tab ${page === tab.id ? 'active' : ''} ${tab.id === 'nuevo' ? 'tab-new' : ''}`}
        aria-current={page === tab.id ? 'page' : undefined}
        onClick={() => navigate(tab.id)}>
        <span className="tab-icon"><tab.icon size={22} aria-hidden="true"/>
          {tab.id === 'pedidos' && pending > 0 && <i className="tab-badge">{pending}</i>}
        </span>
        <span className="tab-label">{tab.label}</span>
      </button>)}
    </nav>}

    {account && <Modal title="Tu cuenta" close={() => setAccount(false)}>
      <div className="account">
        <div className="account-head">
          <span className="avatar avatar-lg">{app.profile.name.slice(0, 1)}</span>
          <div><strong>{app.profile.name}</strong><small>{labels[app.role]}</small></div>
        </div>
        <div className="account-links">
          <button className="account-link" onClick={() => navigate('insumos')}><PackageOpen size={20}/><span>Insumos y stock</span><ArrowRight size={18}/></button>
          {app.role === 'superadmin' && <button className="account-link" onClick={() => navigate('equipo')}><Users size={20}/><span>Equipo y permisos</span><ArrowRight size={18}/></button>}
        </div>
        <button className="btn btn-ghost btn-block" disabled={app.busy} onClick={() => void app.logout()}><LogOut size={18}/>Cerrar sesión</button>
        <p className="tiny center">Sesión con permisos de {labels[app.role].toLowerCase()}.</p>
      </div>
    </Modal>}

    {app.notice && <div className="toast" role="status"><CheckCheck size={18}/>{app.notice}</div>}
  </div>
}

/* ---------------------------------------------------------------- Inicio */

function Home({ app, onNew, onReport, onCash, onEdit }: { app: Restaurant; onNew: () => void; onReport: () => void; onCash: (business: Business) => void; onEdit: (order: Order) => void }) {
  const [filter, setFilter] = useState<'activos' | 'completados' | 'todos'>('activos')
  const [search, setSearch] = useState('')
  const [payment, setPayment] = useState<{ order: Order; split: boolean } | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)

  const orders = app.data.orders.filter(order => {
    const matchesFilter = filter === 'todos' || (filter === 'activos' ? !order.paid : order.paid)
    return matchesFilter && `${order.number} ${order.customer}`.toLowerCase().includes(search.toLowerCase())
  })
  const paymentOrder = app.data.orders.find(order => order.id === payment?.order.id)
  const detailOrder = app.data.orders.find(order => order.id === detail)

  return <>
    <div className="page-head">
      <div><p className="eyebrow">{today()}</p><h1>Pedidos</h1></div>
    </div>

    <SalesHero app={app} onReport={onReport}/>
    <CashMini app={app} open={onCash}/>

    <div className="toolbar">
      <div className="segmented" role="group" aria-label="Filtrar pedidos">
        {([['activos', 'En proceso'], ['completados', 'Completados'], ['todos', 'Todos']] as const).map(([id, label]) =>
          <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      <label className="search">
        <Search size={18} aria-hidden="true"/>
        <input aria-label="Buscar pedido" placeholder="Buscar por número o nombre" value={search} onChange={event => setSearch(event.target.value)}/>
      </label>
    </div>

    {!orders.length
      ? <Empty title={search ? 'No encontramos ese pedido' : filter === 'completados' ? 'Aún no hay pedidos cobrados' : 'No hay pedidos en proceso'}
          action={!search && filter !== 'completados' && canWrite(app.role) ? <button className="btn btn-primary" onClick={onNew}><Plus size={18}/>Tomar un pedido</button> : undefined}>
          {search ? 'Prueba con otro nombre o número.' : 'Cuando alguien pida algo, aparecerá aquí.'}
        </Empty>
      : <OrderList orders={orders} canPay={canWrite(app.role)} payments={app.data.order_payments} open={order => { app.setError(''); setDetail(order.id) }} pay={order => { app.setError(''); setPayment({ order, split: false }) }}/>}

    {detailOrder && <OrderDetail app={app} order={detailOrder} close={() => setDetail(null)}
      pay={() => { setDetail(null); setPayment({ order: detailOrder, split: false }) }}
      split={() => { setDetail(null); setPayment({ order: detailOrder, split: true }) }}
      edit={() => { setDetail(null); onEdit(detailOrder) }}
      showReceipt={async path => {
        try { setReceipt(await app.receiptUrl(path)) } catch (error) { app.setError((error as Error).message) }
      }}/>}

    {paymentOrder && <Payment app={app} order={paymentOrder} initialSplit={payment?.split || false} close={() => setPayment(null)}
      view={() => { setPayment(null); setDetail(paymentOrder.id) }}/>}

    {receipt && <Modal title="Comprobante de transferencia" close={() => setReceipt(null)}>
      <img className="receipt-image" src={receipt} alt="Comprobante del pago"/>
    </Modal>}
  </>
}

function SalesHero({ app, onReport }: { app: Restaurant; onReport: () => void }) {
  const summary = analyze(app.data.orders, app.data.products, 'hoy', new Date(), paymentTimes(app.data.movements))
  return <section className="sales-hero" aria-label="Resumen de ventas de hoy">
    <div className="sales-hero-top">
      <span className="eyebrow">Palatto · ventas de hoy</span>
      <button className="hero-link" onClick={onReport}>Ver reportes<ArrowUpRight size={15}/></button>
    </div>
    <strong className="hero-amount">{money(summary.revenue)}</strong>
  </section>
}

function CashMini({ app, open }: { app: Restaurant; open: (business: Business) => void }) {
  return <div className="cash-mini">
    {(['palatto', 'carreta'] as Business[]).map(business => {
      const movements = app.data.movements.filter(movement => movement.business === business)
      const balance = movements.reduce((sum, movement) => sum + movement.amount, 0)
      return <button key={business} className="cash-mini-card" onClick={() => open(business)}>
        <span className="cash-mini-name">{business === 'palatto' ? <ChefHat size={16}/> : <Coffee size={16}/>}{registerLabel(business)}</span>
        <strong>{money(balance)}</strong>
        <span className="cash-mini-state">{business === 'palatto' ? 'Palatto' : 'Registro separado · Bebidas'}</span>
      </button>
    })}
  </div>
}

function OrderDetail({ app, order, close, pay, split, edit, showReceipt }: { app: Restaurant; order: Order; close: () => void; pay: () => void; split: () => void; edit: () => void; showReceipt: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('Pedido cancelado')
  const owed = total(order.items)
  const payments = app.data.order_payments.filter(payment => payment.order_id === order.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0)
  const remaining = Math.max(0, owed - paid)
  return <Modal title={`Pedido #${number(order.number)}`} close={close}>
    <div className="dialog-body">
    {confirming
      ? <div className="form-stack">
          <div className="alert alert-danger">
            <Trash2 size={20}/>
            <div><strong>Se eliminará el pedido #{number(order.number)}</strong><p>Esta acción no se puede deshacer. Quedará registrado quién lo eliminó y por qué.</p></div>
          </div>
          <label>Motivo<input value={reason} onChange={event => setReason(event.target.value)} maxLength={300} minLength={3} required/></label>
          {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
          <button className="btn btn-danger btn-block btn-lg" disabled={app.busy || reason.trim().length < 3}
            onClick={async () => { if (await app.deleteOrder(order, reason)) close() }}>
            <Trash2 size={18}/>{app.busy ? 'Eliminando…' : 'Sí, eliminar pedido'}
          </button>
          <button className="btn btn-ghost btn-block" disabled={app.busy} onClick={() => setConfirming(false)}>Volver</button>
        </div>
      : <>
          <div className="detail-head">
            <div>
              <strong>{order.customer}</strong>
              <small>{dateTime(order.created_at)} · {order.takeaway ? 'Para llevar' : 'Para servir'}</small>
            </div>
            <span className={`chip ${order.paid ? 'chip-done' : 'chip-live'}`}><i aria-hidden="true"/>{order.paid ? 'Cobrado' : 'En proceso'}</span>
          </div>

          <ul className="detail-items">
            {order.items.map(item => <li key={item.product_id}>
              <span><b>{item.quantity}</b> {item.name}<small>{businessLabel(item.business)}</small></span>
              <span>{money(item.price * item.quantity)}</span>
            </li>)}
          </ul>

          {order.notes && <p className="detail-note">{order.notes}</p>}

          <div className="detail-total"><span>{payments.length ? 'Total del pedido' : 'Total'}</span><strong>{money(owed)}</strong></div>

          <div className="allocation">
            <span>Palatto <b>{money(total(order.items, 'palatto'))}</b></span>
            <span>Aguas y colas <b>{money(total(order.items, 'carreta'))}</b></span>
          </div>

          {payments.length > 0 && <section className="split-summary">
            <div className="section-top"><h3>Cuenta dividida</h3><span className="pill">{payments.length} {payments.length === 1 ? 'pago' : 'pagos'}</span></div>
            <ul className="split-list">
              {payments.map(payment => <li key={payment.id}>
                <div><strong>{payment.label}</strong><small>{payment.items.map(item => `${item.quantity} × ${item.name}`).join(' · ')}</small></div>
                <span><b>{money(payment.amount)}</b><small>{payment.method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</small></span>
              </li>)}
            </ul>
            {!order.paid && <div className="split-progress">
              <span>Cobrado <b>{money(paid)}</b></span>
              <span>Falta <b>{money(remaining)}</b></span>
            </div>}
          </section>}

          {order.paid && (payments.length
            ? <p className="detail-paid"><Check size={16}/> Cobrado en {payments.length} {payments.length === 1 ? 'pago' : 'pagos'}</p>
            : <p className="detail-paid"><Check size={16}/> Cobrado con {order.method === 'efectivo' ? 'efectivo' : 'transferencia'}</p>)}
          {order.receipt && <button className="btn btn-ghost btn-block btn-sm" onClick={() => showReceipt(order.receipt!)}><CreditCard size={16}/>Ver comprobante</button>}

          <div className="detail-actions">
            {!order.paid && canWrite(app.role) && (payments.length
              ? <button className="btn btn-money btn-lg btn-block" disabled={app.busy} onClick={split}><Users size={19}/>Cobrar el resto · {money(remaining)}</button>
              : <>
                  <button className="btn btn-money btn-lg btn-block" disabled={app.busy} onClick={pay}><Banknote size={19}/>Cobrar {money(owed)}</button>
                  <button className="btn btn-ghost btn-block" onClick={split}><Users size={17}/>Dividir cuenta</button>
                </>)}
            {!payments.length && canEdit(app.role, order) && <button className="btn btn-ghost btn-block" onClick={edit}><Pencil size={17}/>Editar pedido</button>}
            {!order.paid && !payments.length && canWrite(app.role) && <button className="btn btn-danger-ghost btn-block" onClick={() => setConfirming(true)}><Trash2 size={17}/>Eliminar pedido</button>}
          </div>

          <details className="history">
            <summary><History size={15}/>Historial</summary>
            {app.data.audits.filter(audit => audit.order_id === order.id).map(audit => <p key={audit.id}>{audit.reason}<small>{dateTime(audit.created_at)}</small></p>)}
            <p>Pedido registrado<small>{dateTime(order.created_at)}</small></p>
          </details>
        </>}
    </div>
  </Modal>
}

function Payment({ app, order, initialSplit, close, view }: { app: Restaurant; order: Order; initialSplit: boolean; close: () => void; view: () => void }) {
  const payments = app.data.order_payments.filter(payment => payment.order_id === order.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const [mode, setMode] = useState<'completo' | 'dividir'>(initialSplit || payments.length > 0 ? 'dividir' : 'completo')

  return <Modal title={`Cobrar #${number(order.number)}`} close={close}>
    {payments.length === 0 && <div className="pay-modes segmented segmented-lg" role="group" aria-label="Forma de cobro">
      <button type="button" className={mode === 'completo' ? 'active' : ''} aria-pressed={mode === 'completo'} onClick={() => setMode('completo')}><Banknote size={18}/>Cobro completo</button>
      <button type="button" className={mode === 'dividir' ? 'active' : ''} aria-pressed={mode === 'dividir'} onClick={() => setMode('dividir')}><Users size={18}/>Dividir cuenta</button>
    </div>}
    {mode === 'dividir'
      ? <SplitPayment app={app} order={order} payments={payments} close={close} view={view}/>
      : <FullPayment app={app} order={order} close={close} view={view}/>}
  </Modal>
}

function FullPayment({ app, order, close, view }: { app: Restaurant; order: Order; close: () => void; view: () => void }) {
  const [method, setMethod] = useState<Method>('efectivo')
  const [received, setReceived] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)
  const amount = total(order.items)
  const given = cents(received)
  const change = Math.max(0, given - amount)
  const quick = [...new Set([amount, 500, 1000, 2000, 5000])].filter(value => value >= amount).slice(0, 4)

  return <form className="form-stack" onSubmit={async event => {
    event.preventDefault()
    if (await app.pay(order, method, given, receipt)) close()
  }}>
    <div className="pay-total">
      <span>Total a cobrar</span>
      <strong>{money(amount)}</strong>
      <small>{order.takeaway ? 'Para llevar' : 'Para servir'} · {order.items.reduce((count, item) => count + item.quantity, 0)} artículos</small>
    </div>

    <div className="segmented segmented-lg" role="group" aria-label="Forma de pago">
      {(['efectivo', 'transferencia'] as Method[]).map(option => <button type="button" key={option} className={method === option ? 'active' : ''} aria-pressed={method === option} onClick={() => setMethod(option)}>
        {option === 'efectivo' ? <Banknote size={19}/> : <CreditCard size={19}/>}{option === 'efectivo' ? 'Efectivo' : 'Transferencia'}
      </button>)}
    </div>

    {method === 'efectivo'
      ? <>
          <div className="quick-cash" role="group" aria-label="Efectivo recibido">
            {quick.map(value => <button type="button" key={value} className={`quick-cash-btn ${given === value ? 'active' : ''}`} onClick={() => setReceived(String(value / 100))}>
              {value === amount ? 'Exacto' : money(value)}
            </button>)}
          </div>
          <label>Efectivo recibido ($)
            <input type="number" inputMode="decimal" min={amount / 100} step="0.01" value={received} onChange={event => setReceived(event.target.value)} placeholder="0.00" required/>
          </label>
          <div className={`change-box ${change > 0 ? 'has-change' : ''}`}>
            <span>Suelto</span><strong>{money(change)}</strong>
          </div>
        </>
      : <ReceiptUpload app={app} value={receipt} onChange={setReceipt}/>}

    <button type="button" className="link-button" onClick={view}>Ver detalle o editar<ArrowRight size={16}/></button>

    <div className="allocation">
      <span>Palatto <b>{money(total(order.items, 'palatto'))}</b></span>
      <span>Aguas y colas <b>{money(total(order.items, 'carreta'))}</b></span>
    </div>

    {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
    <button className="btn btn-money btn-lg btn-block" disabled={app.busy || order.paid || (method === 'transferencia' ? !receipt : given < amount)}>
      {order.paid ? 'Pedido cobrado' : app.busy ? 'Guardando…' : 'Confirmar pago'}<Check size={19}/>
    </button>
    <p className="tiny center">Confirma cuando tengas el dinero en mano.</p>
  </form>
}

function SplitPayment({ app, order, payments, close, view }: { app: Restaurant; order: Order; payments: OrderPayment[]; close: () => void; view: () => void }) {
  const [label, setLabel] = useState(`Persona ${payments.length + 1}`)
  const [method, setMethod] = useState<Method>('efectivo')
  const [received, setReceived] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, number>>({})

  const assigned = new Map<string, number>()
  for (const payment of payments)
    for (const item of payment.items)
      assigned.set(item.product_id, (assigned.get(item.product_id) || 0) + item.quantity)

  const lines = order.items
    .map(item => ({ ...item, available: item.quantity - (assigned.get(item.product_id) || 0) }))
    .filter(item => item.available > 0)
  const selected = lines
    .map(item => ({ product_id: item.product_id, name: item.name, price: item.price, business: item.business, quantity: picked[item.product_id] || 0 }))
    .filter(item => item.quantity > 0)
  const amount = selected.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const given = cents(received)
  const change = Math.max(0, given - amount)
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0)
  const owed = total(order.items)
  const remaining = Math.max(0, owed - paid)
  const ready = label.trim().length > 0 && selected.length > 0 && (method === 'transferencia' ? !!receipt : given >= amount)

  function move(productId: string, delta: number, max: number) {
    setPicked(current => ({ ...current, [productId]: Math.max(0, Math.min(max, (current[productId] || 0) + delta)) }))
  }

  return <form className="form-stack" onSubmit={async event => {
    event.preventDefault()
    if (await app.splitPay(order, label, selected, method, given, receipt)) close()
  }}>
    <div className="pay-total">
      <span>Falta por cobrar</span>
      <strong>{money(remaining)}</strong>
      <small>{payments.length ? `${payments.length} ${payments.length === 1 ? 'persona ya pagó' : 'personas ya pagaron'} · ${money(paid)} cobrado` : 'Elige qué productos paga cada persona'}</small>
    </div>

    {payments.length > 0 && <ul className="split-list compact">
      {payments.map((payment, index) => <li key={index}>
        <div><strong>{payment.label}</strong><small>{payment.items.map(item => `${item.quantity} × ${item.name}`).join(' · ')}</small></div>
        <span><b>{money(payment.amount)}</b></span>
      </li>)}
    </ul>}

    <label>¿Quién paga?<input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} required placeholder="Nombre de la persona"/></label>

    <div className="split-picker">
      <div className="section-top"><p className="field-label">Productos de esta persona</p><span className="muted small">{selected.reduce((sum, item) => sum + item.quantity, 0)} elegidos</span></div>
      <ul>
        {lines.map(item => {
          const count = picked[item.product_id] || 0
          return <li key={item.product_id} className={count ? 'picked' : ''}>
            <div className="basket-info">
              <strong>{item.name}</strong>
              <small>{money(item.price)} · quedan {item.available}</small>
            </div>
            <div className="stepper">
              <button type="button" aria-label={`Quitar uno de ${item.name}`} onClick={() => move(item.product_id, -1, item.available)} disabled={!count}><Minus size={16}/></button>
              <span>{count}</span>
              <button type="button" aria-label={`Añadir uno de ${item.name}`} onClick={() => move(item.product_id, 1, item.available)} disabled={count >= item.available}><Plus size={16}/></button>
            </div>
            <b className="basket-price">{money(item.price * count)}</b>
          </li>
        })}
        {!lines.length && <li className="empty-line">Este pedido ya está repartido por completo.</li>}
      </ul>
    </div>

    <div className="split-total"><span>Esta persona paga</span><strong>{money(amount)}</strong></div>

    <div className="segmented segmented-lg" role="group" aria-label="Forma de pago de esta persona">
      {(['efectivo', 'transferencia'] as Method[]).map(option => <button type="button" key={option} className={method === option ? 'active' : ''} aria-pressed={method === option} onClick={() => setMethod(option)}>
        {option === 'efectivo' ? <Banknote size={19}/> : <CreditCard size={19}/>}{option === 'efectivo' ? 'Efectivo' : 'Transferencia'}
      </button>)}
    </div>

    {method === 'transferencia'
      ? <ReceiptUpload app={app} value={receipt} onChange={setReceipt}/>
      : amount > 0
        ? <>
            <div className="quick-cash" role="group" aria-label="Efectivo recibido">
              {[...new Set([amount, 500, 1000, 2000, 5000])].filter(value => value >= amount).slice(0, 4).map(value => <button type="button" key={value} className={`quick-cash-btn ${given === value ? 'active' : ''}`} onClick={() => setReceived(String(value / 100))}>
                {value === amount ? 'Exacto' : money(value)}
              </button>)}
            </div>
            <label>Efectivo recibido ($)
              <input type="number" inputMode="decimal" min={amount / 100} step="0.01" value={received} onChange={event => setReceived(event.target.value)} placeholder="0.00" required/>
            </label>
            <div className={`change-box ${change > 0 ? 'has-change' : ''}`}><span>Suelto</span><strong>{money(change)}</strong></div>
          </>
        : <p className="empty-line">Elige los productos de esta persona para calcular el importe.</p>}

    <button type="button" className="link-button" onClick={view}>Ver detalle<ArrowRight size={16}/></button>

    {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
    <button className="btn btn-money btn-lg btn-block" disabled={app.busy || !ready}>
      {app.busy ? 'Guardando…' : amount >= remaining ? 'Cobrar y cerrar cuenta' : 'Registrar pago'}<Check size={19}/>
    </button>
    <p className="tiny center">Cada pago queda dentro de este mismo pedido, con los productos asignados a cada persona.</p>
  </form>
}

function ReceiptUpload({ app, value, onChange }: { app: Restaurant; value: string | null; onChange: (value: string | null) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  return <div className="upload">
    <label className={value ? 'upload-box done' : 'upload-box'}>
      {value ? <><CheckCheck size={22}/><strong>Comprobante listo</strong><span>Toca para cambiarlo</span></> : <><CreditCard size={22}/><strong>Subir comprobante</strong><span>JPG, PNG o WebP · máximo 5 MB</span></>}
      <input aria-label="Foto del comprobante" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={uploading}
        onChange={async event => {
          const file = event.target.files?.[0]
          if (!file) return
          onChange(null)
          setUploading(true)
          setError('')
          try { onChange(await app.upload(file)) } catch (caught) { setError((caught as Error).message) } finally { setUploading(false) }
        }}/>
    </label>
    {uploading && <p className="tiny center">Subiendo imagen…</p>}
    {error && <p className="alert alert-error">{error}</p>}
  </div>
}

/* ------------------------------------------------------------ Nuevo pedido */

function OrderEditor({ app, order, done }: { app: Restaurant; order?: Order; done: () => void }) {
  const [picker, setPicker] = useState(false)
  const [service, setService] = useState<'servir' | 'llevar' | null>(order ? (order.takeaway ? 'llevar' : 'servir') : null)
  const [showNotes, setShowNotes] = useState(Boolean(order?.notes))
  const [items, setItems] = useState<Item[]>(order?.items || [])
  const [notes, setNotes] = useState(order?.notes || '')
  const [reason, setReason] = useState('')
  const [received, setReceived] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)

  const priced = priceForService(items, service === 'llevar')
  const difference = order?.paid ? total(priced) - total(order.items) : 0
  const takeawayFee = priced.reduce((sum, item) => sum + (item.takeaway_fee || 0) * item.quantity, 0)

  function add(product: Product) {
    setPicker(false)
    setItems(current => {
      const found = current.find(item => item.product_id === product.id)
      return found
        ? current.map(item => item.product_id === product.id ? { ...item, quantity: Math.min(99, item.quantity + 1) } : item)
        : [...current, { product_id: product.id, name: product.name, price: product.price, base_price: product.price, takeaway_fee: product.takeaway_fee || 0, business: product.business, quantity: 1 }]
    })
  }
  function quantity(id: string, delta: number) {
    setItems(current => current.map(item => item.product_id === id ? { ...item, quantity: Math.min(99, item.quantity + delta) } : item).filter(item => item.quantity > 0))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!service) { app.setError('Elige para servir o para llevar.'); return }
    if (await app.saveOrder(order?.customer || 'Pedido', notes, priced, order, reason, cents(received), receipt, service === 'llevar')) done()
  }

  return <div className="editor">
    <header className="editor-bar">
      <button className="icon-button" onClick={done} aria-label="Volver a pedidos"><ChevronLeft size={22}/></button>
      <div><p className="eyebrow">{order ? 'Corregir' : 'Nuevo'}</p><h1>{order ? `Pedido #${number(order.number)}` : `Pedido #${number(Math.max(0, ...app.data.orders.map(o => o.number)) + 1)}`}</h1></div>
      <button className="btn btn-ghost btn-sm" onClick={done}>Cancelar</button>
    </header>

    <form className="editor-form" onSubmit={submit}>
      <section className="editor-section">
        <p className="field-label">¿Cómo se entrega?</p>
        <div className="segmented segmented-lg" role="group" aria-label="Tipo de servicio">
          {(['servir', 'llevar'] as const).map(value => <button type="button" key={value} className={service === value ? 'active' : ''} aria-pressed={service === value} onClick={() => setService(value)}>
            {value === 'servir' ? 'Para servir' : 'Para llevar'}
          </button>)}
        </div>
      </section>

      <section className="editor-section">
        <div className="section-top"><p className="field-label">Productos</p>{items.length > 0 && <span className="muted small">{items.reduce((sum, item) => sum + item.quantity, 0)} artículos</span>}</div>
        {items.length === 0
          ? <button type="button" className="add-first" onClick={() => setPicker(true)}><Plus size={24}/><span>Agregar productos</span></button>
          : <ul className="basket">
              {items.map(item => <li key={item.product_id}>
                <div className="basket-info">
                  <strong>{item.name}</strong>
                  <small>{businessLabel(item.business)}{service === 'llevar' && !!item.takeaway_fee ? ` · +${money(item.takeaway_fee)} para llevar` : ''}</small>
                </div>
                <div className="stepper">
                  <button type="button" aria-label={`Quitar uno de ${item.name}`} onClick={() => quantity(item.product_id, -1)}><Minus size={16}/></button>
                  <span>{item.quantity}</span>
                  <button type="button" aria-label={`Añadir uno de ${item.name}`} onClick={() => quantity(item.product_id, 1)}
                    disabled={item.quantity >= 99 || !app.data.products.find(product => product.id === item.product_id)?.active}><Plus size={16}/></button>
                </div>
                <b className="basket-price">{money(item.price * item.quantity)}</b>
              </li>)}
            </ul>}
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setPicker(true)}><Plus size={18}/>{items.length ? 'Agregar otro producto' : 'Agregar productos'}</button>
      </section>

      {service === 'llevar' && <p className="note-line">Incluye {money(takeawayFee)} de adicional para llevar.</p>}

      <section className="editor-section">
        <button type="button" className="section-toggle" aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
          <Pencil size={16}/>{showNotes ? 'Ocultar instrucciones' : notes ? 'Editar instrucciones' : 'Añadir instrucciones'}
        </button>
        {showNotes && <textarea id="order-notes" value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} placeholder="Sin cebolla, salsa aparte…" aria-label="Instrucciones para cocina"/>}
      </section>

      {order && <section className="editor-section">
        <label>Motivo de la corrección<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={450} required placeholder="¿Qué cambió y por qué?"/></label>
        {order.paid && <div className="correction">
          <strong>Este pedido ya está cobrado</strong>
          <p>{difference > 0 ? `Cobra adicional: ${money(difference)}` : difference < 0 ? `Devuelve al cliente: ${money(-difference)}` : 'Sin diferencia en el total.'}</p>
          {order.method === 'efectivo' && difference > 0 && <label>Efectivo adicional recibido ($)
            <input type="number" inputMode="decimal" step="0.01" min={difference / 100} value={received} onChange={event => setReceived(event.target.value)} required/>
            <span className="tiny">Suelto: {money(Math.max(0, cents(received) - difference))}</span>
          </label>}
          {order.method === 'transferencia' && difference !== 0 && <ReceiptUpload app={app} value={receipt} onChange={setReceipt}/>}
        </div>}
      </section>}

      {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}

      <div className="editor-foot">
        <div><small>Total</small><strong>{money(total(priced))}</strong></div>
        <button className="btn btn-primary btn-lg" disabled={app.busy || !service || !items.length || (!!order?.paid && order.method === 'transferencia' && difference !== 0 && !receipt)}>
          {app.busy ? 'Guardando…' : order ? 'Guardar cambio' : 'Enviar a cocina'}<ArrowRight size={19}/>
        </button>
      </div>
    </form>

    {picker && <Modal title="Agregar productos" close={() => setPicker(false)}>
      <ProductPicker app={app} selected={items} add={add}/>
    </Modal>}
  </div>
}

function ProductPicker({ app, selected, add }: { app: Restaurant; selected: Item[]; add: (product: Product) => void }) {
  const [search, setSearch] = useState('')
  const [business, setBusiness] = useState<'todos' | Business>('todos')
  const products = app.data.products.filter(product =>
    product.active && product.name.toLowerCase().includes(search.toLowerCase()) && (business === 'todos' || product.business === business))

  return <section className="picker">
    <label className="search"><Search size={18}/><input value={search} onChange={event => setSearch(event.target.value)} autoFocus placeholder="Buscar producto" aria-label="Buscar producto"/></label>
    <div className="segmented" role="group" aria-label="Filtrar por negocio">
      {([['todos', 'Todo'], ['palatto', 'Palatto'], ['carreta', 'Aguas y colas']] as const).map(([id, label]) =>
        <button key={id} className={business === id ? 'active' : ''} aria-pressed={business === id} onClick={() => setBusiness(id)}>{label}</button>)}
    </div>
    {!products.length
      ? <Empty title="Sin productos">{search ? 'Prueba otra búsqueda.' : 'Agrega productos desde Menú.'}</Empty>
      : <div className="product-grid">
          {products.map(product => {
            const count = selected.find(item => item.product_id === product.id)?.quantity
            return <button key={product.id} className="product-card" onClick={() => add(product)}>
              <ProductPhoto app={app} product={product}/>
              {count ? <span className="product-count">{count}</span> : null}
              <strong>{product.name}</strong>
              <span className="product-card-foot"><b>{money(product.price)}</b><span className="add-circle"><Plus size={17}/></span></span>
            </button>
          })}
        </div>}
  </section>
}

/* ----------------------------------------------------------------- Cajas */

function CashOverview({ app, open }: { app: Restaurant; open: (business: Business) => void }) {
  return <>
    <div className="page-head"><div><p className="eyebrow">Palatto · dinero</p><h1>Cajas</h1></div></div>
    <div className="cash-overview">
      {(['palatto', 'carreta'] as Business[]).map(business => {
        const movements = app.data.movements.filter(movement => movement.business === business)
        const balance = movements.reduce((sum, movement) => sum + movement.amount, 0)
        const cash = movements.filter(movement => movement.method === 'efectivo').reduce((sum, movement) => sum + movement.amount, 0)
        const transfer = movements.filter(movement => movement.method === 'transferencia').reduce((sum, movement) => sum + movement.amount, 0)
        return <button key={business} className="cash-card" onClick={() => open(business)}>
          <span className="cash-card-top">
            <span className="cash-icon">{business === 'palatto' ? <ChefHat size={20}/> : <Coffee size={20}/>}</span>
          <span className="cash-card-badge">{business === 'palatto' ? 'Palatto' : 'Registro de ventas'}</span>
          </span>
          <strong className="cash-card-name">{registerLabel(business)}</strong>
          <small>{businessLabel(business)}</small>
          <span className="cash-card-amount">{money(balance)}</span>
          <span className="cash-card-split"><span>Efectivo {money(cash)}</span><span>Transf. {money(transfer)}</span></span>
          <span className="cash-card-open">{business === 'palatto' ? 'Ver caja principal' : 'Ver registro de bebidas'}<ArrowRight size={16}/></span>
        </button>
      })}
    </div>
    <p className="tiny center muted">Un solo negocio: Palatto. Las ventas de aguas y colas tienen un registro y saldo separado.</p>
  </>
}

function Cash({ app, business, back }: { app: Restaurant; business: Business; back: () => void }) {
  const [transferId, setTransferId] = useState(() => crypto.randomUUID())
  const [form, setForm] = useState<'ingreso' | 'gasto' | 'retiro' | 'transferir' | null>(null)
  const [method, setMethod] = useState<Method>('efectivo')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const movements = app.data.movements.filter(movement => movement.business === business)
  const balance = (method: Method) => movements.filter(movement => movement.method === method).reduce((sum, movement) => sum + movement.amount, 0)

  function closeForm() {
    setForm(null)
    setAmount('')
    setReason('')
    setTransferId(crypto.randomUUID())
  }

  return <>
    <div className="subpage-bar">
      <button className="icon-button" onClick={back} aria-label="Volver a cajas"><ChevronLeft size={22}/></button>
      <div><p className="eyebrow">{businessLabel(business)}</p><h1>{registerLabel(business)}</h1></div>
    </div>

    <section className="balance-card">
      <div className="balance-top"><span>Saldo en caja</span><span className="balance-state">Disponible</span></div>
      <strong>{money(balance('efectivo') + balance('transferencia'))}</strong>
      <div className="balance-split">
        <span><Banknote size={16}/>Efectivo<b>{money(balance('efectivo'))}</b></span>
        <span><CreditCard size={16}/>Transferencias<b>{money(balance('transferencia'))}</b></span>
      </div>
    </section>

    {canCash(app.role, business)
      ? <div className="cash-actions">
          <button className="cash-action in" onClick={() => { setForm('ingreso'); setMethod('efectivo') }}><Plus size={20}/>Ingresar</button>
          <button className="cash-action expense" onClick={() => { setForm('gasto'); setMethod('efectivo') }}><ShoppingBag size={20}/>Gasto</button>
          <button className="cash-action out" onClick={() => { setForm('retiro'); setMethod('efectivo') }}><ArrowDownLeft size={20}/>Retirar</button>
          {app.role === 'superadmin' && <button className="cash-action move" onClick={() => { setForm('transferir'); setMethod('efectivo') }}><ArrowRight size={20}/>Transferir</button>}
        </div>
      : <p className="alert alert-info"><ShieldCheck size={17}/>Solo Administrador y Superadmin ajustan esta caja. Los cobros entran automáticamente.</p>}

    <DailyReport app={app} business={business}/>

    <section className="stack">
      <div className="section-top"><h2>Movimientos</h2><span className="pill">{movements.length}</span></div>
      {!movements.length
        ? <p className="empty-line">Aquí verás cada ingreso, gasto, retiro y cobro.</p>
        : <ul className="movement-list">
            {[...movements].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(movement => <li className="movement" key={movement.id}>
              <span className={`movement-icon ${movement.amount < 0 ? 'out' : ''}`}>{movement.amount < 0 ? <ArrowUpRight size={18}/> : <ArrowRight size={18}/>}</span>
              <div><strong>{movement.reason}</strong><small>{movementKindLabel(movement.kind)} · {dateTime(movement.created_at)} · {movement.method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</small></div>
              <b className={movement.amount < 0 ? 'negative' : 'positive'}>{movement.amount > 0 ? '+' : '−'}{money(Math.abs(movement.amount))}</b>
            </li>)}
          </ul>}
    </section>

    {form && <Modal title={form === 'ingreso' ? 'Ingresar dinero' : form === 'gasto' ? 'Registrar gasto' : form === 'retiro' ? 'Retirar de caja' : 'Transferir entre cajas'} close={closeForm}>
      <form className="form-stack" onSubmit={async event => {
        event.preventDefault()
        const value = cents(amount)
        const done = form === 'transferir'
          ? await app.transfer(transferId, business, value, method, reason)
          : await app.cash(business, form === 'retiro' || form === 'gasto' ? -value : value, method, reason, form)
        if (done) closeForm()
      }}>
        {form === 'transferir' && <p className="alert alert-info">Destino: <strong>{business === 'palatto' ? 'Caja de aguas y colas' : 'Caja principal'}</strong></p>}
        {form === 'gasto' && <p className="alert alert-info">Un gasto es una salida para comprar algo. Un retiro es sacar dinero del negocio.</p>}
        <label>Importe ($)<input type="number" inputMode="decimal" step="0.01" min="0.01" max="1000000" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" autoFocus/></label>
        <label>Medio<select value={method} onChange={event => setMethod(event.target.value as Method)}>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
        </select></label>
        <label>Motivo<textarea rows={2} required minLength={3} maxLength={450} value={reason} onChange={event => setReason(event.target.value)} placeholder={form === 'ingreso' ? 'Fondo para dar suelto' : form === 'gasto' ? 'Compra de hielo, proveedor…' : form === 'retiro' ? 'Retiro del dueño' : 'Cambio de caja'}/></label>
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}>
          {app.busy ? 'Guardando…' : form === 'ingreso' ? 'Ingresar dinero' : form === 'gasto' ? 'Registrar gasto' : form === 'retiro' ? 'Retirar dinero' : 'Transferir'}<Check size={18}/>
        </button>
      </form>
    </Modal>}
  </>
}

const reportDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
function DailyReport({ app, business }: { app: Restaurant; business: Business }) {
  const [day, setDay] = useState(() => reportDate(new Date().toISOString()))
  const records = app.data.movements.filter(movement => movement.business === business && reportDate(movement.created_at) === day)
  const kinds: MovementKind[] = ['cobro', 'ingreso', 'gasto', 'retiro', 'correccion', 'transferencia']
  return <details className="daily-report">
    <summary>Reporte del día<span>{new Date(day + 'T12:00:00').toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}</span></summary>
    <label>Fecha<input type="date" value={day} onChange={event => setDay(event.target.value)}/></label>
    {(['efectivo', 'transferencia'] as Method[]).map(method => {
      const selected = records.filter(movement => movement.method === method)
      return <div className="report-method" key={method}>
        <h3>{method === 'efectivo' ? 'Efectivo' : 'Transferencias'}</h3>
        {kinds.map(kind => {
          const value = selected.filter(movement => movement.kind === kind).reduce((sum, movement) => sum + movement.amount, 0)
          if (!value) return null
          return <div key={kind}><span>{movementKindLabel(kind)}</span><b className={value < 0 ? 'negative' : ''}>{value < 0 ? '−' : ''}{money(Math.abs(value))}</b></div>
        })}
        {!selected.length && <div><span>Sin movimientos</span><b>{money(0)}</b></div>}
        <div className="report-net"><span>Neto</span><b>{money(selected.reduce((sum, movement) => sum + movement.amount, 0))}</b></div>
      </div>
    })}
  </details>
}

/* ------------------------------------------------------------------ Menú */

function Menu({ app }: { app: Restaurant }) {
  const [editing, setEditing] = useState<Product | null>(null)
  const [filter, setFilter] = useState<'todos' | Business>('todos')
  const blank: Product = { id: '', name: '', price: 0, business: 'palatto', category: 'General', active: true }
  const products = app.data.products.filter(product => filter === 'todos' || product.business === filter)

  return <>
    <div className="page-head">
      <div><p className="eyebrow">Lo que preparamos</p><h1>Menú</h1></div>
      {canMenu(app.role) && <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={18}/>Agregar</button>}
    </div>

    <div className="segmented" role="group" aria-label="Filtrar menú">
      {([['todos', 'Todo'], ['palatto', 'Palatto'], ['carreta', 'Aguas y colas']] as const).map(([id, label]) =>
        <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
    </div>

    {!products.length
      ? <Empty title="Tu menú está vacío" action={canMenu(app.role) ? <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={18}/>Agregar producto</button> : undefined}>
          Agrega los productos de Palatto y las aguas y colas con sus precios.
        </Empty>
      : <ul className="menu-list">
          {products.map(product => <li className={`menu-row ${product.active ? '' : 'is-hidden'}`} key={product.id}>
            <ProductPhoto app={app} product={product}/>
            <div className="menu-info"><strong>{product.name}</strong><small>{product.category} · {businessLabel(product.business)}</small></div>
            <b className="menu-price">{money(product.price)}</b>
            {canMenu(app.role)
              ? <button className="icon-button" aria-label={`Editar ${product.name}`} onClick={() => setEditing(product)}><Pencil size={17}/></button>
              : <span className={`chip ${product.active ? 'chip-on' : 'chip-off'}`}><i/>{product.active ? 'Activo' : 'Oculto'}</span>}
          </li>)}
        </ul>}

    {editing && <ProductForm key={editing.id} app={app} product={editing} close={() => setEditing(null)}/>}
  </>
}

function ProductForm({ app, product, close }: { app: Restaurant; product: Product; close: () => void }) {
  const [hasFee, setHasFee] = useState((product.takeaway_fee || 0) > 0)
  const [fee, setFee] = useState(product.takeaway_fee ? String(product.takeaway_fee / 100) : '')
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState(product)
  const [price, setPrice] = useState(product.price ? String(product.price / 100) : '')

  return <Modal title={product.id ? 'Editar producto' : 'Nuevo producto'} close={close}>
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault()
      if (await app.saveProduct({ ...draft, price: cents(price), takeaway_fee: hasFee ? cents(fee) : 0 })) close()
    }}>
      <label className="photo-field">Foto
        <ProductPhoto app={app} product={draft}/>
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={async event => {
          const file = event.target.files?.[0]
          if (!file) return
          setUploading(true)
          try { const path = await app.uploadProductPhoto(file); setDraft(current => ({ ...current, image_path: path })) }
          catch (error) { app.setError(error instanceof Error ? error.message : 'No se pudo subir la foto.') }
          finally { setUploading(false) }
        }}/>
        {uploading && <span className="tiny">Subiendo foto…</span>}
      </label>
      <label>Nombre<input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Ej. Hamburguesa Palatto"/></label>
      <div className="form-columns">
        <label>Precio ($)<input type="number" inputMode="decimal" step="0.01" min="0.01" max="10000" required value={price} onChange={event => setPrice(event.target.value)}/></label>
        <label>Negocio<select value={draft.business} onChange={event => setDraft({ ...draft, business: event.target.value as Business })}>
          <option value="palatto">Palatto</option><option value="carreta">Aguas y colas</option>
        </select></label>
      </div>
      <label>Categoría<input required value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })} placeholder="Hamburguesas, sorbetes…"/></label>
      <fieldset className="fieldset">
        <legend>Tarifa para llevar</legend>
        <div className="segmented">
          <button type="button" className={!hasFee ? 'active' : ''} aria-pressed={!hasFee} onClick={() => setHasFee(false)}>No aplica</button>
          <button type="button" className={hasFee ? 'active' : ''} aria-pressed={hasFee} onClick={() => setHasFee(true)}>Sí aplica</button>
        </div>
        {hasFee && <label>Adicional por unidad ($)<input type="number" inputMode="decimal" min="0.01" max="10000" step="0.01" required value={fee} onChange={event => setFee(event.target.value)} placeholder="0.50"/></label>}
      </fieldset>
      <label className="switch-row">
        <span><strong>Disponible en el menú</strong><small>Si lo ocultas, no se puede pedir.</small></span>
        <input type="checkbox" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })}/>
      </label>
      {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
      <button className="btn btn-primary btn-lg btn-block" disabled={app.busy || uploading}>{product.id ? 'Guardar cambios' : 'Crear producto'}<Check size={18}/></button>
    </form>
  </Modal>
}

/* ---------------------------------------------------------------- Equipo */

function Team({ app }: { app: Restaurant }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('mesera')

  return <>
    <div className="page-head">
      <div><p className="eyebrow">Cada persona, su función</p><h1>Equipo</h1></div>
      <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={18}/>Agregar</button>
    </div>

    <ul className="team-list">
      {app.data.profiles.map(person => <li className={`team-row ${person.active ? '' : 'inactive'}`} key={person.id}>
        <span className="avatar">{person.name.slice(0, 1)}</span>
        <div className="team-info"><strong>{person.name}</strong><small>{person.active ? labels[person.role] : 'Acceso desactivado'}</small></div>
        <label className="sr-only" htmlFor={`role-${person.id}`}>Rol de {person.name}</label>
        <select id={`role-${person.id}`} value={person.role} disabled={app.busy || person.id === app.profile?.id}
          onChange={event => void app.manageUser({ id: person.id, name: person.name, role: event.target.value as Role, active: person.active })}>
          {roles.map(item => <option key={item} value={item}>{labels[item]}</option>)}
        </select>
        {person.id !== app.profile?.id && <button className="icon-button" aria-label={`${person.active ? 'Desactivar' : 'Activar'} a ${person.name}`} disabled={app.busy}
          onClick={() => void app.manageUser({ id: person.id, name: person.name, role: person.role, active: !person.active })}><Power size={17}/></button>}
      </li>)}
    </ul>

    <details className="roles-guide">
      <summary>¿Qué puede hacer cada rol?</summary>
      {[['Superadmin', 'Acceso total y gestión de usuarios.'], ['Administrador', 'Pedidos, menú y ambas cajas de Palatto.'], ['Cocinero', 'Toma y cobra pedidos de cocina.'], ['Mesera', 'Toma, modifica y cobra pedidos.'], ['Visualizador', 'Solo consulta, sin cambios.']].map(([title, description]) =>
        <div key={title}><strong>{title}</strong><p>{description}</p></div>)}
    </details>

    {adding && <Modal title="Agregar al equipo" close={() => setAdding(false)}>
      <form className="form-stack" onSubmit={async event => {
        event.preventDefault()
        if (await app.manageUser({ name, email, password, role })) { setName(''); setEmail(''); setPassword(''); setAdding(false) }
      }}>
        <label>Nombre<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Ej. Ana Torres"/></label>
        <label>Correo<input type="email" inputMode="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="ana@correo.com"/></label>
        <label>Contraseña inicial<input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={event => setPassword(event.target.value)} placeholder="Mínimo 10 caracteres"/></label>
        <label>Rol<select value={role} onChange={event => setRole(event.target.value as Role)}>{roles.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}><Plus size={18}/>Crear usuario</button>
      </form>
    </Modal>}
  </>
}

/* --------------------------------------------------------------- Piezas */

function ProductPhoto({ app, product }: { app: Restaurant; product: Product }) {
  return product.image_path
    ? <img className="product-photo" src={app.productPhotoUrl(product.image_path)} alt={product.name} loading="lazy"/>
    : <span className="product-photo photo-placeholder" aria-hidden="true">{product.business === 'carreta' ? <Coffee size={22}/> : <Flame size={22}/>}</span>
}
