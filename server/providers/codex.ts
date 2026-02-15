import type { AgentProvider, AgentEvent, SessionContext } from './types.js'

// ===== OpenAI Codex CLI Provider =====
// https://github.com/openai/codex

export const codexProvider: AgentProvider = {
  name: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  defaultModel: 'o4-mini',

  capabilities: {
    streaming: true,
    maxTurns: false,
    systemPrompt: false,
    agentTeams: false,
    modelSelection: true,
    dangerousMode: true,
  },

  settings: [
    {
      key: 'sandbox',
      label: 'Sandbox mode',
      description: 'Control Codex file system access permissions',
      type: 'select',
      default: 'danger-full-access',
      options: [
        { value: 'read-only', label: 'Read-only' },
        { value: 'workspace-write', label: 'Workspace writable' },
        { value: 'danger-full-access', label: 'Full access (dangerous)' },
      ],
    },
  ],

  buildArgs(ctx: SessionContext): string[] {
    const ps = ctx.providerSettings || {}
    const sandbox = (ps.sandbox as string) || 'danger-full-access'

    const args = [
      'exec',
      '--full-auto',
      '--json',
      '--sandbox', sandbox,
    ]
    if (ctx.model) {
      args.push('--model', ctx.model)
    }
    args.push(ctx.prompt)
    return args
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    try {
      const event = JSON.parse(trimmed)

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

        case 'error':
          return { type: 'error', content: event.message || event.error || JSON.stringify(event) }

        case 'status':
        case 'progress':
          return { type: 'system', content: event.message || event.status || '' }

        case 'thinking':
          return { type: 'thinking', content: (event.content || event.text || '').slice(0, 300) }

        default:
          return { type: 'ignore' }
      }
    } catch {
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
