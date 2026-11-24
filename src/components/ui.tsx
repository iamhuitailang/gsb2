import type { ReactNode } from 'react'

export type BadgeTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'accent'

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: 'badge badge-ok',
  warn: 'badge badge-warn',
  error: 'badge badge-error',
  info: 'badge badge-info',
  neutral: 'badge badge-neutral',
  accent: 'badge badge-accent',
}

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: BadgeTone
  children: ReactNode
  title?: string
}) {
  return (
    <span className={TONE_CLASS[tone]} title={title}>
      {children}
    </span>
  )
}

export function Panel({
  title,
  eyebrow,
  subtitle,
  actions,
  children,
  className = '',
  id,
}: {
  title?: string
  eyebrow?: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      {(title || actions || eyebrow) && (
        <header className="panel-head">
          <div className="panel-heading">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2>{title}</h2>}
            {subtitle && <p className="panel-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: BadgeTone
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function InlineNote({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok'
  children: ReactNode
}) {
  return <div className={`inline-note inline-${tone}`}>{children}</div>
}
