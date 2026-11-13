import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowDownLeft, ArrowRight, ArrowUpRight, Banknote, BarChart3, Bell, BookOpen, Check, CheckCheck,
  ChevronLeft, ClipboardList, Coffee, CreditCard, Download, Flame, History, KeyRound, LogOut, Minus, PackageOpen,
  Pencil, Plus, Power, Receipt, Search, ShieldCheck, ShoppingBag, Trash2, Users, X,
} from 'lucide-react'
import { Modal } from './Modal'
import { useRestaurant } from './lib/useRestaurant'
import type { Restaurant } from './lib/useRestaurant'
import { itemIsDrink, itemTotal, canCash, canEdit, canMenu, canWrite, cents, labels, money, orderService, orderTotal, roles, total } from './lib/domain'
import type { Business, Item, Method, MovementKind, Order, OrderPayment, Product, Profile, Role } from './lib/domain'
import { analyze, dayKey, paymentTimes } from './lib/analytics'
import { OrderList } from './OrderList'
import { Reports } from './Reports'
import { Inventory } from './Inventory'
import './App.css'

type Page = 'pedidos' | 'nuevo' | 'cajas' | 'menu' | 'equipo' | 'reportes' | 'insumos' | 'cuenta' | 'resumen'
type Route = { page: Page; cashBusiness: Business | null }

const number = (n: number) => String(n)
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
    </section>
  </main>
}

export default function App() {
  const app = useRestaurant()
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null)
  const [installed, setInstalled] = useState(false)
  const [page, setPage] = useState<Page>('pedidos')
  const [editing, setEditing] = useState<Order | undefined>()
  const [cashBusiness, setCashBusiness] = useState<Business | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [payRequest, setPayRequest] = useState<string | null>(null)
  const [history, setHistory] = useState<Route[]>([])
  const historyInitialized = useRef(false)

  useEffect(() => {
    if (historyInitialized.current) return
    historyInitialized.current = true
    window.history.pushState({ palatto: true }, '', window.location.href)
    window.history.pushState({ palatto: true }, '', window.location.href)
  }, [])

  useEffect(() => {
    function onPopState() {
      if (history.length) {
        const previous = history[history.length - 1]
        setHistory(current => current.slice(0, -1))
        setPage(previous.page)
        setCashBusiness(previous.page === 'cajas' ? (previous.cashBusiness ?? 'palatto') : null)
        setEditing(undefined)
        setPayRequest(null)
        app.setError('')
        return
      }

      const wantsHome = window.confirm('¿Quieres salir de Palatto? La aplicación permanecerá abierta en Inicio.')
      if (wantsHome) {
        setPage('pedidos')
        setCashBusiness(null)
        setEditing(undefined)
        setDetail(null)
        setPayRequest(null)
        app.setError('')
      }
      window.history.pushState({ palatto: true }, '', window.location.href)
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [app.setError, history])

  useEffect(() => {
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event) }
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null) }
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true)
    void navigator.serviceWorker?.register('/sw.js').catch(() => undefined)
    window.addEventListener('beforeinstallprompt', onInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (app.loading) return <div className="loading"><img src="/palatto-logo.png" alt="Palatto"/><p>Cargando…</p></div>
  if (!app.profile) return <Login app={app}/>
  if (app.profile.must_change_password) return <PasswordChange app={app} mandatory/>

  const pending = app.data.orders.filter(order => !order.paid).length
  const tabs = [
    { id: 'pedidos', label: 'Inicio', icon: ClipboardList },
    { id: 'insumos', label: 'Insumos', icon: PackageOpen },
    { id: 'nuevo', label: 'Nuevo', icon: Plus },
    { id: 'reportes', label: 'Reportes', icon: BarChart3 },
    { id: 'menu', label: 'Menú', icon: BookOpen },
  ] as const

  function pushCurrent() {
    setHistory(current => [...current, { page, cashBusiness }])
    window.history.pushState({ palatto: true }, '', window.location.href)
  }
  function go(next: Page, cash: Business | null = next === 'cajas' ? 'palatto' : null) {
    if (page !== next || cashBusiness !== cash) pushCurrent()
    setPage(next)
    setCashBusiness(cash)
    setEditing(undefined)
    setPayRequest(null)
    app.setError('')
  }
  function navigate(next: Page) {
    go(next)
  }
  function back() {
    window.history.back()
  }
  function edit(order: Order) {
    if (page !== 'nuevo') pushCurrent()
    setEditing(order)
    setPage('nuevo')
    setCashBusiness(null)
    app.setError('')
  }
  function finishOrder() {
    setEditing(undefined)
    setDetail(null)
    setPayRequest(null)
    setPage('pedidos')
    setCashBusiness(null)
    setHistory([])
    app.setError('')
  }
  function paySaved(id: string) {
    setEditing(undefined)
    setDetail(null)
    setPage('pedidos')
    setCashBusiness(null)
    setHistory([])
    setPayRequest(id)
    app.setError('')
  }

  return <div className="app-shell">
    <header className="app-bar">
      <button className="app-brand" onClick={() => navigate('pedidos')} aria-label="Ir a inicio">
        <img src="/palatto-logo.png" alt=""/>
        <span><strong>Palatto</strong></span>
      </button>
      <div className="app-bar-right">
        {pending > 0 && page !== 'pedidos' && <span className="pending-dot" aria-label={`${pending} pedidos en proceso`}>{pending}</span>}
        <button className="avatar-button" onClick={() => navigate('cuenta')} aria-label="Tu cuenta y ajustes">
          {app.profile.name.slice(0, 1)}
        </button>
      </div>
    </header>

    <main className={`app-main ${page === 'nuevo' ? 'app-main-flush' : ''}`}>
      {app.error && <div className="alert alert-error global-alert" role="alert">
        <span>{app.error}</span>
        <button className="icon-button icon-sm" onClick={() => app.setError('')} aria-label="Cerrar aviso"><X size={16}/></button>
      </div>}

      {page === 'pedidos' && <Home app={app} detail={detail} setDetail={setDetail} payRequest={payRequest} payHandled={() => setPayRequest(null)} onNew={() => navigate('nuevo')} onReport={() => navigate('reportes')} onSummary={() => navigate('resumen')} onCash={business => go('cajas', business)} onEdit={edit}/>}
      {page === 'resumen' && <DailySummary app={app} onCash={business => go('cajas', business)}/>}
      {page === 'reportes' && <Reports app={app}/>}
      {page === 'insumos' && <Inventory app={app}/>}
      {page === 'nuevo' && canWrite(app.role) && <OrderEditor key={editing?.id || 'new'} app={app} order={editing} back={back} done={finishOrder} pay={paySaved}/>}
      {page === 'cajas' && cashBusiness
        ? <Cash app={app} back={back}/>
        : null}
      {page === 'menu' && <Menu app={app}/>}
      {page === 'equipo' && app.role === 'superadmin' && <Team app={app}/>}
      {page === 'cuenta' && <AccountPage app={app} installPrompt={installPrompt} installed={installed} navigate={navigate} onInstall={async () => {
        if (!installPrompt) return
        const prompt = installPrompt as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
        await prompt.prompt()
        if ((await prompt.userChoice).outcome === 'accepted') setInstallPrompt(null)
      }}/>}
    </main>

    {page !== 'nuevo' && page !== 'cuenta' && <nav className="tabbar" aria-label="Navegación principal">
      {tabs.map(tab => <button key={tab.id}
        className={`tab ${page === tab.id || (page === 'resumen' && tab.id === 'pedidos') ? 'active' : ''} ${tab.id === 'nuevo' ? 'tab-new' : ''}`}
        aria-current={page === tab.id || (page === 'resumen' && tab.id === 'pedidos') ? 'page' : undefined}
        onClick={() => navigate(tab.id)}>
        <span className="tab-icon"><tab.icon size={tab.id === 'nuevo' ? 26 : 22} aria-hidden="true"/>
          {tab.id === 'pedidos' && pending > 0 && <i className="tab-badge">{pending}</i>}
        </span>
        <span className="tab-label">{tab.label}</span>
      </button>)}
    </nav>}

    <div className="toast-stack" role="status" aria-live="polite">
      {app.notices.map(item => <div className="toast" key={item.id}>
        <span className="toast-icon"><CheckCheck size={19}/></span>
        <span className="toast-copy"><strong>Listo</strong><span>{item.message}</span></span>
        <button className="toast-close" type="button" aria-label="Cerrar notificación" onClick={() => app.dismissNotice(item.id)}><X size={17}/></button>
      </div>)}
    </div>
  </div>
}

/* ---------------------------------------------------------------- Inicio */

function Home({ app, detail, setDetail, payRequest, payHandled, onNew, onReport, onSummary, onCash, onEdit }: { app: Restaurant; detail: string | null; setDetail: (id: string | null) => void; payRequest: string | null; payHandled: () => void; onNew: () => void; onReport: () => void; onSummary: () => void; onCash: (business: Business) => void; onEdit: (order: Order) => void }) {
  const [filter, setFilter] = useState<'activos' | 'completados' | 'todos'>('activos')
  const [search, setSearch] = useState('')
  const [payment, setPayment] = useState<{ order: Order; split: boolean } | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)

  const orders = app.data.orders.filter(order => {
    const matchesFilter = filter === 'todos' || (filter === 'activos' ? !order.paid : order.paid)
    return matchesFilter && `${order.number} ${order.customer}`.toLowerCase().includes(search.toLowerCase())
  }).sort((a, b) => filter === 'completados'
    ? (b.paid_at || b.created_at).localeCompare(a.paid_at || a.created_at)
    : a.created_at.localeCompare(b.created_at))
  const paymentOrder = app.data.orders.find(order => order.id === payment?.order.id)
  const detailOrder = app.data.orders.find(order => order.id === detail)

  useEffect(() => {
    if (!payRequest) return
    const order = app.data.orders.find(item => item.id === payRequest)
    if (order) {
      setPayment({ order, split: false })
      payHandled()
    }
  }, [payRequest, app.data.orders, payHandled])

  return <>
    <div className="page-head">
      <div><p className="eyebrow">{today()}</p><h1>Pedidos</h1></div>
      {canWrite(app.role) && <button className="home-new" onClick={onNew} aria-label="Nuevo pedido"><Plus size={20}/></button>}
    </div>

    <SalesHero app={app} onReport={onReport} onSummary={onSummary} onCash={onCash}/>

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
      edit={() => onEdit(detailOrder)}
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

function SalesHero({ app, onReport, onSummary, onCash }: { app: Restaurant; onReport: () => void; onSummary: () => void; onCash: (business: Business) => void }) {
  const balance = app.data.movements.reduce((sum, movement) => sum + movement.amount, 0)
  const cash = app.data.movements.filter(movement => movement.method === 'efectivo').reduce((sum, movement) => sum + movement.amount, 0)
  const transfer = app.data.movements.filter(movement => movement.method === 'transferencia').reduce((sum, movement) => sum + movement.amount, 0)

  return <section className="sales-hero" aria-label="Saldo de caja por medio de pago">
    <div className="sales-hero-top">
      <span className="eyebrow">Caja</span>
      <div className="sales-hero-links"><button className="hero-link" onClick={onSummary}>Resumen del día<ArrowRight size={15}/></button><button className="hero-link" onClick={onReport}>Reportes<ArrowUpRight size={15}/></button></div>
    </div>
    <button className="hero-balance" onClick={() => onCash('palatto')} aria-label="Abrir la caja">
      <strong className="hero-amount">{money(balance)}</strong>
      <span className="hero-caption">Saldo total</span>
    </button>
    <div className="hero-day hero-day-methods">
      <button className="hero-method" onClick={() => onCash('palatto')} aria-label="Ver saldo total en efectivo">
        <span className="hero-method-copy"><small>Efectivo</small><strong>{money(cash)}</strong></span>
      </button>
      <button className="hero-method" onClick={() => onCash('palatto')} aria-label="Ver saldo total por transferencia">
        <span className="hero-method-copy"><small>Transferencia</small><strong>{money(transfer)}</strong></span>
      </button>
    </div>
  </section>
}

function OrderDetail({ app, order, close, pay, split, edit, showReceipt }: { app: Restaurant; order: Order; close: () => void; pay: () => void; split: () => void; edit: () => void; showReceipt: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('Pedido cancelado')
  const owed = orderTotal(order)
  const payments = app.data.order_payments.filter(payment => payment.order_id === order.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0)
  const remaining = Math.max(0, owed - paid)
  return <Modal title={`Pedido #${number(order.number)}`} close={close} page>
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
              <small>{dateTime(order.created_at)} · {orderService(order)}</small>
            </div>
            <span className={`chip ${order.paid ? 'chip-done' : 'chip-live'}`}><i aria-hidden="true"/>{order.paid ? 'Cobrado' : 'En proceso'}</span>
          </div>

          <ul className="detail-items">
            {order.items.map(item => <li key={item.product_id}>
              <span>
                <b>{item.quantity}</b> {item.name}
                <small>
                  {itemIsDrink(item) ? 'Agua o cola' : 'Comida'}
                  {!!item.takeaway_quantity && ` · ${item.takeaway_quantity} para llevar`}
                </small>
              </span>
              <span>{money(itemTotal(item))}</span>
            </li>)}
          </ul>

          {order.notes && <p className="detail-note">{order.notes}</p>}

          <div className="detail-total"><span>{payments.length ? 'Total del pedido' : 'Total'}</span><strong>{money(owed)}</strong></div>

          {!!order.adjustment && <p className="detail-adjust">
            <Pencil size={14}/>
            <span>Total ajustado {order.adjustment > 0 ? '+' : ''}{money(order.adjustment)}</span>
          </p>}

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

  return <Modal title={`Cobrar #${number(order.number)}`} close={close} page>
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
  const base = total(order.items)
  const current = orderTotal(order)
  const [method, setMethod] = useState<Method>('efectivo')
  const [received, setReceived] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)
  const [totalInput, setTotalInput] = useState(() => (current / 100).toFixed(2))
  const [formError, setFormError] = useState('')
  const parsed = totalInput.trim() === '' ? current : cents(totalInput)
  const amount = Number.isFinite(parsed) ? parsed : 0
  const changed = amount !== base
  const given = cents(received)
  const change = Math.max(0, given - amount)
  const quick = [...new Set([amount, 500, 1000, 2000, 5000])].filter(value => value >= amount && value > 0).slice(0, 4)

  return <form className="form-stack" onSubmit={async event => {
    event.preventDefault()
    setFormError('')
    if (!Number.isFinite(amount) || amount <= 0) { setFormError('El total debe ser un importe mayor a cero.'); return }
    if (await app.pay(order, method, given, receipt, amount)) close()
  }}>
    <div className="pay-total">
      <span>Total a cobrar</span>
      <strong>{money(amount)}</strong>
      <small>{orderService(order)} · {order.items.reduce((count, item) => count + item.quantity, 0)} artículos</small>
      {changed && <small className="pay-adjust-note">Original {money(base)} · Ajuste {amount > base ? '+' : ''}{money(amount - base)}</small>}
    </div>

    <div className="adjust-box">
      <label>Total final ($)
        <input type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" value={totalInput} onChange={event => { setTotalInput(event.target.value); setFormError('') }}/>
      </label>
      <small className="adjust-hint">Puedes cambiarlo si diste un descuento o hiciste un ajuste.</small>
      {changed && <button type="button" className="link-button" onClick={() => { setTotalInput((base / 100).toFixed(2)); setFormError('') }}>Usar total original ({money(base)})</button>}
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

    {(formError || app.error) && <p className="alert alert-error" role="alert">{formError || app.error}</p>}
    <button className="btn btn-money btn-lg btn-block" disabled={app.busy || order.paid || amount <= 0 || (method === 'transferencia' ? !receipt : given < amount)}>
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
    .map(item => {
      const quantity = picked[item.product_id] || 0
      return {
        ...item,
        quantity,
        takeaway_quantity: item.quantity ? Math.round((item.takeaway_quantity || 0) * quantity / item.quantity) : 0,
      }
    })
    .filter(item => item.quantity > 0)
  const amount = selected.reduce((sum, item) => sum + Math.round(itemTotal(item) / item.quantity) * item.quantity, 0)
  const given = cents(received)
  const change = Math.max(0, given - amount)
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0)
  const owed = orderTotal(order)
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

function ReceiptUpload({ app, value, onChange, title = 'Subir comprobante', hint = 'Foto o archivo JPG, PNG o WebP · máximo 5 MB' }: { app: Restaurant; value: string | null; onChange: (value: string | null) => void; title?: string; hint?: string }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  return <div className="upload">
    <label className={value ? 'upload-box done' : 'upload-box'}>
      {value ? <><CheckCheck size={22}/><strong>{title.replace('Subir ', '')} cargado</strong><span>Toca para cambiarlo</span></> : <><CreditCard size={22}/><strong>{title}</strong><span>{hint}</span></>}
      <input aria-label={title} type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading}
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

function OrderEditor({ app, order, back, done, pay }: { app: Restaurant; order?: Order; back: () => void; done: () => void; pay: (id: string) => void }) {
  const [picker, setPicker] = useState(false)
  const [showNotes, setShowNotes] = useState(Boolean(order?.notes))
  const [items, setItems] = useState<Item[]>(order?.items || [])
  const [notes, setNotes] = useState(order?.notes || '')
  const [reason, setReason] = useState('')

  const itemsTotal = total(items)
  const takeawayFee = items.reduce((sum, item) => sum + (item.takeaway_fee || 0) * (item.takeaway_quantity || 0), 0)
  const quantityTotal = items.reduce((sum, item) => sum + item.quantity, 0)
  const allTakeaway = items.length > 0 && items.every(item => (item.takeaway_quantity || 0) >= item.quantity)
  const nextNumber = order?.number ?? Math.max(0, ...app.data.orders.filter(item => dayKey(item.created_at) === dayKey(new Date())).map(item => item.number)) + 1

  function add(product: Product) {
    setPicker(false)
    setItems(current => {
      const found = current.find(item => item.product_id === product.id)
      return found
        ? current.map(item => item.product_id === product.id ? { ...item, quantity: Math.min(99, item.quantity + 1) } : item)
        : [...current, {
            product_id: product.id,
            name: product.name,
            price: product.price,
            base_price: product.price,
            takeaway_fee: product.takeaway_fee || 0,
            takeaway_quantity: 0,
            is_drink: Boolean(product.is_drink),
            business: product.business,
            quantity: 1,
          }]
    })
  }
  function quantity(id: string, delta: number) {
    setItems(current => current.map(item => item.product_id === id
      ? { ...item, quantity: Math.min(99, item.quantity + delta), takeaway_quantity: Math.min(item.takeaway_quantity || 0, Math.max(0, item.quantity + delta)) }
      : item).filter(item => item.quantity > 0))
  }
  function takeaway(id: string, delta: number) {
    setItems(current => current.map(item => item.product_id === id
      ? { ...item, takeaway_quantity: Math.max(0, Math.min(item.quantity, (item.takeaway_quantity || 0) + delta)) }
      : item))
  }
  function setAllTakeaway(value: boolean) {
    setItems(current => current.map(item => ({ ...item, takeaway_quantity: value ? item.quantity : 0 })))
  }
  async function submit(charge: boolean) {
    if (!items.length) { app.setError('Añade al menos un producto.'); return }
    const saved = await app.saveOrder(order?.customer || 'Pedido', notes, items, order, reason, 0, null, allTakeaway)
    if (!saved) return
    if (charge) pay(saved)
    else done()
  }

  return <div className="editor">
    <header className="editor-bar">
      <button className="icon-button" onClick={back} aria-label="Volver"><ChevronLeft size={22}/></button>
      <div><p className="eyebrow">{order ? 'Corregir' : 'Nuevo'}</p><h1>{order ? `Pedido #${number(order.number)}` : `Pedido #${number(nextNumber)}`}</h1></div>
      <button className="btn btn-ghost btn-sm" onClick={back}>Cancelar</button>
    </header>

    <form className="editor-form" onSubmit={event => { event.preventDefault(); void submit(false) }}>
      <section className="editor-section">
        <div className="section-top"><p className="field-label">Productos</p>{items.length > 0 && <span className="muted small">{quantityTotal} artículos</span>}</div>
        {items.length === 0
          ? <div className="add-first-hint">Aún no has agregado productos.</div>
          : <>
              <label className="takeaway-summary">
                <span className="takeaway-summary-copy">
                  <strong>Para llevar</strong>
                  <small>{allTakeaway ? 'Todos los productos' : 'Pedido para servir'}</small>
                </span>
                <input type="checkbox" role="switch" aria-label="Marcar todos los productos para llevar" checked={allTakeaway} onChange={event => setAllTakeaway(event.target.checked)}/>
              </label>
              <ul className="basket">
                {items.map(item => <li key={item.product_id} className={item.takeaway_quantity ? 'has-takeaway' : ''}>
                  <div className="basket-info">
                    <strong>{item.name}</strong>
                    <small>{itemIsDrink(item) ? 'Agua o cola' : 'Comida'}{item.takeaway_fee ? ` · +${money(item.takeaway_fee)} para llevar` : ''}</small>
                  </div>
                  <div className="stepper">
                    <button type="button" aria-label={`Quitar uno de ${item.name}`} onClick={() => quantity(item.product_id, -1)}><Minus size={16}/></button>
                    <span>{item.quantity}</span>
                    <button type="button" aria-label={`Añadir uno de ${item.name}`} onClick={() => quantity(item.product_id, 1)}
                      disabled={item.quantity >= 99 || !app.data.products.find(product => product.id === item.product_id)?.active}><Plus size={16}/></button>
                  </div>
                  <b className="basket-price">{money(itemTotal(item))}</b>
                  <details className="takeaway-control">
                    <summary aria-label={`Editar servicio de ${item.name}`}>
                      <span>{item.takeaway_quantity ? `${item.takeaway_quantity}/${item.quantity} llevar` : 'Servicio'}</span>
                    </summary>
                    <div className="takeaway-item-edit">
                      <span>Para llevar</span>
                      <div className="stepper stepper-sm">
                        <button type="button" aria-label={`Quitar uno para llevar de ${item.name}`} onClick={() => takeaway(item.product_id, -1)} disabled={!item.takeaway_quantity}><Minus size={12}/></button>
                        <span>{item.takeaway_quantity || 0}</span>
                        <button type="button" aria-label={`Añadir uno para llevar de ${item.name}`} onClick={() => takeaway(item.product_id, 1)} disabled={(item.takeaway_quantity || 0) >= item.quantity}><Plus size={12}/></button>
                      </div>
                      {(item.takeaway_fee || 0) > 0 && <small>+{money(item.takeaway_fee || 0)} por unidad</small>}
                    </div>
                  </details>
                </li>)}
              </ul>
            </>}
        <button type="button" className="btn btn-ghost btn-block" onClick={() => setPicker(true)}><Plus size={18}/>Agregar producto</button>
      </section>

      {takeawayFee > 0 && <p className="note-line">Incluye {money(takeawayFee)} de adicional para llevar.</p>}

      <section className="editor-section">
        <button type="button" className="section-toggle" aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
          <Pencil size={16}/>{showNotes ? 'Ocultar instrucciones' : notes ? 'Editar instrucciones' : 'Añadir instrucciones'}
        </button>
        {showNotes && <textarea id="order-notes" value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} placeholder="Sin cebolla, salsa aparte…" aria-label="Instrucciones para cocina"/>}
      </section>

      {order && <section className="editor-section">
        <label>Motivo de la corrección<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={450} required placeholder="¿Qué cambió y por qué?"/></label>
      </section>}

      {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}

      <div className="editor-foot">
        <div><small>Total</small><strong>{money(itemsTotal)}</strong></div>
        <div className="editor-foot-actions">
          {!order?.paid && <button type="button" className="btn btn-money btn-lg" disabled={app.busy || !items.length} onClick={() => void submit(true)}>
            {app.busy ? 'Guardando…' : 'Cobrar ahora'}<Banknote size={18}/>
          </button>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={app.busy || !items.length}>
            {app.busy ? 'Guardando…' : order ? 'Guardar cambio' : 'Enviar a cocina'}<ArrowRight size={19}/>
          </button>
        </div>
      </div>
    </form>

    {picker && <Modal title="Agregar productos" close={() => setPicker(false)} large>
      <ProductPicker app={app} selected={items} add={add}/>
    </Modal>}
  </div>
}

function ProductPicker({ app, selected, add }: { app: Restaurant; selected: Item[]; add: (product: Product) => void }) {
  const [search, setSearch] = useState('')
  const products = app.data.products.filter(product =>
    product.active && product.name.toLowerCase().includes(search.toLowerCase()))

  return <section className="picker">
    <label className="search"><Search size={18}/><input value={search} onChange={event => setSearch(event.target.value)} autoFocus placeholder="Buscar producto" aria-label="Buscar producto"/></label>
    {!products.length
      ? <Empty title="Sin productos">{search ? 'Prueba otra búsqueda.' : 'Agrega productos desde Menú.'}</Empty>
      : <div className="product-list">
          {products.map(product => {
            const count = selected.find(item => item.product_id === product.id)?.quantity
            return <button key={product.id} className="product-row" onClick={() => add(product)}>
              <span className="product-row-photo"><ProductPhoto app={app} product={product}/></span>
              <span className="product-row-info">
                <strong>{product.name}</strong>
                <small>{product.is_drink ? 'Agua o cola' : 'Comida'}{product.takeaway_fee ? ` · +${money(product.takeaway_fee)} para llevar` : ''}</small>
              </span>
              {count ? <span className="product-row-count">{count}</span> : null}
              <b className="product-row-price">{money(product.price)}</b>
              <span className="add-circle"><Plus size={17}/></span>
            </button>
          })}
        </div>}
  </section>
}

/* ----------------------------------------------------------------- Cajas */

function Cash({ app, back }: { app: Restaurant; back: () => void }) {
  const [form, setForm] = useState<'ingreso' | 'gasto' | 'retiro' | null>(null)
  const [method, setMethod] = useState<Method>('efectivo')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [receipt, setReceipt] = useState<string | null>(null)
  const [viewReceipt, setViewReceipt] = useState<string | null>(null)

  const movements = [...app.data.movements].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const balance = (method: Method) => movements.filter(movement => movement.method === method).reduce((sum, movement) => sum + movement.amount, 0)

  function closeForm() {
    setForm(null)
    setAmount('')
    setReason('')
    setReceipt(null)
  }

  function openForm(next: 'ingreso' | 'gasto' | 'retiro') {
    setForm(next)
    setMethod('efectivo')
  }

  async function showReceipt(path: string) {
    try { setViewReceipt(await app.receiptUrl(path)) } catch (error) { app.setError((error as Error).message) }
  }

  return <>
    <div className="subpage-bar">
      <button className="back-button" onClick={back} aria-label="Volver"><ChevronLeft size={22}/><span>Volver</span></button>
      <div><p className="eyebrow">Palatto</p><h1>Caja</h1></div>
    </div>

    <section className="balance-card">
      <div className="balance-top"><span>Saldo total del negocio</span><span className="balance-state">Disponible</span></div>
      <strong>{money(balance('efectivo') + balance('transferencia'))}</strong>
      <div className="balance-split">
        <span><Banknote size={16}/>Efectivo<b>{money(balance('efectivo'))}</b></span>
        <span><CreditCard size={16}/>Transferencias<b>{money(balance('transferencia'))}</b></span>
      </div>
    </section>

    {canCash(app.role, 'palatto')
      ? <div className="cash-actions">
          <button className="cash-action in" onClick={() => openForm('ingreso')}><Plus size={20}/>Ingresar</button>
          <button className="cash-action expense" onClick={() => openForm('gasto')}><ShoppingBag size={20}/>Gasto</button>
          <button className="cash-action out" onClick={() => openForm('retiro')}><ArrowDownLeft size={20}/>Retirar</button>
        </div>
      : <p className="alert alert-info"><ShieldCheck size={17}/>Solo Administrador y Superadmin ajustan la caja. Los cobros entran automáticamente.</p>}

    <DailyReport app={app}/>

    <section className="stack">
      <div className="section-top"><h2>Movimientos</h2><span className="pill">{movements.length}</span></div>
      {!movements.length
        ? <p className="empty-line">Aquí verás cada ingreso, gasto, retiro y cobro.</p>
        : <ul className="movement-list">
            {movements.map(movement => <li className="movement" key={movement.id}>
              <span className={`movement-icon ${movement.amount < 0 ? 'out' : ''}`}>{movement.amount < 0 ? <ArrowUpRight size={18}/> : <ArrowRight size={18}/>}</span>
              <div><strong>{movement.reason}</strong><small>{movementKindLabel(movement.kind)} · {dateTime(movement.created_at)} · {movement.method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</small></div>
              {movement.receipt && <button type="button" className="movement-receipt" onClick={() => void showReceipt(movement.receipt!)}>Factura</button>}
              <b className={movement.amount < 0 ? 'negative' : 'positive'}>{movement.amount > 0 ? '+' : '−'}{money(Math.abs(movement.amount))}</b>
            </li>)}
          </ul>}
    </section>

    {form && <Modal title={form === 'ingreso' ? 'Ingresar dinero' : form === 'gasto' ? 'Registrar gasto' : 'Retirar de caja'} close={closeForm} page>
      <form className="form-stack" onSubmit={async event => {
        event.preventDefault()
        const value = cents(amount)
        const done = await app.cash('palatto', form === 'retiro' || form === 'gasto' ? -value : value, method, reason, form, form === 'gasto' ? receipt : null)
        if (done) closeForm()
      }}>
        {form === 'gasto' && <p className="alert alert-info">Un gasto es una salida para comprar algo. Un retiro es sacar dinero del negocio.</p>}
        <label>Importe ($)<input type="number" inputMode="decimal" step="0.01" min="0.01" max="1000000" required value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" autoFocus/></label>
        <label>Medio<select value={method} onChange={event => setMethod(event.target.value as Method)}>
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
        </select></label>
        <label>Motivo<textarea rows={2} required minLength={3} maxLength={450} value={reason} onChange={event => setReason(event.target.value)} placeholder={form === 'ingreso' ? 'Fondo para dar suelto' : form === 'gasto' ? 'Compra de hielo, proveedor…' : 'Retiro del dueño'}/></label>
        {form === 'gasto' && <ReceiptUpload app={app} value={receipt} onChange={setReceipt} title="Subir factura" hint="Opcional · foto o archivo JPG, PNG o WebP"/>}
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}>
          {app.busy ? 'Guardando…' : form === 'ingreso' ? 'Ingresar dinero' : form === 'gasto' ? 'Registrar gasto' : 'Retirar dinero'}<Check size={18}/>
        </button>
      </form>
    </Modal>}

    {viewReceipt && <Modal title="Factura del gasto" close={() => setViewReceipt(null)}>
      <img className="receipt-image" src={viewReceipt} alt="Factura del movimiento"/>
    </Modal>}
  </>
}

const reportDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
function DailyReport({ app }: { app: Restaurant }) {
  const [day, setDay] = useState(() => reportDate(new Date().toISOString()))
  const records = app.data.movements.filter(movement => reportDate(movement.created_at) === day)
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

function DailySummary({ app, onCash }: { app: Restaurant; onCash: (business: Business) => void }) {
  const [confirmDrinksWithdrawal, setConfirmDrinksWithdrawal] = useState(false)
  const now = new Date()
  const summary = analyze(app.data.orders, app.data.products, 'hoy', now, paymentTimes(app.data.movements), app.data.order_payments)
  const todayKey = reportDate(now.toISOString())
  const movements = app.data.movements.filter(movement => reportDate(movement.created_at) === todayKey).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const sum = (kind: MovementKind) => movements.filter(movement => movement.kind === kind).reduce((value, movement) => value + movement.amount, 0)
  const drinksCashSales = movements.filter(movement => movement.business === 'carreta' && movement.method === 'efectivo' && (movement.kind === 'cobro' || movement.kind === 'correccion')).reduce((value, movement) => value + movement.amount, 0)
  const drinksWithdrawalReason = `Retiro diario de aguas y colas · ${todayKey}`
  const drinksCashWithdrawn = movements.filter(movement => movement.business === 'carreta' && movement.method === 'efectivo' && movement.kind === 'retiro' && movement.reason === drinksWithdrawalReason).reduce((value, movement) => value + Math.abs(movement.amount), 0)
  const drinksCashPending = Math.max(0, drinksCashSales - drinksCashWithdrawn)
  const drinksCashBalance = app.data.movements.filter(movement => movement.business === 'carreta' && movement.method === 'efectivo').reduce((value, movement) => value + movement.amount, 0)
  const expenses = Math.max(0, -sum('gasto'))
  const cashBalance = app.data.movements.reduce((value, movement) => value + movement.amount, 0)
  const balanceByMethod = (method: Method) => app.data.movements.filter(movement => movement.method === method).reduce((value, movement) => value + movement.amount, 0)
  const chartMax = Math.max(summary.revenue, expenses, cashBalance, 1)
  const drinksCanBeWithdrawn = drinksCashPending > 0 && drinksCashBalance >= drinksCashPending
  async function withdrawDrinksCash() {
    const success = await app.cash('carreta', -drinksCashPending, 'efectivo', drinksWithdrawalReason, 'retiro')
    if (success) setConfirmDrinksWithdrawal(false)
  }
  return <div className="daily-summary-page">
    <div className="page-heading"><div><p className="eyebrow">Palatto · {new Date(todayKey + 'T12:00:00').toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })}</p><h1>Resumen del día</h1></div></div>
    <div className="daily-summary-grid">
      <article className="daily-summary-stat sales"><small>Vendido hoy</small><strong>{money(summary.revenue)}</strong><span>Confirmado al cobrar</span></article>
      <article className="daily-summary-stat orders"><small>Pedidos cobrados</small><strong>{summary.orders}</strong><span>En el día</span></article>
      {canCash(app.role, 'carreta')
        ? <button type="button" className="daily-summary-stat drinks drinks-button" disabled={!drinksCanBeWithdrawn || app.busy} onClick={() => setConfirmDrinksWithdrawal(true)} aria-label={`Retirar ${money(drinksCashPending)} en efectivo de la caja de aguas y colas`}>
            <small>Aguas y colas</small><strong>{money(drinksCashPending)}</strong><span>{drinksCashBalance < drinksCashPending ? 'Efectivo insuficiente en la caja' : 'Efectivo cobrado hoy pendiente de retirar'}</span>
            <ArrowDownLeft className="drinks-action-indicator" size={16}/>
          </button>
        : <article className="daily-summary-stat drinks"><small>Aguas y colas</small><strong>{money(drinksCashPending)}</strong><span>Efectivo cobrado hoy pendiente de retirar</span></article>}
      <article className="daily-summary-stat cash"><small>Saldo en caja</small><strong>{money(cashBalance)}</strong><span>Efectivo y transferencias</span></article>
    </div>
    {confirmDrinksWithdrawal && <Modal title="Retirar de caja" close={() => setConfirmDrinksWithdrawal(false)}>
      <div className="dialog-body form-stack">
        <p>¿Quieres retirar {money(drinksCashPending)} en efectivo de la caja de aguas y colas?</p>
        <div className="editor-foot-actions">
          <button type="button" className="btn btn-ghost" disabled={app.busy} onClick={() => setConfirmDrinksWithdrawal(false)}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={app.busy} onClick={() => void withdrawDrinksCash()}>{app.busy ? 'Retirando…' : 'Sí, retirar'}</button>
        </div>
      </div>
    </Modal>}
    <section className="summary-payment-breakdown" aria-label="Desglose de efectivo y transferencias">
      <div><h2>Cobros de hoy</h2><p><span><Banknote size={16}/>Efectivo</span><b>{money(summary.byMethod.efectivo.revenue)}</b></p><p><span><CreditCard size={16}/>Transferencias</span><b>{money(summary.byMethod.transferencia.revenue)}</b></p>
        <small>{summary.byMethod.efectivo.orders} {summary.byMethod.efectivo.orders === 1 ? 'pedido' : 'pedidos'} en efectivo · {summary.byMethod.transferencia.orders} por transferencia.</small>
      </div>
      <div><h2>Saldo disponible</h2><p><span><Banknote size={16}/>Efectivo</span><b>{money(balanceByMethod('efectivo'))}</b></p><p><span><CreditCard size={16}/>Transferencias</span><b>{money(balanceByMethod('transferencia'))}</b></p></div>
    </section>
    <section className="summary-figure" aria-label="Gráfica de ventas, saldo en caja y gastos"><div className="summary-figure-heading"><div><span className="eyebrow">Vista rápida</span><h2>Así va el día</h2></div><span className="summary-figure-mark"><BarChart3 size={19}/></span></div>
      {[['Vendido', summary.revenue, 'sales'], ['En caja', cashBalance, 'cash'], ['Gastado', expenses, 'expenses']].map(([label, value, style]) => <div className="summary-bar-row" key={String(label)}><div><span>{label}</span><b>{money(Number(value))}</b></div><span className="summary-bar-track"><i className={String(style)} style={{ width: `${Math.max(2, Number(value) / chartMax * 100)}%` }}/></span></div>)}
    </section>
    <button className="daily-register-card summary-cash-link" onClick={() => onCash('palatto')}><span><small>Detalle</small><strong>Abrir movimientos de caja</strong></span><ArrowRight size={18}/></button>
    <section className="daily-summary-log">
      <div className="section-heading"><h2>Movimientos de hoy</h2><span className="pill">{movements.length}</span></div>
      {!movements.length ? <div className="empty"><div className="empty-icon"><Receipt size={26}/></div><h3>Aún no hay movimientos</h3><p>Los cobros y gastos aparecerán aquí en cuanto se registren.</p></div> : <div className="movement-list">
        {movements.map(movement => <div className="movement" key={movement.id}>
          <span className={`movement-icon ${movement.amount < 0 ? 'out' : ''}`}>{movement.amount < 0 ? <ArrowDownLeft size={17}/> : <ArrowUpRight size={17}/>}</span>
          <div><strong>{movement.reason}</strong><small>{movementKindLabel(movement.kind)} · {dateTime(movement.created_at)} · {movement.method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</small></div>
          <b className={movement.amount < 0 ? 'negative' : 'positive'}>{movement.amount < 0 ? '−' : '+'}{money(Math.abs(movement.amount))}</b>
        </div>)}
      </div>}
    </section>
  </div>
}

/* ------------------------------------------------------------------ Menú */

function Menu({ app }: { app: Restaurant }) {
  const [editing, setEditing] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const [search, setSearch] = useState('')
  const blank: Product = { id: '', name: '', price: 0, business: 'palatto', category: 'General', active: true, is_drink: false }
  const products = app.data.products.filter(product => product.name.toLowerCase().includes(search.trim().toLowerCase()))

  return <>
    <div className="page-head">
      <div><p className="eyebrow">Lo que preparamos</p><h1>Menú</h1></div>
      {canMenu(app.role) && <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={18}/>Agregar</button>}
    </div>

    <label className="search menu-search">
      <Search size={18} aria-hidden="true"/>
      <input aria-label="Buscar producto" placeholder="Buscar en el menú" value={search} onChange={event => setSearch(event.target.value)}/>
    </label>

    {!products.length
      ? <Empty title={search ? 'No encontramos ese producto' : 'Tu menú está vacío'} action={!search && canMenu(app.role) ? <button className="btn btn-primary" onClick={() => setEditing(blank)}><Plus size={18}/>Agregar producto</button> : undefined}>
          {search ? 'Prueba con otro nombre.' : 'Agrega los productos y sus precios.'}
        </Empty>
      : <ul className="menu-list">
          {products.map(product => <li className={`menu-row ${product.active ? '' : 'is-hidden'}`} key={product.id}>
            <ProductPhoto app={app} product={product}/>
            <div className="menu-info">
              <strong>{product.name}</strong>
              <small>{product.is_drink ? 'Agua o cola' : 'Comida'}{product.takeaway_fee ? ` · +${money(product.takeaway_fee)} para llevar` : ''}</small>
            </div>
            <b className="menu-price">{money(product.price)}</b>
            {canMenu(app.role)
              ? <div className="menu-actions">
                  <button className="icon-button" aria-label={`Editar ${product.name}`} onClick={() => setEditing(product)}><Pencil size={17}/></button>
                  <button className="icon-button danger" aria-label={`Eliminar ${product.name}`} onClick={() => setDeleting(product)}><Trash2 size={17}/></button>
                </div>
              : <span className={`chip ${product.active ? 'chip-on' : 'chip-off'}`}><i/>{product.active ? 'Activo' : 'Oculto'}</span>}
          </li>)}
        </ul>}

    {editing && <ProductForm key={editing.id} app={app} product={editing} close={() => setEditing(null)}/>}

    {deleting && <Modal title="Eliminar producto" close={() => setDeleting(null)}>
      <div className="form-stack">
        <div className="alert alert-danger">
          <Trash2 size={20}/>
          <div><strong>{deleting.name}</strong><p>Dejará de aparecer en el menú. Los pedidos anteriores conservan su nombre y precio.</p></div>
        </div>
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-danger btn-block btn-lg" disabled={app.busy} onClick={async () => { if (await app.deleteProduct(deleting)) setDeleting(null) }}>
          <Trash2 size={18}/>{app.busy ? 'Eliminando…' : 'Sí, eliminar producto'}
        </button>
        <button className="btn btn-ghost btn-block" disabled={app.busy} onClick={() => setDeleting(null)}>Volver</button>
      </div>
    </Modal>}
  </>
}

function ProductForm({ app, product, close }: { app: Restaurant; product: Product; close: () => void }) {
  const [hasFee, setHasFee] = useState((product.takeaway_fee || 0) > 0)
  const [fee, setFee] = useState(product.takeaway_fee ? String(product.takeaway_fee / 100) : '')
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState(product)
  const [price, setPrice] = useState(product.price ? String(product.price / 100) : '')

  function applyFee() {
    setHasFee(true)
    if (!fee.trim()) setFee('0.25')
  }

  return <Modal title={product.id ? 'Editar producto' : 'Nuevo producto'} close={close} page>
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault()
      if (await app.saveProduct({
        ...draft,
        price: cents(price),
        takeaway_fee: hasFee ? cents(fee) : 0,
        business: draft.is_drink ? 'carreta' : 'palatto',
        category: draft.is_drink ? 'Aguas y colas' : 'General',
      })) close()
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
      <label>Precio ($)<input type="number" inputMode="decimal" step="0.01" min="0.01" max="10000" required value={price} onChange={event => setPrice(event.target.value)}/></label>
      <label className="switch-row">
        <span><strong>Es agua o cola</strong><small>Se suma aparte en el resumen del día.</small></span>
        <input type="checkbox" checked={Boolean(draft.is_drink)} onChange={event => setDraft({ ...draft, is_drink: event.target.checked })}/>
      </label>
      <fieldset className="fieldset">
        <legend>Tarifa para llevar</legend>
        <div className="segmented">
          <button type="button" className={!hasFee ? 'active' : ''} aria-pressed={!hasFee} onClick={() => setHasFee(false)}>No aplica</button>
          <button type="button" className={hasFee ? 'active' : ''} aria-pressed={hasFee} onClick={applyFee}>Sí aplica</button>
        </div>
        {hasFee && <label>Adicional por unidad ($)<input type="number" inputMode="decimal" min="0.01" max="10000" step="0.01" required value={fee} onChange={event => setFee(event.target.value)} placeholder="0.25"/></label>}
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
  const [password, setPassword] = useState(() => temporaryPassword())
  const [role, setRole] = useState<Role>('mesera')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'activos' | 'todos' | 'inactivos'>('activos')
  const [copied, setCopied] = useState(false)
  const [emails, setEmails] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Profile | null>(null)
  const [credential, setCredential] = useState<{ id: string; email: string; password: string } | null>(null)
  const [credentialCopied, setCredentialCopied] = useState(false)
  const [teamError, setTeamError] = useState('')
  const people = app.data.profiles.filter(person =>
    (filter === 'todos' || (filter === 'activos' ? person.active : !person.active)) && person.name.toLowerCase().includes(search.trim().toLowerCase()))
  const activeCount = app.data.profiles.filter(person => person.active).length

  useEffect(() => {
    let alive = true
    void app.getManagedUsers().then(users => {
      if (alive) setEmails(Object.fromEntries(users.map(user => [user.id, user.email])))
    }).catch(error => { if (alive) setTeamError(error instanceof Error ? error.message : 'No se pudieron cargar los correos.') })
    return () => { alive = false }
  }, [app.profile?.id])

  return <>
    <div className="page-head team-page-head">
      <div><p className="eyebrow">Accesos de Palatto</p><h1>Equipo</h1><p className="muted">{activeCount} cuentas activas · {app.data.profiles.length - activeCount} desactivadas</p></div>
      <button className="btn btn-primary" onClick={() => { setPassword(temporaryPassword()); setAdding(true); setCopied(false) }}><Plus size={18}/>Crear cuenta</button>
    </div>

    <section className="team-tools" aria-label="Buscar y filtrar cuentas">
      <label className="search"><Search size={18}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por nombre" aria-label="Buscar por nombre"/></label>
      <div className="segmented" role="group" aria-label="Estado de las cuentas">
        {([['activos', 'Activas'], ['todos', 'Todas'], ['inactivos', 'Desactivadas']] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
      </div>
    </section>

    <ul className="team-list team-cards">
      {people.map(person => <li className={`team-row ${person.active ? '' : 'inactive'}`} key={person.id}>
        <button className="team-person" onClick={() => { setSelected(person); setCredential(null); setTeamError('') }} aria-label={`Ver cuenta de ${person.name}`}><span className="avatar avatar-lg">{person.name.slice(0, 1)}</span><div className="team-info"><strong>{person.name}</strong><small>{person.active ? 'Cuenta activa' : 'Acceso pausado'}{person.id === app.profile?.id ? ' · Tú' : ''}</small><span className="team-email-preview">{emails[person.id] || 'Ver datos de acceso'}</span></div><ArrowRight size={17}/></button>
        <label className="team-role-label" htmlFor={`role-${person.id}`}>Rol</label>
        <select id={`role-${person.id}`} value={person.role} disabled={app.busy || person.id === app.profile?.id}
          onChange={event => void app.manageUser({ id: person.id, name: person.name, role: event.target.value as Role, active: person.active })}>
          {roles.map(item => <option key={item} value={item}>{labels[item]}</option>)}
        </select>
        {person.id !== app.profile?.id && <button className={`team-access ${person.active ? '' : 'paused'}`} disabled={app.busy}
          onClick={() => void app.manageUser({ id: person.id, name: person.name, role: person.role, active: !person.active })}><Power size={16}/>{person.active ? 'Desactivar' : 'Activar'}</button>}
      </li>)}
      {!people.length && <li className="team-empty">No hay cuentas que coincidan con esta búsqueda.</li>}
    </ul>

    <details className="roles-guide">
      <summary>¿Qué puede hacer cada rol?</summary>
      {[['Superadmin', 'Acceso total y gestión de usuarios.'], ['Administrador', 'Pedidos, menú y caja de Palatto.'], ['Cocinero', 'Toma y cobra pedidos de cocina.'], ['Mesera', 'Toma, modifica y cobra pedidos.'], ['Mesero', 'Toma, modifica y cobra pedidos.'], ['Visualizador', 'Solo consulta, sin cambios.']].map(([title, description]) =>
        <div key={title}><strong>{title}</strong><p>{description}</p></div>)}
    </details>

    {adding && <Modal title="Agregar al equipo" close={() => setAdding(false)} page>
      <form className="form-stack" onSubmit={async event => {
        event.preventDefault()
        if (await app.manageUser({ name, email, password, role })) { setName(''); setEmail(''); setPassword(temporaryPassword()); setAdding(false) }
      }}>
        <label>Nombre<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Ej. Ana Torres"/></label>
        <label>Correo<input type="email" inputMode="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="ana@correo.com"/></label>
        <div className="temporary-password"><label>Contraseña temporal<input type="text" autoComplete="off" required minLength={10} value={password} onChange={event => setPassword(event.target.value)} spellCheck={false}/></label>
          <div className="temporary-actions"><button type="button" className="btn btn-ghost" onClick={() => { setPassword(temporaryPassword()); setCopied(false) }}><History size={17}/>Generar otra</button>
            <button type="button" className="btn btn-ghost" onClick={() => { void navigator.clipboard.writeText(password); setCopied(true) }}><ClipboardList size={17}/>{copied ? 'Copiada' : 'Copiar'}</button></div>
          <small>Compártela directamente con la persona. Se le pedirá cambiarla al ingresar.</small>
        </div>
        <label>Rol<select value={role} onChange={event => setRole(event.target.value as Role)}>{roles.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
        {app.error && <p className="alert alert-error" role="alert">{app.error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}><Plus size={18}/>Crear usuario</button>
      </form>
    </Modal>}

    {selected && <Modal title="Datos de acceso" close={() => setSelected(null)} page>
      <div className="team-account-details">
        <div className="team-account-identity"><span className="avatar avatar-lg">{selected.name.slice(0, 1)}</span><div><strong>{selected.name}</strong><small>{labels[selected.role]}</small></div></div>
        <div className="credential-field"><small>Correo de ingreso</small><strong>{emails[selected.id] || 'Cargando correo…'}</strong></div>
        <div className="credential-field"><small>Contraseña</small>{credential?.id === selected.id
          ? <><code>{credential.password}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard.writeText(credential.password).then(() => setCredentialCopied(true)) }}><ClipboardList size={16}/>{credentialCopied ? 'Copiada' : 'Copiar contraseña'}</button></>
          : <p>La contraseña actual está protegida y no se puede recuperar. Puedes generar una nueva contraseña temporal.</p>}</div>
        {teamError && <p className="alert alert-error" role="alert">{teamError}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={app.busy} onClick={async () => {
          const result = await app.resetUserPassword(selected.id)
          if (result) { setCredential({ id: selected.id, email: result.email, password: result.temporaryPassword }); setEmails(current => ({ ...current, [selected.id]: result.email })); setCredentialCopied(false) }
        }}><KeyRound size={18}/>Generar contraseña temporal</button>
        <p className="tiny">Al iniciar sesión, la persona deberá cambiar la contraseña temporal.</p>
      </div>
    </Modal>}
  </>
}

function temporaryPassword() {
  return `Pala-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}!`
}

function PasswordChange({ app, mandatory = false }: { app: Restaurant; mandatory?: boolean }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [message, setMessage] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setMessage('')
    if (password.length < 10) { setMessage('Usa al menos 10 caracteres.'); return }
    if (password !== confirm) { setMessage('Las contraseñas no coinciden.'); return }
    await app.changePassword(password)
  }
  const form = <form className="form-stack" onSubmit={event => void submit(event)}>
      <label>Nueva contraseña<input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={10} value={password} onChange={event => setPassword(event.target.value)} required/></label>
      <label>Repite la contraseña<input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={10} value={confirm} onChange={event => setConfirm(event.target.value)} required/></label>
      <label className="check-row"><input type="checkbox" checked={show} onChange={event => setShow(event.target.checked)}/>Mostrar contraseñas</label>
      {(message || app.error) && <p className="alert alert-error" role="alert">{message || app.error}</p>}
      <button className="btn btn-primary btn-lg btn-block" disabled={app.busy}>{app.busy ? 'Guardando…' : 'Guardar contraseña'}<Check size={18}/></button>
    </form>
  if (!mandatory) return <div className="password-inline"><div className="signin-heading"><h2>Cambiar contraseña</h2><p>Usa una contraseña que no compartas con otras cuentas.</p></div>{form}</div>
  return <main className="signin"><section className="signin-card password-card">
    <img className="signin-logo" src="/palatto-logo.png" alt="Palatto"/>
    <div className="signin-heading"><h1>Crea tu contraseña</h1><p>Tu contraseña temporal es de un solo uso. Elige una personal para continuar.</p></div>
    {form}
  </section></main>
}

function AccountPage({ app, installPrompt, installed, navigate, onInstall }: { app: Restaurant; installPrompt: Event | null; installed: boolean; navigate: (page: Page) => void; onInstall: () => void }) {
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMessage, setPushMessage] = useState('')
  const [pushEnabled, setPushEnabled] = useState(false)
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    void navigator.serviceWorker.ready.then(async registration => setPushEnabled(Boolean(await registration.pushManager.getSubscription()))).catch(() => undefined)
  }, [])
  async function togglePush() {
    setPushBusy(true); setPushMessage('')
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Este navegador no admite notificaciones push.')
      const registration = await navigator.serviceWorker.ready
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await app.push({ action: 'unsubscribe', endpoint: current.endpoint })
        await current.unsubscribe()
        setPushEnabled(false); setPushMessage('Notificaciones desactivadas en este dispositivo.')
      } else {
        if (!vapidPublicKey) throw new Error('Falta añadir VITE_VAPID_PUBLIC_KEY en Vercel para habilitar las notificaciones.')
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') throw new Error('Permite las notificaciones para poder activarlas.')
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(vapidPublicKey) })
        await app.push({ action: 'subscribe', subscription: subscription.toJSON() })
        setPushEnabled(true); setPushMessage('Este dispositivo recibirá avisos de cambios importantes en Palatto.')
      }
    } catch (error) { setPushMessage(error instanceof Error ? error.message : 'No se pudieron actualizar las notificaciones.') }
    finally { setPushBusy(false) }
  }
  return <div className="settings-page">
    <div className="page-head"><div><p className="eyebrow">Preferencias personales</p><h1>Tu cuenta</h1></div></div>
    <section className="account-profile-card">
      <span className="avatar avatar-lg">{app.profile!.name.slice(0, 1)}</span>
      <div><strong>{app.profile!.name}</strong><small>{labels[app.role]}</small></div>
      <span className="account-status"><Check size={15}/>Activa</span>
    </section>
    <section className="settings-card">
      <div className="settings-card-title"><ShieldCheck size={20}/><div><h2>Seguridad</h2><p>Actualiza tu clave cuando quieras.</p></div></div>
      <button className="account-link" onClick={() => setPasswordOpen(value => !value)}><span>{passwordOpen ? 'Cerrar cambio de contraseña' : 'Cambiar contraseña'}</span><ArrowRight size={18}/></button>
      {passwordOpen && <PasswordChange app={app}/>}
    </section>
    <section className="settings-card">
      <div className="settings-card-title"><Bell size={20}/><div><h2>Notificaciones</h2><p>Recibe avisos de pedidos, caja, menú e insumos.</p></div></div>
      <button className={`btn ${pushEnabled ? 'btn-ghost' : 'btn-primary'} btn-block`} disabled={pushBusy} onClick={() => void togglePush()}>{pushBusy ? 'Actualizando…' : pushEnabled ? 'Desactivar en este dispositivo' : 'Activar notificaciones'}<Bell size={17}/></button>
      {pushMessage && <p className="tiny" role="status">{pushMessage}</p>}
      {typeof Notification !== 'undefined' && Notification.permission === 'denied' && <p className="tiny">El navegador bloqueó los avisos. Cámbialo en los permisos del sitio.</p>}
    </section>
    <section className="settings-card">
      <div className="settings-card-title"><Download size={20}/><div><h2>Instalar Palatto</h2><p>Abre la app desde tu pantalla de inicio.</p></div></div>
      {installed ? <p className="install-state"><Check size={17}/>Palatto ya está instalada en este dispositivo.</p>
        : installPrompt ? <button className="btn btn-primary btn-block" onClick={onInstall}>Instalar aplicación<Download size={17}/></button>
        : <p className="install-help">En el menú del navegador, elige <strong>Instalar aplicación</strong> o <strong>Añadir a pantalla principal</strong>.</p>}
    </section>
    <div className="account-links">
      <button className="account-link" onClick={() => navigate('insumos')}><PackageOpen size={20}/><span>Insumos y stock</span><ArrowRight size={18}/></button>
      {app.role === 'superadmin' && <button className="account-link" onClick={() => navigate('equipo')}><Users size={20}/><span>Equipo y cuentas</span><ArrowRight size={18}/></button>}
    </div>
    <button className="btn btn-ghost btn-block" disabled={app.busy} onClick={() => void app.logout()}><LogOut size={18}/>Cerrar sesión</button>
  </div>
}

function decodeVapidKey(key: string) {
  const normalized = key.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '='))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

/* --------------------------------------------------------------- Piezas */

function ProductPhoto({ app, product }: { app: Restaurant; product: Product }) {
  return product.image_path
    ? <img className="product-photo" src={app.productPhotoUrl(product.image_path)} alt={product.name} loading="lazy"/>
    : <span className="product-photo photo-placeholder" aria-hidden="true">{product.is_drink ? <Coffee size={22}/> : <Flame size={22}/>}</span>
}
