// ===== 服务端类型定义 =====

export interface ProjectData {
  id: string
  name: string
  spec: string
  status: 'idle' | 'initializing' | 'reviewing' | 'running' | 'paused' | 'completed' | 'error'
  model: string
  concurrency: number // 并发 Agent 数量，默认 1
  useAgentTeams: boolean // 使用 Agent Teams 模式（Claude 内部协调多 Agent）
  systemPrompt?: string // 项目级系统提示词，注入到所有 Agent 的 --system-prompt 参数
  reviewBeforeCoding?: boolean // 初始化后进入审查模式，不自动开始编码
  createdAt: string
  updatedAt: string
  projectDir: string // 项目在磁盘上的路径
}

export interface FeatureData {
  id: string
  category: string
  description: string
  steps: string[]
  passes: boolean
  inProgress?: boolean // Agent 正在处理中
}

export interface SessionData {
  id: string
  projectId: string
  type: 'initializer' | 'coding' | 'agent-teams'
  status: 'running' | 'completed' | 'failed' | 'stopped'
  featureId?: string
  agentIndex?: number  // Agent 编号（0-based）
  branch?: string      // 工作分支名
  pid?: number         // claude 进程 PID，用于重启后清理孤儿进程
  logFile?: string     // claude 原始输出日志文件路径
  startedAt: string
  endedAt?: string
}

export interface LogEntryData {
  id: string
  sessionId: string
  timestamp: string
  type: 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'system' | 'error'
  content: string
  toolName?: string
  toolInput?: string
  agentIndex?: number // Agent 编号，用于前端过滤
  temporary?: boolean // 临时日志，前端使用替换策略显示
}

export interface HelpRequestData {
  id: string
  projectId: string
  sessionId: string
  agentIndex: number
  message: string
  status: 'pending' | 'resolved'
  response?: string
  createdAt: string
  resolvedAt?: string
  // 上下文信息，帮助人工理解和 Agent 恢复
  featureId?: string
  featureDescription?: string
  recentLogs?: string[]
}

// WebSocket 广播消息
export type BroadcastMessage =
  | { type: 'log'; projectId: string; entry: LogEntryData }
  | { type: 'status'; projectId: string; status: ProjectData['status'] }
  | { type: 'progress'; projectId: string; progress: { total: number; passed: number; percentage: number } }
  | { type: 'feature_update'; projectId: string; featureId: string; passes: boolean }
  | { type: 'features_sync'; projectId: string; features: FeatureData[] }
  | { type: 'session_update'; projectId: string; session: SessionData }
  | { type: 'agent_count'; projectId: string; active: number; total: number }
  | { type: 'human_help'; projectId: string; request: HelpRequestData }
