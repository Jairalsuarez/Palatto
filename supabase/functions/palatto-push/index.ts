import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })

function allowedEndpoint(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && (
      url.hostname === 'fcm.googleapis.com' || url.hostname === 'push.services.mozilla.com' || url.hostname.endsWith('.push.services.mozilla.com') ||
      url.hostname.endsWith('.notify.windows.com') || url.hostname.endsWith('.push.apple.com'))
  } catch { return false }
}

type Details = {
  actorName?: string
  orderId?: string
  orderNumber?: number
  customer?: string
  takeaway?: boolean
  items?: number
  itemsSummary?: string
  amount?: number
  method?: string
  kind?: string
  reason?: string
  label?: string
  name?: string
  paid?: boolean
  received?: boolean
  reconciliationId?: string
  cashBalance?: number
  transferBalance?: number
  countedCash?: number
  countedTransfer?: number
}

const moneyLabel = (value?: number) => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(value) / 100)
  : ''
const methodLabel = (method?: string) => method === 'transferencia' ? 'transferencia' : 'efectivo'
const orderLabel = (details: Details) => `Pedido${details.orderNumber ? ` #${details.orderNumber}` : ''}${details.customer && details.customer.toLowerCase() !== 'pedido' ? ` · ${details.customer}` : ''}`

function buildNotice(event: string, details: Details) {
  const amount = moneyLabel(details.amount)
  switch (event) {
    case 'order_created':
      return {
        title: 'Pedido nuevo',
        body: `${orderLabel(details)} · ${details.takeaway ? 'Para llevar' : 'Para servir'}${details.itemsSummary ? ` · ${details.itemsSummary}` : ''}${amount ? ` · ${amount}` : ''}`,
        push: true,
      }
    case 'order_updated':
      return { title: 'Pedido actualizado', body: `${orderLabel(details)} se actualizó.`, push: false }
    case 'order_paid':
      return { title: 'Pedido cobrado', body: `${orderLabel(details)} · ${amount || 'Cobrado'} en ${methodLabel(details.method)}.`, push: false }
    case 'split_payment':
      return { title: 'Pago registrado', body: `${details.label || 'Una persona'} pagó ${amount || 'su parte'} del ${orderLabel(details).toLowerCase()}.`, push: false }
    case 'order_deleted':
      return { title: 'Pedido eliminado', body: `${orderLabel(details)} · ${details.reason || 'Sin motivo'}.`, push: false }
    case 'product_saved':
      return { title: 'Menú actualizado', body: `${details.name || 'Un producto'} fue ${details.reason || 'actualizado'}.`, push: false }
    case 'product_photo_saved':
      return { title: 'Foto del menú', body: 'Se actualizó una foto de producto.', push: false }
    case 'cash_movement': {
      const kind = details.kind === 'gasto' ? 'Gasto' : details.kind === 'retiro' ? 'Retiro' : details.kind === 'ingreso' ? 'Ingreso' : 'Movimiento de caja'
      return {
        title: kind === 'Movimiento de caja' ? kind : `${kind} registrado`,
        body: `${amount || 'Movimiento'}${details.reason ? ` · ${details.reason}` : ''} · ${methodLabel(details.method)}.`,
        push: ['ingreso', 'gasto', 'retiro'].includes(String(details.kind)),
      }
    }
    case 'cash_transfer':
      return { title: 'Transferencia de caja', body: `${amount || 'Transferencia'}${details.reason ? ` · ${details.reason}` : ''}.`, push: false }
    case 'cash_reconciled': {
      const cash = moneyLabel(details.cashBalance)
      const transfer = moneyLabel(details.transferBalance)
      const differences = (Number(details.countedCash || 0) - Number(details.cashBalance || 0)) + (Number(details.countedTransfer || 0) - Number(details.transferBalance || 0))
      const suffix = differences ? ` · Diferencia ${differences > 0 ? '+' : ''}${moneyLabel(differences)}` : ' · Sin diferencias'
      return { title: 'Caja cuadrada', body: `Caja cuadrada${details.actorName ? ` por ${details.actorName}` : ''} · Efectivo ${cash || '$0.00'} · Transferencia ${transfer || '$0.00'}${suffix}.`, push: true }
    }
    case 'user_saved':
      return { title: 'Equipo actualizado', body: `${details.name || 'Una cuenta'} fue ${details.reason || 'actualizada'}.`, push: false }
    case 'password_changed':
      return { title: 'Seguridad de cuenta', body: 'Se cambió la contraseña de una cuenta.', push: false }
    case 'password_reset':
      return { title: 'Seguridad de cuenta', body: 'El administrador generó una nueva contraseña temporal.', push: false }
    case 'supply_saved':
      return { title: 'Insumos actualizados', body: `${details.name || 'Un insumo'} fue actualizado en el catálogo.`, push: false }
    case 'supply_movement':
      return { title: 'Movimiento de insumo', body: `${details.name || 'Un insumo'} · ${details.reason || 'Entrada, consumo o ajuste'}.`, push: false }
    case 'supply_purchase_created':
      return {
        title: 'Compra de insumo',
        body: `${details.name || 'Un insumo'} · ${amount || 'Compra'} · ${details.paid ? 'Pagada' : 'Pendiente'}${details.received ? ' · Recibida' : ''}.`,
        push: false,
      }
    case 'supply_purchase_paid':
      return { title: 'Insumo pagado', body: `${details.name || 'Una compra'} se marcó como pagada. La caja no cambia.`, push: false }
    case 'supply_purchase_pending':
      return { title: 'Pago de insumo revertido', body: `${details.name || 'Una compra'} volvió a quedar pendiente.`, push: false }
    case 'supply_purchase_received':
      return { title: 'Insumo recibido', body: `${details.name || 'Una compra'} se marcó como recibida y actualizó el stock.`, push: false }
    default:
      return null
  }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return reply({ error: 'Método no permitido' }, 405)
  try {
    const bearer = request.headers.get('Authorization')
    if (!bearer?.startsWith('Bearer ')) return reply({ error: 'Inicia sesión para continuar' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error: authError } = await admin.auth.getUser(bearer.slice(7))
    if (authError || !user) return reply({ error: 'Sesión inválida' }, 401)
    const { data: profile } = await admin.from('profiles').select('active,role,name').eq('id', user.id).single()
    if (!profile?.active) return reply({ error: 'Tu cuenta está desactivada' }, 403)
    const body = await request.json()

    if (body.action === 'subscribe') {
      const subscription = body.subscription
      const endpoint = subscription?.endpoint
      const p256dh = subscription?.keys?.p256dh
      const auth = subscription?.keys?.auth
      if (typeof endpoint !== 'string' || !allowedEndpoint(endpoint) || typeof p256dh !== 'string' || p256dh.length < 80 || typeof auth !== 'string' || auth.length < 20)
        return reply({ error: 'Suscripción de notificaciones inválida' }, 400)
      const { error } = await admin.from('push_subscriptions').upsert({ user_id: user.id, endpoint, p256dh, auth, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' })
      if (error) throw error
      return reply({ ok: true })
    }

    if (body.action === 'unsubscribe') {
      if (typeof body.endpoint !== 'string' || !allowedEndpoint(body.endpoint)) return reply({ error: 'Dirección de notificaciones inválida' }, 400)
      const { error } = await admin.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', body.endpoint)
      if (error) throw error
      return reply({ ok: true })
    }

    if (body.action === 'notify_new_order' || body.action === 'notify_activity') {
      if (profile.role === 'visualizador') return reply({ error: 'No tienes permiso para crear pedidos' }, 403)
      const event = String(body.action === 'notify_new_order' ? 'order_created' : body.event)
      const details: Details = body.details && typeof body.details === 'object' ? body.details : {}
      if (event === 'cash_reconciled') {
        if (!['superadmin', 'administrador'].includes(String(profile.role))) return reply({ error: 'Solo administración puede cuadrar la caja' }, 403)
        if (typeof details.reconciliationId !== 'string') return reply({ error: 'Falta el registro de cuadre' }, 400)
        const { data: reconciliation } = await admin.from('cash_reconciliations').select('id,cash_balance,transfer_balance,counted_cash,counted_transfer').eq('id', details.reconciliationId).eq('reconciled_by', user.id).maybeSingle()
        if (!reconciliation) return reply({ error: 'El cuadre no existe o no corresponde a tu cuenta' }, 403)
        details.cashBalance = Number(reconciliation.cash_balance)
        details.transferBalance = Number(reconciliation.transfer_balance)
        details.countedCash = Number(reconciliation.counted_cash)
        details.countedTransfer = Number(reconciliation.counted_transfer)
        details.actorName = String(profile.name || '')
      }
      if (details.orderId && ['order_created', 'order_updated', 'order_paid', 'split_payment'].includes(event)) {
        const { data: order } = await admin.from('orders').select('number,customer,takeaway,items').eq('id', details.orderId).maybeSingle()
        if (order) {
          details.orderNumber ??= Number(order.number)
          details.customer ??= String(order.customer || '')
          const items = Array.isArray(order.items) ? order.items as { name?: string; quantity?: number; takeaway_quantity?: number }[] : []
          if (typeof details.takeaway !== 'boolean') {
            details.takeaway = Boolean(order.takeaway) || items.some(item => Number(item.takeaway_quantity || 0) > 0)
          }
          details.items = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
          details.itemsSummary = items.map(item => `${Number(item.quantity || 0)} × ${String(item.name || 'Producto')}`).join(', ')
        }
      }
      const notice = buildNotice(event, details)
      if (!notice) return reply({ error: 'Tipo de aviso inválido' }, 400)

      // Toda la actividad queda en el centro de notificaciones de la app.
      const { error: insertError } = event === 'order_created'
        ? { error: null }
        : await admin.from('notifications').insert({
          event,
          title: notice.title,
          body: notice.body,
          order_id: typeof details.orderId === 'string' ? details.orderId : null,
          actor: user.id,
          actor_name: profile.name || details.actorName || null,
        })
      if (insertError) console.error('No se pudo guardar la notificación interna', insertError)
      const notified = event !== 'order_created' && !insertError

      // Solo los pedidos nuevos y los movimientos de caja se envían como push.
      if (!notice.push) return reply({ ok: true, notified, sent: 0, reason: 'internal_only' })

      const publicKey = Deno.env.get('PALATTO_VAPID_PUBLIC_KEY')
      const privateKey = Deno.env.get('PALATTO_VAPID_PRIVATE_KEY')
      const subject = Deno.env.get('PALATTO_VAPID_SUBJECT') || 'mailto:admin@palatto.app'
      if (!publicKey || !privateKey) return reply({ ok: true, notified, sent: 0, reason: 'push_not_configured' })
      // Every active account should receive activity notifications, including
      // the account that performed the action. A user may have several devices.
      const kitchenOnly = event === 'order_created'
      const { data: recipients, error: recipientsError } = await admin.from('profiles').select('id').eq('active', true).match(kitchenOnly ? { role: 'cocinero' } : {})
      if (recipientsError) throw recipientsError
      if (!recipients?.length) return reply({ ok: true, notified, sent: 0, attempted: 0, reason: 'no_recipients' })
      const { data: subscriptions, error: subscriptionsError } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth').in('user_id', recipients.map(person => person.id))
      if (subscriptionsError) throw subscriptionsError
      if (!subscriptions?.length) return reply({ ok: true, notified, sent: 0, attempted: 0, reason: 'no_subscriptions' })
      try { webpush.setVapidDetails(subject, publicKey, privateKey) }
      catch { return reply({ ok: true, notified, sent: 0, reason: 'invalid_vapid' }) }
      const failureStatuses: number[] = []
      const results = await Promise.all((subscriptions || []).map(async subscription => {
        if (!allowedEndpoint(subscription.endpoint)) return false
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            JSON.stringify({ title: notice.title, body: notice.body, url: '/', orderId: typeof details.orderId === 'string' ? details.orderId : null }),
            { TTL: 3600, urgency: 'high', timeout: 10000 })
          return true
        } catch (error) {
          const status = Number((error as { statusCode?: number }).statusCode || 0)
          failureStatuses.push(status)
          if (status === 404 || status === 410) await admin.from('push_subscriptions').delete().eq('id', subscription.id)
          return false
        }
      }))
      const sent = results.filter(Boolean).length
      if (!sent) console.warn('Palatto push delivery failed', { attempted: subscriptions.length, statuses: failureStatuses })
      return reply({ ok: true, notified, sent, attempted: subscriptions.length, ...(sent ? {} : { reason: 'delivery_failed', statuses: failureStatuses }) })
    }

    return reply({ error: 'Acción desconocida' }, 400)
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'No se pudo actualizar la notificación' }, 400) }
})
