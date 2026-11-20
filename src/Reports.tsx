import { useMemo, useState } from 'react'
import { Banknote, Coffee, CreditCard, Download, ShoppingBag, TrendingUp, Wallet } from 'lucide-react'
import type { Restaurant } from './lib/useRestaurant'
import type { RangeKey } from './lib/analytics'
import { analyze, dailyTrend, dayKey, paymentTimes, rangeDays, rangeLabels, salesCsv } from './lib/analytics'
import { displayNumber, displayNumericText, money } from './lib/domain'

const ranges: RangeKey[] = ['hoy', 'ayer', '7d', 'quincena', 'mes']

export function Reports({ app }: { app: Restaurant }) {
  const [range, setRange] = useState<RangeKey>('hoy')
  const paidAt = useMemo(() => paymentTimes(app.data.movements), [app.data.movements])
  const now = new Date()
  const days = rangeDays(range, now)
  const data = useMemo(() => analyze(app.data.orders, app.data.products, range, now, paidAt, app.data.order_payments), [app.data.orders, app.data.products, app.data.order_payments, range, paidAt])
  const history = useMemo(() => analyze(app.data.orders, app.data.products, 'todo', now, paidAt, app.data.order_payments), [app.data.orders, app.data.products, app.data.order_payments, paidAt])
  const series = useMemo(() => range === 'hoy'
    ? data.byHour.map(hour => ({ label: `${displayNumber(String(hour.hour).padStart(2, '0'))}h`, value: hour.revenue, hint: `${displayNumber(String(hour.hour).padStart(2, '0'))}:00 · ${displayNumber(hour.orders)} pedidos` }))
    : dailyTrend(app.data.orders, Math.max(days.length, 1), now, paidAt).map(day => ({
      label: displayNumericText(new Date(`${day.day}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })), value: day.revenue,
      hint: `${displayNumericText(new Date(`${day.day}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' }))} · ${displayNumber(day.orders)} pedidos`,
    })), [app.data.orders, data.byHour, days.length, now, paidAt, range])
  const movements = useMemo(() => app.data.movements.filter(movement => days.includes(dayKey(movement.created_at))), [app.data.movements, days])
  const expenses = Math.max(0, -movements.filter(movement => movement.kind === 'gasto').reduce((sum, movement) => sum + movement.amount, 0))
  const profit = data.revenue - expenses
  const cashBalance = app.data.movements.reduce((sum, movement) => sum + movement.amount, 0)
  const drinksUnits = data.byProduct.filter(product => product.business === 'carreta').reduce((sum, product) => sum + product.quantity, 0)
  const drinksShare = data.revenue ? Math.round(data.drinksRevenue / data.revenue * 100) : 0
  const topProducts = data.byProduct.slice(0, 6)
  const allTimeTop = [...history.byProduct].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 10)
  const methods = [
    { key: 'efectivo' as const, label: 'Efectivo', icon: Banknote, fill: 'green', value: data.byMethod.efectivo.revenue, count: data.byMethod.efectivo.orders },
    { key: 'transferencia' as const, label: 'Transferencia', icon: CreditCard, fill: 'blue', value: data.byMethod.transferencia.revenue, count: data.byMethod.transferencia.orders },
  ]
  const maxValue = Math.max(...series.map(point => point.value), 1)
  const peakIndex = series.reduce((best, point, index) => point.value > series[best].value ? index : best, 0)
  const positiveValues = series.filter(point => point.value > 0).map(point => point.value)
  const lowValue = positiveValues.length ? Math.min(...positiveValues) : 0
  const hasSales = data.revenue > 0
  const width = 720, height = 250, left = 22, right = width - 22, baseline = 194, top = 28
  const points = series.map((point, index) => ({
    ...point,
    x: series.length < 2 ? width / 2 : left + index * (right - left) / (series.length - 1),
    y: baseline - point.value / maxValue * (baseline - top),
  }))
  const line = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const area = `${line} L ${points.at(-1)?.x ?? width / 2} ${baseline} L ${points[0]?.x ?? width / 2} ${baseline} Z`
  const labelsToShow = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])

  function exportCsv() {
    const csv = salesCsv(app.data.orders, app.data.products, range, now, paidAt, app.data.order_payments)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `palatto-ventas-${range}-${dayKey(now)}.csv`
    document.body.append(link)
    link.click(); link.remove(); URL.revokeObjectURL(url)
  }

  return <div className="reports-simple">
    <div className="page-heading">
      <div><p className="eyebrow">Ventas y resultados</p><h1>Reportes</h1></div>
      <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!hasSales}><Download size={17}/>CSV</button>
    </div>

    <div className="segmented report-range-simple" role="group" aria-label="Periodo del reporte">
      {ranges.map(key => <button type="button" key={key} className={range === key ? 'active' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{displayNumericText(rangeLabels[key])}</button>)}
    </div>

    <section className="report-total-card">
      <small>Vendido · {displayNumericText(rangeLabels[range])}</small>
      <strong>{money(data.revenue)}</strong>
      <span>{displayNumber(data.orders)} pedidos · {displayNumber(data.itemsSold)} artículos · ticket {money(data.averageTicket)}</span>
    </section>

    <div className="report-kpis">
      <article className="report-kpi">
        <span className="report-kpi-icon"><ShoppingBag size={19}/></span>
        <div><small>Gastos</small><strong>{money(expenses)}</strong><span>{displayNumber(movements.filter(movement => movement.kind === 'gasto').length)} salidas</span></div>
      </article>
      <article className="report-kpi">
        <span className="report-kpi-icon"><TrendingUp size={19}/></span>
        <div><small>Balance</small><strong>{money(profit)}</strong><span>Ventas menos gastos</span></div>
      </article>
      <article className="report-kpi">
        <span className="report-kpi-icon"><Wallet size={19}/></span>
        <div><small>Saldo en caja</small><strong>{money(cashBalance)}</strong><span>Histórico disponible</span></div>
      </article>
      <article className="report-kpi">
        <span className="report-kpi-icon"><Coffee size={19}/></span>
        <div><small>Aguas y colas</small><strong>{money(data.drinksRevenue)}</strong><span>{displayNumber(drinksUnits)} unidades · {displayNumber(drinksShare)}%</span></div>
      </article>
    </div>

    <section className="report-card">
      <div className="report-card-heading"><div><h2>Medios de pago</h2><p>Total cobrado por cada medio.</p></div></div>
      {methods.map(method => {
        const share = data.revenue ? Math.round(method.value / data.revenue * 100) : 0
        return <div className="split-row" key={method.key}>
          <div className="split-label"><span><span><method.icon size={15}/>{method.label}</span><small>{displayNumber(method.count)} pedidos · {displayNumber(share)}%</small></span><b>{money(method.value)}</b></div>
          <span className="split-track"><i className={`split-fill ${method.fill}`} style={{ width: `${Math.max(method.value > 0 ? 3 : 0, share)}%` }}/></span>
        </div>
      })}
    </section>

    <section className="report-chart-card report-card">
      <div className="report-chart-heading"><div><h2>{range === 'hoy' ? 'Ventas por hora' : 'Tendencia de ventas'}</h2><p>{range === 'hoy' ? 'Hora de Ecuador' : 'Ventas por día'}</p></div>
        <span className="chart-peak"><TrendingUp size={16}/>{hasSales ? money(series[peakIndex]?.value || 0) : money(0)}</span>
      </div>
      {hasSales ? <>
        <svg className="sales-line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Gráfico de ventas para ${rangeLabels[range]}`}>
          <defs><linearGradient id="sales-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--copper)" stopOpacity=".32"/><stop offset="100%" stopColor="var(--copper)" stopOpacity="0"/></linearGradient></defs>
          {[top, top + (baseline - top) / 2, baseline].map(y => <line key={y} x1={left} x2={right} y1={y} y2={y} className="chart-grid-line"/>)}
          <path d={area} fill="url(#sales-area)"/>
          <path d={line} className="sales-chart-line"/>
          {points.map((point, index) => <g key={`${point.label}-${index}`}><circle cx={point.x} cy={point.y} r={index === peakIndex ? 6 : 3.3} className={index === peakIndex ? 'chart-point peak' : 'chart-point'}><title>{point.hint}: {money(point.value)}</title></circle></g>)}
          {points.map((point, index) => labelsToShow.has(index) && <text key={`label-${index}`} x={point.x} y="232" className="chart-axis-label" textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{point.label}</text>)}
        </svg>
        <div className="chart-high-low"><span><i className="chart-dot high"/>Mejor {series[peakIndex]?.label}</span><span><i className="chart-dot low"/>Menor venta <b>{money(lowValue)}</b></span></div>
      </> : <div className="chart-no-sales"><TrendingUp size={28}/><strong>Sin ventas en este periodo</strong></div>}
    </section>

    <div className="report-columns">
      <section className="report-card">
        <div className="report-card-heading"><div><h2>Productos más vendidos</h2></div></div>
        {topProducts.length
          ? <div className="rank-list">{topProducts.map((product, index) => <div className="rank-row" key={product.productId}>
              <span className={`rank-number ${index === 0 ? 'top' : ''}`}>{displayNumber(index + 1)}</span>
              <div className="rank-content">
                <div className="split-label"><span><span>{product.name}</span><small>{product.business === 'carreta' ? 'Aguas y colas' : product.category}</small></span><b>{money(product.revenue)}</b></div>
                <span className="split-track"><i className="split-fill" style={{ width: `${Math.max(3, product.revenue / Math.max(topProducts[0].revenue, 1) * 100)}%` }}/></span>
              </div>
              <span className="rank-quantity">{displayNumber(product.quantity)} u.</span>
            </div>)}</div>
          : <p className="empty-line">Aún no hay productos vendidos.</p>}
      </section>

      <section className="report-card">
        <div className="report-card-heading"><div><h2>Resumen del periodo</h2></div></div>
        <div className="split-row"><div className="split-label"><span><span>Comida</span><small>{displayNumber(data.byBusiness.palatto.orders)} pedidos</small></span><b>{money(data.byBusiness.palatto.revenue)}</b></div></div>
        <div className="split-row"><div className="split-label"><span><span>Aguas y colas</span><small>{displayNumber(data.byBusiness.carreta.orders)} pedidos</small></span><b>{money(data.byBusiness.carreta.revenue)}</b></div></div>
        <div className="split-row"><div className="split-label"><span><span>{range === 'hoy' ? 'Mejor hora' : 'Mejor día'}</span></span><b>{hasSales ? series[peakIndex]?.label : '—'}</b></div></div>
        <div className="split-row"><div className="split-label"><span><span>Hora pico</span></span><b>{data.peakHour ? `${displayNumber(String(data.peakHour.hour).padStart(2, '0'))}:00` : '—'}</b></div></div>
        <div className="split-row"><div className="split-label"><span><span>Ticket promedio</span></span><b>{money(data.averageTicket)}</b></div></div>
        {range !== 'hoy' && <div className="split-row"><div className="split-label"><span><span>Promedio por día</span></span><b>{money(Math.round(data.revenue / Math.max(days.length, 1)))}</b></div></div>}
        <div className="split-row"><div className="split-label"><span><span>Gastos del periodo</span></span><b>{money(expenses)}</b></div></div>
        <div className="split-row"><div className="split-label"><span><span>Margen</span></span><b>{displayNumber(data.revenue ? Math.round(profit / data.revenue * 100) : 0)}%</b></div></div>
      </section>
    </div>

    <section className="report-card all-time-top">
      <div className="report-card-heading">
        <div><h2>Top 10 histórico</h2><p>Productos más vendidos hasta la fecha, sin importar el periodo elegido.</p></div>
        <span className="pill">{displayNumber(history.itemsSold)} u.</span>
      </div>
      {allTimeTop.length
        ? <div className="rank-list">{allTimeTop.map((product, index) => <div className="rank-row" key={product.productId}>
            <span className={`rank-number ${index === 0 ? 'top' : ''}`}>{displayNumber(index + 1)}</span>
            <div className="rank-content">
              <div className="split-label"><span><span>{product.name}</span><small>{product.business === 'carreta' ? 'Aguas y colas' : product.category}</small></span><b>{money(product.revenue)}</b></div>
              <span className="split-track"><i className="split-fill" style={{ width: `${Math.max(3, product.quantity / Math.max(allTimeTop[0].quantity, 1) * 100)}%` }}/></span>
            </div>
            <span className="rank-quantity">{displayNumber(product.quantity)} u.</span>
          </div>)}</div>
        : <p className="empty-line">Aún no hay productos vendidos.</p>}
    </section>
  </div>
}
