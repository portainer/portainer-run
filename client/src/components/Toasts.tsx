import { useEffect, useRef } from 'react'
import { toast, Toaster } from '@ds/v3-components/Toast/Toast'
import type { ToastVariant } from '@ds/v3-components/Toast/Toast'
import { useAppStore } from '../store/useAppStore.js'

const TYPE_TO_VARIANT: Record<string, ToastVariant> = {
  ok: 'success',
  err: 'error',
  info: 'default',
}

/**
 * Bridges the existing store toast queue (pushToast/removeToast) to the
 * design-system Toaster without changing the store contract.
 */
export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    for (const t of toasts) {
      if (seen.current.has(t.id)) continue
      seen.current.add(t.id)
      toast({ title: t.msg, variant: TYPE_TO_VARIANT[t.type] ?? 'default' })
    }
  }, [toasts])

  return <Toaster />
}
