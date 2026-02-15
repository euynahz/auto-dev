import type { AgentProvider, AgentEvent, SessionContext } from './types.js'

// ===== OpenCode CLI Provider =====
// https://github.com/opencode-ai/opencode

export const opencodeProvider: AgentProvider = {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',

  capabilities: {
    streaming: false,       // run 模式输出完整结果，非流式
    maxTurns: false,
    systemPrompt: false,
    agentTeams: false,
    modelSelection: false,  // opencode 通过配置文件选模型，不支持 CLI flag
    dangerousMode: false,
  },

  buildArgs(ctx: SessionContext): string[] {
    return [
      'run',
      '--format', 'json',
      '--quiet',
      ctx.prompt,
    ]
  },

  parseLine(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    try {
      const event = JSON.parse(trimmed)

      // opencode run --format json 输出格式
      // 可能是单个 JSON 对象（最终结果）或流式事件

      // 最终结果格式：{ response: "...", ... }
      if (event.response) {
        return { type: 'text', content: event.response }
      }

      // 事件格式
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

      // 有 content 字段的通用处理
      if (event.content && typeof event.content === 'string') {
        return { type: 'text', content: event.content }
      }

      return { type: 'ignore' }
    } catch {
      // 非 JSON — 纯文本输出
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
