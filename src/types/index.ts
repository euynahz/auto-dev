// ===== Project Types =====

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
  provider: string
  providerSettings?: Record<string, unknown>
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

// ===== Agent Log Types =====

export interface LogEntry {
  id: string
  sessionId: string
  timestamp: string
  type: 'assistant' | 'tool_use' | 'tool_result' | 'thinking' | 'system' | 'error'
  content: string
  toolName?: string
  toolInput?: string
  agentIndex?: number
  temporary?: boolean // Temporary log entry, frontend uses replacement strategy for display
}

// ===== Human Assistance Requests =====

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

// ===== WebSocket Message Types =====

export type WSMessage =
  | { type: 'log'; projectId: string; entry: LogEntry }
  | { type: 'status'; projectId: string; status: ProjectStatus }
  | { type: 'progress'; projectId: string; progress: Project['progress'] }
  | { type: 'feature_update'; projectId: string; featureId: string; passes: boolean }
  | { type: 'features_sync'; projectId: string; features: Feature[] }
  | { type: 'session_update'; projectId: string; session: Session }
  | { type: 'agent_count'; projectId: string; active: number; total: number }
  | { type: 'human_help'; projectId: string; request: HelpRequest }

// ===== API Request Types =====

export interface CreateProjectRequest {
  name: string
  spec: string
  path?: string
  forceClean?: boolean
  provider?: string
  providerSettings?: Record<string, unknown>
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
  provider?: string
  providerSettings?: Record<string, unknown>
  model?: string
  concurrency?: number
  useAgentTeams?: boolean
  systemPrompt?: string
  reviewBeforeCoding?: boolean
}

// ===== Provider Types =====

export interface ProviderCapabilities {
  streaming: boolean
  maxTurns: boolean
  systemPrompt: boolean
  agentTeams: boolean
  modelSelection: boolean
  dangerousMode: boolean
}

export interface ProviderSetting {
  key: string
  label: string
  description?: string
  type: 'boolean' | 'string' | 'select' | 'number'
  default: unknown
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
}

export interface ProviderInfo {
  name: string
  displayName: string
  defaultModel?: string
  capabilities: ProviderCapabilities
  settings?: ProviderSetting[]
}
