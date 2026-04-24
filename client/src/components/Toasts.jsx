import { useAppStore } from '../store/useAppStore.js'

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toast-wrap" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type === 'ok' ? 'ok' : t.type === 'err' ? 'err' : 'info'}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}
