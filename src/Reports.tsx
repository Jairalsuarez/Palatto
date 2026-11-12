import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BarChart3, Clock3, Coffee, Download, ChefHat, Receipt, ShoppingBag, TrendingUp, Trophy, Wallet } from 'lucide-react'
import type { Restaurant } from './lib/useRestaurant'
import type { RangeKey } from './lib/analytics'
import { analyze, dailyTrend, dayKey, paymentTimes, peakHourLabel, rangeLabels, salesCsv } from './lib/analytics'
import { businessLabel, money } from './lib/domain'

const ranges: RangeKey[] = ['hoy', 'ayer', '7d', 'mes', 'todo']

function Kpi({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return <div className="report-kpi">
    <span className="report-kpi-icon">{icon}</span>
    <div><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>
  </div>
}

function SplitBar({ value, max, color = '' }: { value: number; max: number; color?: string }) {
  const width = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round(value / max * 100)) : 0
  return <span className="split-track" aria-hidden="true"><span className={`split-fill ${color}`} style={{ width: `${width}%` }}/></span>
}

export function Reports({ app }: { app: Restaurant }) {
  const [range, setRange] = useState<RangeKey>('hoy')
  const paidAt = useMemo(() => paymentTimes(app.data.movements), [app.data.movements])
  const data = useMemo(() => analyze(app.data.orders, app.data.products, range, new Date(), paidAt, app.data.order_payments), [app.data.orders, app.data.products, app.data.order_payments, range, paidAt])
  const trend = useMemo(() => dailyTrend(app.data.orders, 14, new Date(), paidAt), [app.data.orders, paidAt])
  const maxHour = Math.max(...data.byHour.map(hour => hour.revenue), 1)
  const maxProduct = data.byProduct[0]?.revenue || 1
  const maxCategory = data.byCategory[0]?.revenue || 1
  const maxDay = Math.max(...trend.map(day => day.revenue), 1)
  const businessTotal = data.byBusiness.palatto.revenue + data.byBusiness.carreta.revenue
  const paymentTotal = data.byMethod.efectivo.revenue + data.byMethod.transferencia.revenue
  const topProduct = data.byProduct[0]
  const topCategory = data.byCategory[0]
  const hasSales = data.orders > 0

  function exportCsv() {
    const csv = salesCsv(app.data.orders, app.data.products, range, new Date(), paidAt, app.data.order_payments)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `palatto-ventas-${range}-${dayKey(new Date())}.csv`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return <>
    <div className="page-heading">
      <div><h1>Reportes</h1><p>Ventas cobradas, productos y horas con más movimiento.</p></div>
      <div className="report-heading-actions">
        <div className="segmented report-range" role="group" aria-label="Rango de fechas">
          {ranges.map(key => <button key={key} className={range === key ? 'active' : ''} aria-pressed={range === key} onClick={() => setRange(key)}>{rangeLabels[key]}</button>)}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!hasSales}><Download size={17}/>Exportar CSV</button>
      </div>
    </div>

    <div className="report-kpis">
      <Kpi icon={<Wallet size={21}/>} label="Ventas" value={money(data.revenue)} detail={`${data.orders} pedido${data.orders === 1 ? '' : 's'} cobrado${data.orders === 1 ? '' : 's'}`} />
      <Kpi icon={<Receipt size={21}/>} label="Ticket promedio" value={money(data.averageTicket)} detail="Por pedido cobrado" />
      <Kpi icon={<ShoppingBag size={21}/>} label="Artículos vendidos" value={String(data.itemsSold)} detail="Unidades en total" />
      <Kpi icon={<TrendingUp size={21}/>} label="Mejor producto" value={topProduct ? topProduct.name : 'Sin ventas'} detail={topProduct ? `${topProduct.quantity} vendidos · ${money(topProduct.revenue)}` : 'Aún no hay datos'} />
    </div>

    {!hasSales && <div className="report-empty">
      <div className="empty-icon"><BarChart3 size={30}/></div>
      <h3>Sin ventas en {rangeLabels[range].toLowerCase()}</h3>
      <p>Los reportes se llenan automáticamente cuando cobras un pedido. Prueba con otro rango de fechas.</p>
    </div>}

    {hasSales && <>
      <div className="report-highlights">
        <section className="peak-card">
          <span className="peak-icon green"><Trophy size={22}/></span>
          <div><small>Producto estrella</small><strong>{topProduct?.name || '—'}</strong><span>{topProduct ? `${topProduct.quantity} vendidos` : 'Sin datos'}</span></div>
        </section>
        <section className="peak-card">
          <span className="peak-icon blue"><BarChart3 size={22}/></span>
          <div><small>Categoría más vendida</small><strong>{topCategory?.category || '—'}</strong><span>{topCategory ? money(topCategory.revenue) : 'Sin datos'}</span></div>
        </section>
      </div>

      <section className="report-card">
        <div className="report-card-heading"><div><h2>Ventas por hora</h2><p>Así se reparte el dinero durante el día. La barra naranja es el pico.</p></div><span className="pill orange"><Clock3 size={13}/>{data.peakHour ? peakHourLabel(data.peakHour.hour) : 'Sin pico'}</span></div>
        <div className="hour-chart" role="img" aria-label={`Ventas por hora. Pico a las ${data.peakHour ? peakHourLabel(data.peakHour.hour) : 'sin datos'}.`}>
          {data.byHour.map(hour => <div className="hour-column" key={hour.hour} title={`${peakHourLabel(hour.hour)} · ${money(hour.revenue)} · ${hour.orders} pedidos`}>
            <span className="hour-bar-wrap"><span className={`hour-bar ${hour.hour === data.peakHour?.hour ? 'peak' : ''} ${hour.revenue === 0 ? 'empty' : ''}`} style={{ height: `${hour.revenue > 0 ? Math.max(6, Math.round(hour.revenue / maxHour * 100)) : 2}%` }}/></span>
            <small>{hour.hour % 3 === 0 ? `${String(hour.hour).padStart(2, '0')}h` : ''}</small>
          </div>)}
        </div>
        <div className="hour-legend"><span><i className="legend-dot"/>Ventas del pico</span><span>Pasa el cursor o toca una barra para ver el detalle</span></div>
      </section>

      <div className="report-columns">
        <section className="report-card">
          <div className="report-card-heading"><div><h2>Palatto · ventas por registro</h2><p>Las aguas y colas se separan para llevar su propio control.</p></div></div>
          {(['palatto', 'carreta'] as const).map(business => <div className="split-row" key={business}>
            <div className="split-label"><span>{business === 'palatto' ? <ChefHat size={17}/> : <Coffee size={17}/>}{businessLabel(business)}</span><b>{money(data.byBusiness[business].revenue)}</b></div>
            <SplitBar value={data.byBusiness[business].revenue} max={businessTotal} color={business === 'palatto' ? '' : 'green'}/>
            <small>{businessTotal > 0 ? Math.round(data.byBusiness[business].revenue / businessTotal * 100) : 0}% del total · {data.byBusiness[business].orders} pedidos · {data.byBusiness[business].items} artículos</small>
          </div>)}
        </section>

        <section className="report-card">
          <div className="report-card-heading"><div><h2>Por forma de pago</h2><p>Cómo pagaron los clientes.</p></div></div>
          {(['efectivo', 'transferencia'] as const).map(method => <div className="split-row" key={method}>
            <div className="split-label"><span>{method === 'efectivo' ? 'Efectivo' : 'Transferencia'}</span><b>{money(data.byMethod[method].revenue)}</b></div>
            <SplitBar value={data.byMethod[method].revenue} max={paymentTotal} color={method === 'efectivo' ? '' : 'blue'}/>
            <small>{paymentTotal > 0 ? Math.round(data.byMethod[method].revenue / paymentTotal * 100) : 0}% del total · {data.byMethod[method].orders} pedidos</small>
          </div>)}
        </section>
      </div>

      <div className="report-columns">
        <section className="report-card">
          <div className="report-card-heading"><div><h2>Productos más vendidos</h2><p>Por dinero cobrado, no solo por cantidad.</p></div></div>
          <div className="rank-list">
            {data.byProduct.slice(0, 10).map((product, index) => <div className="rank-row" key={product.productId}>
              <span className={`rank-number ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
              <div className="rank-content">
                <div className="split-label"><span>{product.name}<small>{product.category} · {businessLabel(product.business)}</small></span><b>{money(product.revenue)}</b></div>
                <SplitBar value={product.revenue} max={maxProduct}/>
              </div>
              <span className="rank-quantity">{product.quantity} u</span>
            </div>)}
          </div>
        </section>

        <section className="report-card">
          <div className="report-card-heading"><div><h2>Por categoría</h2><p>Qué tipo de comida deja más ventas.</p></div></div>
          <div className="rank-list">
            {data.byCategory.map((category, index) => <div className="rank-row category-row" key={category.category}>
              <span className={`rank-number ${index < 3 ? 'top' : ''}`}>{index + 1}</span>
              <div className="rank-content">
                <div className="split-label"><span>{category.category}</span><b>{money(category.revenue)}</b></div>
                <SplitBar value={category.revenue} max={maxCategory} color="gold"/>
              </div>
              <span className="rank-quantity">{category.quantity} u</span>
            </div>)}
          </div>
        </section>
      </div>

      <section className="report-card">
        <div className="report-card-heading"><div><h2>Últimos 14 días</h2><p>Tendencia diaria de ventas cobradas.</p></div></div>
        <div className="trend-chart" role="img" aria-label="Tendencia de ventas de los últimos 14 días">
          {trend.map(day => <div className="trend-column" key={day.day} title={`${day.day} · ${money(day.revenue)} · ${day.orders} pedidos`}>
            <span className="trend-value">{day.revenue > 0 ? money(day.revenue) : ''}</span>
            <span className="trend-bar-wrap"><span className={`trend-bar ${day.revenue === 0 ? 'empty' : ''}`} style={{ height: `${day.revenue > 0 ? Math.max(6, Math.round(day.revenue / maxDay * 100)) : 2}%` }}/></span>
            <small>{day.day.slice(8)}/{day.day.slice(5, 7)}</small>
          </div>)}
        </div>
      </section>
    </>}

    <p className="report-note">Las cifras usan pedidos cobrados y la fecha de Ecuador. Los pedidos sin cobrar no cuentan como venta.</p>
  </>
}
