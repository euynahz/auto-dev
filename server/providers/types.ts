// ===== AI Agent Provider 抽象层 =====

/** Session 上下文，传给 provider 构建参数 */
export interface SessionContext {
  prompt: string
  model: string
  maxTurns: number
  systemPrompt?: string
  projectDir: string
  dangerousMode?: boolean    // 跳过权限确认
  disableSlashCommands?: boolean
  verbose?: boolean
  /** Provider 专属设置（来自项目配置） */
  providerSettings?: Record<string, unknown>
}

/** Provider 能力声明 */
export interface ProviderCapabilities {
  streaming: boolean          // 支持流式 JSON 输出
  maxTurns: boolean           // 支持限制轮次
  systemPrompt: boolean       // 支持注入系统提示
  agentTeams: boolean         // 支持内置多 agent 协调
  modelSelection: boolean     // 支持指定模型
  dangerousMode: boolean      // 支持跳过权限确认
}

/** Provider 专属设置项 schema — 前端据此动态渲染控件 */
export interface ProviderSetting {
  key: string
  label: string
  description?: string
  type: 'boolean' | 'string' | 'select' | 'number'
  default: unknown
  /** type='select' 时的选项列表 */
  options?: Array<{ value: string; label: string }>
  /** type='number' 时的范围 */
  min?: number
  max?: number
}

/** 标准化输出事件 — 所有 provider 的 stdout 都转成这个 */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; name: string; input: string }
  | { type: 'tool_result'; output: string }
  | { type: 'system'; content: string }
  | { type: 'error'; content: string }
  | { type: 'ignore' }

/** AI Agent Provider 接口 */
export interface AgentProvider {
  /** Provider 唯一标识 */
  name: string

  /** 显示名称 */
  displayName: string

  /** CLI 可执行文件名 */
  binary: string

  /** 默认模型名（前端 placeholder 用） */
  defaultModel?: string

  /** 能力声明 */
  capabilities: ProviderCapabilities

  /** Provider 专属设置 schema */
  settings?: ProviderSetting[]

  /** 构建 CLI 启动参数 */
  buildArgs(ctx: SessionContext): string[]

  /** 构建额外环境变量（可选） */
  buildEnv?(ctx: SessionContext): Record<string, string>

  /** 解析 stdout 的一行输出 → 标准化事件 */
  parseLine(line: string): AgentEvent | null

  /** 判断进程退出码是否表示成功 */
  isSuccessExit(code: number): boolean

  /** 判断一行输出是否为噪音（应跳过） */
  isNoiseLine?(line: string): boolean
}
