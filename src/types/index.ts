// ===== 项目相关类型 =====

export interface Feature {
  id: string
  category: string
  description: string
  steps: string[]
  passes: boolean
  inProgress?: boolean
  failCount?: number
  lastAttemptAt?: string
}

export type ProjectStatus = 'idle' | 'initializing' | 'reviewing' | 'running' | 'paused' | 'completed' | 'error'

export interface Project {
  id: string
  name: string
  spec: string
  status: ProjectStatus
  model: string
  concurrency: number
  useAgentTeams: boolean
  systemPrompt?: string
  reviewBeforeCoding?: boolean
  createdAt: string
  updatedAt: string
  features: Feature[]
  sessions: Session[]
  progress: {
    total: number
    passed: number
    percentage: number
  }
}

export interface Session {
  id: string
  projectId: string
  type: 'initializer' | 'coding' | 'agent-teams'
  status: 'running' | 'completed' | 'failed' | 'stopped'
  featureId?: string
  agentIndex?: number
  branch?: string
  pid?: number
  logFile?: string
  startedAt: string
  endedAt?: string
  logs: LogEntry[]
}

// ===== Agent 日志类型 =====

export interface LogEntry {
  id: string
  sessionId: string
  timestamp: string
  type: 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'system' | 'error'
  content: string
  toolName?: string
  toolInput?: string
  agentIndex?: number
  temporary?: boolean // 临时日志，前端使用替换策略显示
}

// ===== 人工协助请求 =====

export interface HelpRequest {
  id: string
  projectId: string
  sessionId: string
  agentIndex: number
  message: string
  status: 'pending' | 'resolved'
  response?: string
  createdAt: string
  resolvedAt?: string
}

// ===== WebSocket 消息类型 =====

export type WSMessage =
  | { type: 'log'; projectId: string; entry: LogEntry }
  | { type: 'status'; projectId: string; status: ProjectStatus }
  | { type: 'progress'; projectId: string; progress: Project['progress'] }
  | { type: 'feature_update'; projectId: string; featureId: string; passes: boolean }
  | { type: 'features_sync'; projectId: string; features: Feature[] }
  | { type: 'session_update'; projectId: string; session: Session }
  | { type: 'agent_count'; projectId: string; active: number; total: number }
  | { type: 'human_help'; projectId: string; request: HelpRequest }

// ===== API 请求类型 =====

export interface CreateProjectRequest {
  name: string
  spec: string
  path?: string
  forceClean?: boolean
  model?: string
  concurrency?: number
  useAgentTeams?: boolean
  systemPrompt?: string
  reviewBeforeCoding?: boolean
}

export interface ImportProjectRequest {
  name: string
  path: string
  taskPrompt?: string
  model?: string
  concurrency?: number
  useAgentTeams?: boolean
  systemPrompt?: string
  reviewBeforeCoding?: boolean
}
