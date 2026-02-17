import type { AgentProvider, AgentEvent, SessionContext } from './types.js'

// ===== OpenCode CLI Provider =====
// https://github.com/opencode-ai/opencode

export const opencodeProvider: AgentProvider = {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',

  capabilities: {
    streaming: false,
    maxTurns: false,
    systemPrompt: false,
    agentTeams: false,
    modelSelection: true,
    dangerousMode: false,
  },

  settings: [
    {
      key: 'title',
      label: 'Session title',
      description: 'Name the OpenCode session for easier tracking',
      type: 'string',
      default: '',
    },
  ],

  buildArgs(ctx: SessionContext): string[] {
    const ps = ctx.providerSettings || {}
    const title = ps.title as string

    const args = [
      'run',
      '--format', 'json',
    ]
    if (ctx.model) {
      args.push('--model', ctx.model)
    }
    if (title) {
      args.push('--title', title)
    }
    args.push(ctx.prompt)
    return args
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    try {
      const event = JSON.parse(trimmed)
      const part = event.part || {}

      switch (event.type) {
        case 'text':
          return part.text?.trim() ? { type: 'text', content: part.text } : { type: 'ignore' }

        case 'tool_use': {
          const name = part.tool || 'unknown'
          const state = part.state || {}
          if (state.status === 'completed' && state.output) {
            return { type: 'tool_result', output: String(state.output).slice(0, 500) }
          }
          const input = state.input ? JSON.stringify(state.input).slice(0, 200) : ''
          return { type: 'tool_use', name, input }
        }

        case 'error':
          return { type: 'error', content: part.error || event.error || JSON.stringify(event) }

        case 'step_start':
        case 'step_finish':
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
