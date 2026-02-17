// ===== Server type definitions =====

export interface ProjectData {
  id: string
  name: string
  spec: string
  status: 'idle' | 'initializing' | 'reviewing' | 'running' | 'paused' | 'completed' | 'error'
  provider: string    // AI provider: 'claude' | 'codex' | 'gemini' | ...
  providerSettings?: Record<string, unknown>  // Provider-specific settings
  model: string
  concurrency: number // Concurrent agent count, default 1
  useAgentTeams: boolean // Use Agent Teams mode (internal multi-agent coordination when provider supports it)
  systemPrompt?: string // Project-level system prompt, injected into all agents via --system-prompt
  reviewArchitecture?: boolean // Pause after architecture analysis for human review before task decomposition
  reviewBeforeCoding?: boolean // Enter review mode after initialization, do not auto-start coding
  reviewPhase?: 'architecture' | 'features' // Tracks which phase is currently under review
  verifyCommand?: string // Quality gate command (e.g. "npm test && npm run lint") run before marking feature as passed
  wallTimeoutMin?: number // Wall clock timeout per session in minutes (default 30)
  createdAt: string
  updatedAt: string
  projectDir: string // Project path on disk
}

export interface FeatureData {
  id: string
  category: string
  description: string
  steps: string[]
  passes: boolean
  inProgress?: boolean // Agent is currently processing
  failCount?: number      // Attempt failure count
  lastAttemptAt?: string  // Last attempt time
}

export interface SessionData {
  id: string
  projectId: string
  type: 'architecture' | 'initializer' | 'coding' | 'agent-teams'
  status: 'running' | 'completed' | 'failed' | 'stopped'
  featureId?: string
  agentIndex?: number  // Agent index (0-based)
  branch?: string      // Work branch name
  pid?: number         // Claude process PID, for cleaning up orphans after restart
  logFile?: string     // Claude raw output log file path
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
  agentIndex?: number // Agent index, for frontend filtering
  temporary?: boolean // Temporary log, frontend uses replacement display strategy
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
  // Context info to help humans understand and agents recover
  featureId?: string
  featureDescription?: string
  recentLogs?: string[]
}

export interface FeatureProposalData {
  id: string
  projectId: string
  sessionId: string
  agentIndex: number
  feature: {
    description: string
    reason: string
    steps: string[]
  }
  status: 'accepted' | 'pending'  // accepted = auto-added; pending = awaiting review
  createdAt: string
  sourceFeatureId?: string  // Which feature triggered this proposal
}

// WebSocket broadcast messages
export type BroadcastMessage =
  | { type: 'log'; projectId: string; entry: LogEntryData }
  | { type: 'status'; projectId: string; status: ProjectData['status'] }
  | { type: 'progress'; projectId: string; progress: { total: number; passed: number; percentage: number } }
  | { type: 'feature_update'; projectId: string; featureId: string; passes: boolean }
  | { type: 'features_sync'; projectId: string; features: FeatureData[] }
  | { type: 'session_update'; projectId: string; session: SessionData }
  | { type: 'agent_count'; projectId: string; active: number; total: number }
  | { type: 'human_help'; projectId: string; request: HelpRequestData }
  | { type: 'feature_proposal'; projectId: string; proposal: FeatureProposalData }
