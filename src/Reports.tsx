import { useMemo, useState } from 'react'
import { Download, TrendingUp } from 'lucide-react'
import type { Restaurant } from './lib/useRestaurant'
import type { RangeKey } from './lib/analytics'
import { analyze, dailyTrend, dayKey, paymentTimes, rangeDays, rangeLabels, salesCsv } from './lib/analytics'
import { money } from './lib/domain'

const ranges: RangeKey[] = ['hoy', '7d', 'quincena']

export function Reports({ app }: { app: Restaurant }) {
  const [range, setRange] = useState<RangeKey>('hoy')
  const paidAt = useMemo(() => paymentTimes(app.data.movements), [app.data.movements])
  const now = new Date()
  const days = rangeDays(range, now)
  const data = useMemo(() => analyze(app.data.orders, app.data.products, range, now, paidAt, app.data.order_payments), [app.data.orders, app.data.products, app.data.order_payments, range, paidAt])
  const series = useMemo(() => range === 'hoy'
    ? data.byHour.map(hour => ({ label: `${String(hour.hour).padStart(2, '0')}h`, value: hour.revenue, hint: `${String(hour.hour).padStart(2, '0')}:00 · ${hour.orders} pedidos` }))
    : dailyTrend(app.data.orders, Math.max(days.length, 1), now, paidAt).map(day => ({
      label: new Date(`${day.day}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' }), value: day.revenue,
      hint: `${new Date(`${day.day}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })} · ${day.orders} pedidos`,
    })), [app.data.orders, data.byHour, days.length, now, paidAt, range])
  const expenses = Math.max(0, -app.data.movements.filter(movement => movement.kind === 'gasto' && days.includes(dayKey(movement.created_at))).reduce((sum, movement) => sum + movement.amount, 0))
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
      <div><p className="eyebrow">Ventas y tendencia</p><h1>Reportes</h1><p>Elige un periodo para ver cuánto vendiste y cuándo estuvieron los picos.</p></div>
      <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!hasSales}><Download size={17}/>CSV</button>
    </div>
    <div className="segmented report-range-simple" role="group" aria-label="Periodo del reporte">
      {ranges.map(key => <button type="button" key={key} className={range === key ? 'active' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{rangeLabels[key]}</button>)}
    </div>
    <section className="report-total-card">
      <small>Ventas cobradas · {rangeLabels[range]}</small>
      <strong>{money(data.revenue)}</strong>
      <span>{data.orders} pedidos · {data.itemsSold} artículos vendidos</span>
    </section>
    <div className="reports-simple-stats">
      <article><small>Gastos</small><strong>{money(expenses)}</strong></article>
      <article><small>Ventas menos gastos</small><strong>{money(data.revenue - expenses)}</strong></article>
      <article><small>Promedio por pedido</small><strong>{money(data.averageTicket)}</strong></article>
    </div>
    <section className="report-chart-card">
      <div className="report-chart-heading"><div><h2>Subidas y bajadas</h2><p>{range === 'hoy' ? 'Ventas por hora de Ecuador' : 'Ventas por día'}</p></div>
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
        <div className="chart-high-low"><span><i className="chart-dot high"/>Pico <b>{series[peakIndex]?.label}</b></span><span><i className="chart-dot low"/>Menor venta <b>{money(lowValue)}</b></span></div>
      </> : <div className="chart-no-sales"><TrendingUp size={28}/><strong>Sin ventas en este periodo</strong><span>El gráfico aparecerá cuando se cobre el primer pedido.</span></div>}
    </section>
    <p className="report-note">Las ventas se cuentan al momento del cobro. Los gastos incluyen compras de insumos marcadas como pagadas. Fechas de Ecuador.</p>
  </div>
}
