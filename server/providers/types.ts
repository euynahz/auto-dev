// ===== AI Agent Provider Abstraction Layer =====

/** Session context, passed to provider to build args */
export interface SessionContext {
  prompt: string
  model: string
  maxTurns: number
  systemPrompt?: string
  projectDir: string
  dangerousMode?: boolean    // Skip permission confirmation
  disableSlashCommands?: boolean
  verbose?: boolean
  /** Provider-specific settings (from project config) */
  providerSettings?: Record<string, unknown>
}

/** Provider capability declaration */
export interface ProviderCapabilities {
  streaming: boolean          // Supports streaming JSON output
  maxTurns: boolean           // Supports limiting turns
  systemPrompt: boolean       // Supports injecting system prompt
  agentTeams: boolean         // Supports built-in multi-agent coordination
  modelSelection: boolean     // Supports model selection
  dangerousMode: boolean      // Supports skipping permission confirmation
}

/** Provider-specific setting schema — frontend renders controls based on this */
export interface ProviderSetting {
  key: string
  label: string
  description?: string
  type: 'boolean' | 'string' | 'select' | 'number'
  default: unknown
  /** Options list for type='select' */
  options?: Array<{ value: string; label: string }>
  /** Range for type='number' */
  min?: number
  max?: number
}

/** Standardized output event — all provider stdout is converted to this */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'tool_result'; output: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | { type: 'ignore' }

/** AI Agent Provider interface */
export interface AgentProvider {
  /** Provider unique identifier */
  name: string

  /** Display name */
  displayName: string

  /** CLI binary name */
  binary: string

  /** Default model name (for frontend placeholder) */
  defaultModel?: string

  /** Capability declaration */
  capabilities: ProviderCapabilities

  /** Provider-specific settings schema */
  settings?: ProviderSetting[]

  /** Build CLI launch arguments */
  buildArgs(ctx: SessionContext): string[]

  /** Build extra environment variables (optional) */
  buildEnv?(ctx: SessionContext): Record<string, string>

  /** Parse one line of stdout → standardized event */
  parseLine(line: string): AgentEvent | null

  /** Check if process exit code indicates success */
  isSuccessExit(code: number): boolean

  /** Check if a line of output is noise (should be skipped) */
  isNoiseLine?(line: string): boolean
}
