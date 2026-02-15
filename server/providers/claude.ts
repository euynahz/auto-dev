import type { AgentProvider, AgentEvent, SessionContext } from './types.js'

// ===== Claude Code CLI Provider =====

/** 判断字符串是否像 JSON */
function looksLikeJson(s: string): boolean {
  const t = s.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

/** 解析 Claude API 响应 JSON 中的 content 字段，提取可读内容 */
export function parseThinkingContent(jsonStr: string): string {
  try {
    const obj = JSON.parse(jsonStr)

    // 处理 {"content": [...], "role": "assistant", ...} 格式
    const contentArr = obj.content || obj.message?.content
    if (Array.isArray(contentArr)) {
      const parts: string[] = []
      for (const block of contentArr) {
        if (block.type === 'tool_use') {
          const name = block.name || 'unknown'
          const input = block.input || {}
          const summary = input.file_path || input.command || input.pattern || input.query || input.url || ''
          parts.push(summary ? `${name} → ${summary}` : name)
        } else if (block.type === 'text' && block.text) {
          parts.push(block.text.slice(0, 200))
        }
      }
      if (parts.length > 0) return parts.join(' | ')
    }

    // 处理单层 tool_use 对象
    if (obj.type === 'tool_use' && obj.name) {
      const input = obj.input || {}
      const summary = input.file_path || input.command || input.pattern || input.query || input.url || ''
      return summary ? `${obj.name} → ${summary}` : obj.name
    }

    // 处理有 message 字段的情况
    if (typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message.slice(0, 200)
    }

    // 兜底：返回 type + model 等关键信息
    const fallbackParts: string[] = []
    if (obj.type) fallbackParts.push(obj.type)
    if (obj.model) fallbackParts.push(obj.model)
    if (obj.stop_reason) fallbackParts.push(`stop: ${obj.stop_reason}`)
    if (fallbackParts.length > 0) return fallbackParts.join(' · ')
  } catch {
    // 解析失败
  }
  return jsonStr.slice(0, 200)
}

/** Claude stream-json 噪音事件 */
const NOISE_SUBTYPES = new Set(['hook_started', 'hook_response', 'init', 'config'])

export const claudeProvider: AgentProvider = {
  name: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  defaultModel: 'claude-opus-4-6',

  capabilities: {
    streaming: true,
    maxTurns: true,
    systemPrompt: true,
    agentTeams: true,
    modelSelection: true,
    dangerousMode: true,
  },

  settings: [
    {
      key: 'verbose',
      label: '详细输出',
      description: '输出完整的 stream-json 事件流',
      type: 'boolean',
      default: true,
    },
    {
      key: 'disableSlashCommands',
      label: '禁用斜杠命令',
      description: '防止 Agent 意外触发 /commands',
      type: 'boolean',
      default: true,
    },
  ],

  buildArgs(ctx: SessionContext): string[] {
    const ps = ctx.providerSettings || {}
    const verbose = ps.verbose !== false       // default true
    const disableSlash = ps.disableSlashCommands !== false  // default true

    const args = [
      '-p', ctx.prompt,
      '--output-format', 'stream-json',
      '--max-turns', String(ctx.maxTurns),
    ]
    if (verbose) args.push('--verbose')
    if (ctx.model) {
      args.push('--model', ctx.model)
    }
    if (ctx.dangerousMode !== false) {
      args.push('--dangerously-skip-permissions')
    }
    if (disableSlash) {
      args.push('--disable-slash-commands')
    }
    if (ctx.systemPrompt) {
      args.push('--system-prompt', ctx.systemPrompt)
    }
    return args
  },

  parseLine(line: string): AgentEvent | null {
    try {
      const event = JSON.parse(line)

      if (event.type === 'assistant' && event.message) {
        const content = typeof event.message === 'string'
          ? event.message
          : event.message.content?.map((c: Record<string, unknown>) => c.type === 'text' ? c.text : '').join('') || JSON.stringify(event.message)

        if (!content.trim()) return { type: 'ignore' }

        if (looksLikeJson(content)) {
          return { type: 'thinking', content: parseThinkingContent(content) }
        } else {
          return { type: 'text', content }
        }
      }

      if (event.type === 'tool_use' || event.subtype === 'tool_use') {
        const toolName = event.name || event.tool_name || 'unknown'
        const toolInput = event.input ? JSON.stringify(event.input).slice(0, 200) : ''
        return { type: 'tool_use', name: toolName, input: toolInput }
      }

      if (event.type === 'system' || event.type === 'result') {
        if (NOISE_SUBTYPES.has(event.subtype)) return { type: 'ignore' }
        const content = event.result || event.message || JSON.stringify(event)
        return { type: 'system', content: typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content).slice(0, 500) }
      }

      return { type: 'ignore' }
    } catch {
      // 解析失败：JSON 内容作为 thinking，纯文本作为 system
      if (line.trim()) {
        if (looksLikeJson(line.trim())) {
          return { type: 'thinking', content: parseThinkingContent(line.trim()) }
        }
        return { type: 'system', content: line.trim().slice(0, 500) }
      }
      return null
    }
  },

  isSuccessExit(code: number): boolean {
    return code === 0
  },

  isNoiseLine(line: string): boolean {
    try {
      const event = JSON.parse(line)
      return NOISE_SUBTYPES.has(event.subtype)
    } catch {
      return false
    }
  },
}
