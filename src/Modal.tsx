import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={ref} className="dialog native-dialog" aria-label={title}
    onCancel={event => { event.preventDefault(); close() }}>
    <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="Cerrar" onClick={close}><X /></button></header>
    {children}
  </dialog>
}
