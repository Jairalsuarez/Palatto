import { createClient } from 'npm:@supabase/supabase-js@2'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return reply({ error: 'Método no permitido' }, 405)
  try {
    const auth = request.headers.get('Authorization')
    if (!auth?.startsWith('Bearer ')) return reply({ error: 'Sesión requerida' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error: authError } = await admin.auth.getUser(auth.slice(7))
    if (authError || !user) return reply({ error: 'Sesión inválida' }, 401)
    const { data: caller } = await admin.from('profiles').select('role,active').eq('id', user.id).single()
    if (!caller?.active || caller.role !== 'superadmin') return reply({ error: 'Solo el superadmin puede gestionar usuarios' }, 403)
    const body = await request.json()
    const validRoles = ['superadmin','administrador','cocinero','mesera','visualizador']
    if (!validRoles.includes(body.role) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) return reply({ error: 'Nombre o rol inválido' }, 400)
    if (body.id) {
      if (body.id === user.id && (body.role !== 'superadmin' || body.active === false)) return reply({ error: 'No puedes quitarte tu propio acceso de superadmin' }, 400)
      const { error } = await admin.from('profiles').update({ name: body.name.trim(), role: body.role, active: body.active !== false }).eq('id', body.id)
      if (error) throw error
      return reply({ ok: true })
    }
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length < 10) return reply({ error: 'Correo y contraseña de al menos 10 caracteres requeridos' }, 400)
    const { data, error } = await admin.auth.admin.createUser({ email: body.email.trim(), password: body.password, email_confirm: true })
    if (error) throw error
    const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, name: body.name.trim(), role: body.role, active: true })
    if (profileError) { await admin.auth.admin.deleteUser(data.user.id); throw profileError }
    return reply({ ok: true, id: data.user.id })
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'No se pudo guardar el usuario' }, 400) }
})
