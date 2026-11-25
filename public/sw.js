self.addEventListener('push', event => {
  let message = {}
  try { message = event.data ? event.data.json() : {} } catch { message = { body: event.data?.text() || '' } }
  const title = typeof message.title === 'string' ? message.title : 'Palatto'
  const body = typeof message.body === 'string' ? message.body : 'Tienes una actualización nueva.'
  const url = typeof message.url === 'string' && message.url.startsWith('/') && !message.url.startsWith('//') ? message.url : '/'
  const tag = `palatto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const shownAt = Date.now()
  const lifetime = 5 * 60 * 1000
  const options = {
    body,
    icon: '/palatto-logo.png',
    badge: '/palatto-logo.png',
    timestamp: shownAt,
    requireInteraction: true,
    data: { url, expiresAt: shownAt + lifetime },
    tag,
    renotify: true,
  }
  event.waitUntil((async () => {
    const trigger = typeof TimestampTrigger === 'undefined' ? undefined : new TimestampTrigger(shownAt + lifetime)
    try {
      await self.registration.showNotification(title, trigger ? { ...options, showTrigger: trigger } : options)
    } catch {
      // Older browsers without scheduled notifications still show the push.
      await self.registration.showNotification(title, options)
    }
  })())
})

async function closeExpiredNotifications() {
  const notifications = await self.registration.getNotifications()
  const now = Date.now()
  notifications.forEach(notification => {
    const expiresAt = notification.data?.expiresAt
    if (typeof expiresAt === 'number' && expiresAt <= now) notification.close()
  })
}

self.addEventListener('activate', event => {
  event.waitUntil(closeExpiredNotifications())
})

self.addEventListener('push', event => {
  event.waitUntil(closeExpiredNotifications())
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting())
})

self.addEventListener('periodicsync', event => {
  if (event.tag === 'palatto-notifications-expiry') event.waitUntil(closeExpiredNotifications())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const client = clients.find(item => item.url.startsWith(self.location.origin))
    if (client) return client.focus().then(() => client.navigate(url))
    return self.clients.openWindow(url)
  }))
})
