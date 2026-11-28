import { supabase } from './supabase'

export type PushActivity =
  | 'order_created'
  | 'order_updated'
  | 'order_paid'
  | 'order_delivered'
  | 'split_payment'
  | 'order_deleted'
  | 'product_saved'
  | 'product_photo_saved'
  | 'cash_movement'
  | 'cash_transfer'
  | 'cash_reconciled'
  | 'user_saved'
  | 'password_changed'
  | 'password_reset'
  | 'supply_saved'
  | 'supply_movement'
  | 'supply_purchase_created'
  | 'supply_purchase_paid'
  | 'supply_purchase_pending'
  | 'supply_purchase_received'

export interface PushDetails {
  actorName?: string
  orderId?: string
  movementId?: string
  orderNumber?: number
  customer?: string
  takeaway?: boolean
  items?: number
  itemsSummary?: string
  amount?: number
  method?: 'efectivo' | 'transferencia' | 'efectivo + transferencia'
  kind?: 'ingreso' | 'gasto' | 'retiro' | 'cobro' | 'correccion' | 'transferencia'
  reason?: string
  label?: string
  name?: string
  paid?: boolean
  received?: boolean
  delivered?: boolean
  reconciliationId?: string
  cashBalance?: number
  transferBalance?: number
  countedCash?: number
  countedTransfer?: number
}

export async function notifyActivity(
  event: PushActivity,
  details?: PushDetails,
): Promise<{ sent: number; attempted: number; reason?: string } | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.functions.invoke('palatto-push', {
      body: { action: 'notify_activity', event, details },
    })
    if (error || data?.error) {
      console.error('No se pudo enviar la notificación push', error || data?.error)
      return { sent: 0, attempted: 0, reason: 'function_error' }
    }
    if (data?.sent === 0) console.warn('Notificación push sin destinatarios efectivos', data)
    return data as { sent: number; attempted: number; reason?: string }
  } catch {
    return { sent: 0, attempted: 0, reason: 'network_error' }
  }
}
