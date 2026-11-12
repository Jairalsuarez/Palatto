import { supabase } from './supabase'

export type PushActivity =
  | 'order_created'
  | 'order_updated'
  | 'order_paid'
  | 'split_payment'
  | 'order_deleted'
  | 'product_saved'
  | 'product_photo_saved'
  | 'cash_movement'
  | 'cash_transfer'
  | 'user_saved'
  | 'password_changed'
  | 'password_reset'
  | 'supply_saved'
  | 'supply_movement'
  | 'supply_purchase_created'
  | 'supply_purchase_paid'
  | 'supply_purchase_pending'
  | 'supply_purchase_received'

export async function notifyActivity(event: PushActivity): Promise<{ sent: number; attempted: number; reason?: string } | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.functions.invoke('palatto-push', {
      body: { action: 'notify_activity', event },
    })
    if (error || data?.error) {
      console.error('No se pudo enviar la notificación push', error || data?.error)
      return null
    }
    if (data?.sent === 0) console.warn('Notificación push sin destinatarios efectivos', data)
    return data as { sent: number; attempted: number; reason?: string }
  } catch {
    return null
  }
}

