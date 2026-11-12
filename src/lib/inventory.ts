import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { canWrite } from './domain'
import type { Profile, Role } from './domain'

export type SupplyUnit = 'kg' | 'lb' | 'unidad' | 'litro' | 'funda' | 'caja' | 'porcion'
export type MovementKind = 'entrada' | 'salida' | 'ajuste'

export interface Supply {
  id: string
  name: string
  category: string
  unit: SupplyUnit
  stock: number
  min_stock: number
  cost_per_unit: number
  active: boolean
  created_at: string
  updated_at: string
}

export interface SupplyMovement {
  id: string
  supply_id: string
  kind: MovementKind
  quantity: number
  reason: string
  actor: string
  actor_name?: string
  created_at: string
}

export interface SupplyPurchase {
  id: string
  supply_id: string
  quantity: number
  unit_cost: number
  total_amount: number
  supplier: string
  paid: boolean
  payment_method: 'efectivo' | 'transferencia' | null
  received: boolean
  created_by: string
  created_at: string
  paid_at: string | null
  received_at: string | null
}

export interface SupplyPurchaseInput {
  supply_id: string
  supply_name?: string
  quantity: number
  unit_cost: number
  supplier: string
  paid: boolean
  payment_method: 'efectivo' | 'transferencia' | null
  received: boolean
}

export interface SupplyInput {
  name: string
  category: string
  unit: SupplyUnit
  min_stock: number
  cost_per_unit: number
  active: boolean
}

export const units: { id: SupplyUnit; label: string; short: string }[] = [
  { id: 'kg', label: 'Kilogramo', short: 'kg' },
  { id: 'lb', label: 'Libra', short: 'lb' },
  { id: 'unidad', label: 'Unidad', short: 'u' },
  { id: 'litro', label: 'Litro', short: 'L' },
  { id: 'funda', label: 'Funda', short: 'funda' },
  { id: 'caja', label: 'Caja', short: 'caja' },
  { id: 'porcion', label: 'Porción', short: 'porción' },
]

export const movementLabels: Record<MovementKind, string> = {
  entrada: 'Entrada',
  salida: 'Consumo',
  ajuste: 'Ajuste',
}

export const movementIcons: Record<MovementKind, string> = {
  entrada: '+',
  salida: '−',
  ajuste: '=',
}

export const unitLabel = (unit: SupplyUnit) => units.find(item => item.id === unit)?.short || unit

export function isLowStock(supply: Supply): boolean {
  return supply.stock <= 0 || (supply.min_stock > 0 && supply.stock <= supply.min_stock)
}

export function inventoryValue(supplies: Supply[]): number {
  return supplies.reduce((sum, supply) => sum + Math.round(supply.stock * supply.cost_per_unit), 0)
}

/** Applies a movement to a supply and returns the updated row. Never allows negative stock. */
export function applyMovement(supply: Supply, kind: MovementKind, quantity: number): Supply {
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Escribe una cantidad válida.')
  if (kind !== 'ajuste' && quantity <= 0) throw new Error('La cantidad debe ser mayor a cero.')
  const next = kind === 'entrada'
    ? supply.stock + quantity
    : kind === 'salida'
      ? supply.stock - quantity
      : quantity
  if (next < 0) throw new Error(`No hay suficiente ${supply.name} en inventario.`)
  return { ...supply, stock: Math.round(next * 1000) / 1000, updated_at: new Date().toISOString() }
}

const SUPPLY_KEY = 'palatto:supplies:v1'
const MOVEMENT_KEY = 'palatto:supply-movements:v1'
const PURCHASE_KEY = 'palatto:supply-purchases:v1'

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full or blocked */ }
}

function loadLocalSupplies(): Supply[] {
  return readLocal<Supply[]>(SUPPLY_KEY, [])
}

export function useInventory(profile: Profile | null, role: Role) {
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [movements, setMovements] = useState<SupplyMovement[]>([])
  const [purchases, setPurchases] = useState<SupplyPurchase[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState<'supabase' | 'local'>('local')
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [purchaseSetupNeeded, setPurchaseSetupNeeded] = useState(false)

  const loadLocal = useCallback(() => {
    setSupplies(loadLocalSupplies().sort((a, b) => a.name.localeCompare(b.name)))
    setMovements(readLocal<SupplyMovement[]>(MOVEMENT_KEY, []))
    setPurchases(readLocal<SupplyPurchase[]>(PURCHASE_KEY, []))
    setSource('local')
    setLoading(false)
  }, [])

  const load = useCallback(async () => {
    if (!profile) { setLoading(false); return }
    if (!supabase) { loadLocal(); return }
    setLoading(true)
    const probe = await supabase.from('supplies').select('id').limit(1)
    if (probe.error) {
      if (probe.error.code === 'PGRST205' || probe.error.code === '42P01') setSetupNeeded(true)
      loadLocal()
      return
    }
    const [supplyResult, movementResult, purchaseResult] = await Promise.all([
      supabase.from('supplies').select('*').order('name'),
      supabase.from('supply_movements').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('supply_purchases').select('*').order('created_at', { ascending: false }).limit(300),
    ])
    if (supplyResult.error || movementResult.error) {
      setError(supplyResult.error?.message || movementResult.error?.message || 'No se pudo cargar el inventario.')
      loadLocal()
      return
    }
    setSupplies((supplyResult.data as Supply[]).map(row => ({
      ...row,
      stock: Number(row.stock),
      min_stock: Number(row.min_stock),
      cost_per_unit: Number(row.cost_per_unit),
    })))
    setMovements(movementResult.data as SupplyMovement[])
    if (purchaseResult.error) {
      if (purchaseResult.error.code === 'PGRST205' || purchaseResult.error.code === '42P01') {
        setPurchaseSetupNeeded(true)
        setPurchases([])
      } else {
        setError(purchaseResult.error.message)
        setPurchases([])
      }
    } else {
      setPurchaseSetupNeeded(false)
      setPurchases(purchaseResult.data as SupplyPurchase[])
    }
    setSource('supabase')
    setSetupNeeded(false)
    setLoading(false)
  }, [loadLocal, profile])

  // oxlint-disable-next-line react/set-state-in-effect -- inventory is loaded asynchronously from Supabase or local storage
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  function actorName(): string {
    return profile?.name || 'Equipo'
  }

  async function saveSupply(input: SupplyInput, id?: string): Promise<boolean> {
    if (!canWrite(role)) { setError('Tu rol solo puede consultar el inventario.'); return false }
    if (input.name.trim().length < 2) { setError('Escribe el nombre del insumo.'); return false }
    if (input.min_stock < 0 || input.cost_per_unit < 0) { setError('El mínimo y el costo no pueden ser negativos.'); return false }
    setBusy(true); setError('')
    try {
      if (source === 'supabase' && supabase) {
        const { error: rpcError } = await supabase.rpc('save_supply', {
          p_id: id || null,
          p_name: input.name.trim(),
          p_category: input.category.trim() || 'General',
          p_unit: input.unit,
          p_min_stock: input.min_stock,
          p_cost_per_unit: input.cost_per_unit,
          p_active: input.active,
        })
        if (rpcError) throw rpcError
      } else {
        const rows = loadLocalSupplies()
        const duplicate = rows.find(row => row.name.toLowerCase() === input.name.trim().toLowerCase() && row.id !== id)
        if (duplicate) throw new Error('Ya existe un insumo con ese nombre.')
        const now = new Date().toISOString()
        const list = id
          ? rows.map(row => row.id === id ? { ...row, ...input, name: input.name.trim(), updated_at: now } : row)
          : [...rows, { id: crypto.randomUUID(), ...input, name: input.name.trim(), stock: 0, created_at: now, updated_at: now } as Supply]
        writeLocal(SUPPLY_KEY, list)
      }
      await load()
      setNotice(id ? 'Insumo actualizado.' : 'Insumo agregado.')
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo guardar el insumo.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function registerMovement(supplyId: string, kind: MovementKind, quantity: number, reason: string): Promise<boolean> {
    if (!canWrite(role)) { setError('Tu rol solo puede consultar el inventario.'); return false }
    if (reason.trim().length < 3) { setError('Escribe el motivo del movimiento.'); return false }
    setBusy(true); setError('')
    try {
      if (source === 'supabase' && supabase) {
        const { error: rpcError } = await supabase.rpc('register_supply_movement', {
          p_id: supplyId,
          p_kind: kind,
          p_quantity: quantity,
          p_reason: reason.trim(),
        })
        if (rpcError) throw rpcError
      } else {
        const rows = loadLocalSupplies()
        const supply = rows.find(row => row.id === supplyId)
        if (!supply) throw new Error('El insumo ya no existe.')
        const updated = applyMovement(supply, kind, quantity)
        writeLocal(SUPPLY_KEY, rows.map(row => row.id === supplyId ? updated : row))
        const movement: SupplyMovement = {
          id: crypto.randomUUID(),
          supply_id: supplyId,
          kind,
          quantity,
          reason: reason.trim(),
          actor: profile?.id || '',
          actor_name: actorName(),
          created_at: new Date().toISOString(),
        }
        writeLocal(MOVEMENT_KEY, [movement, ...readLocal<SupplyMovement[]>(MOVEMENT_KEY, [])].slice(0, 500))
      }
      await load()
      setNotice(kind === 'entrada' ? 'Entrada registrada.' : kind === 'salida' ? 'Consumo registrado.' : 'Stock ajustado.')
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo registrar el movimiento.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function registerPurchase(input: SupplyPurchaseInput): Promise<boolean> {
    if (!canWrite(role)) { setError('Tu rol solo puede consultar el inventario.'); return false }
    if ((!input.supply_id && !input.supply_name?.trim()) || input.quantity <= 0 || input.unit_cost <= 0 || (input.paid && !input.payment_method)) { setError('Completa el nombre, el valor y el medio de pago.'); return false }
    setBusy(true); setError('')
    try {
      if (source === 'supabase' && supabase) {
        let supplyId = input.supply_id
        if (!supplyId && input.supply_name?.trim()) {
          const { data: createdId, error: createError } = await supabase.rpc('save_supply', {
            p_id: null, p_name: input.supply_name.trim(), p_category: 'General', p_unit: 'unidad',
            p_min_stock: 0, p_cost_per_unit: 0, p_active: true,
          })
          if (createError) throw createError
          supplyId = createdId as string
        }
        const { error: rpcError } = await supabase.rpc('register_supply_purchase', {
          p_supply: supplyId, p_quantity: input.quantity, p_unit_cost: input.unit_cost,
          p_supplier: input.supplier.trim(), p_paid: input.paid, p_method: input.payment_method, p_received: input.received,
        })
        if (rpcError) throw rpcError
      } else {
        const supplies = loadLocalSupplies()
        let supply = supplies.find(row => row.id === input.supply_id)
        if (!supply && input.supply_name?.trim()) {
          const existing = supplies.find(row => row.name.toLowerCase() === input.supply_name!.trim().toLowerCase())
          supply = existing || { id: crypto.randomUUID(), name: input.supply_name.trim(), category: 'General', unit: 'unidad', stock: 0, min_stock: 0, cost_per_unit: 0, active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
          if (!existing) { supplies.push(supply); writeLocal(SUPPLY_KEY, supplies) }
          input = { ...input, supply_id: supply.id }
        }
        if (!supply) throw new Error('El insumo ya no existe.')
        const now = new Date().toISOString()
        const totalAmount = Math.round(input.quantity * input.unit_cost)
        if (input.paid) {
          const movement = {
            id: crypto.randomUUID(), business: 'palatto' as const, amount: -totalAmount,
            method: input.payment_method!, reason: `Compra de insumos · ${input.supplier.trim() || supply.name}`,
            order_id: null, shift_id: null, actor: profile?.id || '', created_at: now,
            transfer_id: null, kind: 'gasto' as const,
          }
          const movements = readLocal<Record<string, unknown>[]>('palatto.movements', [])
          writeLocal('palatto.movements', [movement, ...movements].slice(0, 1000))
        }
        if (input.received) {
          const next = applyMovement(supply, 'entrada', input.quantity)
          writeLocal(SUPPLY_KEY, supplies.map(row => row.id === input.supply_id ? next : row))
          const stockMovement: SupplyMovement = { id: crypto.randomUUID(), supply_id: input.supply_id, kind: 'entrada', quantity: input.quantity, reason: `Compra recibida · ${input.supplier || supply.name}`, actor: profile?.id || '', created_at: now }
          writeLocal(MOVEMENT_KEY, [stockMovement, ...readLocal<SupplyMovement[]>(MOVEMENT_KEY, [])].slice(0, 500))
        }
        const purchase: SupplyPurchase = { ...input, id: crypto.randomUUID(), supplier: input.supplier.trim(), unit_cost: input.unit_cost, total_amount: totalAmount, created_by: profile?.id || '', created_at: now, paid_at: input.paid ? now : null, received_at: input.received ? now : null }
        writeLocal(PURCHASE_KEY, [purchase, ...readLocal<SupplyPurchase[]>(PURCHASE_KEY, [])].slice(0, 300))
      }
      await load()
      setNotice(input.paid ? 'Compra registrada como pagada.' : 'Compra pendiente registrada.')
      return true
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo registrar la compra.'); return false }
    finally { setBusy(false) }
  }

  async function updatePurchase(purchaseId: string, action: 'paid' | 'unpaid' | 'received', method?: 'efectivo' | 'transferencia'): Promise<boolean> {
    if (!canWrite(role)) { setError('Tu rol solo puede consultar el inventario.'); return false }
    setBusy(true); setError('')
    try {
      if (source === 'supabase' && supabase) {
        const { error: rpcError } = await supabase.rpc('update_supply_purchase', { p_id: purchaseId, p_action: action, p_method: method || null })
        if (rpcError) throw rpcError
      } else {
        const list = readLocal<SupplyPurchase[]>(PURCHASE_KEY, [])
        const purchase = list.find(row => row.id === purchaseId)
        if (!purchase) throw new Error('La compra ya no existe.')
        const now = new Date().toISOString()
        if (action === 'paid' && !purchase.paid) {
          const supply = loadLocalSupplies().find(row => row.id === purchase.supply_id)
          const movement = {
            id: crypto.randomUUID(), business: 'palatto' as const, amount: -purchase.total_amount,
            method: method || 'efectivo', reason: `Compra de insumos · ${purchase.supplier || supply?.name || 'Insumo'}`,
            order_id: null, shift_id: null, actor: profile?.id || '', created_at: now,
            transfer_id: null, kind: 'gasto' as const,
          }
          const movements = readLocal<Record<string, unknown>[]>('palatto.movements', [])
          writeLocal('palatto.movements', [movement, ...movements].slice(0, 1000))
        }
        if (action === 'unpaid' && purchase.paid) {
          const supply = loadLocalSupplies().find(row => row.id === purchase.supply_id)
          const movement = {
            id: crypto.randomUUID(), business: 'palatto' as const, amount: purchase.total_amount,
            method: purchase.payment_method || 'efectivo', reason: `Reversión de pago · compra de ${purchase.supplier || supply?.name || 'Insumo'}`,
            order_id: null, shift_id: null, actor: profile?.id || '', created_at: now,
            transfer_id: null, kind: 'gasto' as const,
          }
          const movements = readLocal<Record<string, unknown>[]>('palatto.movements', [])
          writeLocal('palatto.movements', [movement, ...movements].slice(0, 1000))
        }
        const updated = { ...purchase, ...(action === 'paid' ? { paid: true, payment_method: method || 'efectivo', paid_at: now } : action === 'unpaid' ? { paid: false, payment_method: null, paid_at: null } : { received: true, received_at: now }) }
        if (action === 'received' && !purchase.received) {
          const supplies = loadLocalSupplies()
          const supply = supplies.find(row => row.id === purchase.supply_id)
          if (!supply) throw new Error('El insumo ya no existe.')
          writeLocal(SUPPLY_KEY, supplies.map(row => row.id === supply.id ? applyMovement(row, 'entrada', purchase.quantity) : row))
          const stockMovement: SupplyMovement = { id: crypto.randomUUID(), supply_id: supply.id, kind: 'entrada', quantity: purchase.quantity, reason: `Compra recibida · ${purchase.supplier || supply.name}`, actor: profile?.id || '', created_at: now }
          writeLocal(MOVEMENT_KEY, [stockMovement, ...readLocal<SupplyMovement[]>(MOVEMENT_KEY, [])].slice(0, 500))
        }
        writeLocal(PURCHASE_KEY, list.map(row => row.id === purchaseId ? updated : row))
      }
      await load()
      setNotice(action === 'paid' ? 'Compra marcada como pagada y registrada en gastos.' : action === 'unpaid' ? 'Compra devuelta a pendiente; se registró la reversión del pago.' : 'Pedido recibido y stock actualizado.')
      return true
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo actualizar la compra.'); return false }
    finally { setBusy(false) }
  }

  return {
    supplies, movements, purchases, loading, busy, error, notice, source, setupNeeded, purchaseSetupNeeded,
    setError, setNotice, saveSupply, registerMovement, registerPurchase, updatePurchase, reload: load,
  }
}
