import { useState, useEffect, useMemo, useCallback, memo } from 'react'
import { ChevronDown, Copy, Check, Terminal, GitBranch, Clock, AlertCircle, FileText, Loader2, FileWarning } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Session, Feature } from '@/types'

interface Props {
  projectId: string
  sessions: Session[]
  features: Feature[]
  fullscreen?: boolean
}

const statusStyles: Record<string, { bar: string; badge: 'default' | 'success' | 'destructive' | 'warning'; label: string }> = {
  running:   { bar: 'bg-blue-500/80 hover:bg-blue-500',       badge: 'default',     label: 'Running' },
  completed: { bar: 'bg-emerald-500/80 hover:bg-emerald-500', badge: 'success',     label: 'Completed' },
  failed:    { bar: 'bg-red-500/80 hover:bg-red-500',         badge: 'destructive', label: 'Failed' },
  stopped:   { bar: 'bg-yellow-500/80 hover:bg-yellow-500',   badge: 'warning',     label: 'Stopped' },
}

const typeLabels: Record<string, string> = {
  initializer: 'Initializer',
  coding: 'Coding',
  'agent-teams': 'Agent Teams',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m${s > 0 ? `${s.toString().padStart(2, '0')}s` : ''}`
}

function getDuration(session: Session, now: number): number {
  const start = new Date(session.startedAt).getTime()
  const end = session.endedAt ? new Date(session.endedAt).getTime() : now
  return Math.max(end - start, 0)
}

function getToolStats(session: Session): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const log of session.logs || []) {
    if (log.type === 'tool_use' && log.toolName) {
      stats[log.toolName] = (stats[log.toolName] || 0) + 1
    }
  }
  return stats
}

function getErrorLogs(session: Session): string[] {
  return (session.logs || [])
    .filter((l) => l.type === 'error')
    .slice(-3)
    .map((l) => l.content)
}

// Infer which feature a serial coding session is working on by scanning its logs
const FEATURE_ID_RE = /feature-(\d+)/i
function inferFeatureIdFromLogs(session: Session): string | null {
  for (const log of session.logs || []) {
    if (log.type !== 'assistant' && log.type !== 'system') continue
    const match = log.content.match(FEATURE_ID_RE)
    if (match) return match[0].toLowerCase()
  }
  return null
}

// Get a human-readable task label for the Gantt bar
function getSessionTaskLabel(
  session: Session,
  featureMap: Map<string, Feature>,
): string | null {
  // Explicit featureId — parallel sessions
  if (session.featureId) {
    const f = featureMap.get(session.featureId)
    return f ? f.description : session.featureId
  }

  // Initializer sessions
  if (session.type === 'initializer') return 'Spec Breakdown'

  // Agent Teams
  if (session.type === 'agent-teams') return 'End-to-End Development'

  // Serial coding — try to infer from logs
  const inferredId = inferFeatureIdFromLogs(session)
  if (inferredId) {
    const f = featureMap.get(inferredId)
    return f ? f.description : inferredId
  }

  return null
}

// Parse a single stream-json line into a displayable entry
interface LogLine {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'raw'
  content: string
  toolName?: string
}

function parseLogLine(line: string): LogLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // STDERR lines
  if (trimmed.startsWith('[STDERR]')) {
    return { type: 'error', content: trimmed.slice(8).trim() }
  }

  // Session markers
  if (trimmed.startsWith('===')) {
    return { type: 'system', content: trimmed }
  }

  // Try JSON parse
  try {
    const obj = JSON.parse(trimmed)

    if (obj.type === 'assistant' && obj.message) {
      const content = typeof obj.message === 'string'
        ? obj.message
        : obj.message.content?.map((c: Record<string, unknown>) => {
            if (c.type === 'text') return c.text
            if (c.type === 'tool_use') return `[Tool: ${c.name}]`
            return ''
          }).join('') || JSON.stringify(obj.message).slice(0, 300)
      return { type: 'assistant', content: content.slice(0, 1000) }
    }

    if (obj.type === 'tool_use' || obj.subtype === 'tool_use') {
      const name = obj.name || obj.tool_name || 'unknown'
      const input = obj.input ? JSON.stringify(obj.input).slice(0, 200) : ''
      return { type: 'tool_use', content: input, toolName: name }
    }

    if (obj.type === 'tool_result' || obj.subtype === 'tool_result') {
      const content = typeof obj.content === 'string' ? obj.content.slice(0, 300) : JSON.stringify(obj.content || obj.output || '').slice(0, 300)
      return { type: 'tool_result', content }
    }

    if (obj.type === 'result') {
      const content = obj.result || obj.message || JSON.stringify(obj).slice(0, 300)
      return { type: 'system', content: typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content).slice(0, 500) }
    }

    if (obj.type === 'system') {
      // Skip noisy subtypes
      if (['hook_started', 'hook_response', 'init', 'config'].includes(obj.subtype)) return null
      return { type: 'system', content: (obj.message || JSON.stringify(obj)).slice(0, 300) }
    }

    // Fallback: show type info
    const parts: string[] = []
    if (obj.type) parts.push(obj.type)
    if (obj.model) parts.push(obj.model)
    if (obj.stop_reason) parts.push(`stop: ${obj.stop_reason}`)
    if (parts.length > 0) return { type: 'system', content: parts.join(' · ') }

    return null
  } catch {
    // Non-JSON line
    if (trimmed.length > 0) {
      return { type: 'raw', content: trimmed.slice(0, 500) }
    }
    return null
  }
}

const lineStyles: Record<LogLine['type'], string> = {
  assistant: 'text-blue-300',
  tool_use: 'text-amber-300',
  tool_result: 'text-emerald-300/70',
  system: 'text-muted-foreground',
  error: 'text-red-400',
  raw: 'text-muted-foreground/60',
}

// Memo'd log line — content-visibility: auto lets the browser skip layout/paint for off-screen lines
const RawLogLine = memo(function RawLogLine({ line }: { line: LogLine }) {
  return (
    <div className={cn('py-0.5', lineStyles[line.type])} style={{ contentVisibility: 'auto', containIntrinsicBlockSize: '20px' }}>
      {line.type === 'tool_use' ? (
        <span className="inline-flex items-center gap-1">
          <span className="bg-amber-500/15 text-amber-300 rounded px-1 py-px font-semibold">{line.toolName}</span>
          {line.content && <span className="text-muted-foreground">{line.content}</span>}
        </span>
      ) : (
        <span className="whitespace-pre-wrap break-all">{line.content}</span>
      )}
    </div>
  )
})

export function SessionTimeline({ projectId, sessions, features, fullscreen }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [copiedPath, setCopiedPath] = useState(false)

  // Log viewer state
  const [logSession, setLogSession] = useState<Session | null>(null)
  const [logContent, setLogContent] = useState<string>('')
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)

  const hasRunning = sessions.some((s) => s.status === 'running')

  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasRunning])

  const featureMap = useMemo(() => {
    const map = new Map<string, Feature>()
    for (const f of features) map.set(f.id, f)
    return map
  }, [features])

  // Newest first
  const sorted = useMemo(() => [...sessions].reverse(), [sessions])

  const maxDuration = useMemo(() => {
    let max = 0
    for (const s of sessions) {
      max = Math.max(max, getDuration(s, now))
    }
    return max || 1
  }, [sessions, now])

  const toggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path)
    setCopiedPath(true)
    setTimeout(() => setCopiedPath(false), 1500)
  }, [])

  // Open log viewer
  const openLogViewer = useCallback(async (session: Session) => {
    setLogSession(session)
    setLogContent('')
    setLogError(null)
    setLogLoading(true)
    try {
      const text = await api.getSessionRawLog(projectId, session.id)
      setLogContent(text)
    } catch (err) {
      if (err instanceof Error && err.message === 'LOG_NOT_FOUND') {
        setLogError('Log file not found, it may have been deleted')
      } else {
        setLogError('Failed to fetch log')
      }
    } finally {
      setLogLoading(false)
    }
  }, [projectId])

  // Parse log content into lines
  const parsedLines = useMemo(() => {
    if (!logContent) return []
    return logContent.split('\n').map(parseLogLine).filter((l): l is LogLine => l !== null)
  }, [logContent])

  if (sessions.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-4 text-sm animate-fade-in">
        No session records yet
      </div>
    )
  }

  return (
    <>
      <div className={cn('overflow-y-auto', fullscreen ? 'h-full' : 'max-h-[160px]')}>
        <div className="flex flex-col gap-1 pr-1">
          {sorted.map((session, i) => {
            const style = statusStyles[session.status] || { bar: 'bg-gray-500/80 hover:bg-gray-500', badge: 'default' as const, label: session.status }
            const isRunning = session.status === 'running'
            const duration = getDuration(session, now)
            const widthPct = Math.max((duration / maxDuration) * 100, 15)
            const taskLabel = getSessionTaskLabel(session, featureMap)
            const isExpanded = expandedId === session.id

            return (
              <div key={session.id} style={{ animation: `fade-in 0.2s ease-out ${i * 30}ms both` }}>
                {/* Gantt bar */}
                <button
                  onClick={() => toggle(session.id)}
                  className={cn(
                    'relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-white cursor-pointer transition-all duration-200 w-full text-left',
                    style.bar,
                    isRunning && 'shadow-[0_0_10px] shadow-blue-500/30',
                  )}
                  style={{ width: `${widthPct}%`, minWidth: 160 }}
                >
                  {isRunning && (
                    <div className="absolute inset-0 rounded-md bg-white/10 animate-pulse" />
                  )}
                  <span className="relative flex items-center gap-1.5 truncate flex-1 min-w-0">
                    <span className="font-medium shrink-0">
                      {typeLabels[session.type] || session.type}
                      {session.agentIndex != null && ` #${session.agentIndex}`}
                    </span>
                    {taskLabel && (
                      <>
                        <span className="opacity-50">·</span>
                        <span className="truncate opacity-80">{taskLabel}</span>
                      </>
                    )}
                  </span>
                  <span className="relative flex items-center gap-1 shrink-0 font-mono tabular-nums">
                    {formatDuration(duration)}
                    <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', isExpanded && 'rotate-180')} />
                  </span>
                </button>

                {/* Detail panel */}
                <div
                  className={cn(
                    'grid transition-all duration-200 ease-out',
                    isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="bg-secondary/40 rounded-md mt-1 p-3 text-xs space-y-2.5 border border-border/50">
                      {/* Task info */}
                      {taskLabel && (
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground shrink-0">Task:</span>
                          <span className="font-medium">
                            {session.featureId && <span className="text-muted-foreground mr-1">{session.featureId}</span>}
                            {taskLabel}
                          </span>
                        </div>
                      )}

                      {/* Time + Status row */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span className="font-mono">
                            {new Date(session.startedAt).toLocaleTimeString('en-US')}
                            {' → '}
                            {session.endedAt ? new Date(session.endedAt).toLocaleTimeString('en-US') : 'In Progress'}
                          </span>
                          <span className="text-foreground font-medium">({formatDuration(duration)})</span>
                        </div>
                        {session.branch && (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <GitBranch className="h-3 w-3" />
                            <span className="font-mono">{session.branch}</span>
                          </div>
                        )}
                        <Badge variant={style.badge} className="text-[10px] h-4 px-1.5">{style.label}</Badge>
                      </div>

                      {/* Tool call stats */}
                      {(session.logs || []).length > 0 && (() => {
                        const stats = getToolStats(session)
                        const entries = Object.entries(stats).sort((a, b) => b[1] - a[1])
                        if (entries.length === 0) return null
                        return (
                          <div className="flex items-start gap-2">
                            <Terminal className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                            <div className="flex flex-wrap gap-1.5">
                              {entries.map(([tool, count]) => (
                                <span key={tool} className="bg-secondary rounded px-1.5 py-0.5 font-mono">
                                  {tool} <span className="text-muted-foreground">×{count}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )
                      })()}

                      {/* Error logs */}
                      {session.status === 'failed' && (() => {
                        const errors = getErrorLogs(session)
                        if (errors.length === 0) return null
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1 text-red-400">
                              <AlertCircle className="h-3 w-3" />
                              <span className="font-medium">Error Details</span>
                            </div>
                            {errors.map((err, idx) => (
                              <pre key={idx} className="bg-red-500/10 text-red-300 rounded px-2 py-1 text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                                {err}
                              </pre>
                            ))}
                          </div>
                        )
                      })()}

                      {/* Log file path + view button */}
                      {session.logFile && (
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="font-mono truncate">{session.logFile}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); copyPath(session.logFile!) }}
                            className="shrink-0 p-0.5 rounded hover:bg-secondary cursor-pointer"
                            title="Copy Path"
                          >
                            {copiedPath ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); openLogViewer(session) }}
                            className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-secondary cursor-pointer text-primary"
                            title="View Log"
                          >
                            <FileText className="h-3 w-3" />
                            <span>View</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Log viewer sheet */}
      <Sheet open={!!logSession} onOpenChange={(open) => { if (!open) setLogSession(null) }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Session Log
              {logSession && (
                <Badge variant={statusStyles[logSession.status]?.badge || 'default'} className="text-[10px] h-4 px-1.5 ml-1">
                  {statusStyles[logSession.status]?.label || logSession.status}
                </Badge>
              )}
              {parsedLines.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono ml-auto mr-6">{parsedLines.length} lines</span>
              )}
            </SheetTitle>
            {logSession && (
              <SheetDescription>
                {typeLabels[logSession.type] || logSession.type}
                {logSession.agentIndex != null && ` #${logSession.agentIndex}`}
                {' · '}
                {new Date(logSession.startedAt).toLocaleString('en-US')}
                {logSession.featureId && (() => {
                  const f = featureMap.get(logSession.featureId!)
                  return f ? ` · ${f.id}: ${f.description}` : ''
                })()}
              </SheetDescription>
            )}
          </SheetHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
            {logLoading && (
              <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading log...</span>
              </div>
            )}

            {logError && (
              <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground">
                <FileWarning className="h-8 w-8 text-yellow-500/60" />
                <span className="text-sm">{logError}</span>
              </div>
            )}

            {!logLoading && !logError && parsedLines.length === 0 && (
              <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                Log content is empty
              </div>
            )}

            {!logLoading && !logError && parsedLines.length > 0 && (
              <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
                {parsedLines.map((line, idx) => (
                  <RawLogLine key={idx} line={line} />
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
