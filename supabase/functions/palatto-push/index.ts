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
    const { data: profile } = await admin.from('profiles').select('active,role').eq('id', user.id).single()
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

    if (body.action === 'notify_new_order') {
      if (profile.role === 'visualizador') return reply({ error: 'No tienes permiso para crear pedidos' }, 403)
      const publicKey = Deno.env.get('PALATTO_VAPID_PUBLIC_KEY')
      const privateKey = Deno.env.get('PALATTO_VAPID_PRIVATE_KEY')
      const subject = Deno.env.get('PALATTO_VAPID_SUBJECT') || 'mailto:admin@palatto.app'
      if (!publicKey || !privateKey) return reply({ error: 'Notificaciones sin configurar' }, 503)
      const { data: recipients, error: recipientsError } = await admin.from('profiles').select('id').eq('active', true).neq('id', user.id)
      if (recipientsError) throw recipientsError
      if (!recipients?.length) return reply({ sent: 0, attempted: 0, reason: 'no_recipients' })
      const { data: subscriptions, error: subscriptionsError } = await admin.from('push_subscriptions').select('id,endpoint,p256dh,auth').in('user_id', recipients.map(person => person.id))
      if (subscriptionsError) throw subscriptionsError
      if (!subscriptions?.length) return reply({ sent: 0, attempted: 0, reason: 'no_subscriptions' })
      try { webpush.setVapidDetails(subject, publicKey, privateKey) }
      catch { return reply({ error: 'Las claves VAPID configuradas no forman un par válido.' }, 503) }
      const failureStatuses: number[] = []
      const results = await Promise.all((subscriptions || []).map(async subscription => {
        if (!allowedEndpoint(subscription.endpoint)) return false
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            JSON.stringify({ title: 'Pedido nuevo', body: 'Hay un pedido nuevo para preparar en Palatto.', url: '/' }), { TTL: 3600, urgency: 'high', timeout: 10000 })
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
      return reply({ sent, attempted: subscriptions.length, ...(sent ? {} : { reason: 'delivery_failed', statuses: failureStatuses }) })
    }

    return reply({ error: 'Acción desconocida' }, 400)
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'No se pudo actualizar la notificación' }, 400) }
})
