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
    const body = await request.json()
    if (body.action === 'change_password') {
      if (!caller?.active) return reply({ error: 'Tu cuenta está desactivada' }, 403)
      if (typeof body.password !== 'string' || body.password.length < 10) return reply({ error: 'La contraseña debe tener al menos 10 caracteres' }, 400)
      const { error: passwordError } = await admin.auth.admin.updateUserById(user.id, { password: body.password })
      if (passwordError) throw passwordError
      const { error: profileError } = await admin.from('profiles').update({ must_change_password: false }).eq('id', user.id)
      if (profileError) throw profileError
      return reply({ ok: true })
    }
    if (!caller?.active || caller.role !== 'superadmin') return reply({ error: 'Solo el superadmin puede gestionar usuarios' }, 403)
    if (body.action === 'list_users') {
      const { data: profiles, error: profilesError } = await admin.from('profiles').select('id')
      if (profilesError) throw profilesError
      const ids = new Set((profiles || []).map(profile => profile.id))
      const users: { id: string; email: string }[] = []
      for (let page = 1;; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) throw error
        users.push(...data.users.filter(account => ids.has(account.id)).map(account => ({ id: account.id, email: account.email || '' })))
        if (data.users.length < 1000) break
      }
      return reply({ users })
    }
    if (body.action === 'reset_password') {
      if (typeof body.id !== 'string') return reply({ error: 'Selecciona una cuenta' }, 400)
      const { data: target, error: targetError } = await admin.auth.admin.getUserById(body.id)
      if (targetError || !target.user) return reply({ error: 'No se encontró la cuenta' }, 404)
      const temporaryPassword = `Palatto-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}!`
      const { error } = await admin.auth.admin.updateUserById(body.id, { password: temporaryPassword })
      if (error) throw error
      const { error: profileError } = await admin.from('profiles').update({ must_change_password: true }).eq('id', body.id)
      if (profileError) throw profileError
      return reply({ ok: true, email: target.user.email || '', temporaryPassword })
    }
    const validRoles = ['superadmin','administrador','cocinero','mesera','mesero','visualizador']
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
    const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, name: body.name.trim(), role: body.role, active: true, must_change_password: true })
    if (profileError) { await admin.auth.admin.deleteUser(data.user.id); throw profileError }
    return reply({ ok: true, id: data.user.id })
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'No se pudo guardar el usuario' }, 400) }
})
