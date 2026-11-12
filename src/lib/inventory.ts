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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [source, setSource] = useState<'supabase' | 'local'>('local')
  const [setupNeeded, setSetupNeeded] = useState(false)

  const loadLocal = useCallback(() => {
    setSupplies(loadLocalSupplies().sort((a, b) => a.name.localeCompare(b.name)))
    setMovements(readLocal<SupplyMovement[]>(MOVEMENT_KEY, []))
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
    const [supplyResult, movementResult] = await Promise.all([
      supabase.from('supplies').select('*').order('name'),
      supabase.from('supply_movements').select('*').order('created_at', { ascending: false }).limit(300),
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

  return {
    supplies, movements, loading, busy, error, notice, source, setupNeeded,
    setError, setNotice, saveSupply, registerMovement, reload: load,
  }
}
