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
    {
      key: 'baseUrl',
      label: 'API Base URL',
      description: 'OpenAI-compatible API base URL (leave empty for default)',
      type: 'string',
      default: '',
    },
  ],

  buildArgs(ctx: SessionContext): string[] {
    const ps = ctx.providerSettings || {}
    const sandbox = (ps.sandbox as string) || 'danger-full-access'

    const args = [
      'exec',
      '--json',
      '--sandbox', sandbox,
    ]
    if (ctx.model) {
      args.push('--model', ctx.model)
    }
    args.push(ctx.prompt)
    return args
  },

  buildEnv(ctx: SessionContext): Record<string, string> {
    const ps = ctx.providerSettings || {}
    const baseUrl = ps.baseUrl as string
    return baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    try {
      const event = JSON.parse(trimmed)

      switch (event.type) {
        case 'item.started': {
          const item = event.item || {}
          if (item.type === 'command_execution' && item.command) {
            return { type: 'tool_use', name: 'exec', input: item.command.slice(0, 200) }
          }
          return { type: 'ignore' }
        }

        case 'item.completed': {
          const item = event.item || {}
          switch (item.type) {
            case 'agent_message':
              return item.text?.trim() ? { type: 'text', content: item.text } : { type: 'ignore' }
            case 'reasoning':
              return item.text ? { type: 'thinking', content: item.text.slice(0, 300) } : { type: 'ignore' }
            case 'tool_call':
            case 'function_call':
              return { type: 'tool_use', name: item.name || 'unknown', input: String(item.arguments || '').slice(0, 200) }
            case 'tool_call_output':
            case 'function_call_output':
              return { type: 'tool_result', output: String(item.output || '').slice(0, 500) }
            case 'command_execution':
              if (item.status === 'completed') {
                const output = item.aggregated_output || ''
                return output.trim()
                  ? { type: 'tool_result', output: output.slice(0, 500) }
                  : { type: 'system', content: `$ ${(item.command || '').slice(0, 100)} → exit ${item.exit_code}` }
              }
              return { type: 'tool_use', name: 'exec', input: (item.command || '').slice(0, 200) }
            default:
              return { type: 'ignore' }
          }
        }

        case 'error':
          return { type: 'error', content: event.message || JSON.stringify(event) }

        case 'turn.failed':
          return { type: 'error', content: event.error?.message || 'turn failed' }

        case 'thread.started':
        case 'turn.started':
        case 'turn.completed':
          return { type: 'ignore' }

        default:
          return { type: 'ignore' }
      }
    } catch {
      return trimmed ? { type: 'system', content: trimmed.slice(0, 500) } : null
    }
  },

  isSuccessExit(code: number): boolean {
    return code === 0
  },
}
