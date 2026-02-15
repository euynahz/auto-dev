import type { AgentProvider, AgentEvent, SessionContext } from './types.js'

// ===== OpenAI Codex CLI Provider =====
// https://github.com/openai/codex

export const codexProvider: AgentProvider = {
  name: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',

  capabilities: {
    streaming: true,
    maxTurns: false,        // codex 没有 max-turns 概念
    systemPrompt: false,    // 不支持 --system-prompt
    agentTeams: false,
    modelSelection: true,
    dangerousMode: true,    // --sandbox danger-full-access
  },

  buildArgs(ctx: SessionContext): string[] {
    const args = [
      'exec',
      '--full-auto',
      '--json',
    ]
    if (ctx.model) {
      args.push('--model', ctx.model)
    }
    if (ctx.dangerousMode !== false) {
      args.push('--sandbox', 'danger-full-access')
    }
    // prompt 放最后
    args.push(ctx.prompt)
    return args
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    try {
      const event = JSON.parse(trimmed)

      // Codex JSON 事件格式：{ type: "...", ... }
      switch (event.type) {
        case 'message': {
          const content = event.content || event.text || ''
          if (!content.trim()) return { type: 'ignore' }
          return { type: 'text', content }
        }

        case 'function_call':
        case 'tool_call': {
          const name = event.name || event.function?.name || 'unknown'
          const input = event.arguments || event.function?.arguments || ''
          return { type: 'tool_use', name, input: String(input).slice(0, 200) }
        }

        case 'function_call_output':
        case 'tool_call_output': {
          const output = event.output || event.content || ''
          return { type: 'tool_result', output: String(output).slice(0, 500) }
        }

        case 'error': {
          return { type: 'error', content: event.message || event.error || JSON.stringify(event) }
        }

        case 'status':
        case 'progress': {
          return { type: 'system', content: event.message || event.status || '' }
        }

        case 'thinking': {
          return { type: 'thinking', content: (event.content || event.text || '').slice(0, 300) }
        }

        default:
          return { type: 'ignore' }
      }
    } catch {
      // 非 JSON — 当作系统消息
      if (trimmed) {
        return { type: 'system', content: trimmed.slice(0, 500) }
      }
      return null
    }
  },

  isSuccessExit(code: number): boolean {
    return code === 0
  },
}
