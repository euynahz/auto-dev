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

      if (event.response) {
        return { type: 'text', content: event.response }
      }

      if (event.type === 'text' || event.type === 'message') {
        const content = event.content || event.text || ''
        return content.trim() ? { type: 'text', content } : { type: 'ignore' }
      }

      if (event.type === 'tool_call' || event.type === 'function_call') {
        const name = event.name || event.tool || 'unknown'
        const input = event.input || event.arguments || ''
        return { type: 'tool_use', name, input: String(input).slice(0, 200) }
      }

      if (event.type === 'tool_result' || event.type === 'tool_output') {
        return { type: 'tool_result', output: (event.output || event.content || '').slice(0, 500) }
      }

      if (event.type === 'error') {
        return { type: 'error', content: event.message || event.error || JSON.stringify(event) }
      }

      if (event.content && typeof event.content === 'string') {
        return { type: 'text', content: event.content }
      }

      return { type: 'ignore' }
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
