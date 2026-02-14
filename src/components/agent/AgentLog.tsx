import { useEffect, useRef, memo, useMemo } from 'react'
import { Terminal, Wrench, Settings, AlertCircle, Brain, Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LogEntry } from '@/types'

interface Props {
  logs: LogEntry[]
  fullscreen?: boolean
  onToggleFullscreen?: () => void
}

const logIcons: Record<string, React.ReactNode> = {
  assistant: <Terminal className="h-3.5 w-3.5 text-gray-400" />,
  tool_use: <Wrench className="h-3.5 w-3.5 text-blue-400" />,
  thinking: <Brain className="h-3.5 w-3.5 text-purple-400/50" />,
  system: <Settings className="h-3.5 w-3.5 text-yellow-400" />,
  error: <AlertCircle className="h-3.5 w-3.5 text-red-400" />,
}

const logStyles: Record<string, string> = {
  assistant: 'text-gray-100',
  tool_use: 'text-blue-400/80',
  thinking: 'text-purple-300/40 italic text-xs',
  system: 'text-yellow-400/80',
  error: 'text-red-400',
}

const agentColors = ['text-blue-400', 'text-emerald-400', 'text-purple-400', 'text-orange-400', 'text-pink-400', 'text-cyan-400', 'text-yellow-400', 'text-red-400']

// Memoized individual log entry — only re-renders when its own data changes
const LogEntryRow = memo(function LogEntryRow({ entry, showBreak, isRecent }: {
  entry: LogEntry
  showBreak: boolean
  isRecent: boolean
}) {
  return (
    <div style={{ contentVisibility: 'auto', containIntrinsicBlockSize: '28px' }}>
      {showBreak && (
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-[#1e293b] to-transparent" />
          <span className="text-[10px] text-gray-600 font-mono uppercase tracking-wider px-2">New Session</span>
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-[#1e293b] to-transparent" />
        </div>
      )}
      <div
        className={cn(
          'flex items-start gap-2 py-1 px-2 rounded-md hover:bg-white/[0.02] transition-colors group',
          logStyles[entry.type] || 'text-gray-400'
        )}
        style={isRecent ? { animation: 'fade-in 0.2s ease-out' } : undefined}
      >
        <span className="shrink-0 mt-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
          {logIcons[entry.type] || <Terminal className="h-3.5 w-3.5" />}
        </span>
        {entry.agentIndex != null && (
          <span className={cn('text-[10px] font-mono font-bold px-1 py-0.5 rounded bg-current/10', agentColors[entry.agentIndex % agentColors.length])}>
            A{entry.agentIndex}
          </span>
        )}
        {entry.type === 'tool_use' && entry.toolName && (
          <span className="text-[10px] font-mono text-blue-500/60 bg-blue-500/5 px-1.5 py-0.5 rounded shrink-0">{entry.toolName}</span>
        )}
        <span className="whitespace-pre-wrap break-all flex-1 leading-relaxed">
          {entry.type === 'tool_use' && entry.toolInput ? (
            <>
              <span className="text-blue-300">{entry.content}</span>
              <span className="text-gray-600 text-xs ml-2">{entry.toolInput.slice(0, 200)}</span>
            </>
          ) : (
            entry.content
          )}
        </span>
        <span className="text-[10px] text-gray-700 shrink-0 mt-0.5 font-mono tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
          {new Date(entry.timestamp).toLocaleTimeString('zh-CN')}
        </span>
      </div>
    </div>
  )
})

export function AgentLog({ logs, fullscreen, onToggleFullscreen }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }

  // Pre-compute session breaks so each entry knows if it needs a separator
  const sessionBreaks = useMemo(() => {
    const breaks = new Set<number>()
    for (let i = 1; i < logs.length; i++) {
      if (logs[i].sessionId !== logs[i - 1].sessionId) breaks.add(i)
    }
    return breaks
  }, [logs])

  const recentThreshold = logs.length - 3

  return (
    <div className="flex flex-col h-full bg-[#0b1120] rounded-xl overflow-hidden border border-[#1e293b]">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0f1729] border-b border-[#1e293b] shrink-0">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors cursor-pointer" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-500 transition-colors cursor-pointer" />
          <div className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-500 transition-colors cursor-pointer" />
        </div>
        <div className="flex items-center gap-1.5 ml-2">
          <Terminal className="h-3.5 w-3.5 text-gray-500" />
          <span className="text-xs text-gray-500 font-mono">Agent Log</span>
        </div>
        <span className="text-[10px] text-gray-600 font-mono ml-auto tabular-nums">{logs.length} entries</span>
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="text-gray-500 hover:text-gray-300 p-1 rounded hover:bg-white/5 cursor-pointer transition-colors"
            title={fullscreen ? '退出全屏' : '全屏'}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto terminal-log p-4 space-y-0.5"
      >
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 animate-fade-in">
            <div className="typing-indicator flex gap-1.5">
              <span />
              <span />
              <span />
            </div>
            <span className="text-gray-600 text-sm">等待 Agent 启动...</span>
          </div>
        ) : (
          logs.map((entry, index) => (
            <LogEntryRow
              key={entry.id}
              entry={entry}
              showBreak={sessionBreaks.has(index)}
              isRecent={index >= recentThreshold}
            />
          ))
        )}
        <div />
      </div>
    </div>
  )
}
