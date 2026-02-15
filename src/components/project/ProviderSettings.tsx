import type { ProviderSetting } from '@/types'
import { Input } from '@/components/ui/input'

interface Props {
  settings: ProviderSetting[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

/** 根据 Provider schema 动态渲染专属设置控件 */
export function ProviderSettings({ settings, values, onChange }: Props) {
  if (!settings.length) return null

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Provider 专属设置</p>
      {settings.map((s) => {
        const val = values[s.key] ?? s.default
        return (
          <div key={s.key} className="space-y-1">
            {s.type === 'boolean' ? (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!val}
                  onChange={(e) => onChange(s.key, e.target.checked)}
                  className="accent-primary"
                />
                <span className="text-sm font-medium">{s.label}</span>
              </label>
            ) : (
              <label className="text-sm font-medium">{s.label}</label>
            )}

            {s.type === 'string' && (
              <Input
                value={(val as string) || ''}
                onChange={(e) => onChange(s.key, e.target.value)}
                placeholder={s.label}
              />
            )}

            {s.type === 'select' && s.options && (
              <select
                value={val as string}
                onChange={(e) => onChange(s.key, e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {s.options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )}

            {s.type === 'number' && (
              <Input
                type="number"
                value={val as number}
                min={s.min}
                max={s.max}
                onChange={(e) => onChange(s.key, Number(e.target.value))}
              />
            )}

            {s.description && (
              <p className="text-xs text-muted-foreground">{s.description}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
