self.addEventListener('push', event => {
  let message = {}
  try { message = event.data ? event.data.json() : {} } catch { message = { body: event.data?.text() || '' } }
  const title = typeof message.title === 'string' ? message.title : 'Palatto'
  const body = typeof message.body === 'string' ? message.body : 'Tienes una actualización nueva.'
  const url = typeof message.url === 'string' && message.url.startsWith('/') && !message.url.startsWith('//') ? message.url : '/'
  const tag = `palatto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/palatto-logo.png', badge: '/palatto-logo.png', data: { url }, tag, renotify: true }))
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
