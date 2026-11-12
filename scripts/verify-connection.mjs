import assert from 'node:assert/strict'
const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
assert(url && key, 'Configura .env.local antes de verificar la conexión')
assert(new URL(url).hostname === 'uosswtbajrjcegyaqwdb.supabase.co', 'Proyecto inesperado')
const headers = { apikey: key, 'Content-Type': 'application/json' }
const settings = await fetch(`${url}/auth/v1/settings`, { headers })
assert.equal(settings.status, 200, 'Auth no responde con la clave pública configurada')
console.log('OK: conexión al proyecto y servicio Auth')
for (const table of ['profiles','products','shifts','orders','movements','audits']) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers })
  assert([401,403].includes(response.status), `Acceso anónimo inesperado a ${table}: ${response.status}`)
  console.log(`OK: ${table} rechaza acceso sin sesión`)
}
for (const table of ['supplies','supply_movements']) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers })
  if (response.status === 404) {
    console.log(`PENDIENTE: ${table} aún no existe. Ejecuta scripts/activate-inventory.sql en Supabase.`)
    continue
  }
  assert([401,403].includes(response.status), `Acceso anónimo inesperado a ${table}: ${response.status}`)
  console.log(`OK: ${table} rechaza acceso sin sesión`)
}
const edge = await fetch(`${url}/functions/v1/manage-users`, { method:'POST', headers, body:'{}' })
assert.equal(edge.status,401,'Gestión de usuarios debe exigir sesión')
console.log('OK: manage-users desplegada y protegida')
