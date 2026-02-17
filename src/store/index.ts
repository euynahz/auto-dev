import { create } from 'zustand'
import type { Project, LogEntry, HelpRequest, WSMessage } from '@/types'

interface AgentCountInfo {
  active: number
  total: number
}

interface AppState {
  // Project list
  projects: Project[]
  setProjects: (projects: Project[]) => void
  updateProject: (id: string, updates: Partial<Project>) => void
  addProject: (project: Project) => void
  removeProject: (id: string) => void

  // Currently viewed project
  currentProject: Project | null
  setCurrentProject: (project: Project | null) => void

  // Real-time logs
  logs: Record<string, LogEntry[]>
  setLogs: (projectId: string, entries: LogEntry[]) => void
  addLog: (projectId: string, entry: LogEntry) => void
  clearLogs: (projectId: string) => void

  // Active agent count
  agentCounts: Record<string, AgentCountInfo>
  setAgentCount: (projectId: string, info: AgentCountInfo) => void

  // Human assistance requests
  helpRequests: Record<string, HelpRequest[]>
  setHelpRequests: (projectId: string, requests: HelpRequest[]) => void
  addHelpRequest: (projectId: string, request: HelpRequest) => void
  resolveHelpRequest: (projectId: string, requestId: string) => void

  // WebSocket connection state
  wsConnected: boolean
  setWsConnected: (connected: boolean) => void

  // Handle WebSocket messages
  handleWSMessage: (msg: WSMessage) => void
}

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  setProjects: (projects) => set({ projects }),
  updateProject: (id, updates) =>
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
      currentProject:
        state.currentProject?.id === id
          ? { ...state.currentProject, ...updates }
          : state.currentProject,
    })),
  addProject: (project) =>
    set((state) => ({ projects: [project, ...state.projects] })),
  removeProject: (id) =>
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id) })),

  currentProject: null,
  setCurrentProject: (project) => set({ currentProject: project }),

  logs: {},
  setLogs: (projectId, entries) =>
    set((state) => ({
      logs: { ...state.logs, [projectId]: entries },
    })),
  addLog: (projectId, entry) =>
    set((state) => {
      const existing = state.logs[projectId] || []

      // Temporary log (thinking): replace the previous temporary log from the same agent instead of appending
      if (entry.temporary) {
        const lastIdx = existing.length - 1
        const last = existing[lastIdx]
        if (last && last.temporary && last.agentIndex === entry.agentIndex) {
          const updated = [...existing]
          updated[lastIdx] = entry
          return { logs: { ...state.logs, [projectId]: updated } }
        }
      }

      // Cap at 3000 entries to prevent unbounded memory growth
      const MAX_LOGS = 3000
      const next = existing.length >= MAX_LOGS
        ? [...existing.slice(-(MAX_LOGS - 1)), entry]
        : [...existing, entry]

      return { logs: { ...state.logs, [projectId]: next } }
    }),
  clearLogs: (projectId) =>
    set((state) => ({
      logs: { ...state.logs, [projectId]: [] },
    })),

  agentCounts: {},
  setAgentCount: (projectId, info) =>
    set((state) => ({
      agentCounts: { ...state.agentCounts, [projectId]: info },
    })),

  helpRequests: {},
  setHelpRequests: (projectId, requests) =>
    set((state) => ({
      helpRequests: { ...state.helpRequests, [projectId]: requests },
    })),
  addHelpRequest: (projectId, request) =>
    set((state) => ({
      helpRequests: {
        ...state.helpRequests,
        [projectId]: [...(state.helpRequests[projectId] || []), request],
      },
    })),
  resolveHelpRequest: (projectId, requestId) =>
    set((state) => ({
      helpRequests: {
        ...state.helpRequests,
        [projectId]: (state.helpRequests[projectId] || []).filter((r) => r.id !== requestId),
      },
    })),

  wsConnected: false,
  setWsConnected: (connected) => set({ wsConnected: connected }),

  handleWSMessage: (msg) => {
    const { updateProject, addLog, setAgentCount, addHelpRequest } = get()
    switch (msg.type) {
      case 'log':
        addLog(msg.projectId, msg.entry)
        break
      case 'status':
        updateProject(msg.projectId, { status: msg.status })
        break
      case 'progress':
        updateProject(msg.projectId, { progress: msg.progress })
        break
      case 'agent_count':
        setAgentCount(msg.projectId, { active: msg.active, total: msg.total })
        break
      case 'human_help':
        addHelpRequest(msg.projectId, msg.request)
        break
      case 'feature_proposal':
        // Feature data is already synced via features_sync broadcast; log for visibility
        console.log(`[WS] Feature proposed by Agent ${msg.proposal.agentIndex}: ${msg.proposal.feature.description}`)
        break
      case 'features_sync':
        set((state) => {
          const features = msg.features
          const passed = features.filter((f) => f.passes).length
          const updates = {
            features,
            progress: { total: features.length, passed, percentage: features.length ? (passed / features.length) * 100 : 0 },
          }
          return {
            projects: state.projects.map((p) => (p.id === msg.projectId ? { ...p, ...updates } : p)),
            currentProject: state.currentProject?.id === msg.projectId ? { ...state.currentProject, ...updates } : state.currentProject,
          }
        })
        break
      case 'feature_update':
        set((state) => {
          // Prefer features from currentProject (more likely to be up-to-date than the projects array)
          const current = state.currentProject?.id === msg.projectId ? state.currentProject : null
          const project = current || state.projects.find((p) => p.id === msg.projectId)
          if (!project) return state
          const features = project.features.map((f) =>
            f.id === msg.featureId ? { ...f, passes: msg.passes } : f
          )
          const passed = features.filter((f) => f.passes).length
          const updates = {
            features,
            progress: { total: features.length, passed, percentage: features.length ? (passed / features.length) * 100 : 0 },
          }
          return {
            projects: state.projects.map((p) => (p.id === msg.projectId ? { ...p, ...updates } : p)),
            currentProject: state.currentProject?.id === msg.projectId ? { ...state.currentProject, ...updates } : state.currentProject,
          }
        })
        break
      case 'session_update': {
        // Ensure session has logs array (server SessionData omits it)
        const incomingSession = { logs: [] as LogEntry[], ...msg.session }
        set((state) => {
          // Update both projects array and currentProject
          const updateSessions = (sessions: Session[]) =>
            sessions.some((s) => s.id === incomingSession.id)
              ? sessions.map((s) => (s.id === incomingSession.id ? { ...s, ...incomingSession } : s))
              : [...sessions, incomingSession]

          const projects = state.projects.map((p) =>
            p.id === msg.projectId ? { ...p, sessions: updateSessions(p.sessions) } : p
          )
          const currentProject =
            state.currentProject?.id === msg.projectId
              ? { ...state.currentProject, sessions: updateSessions(state.currentProject.sessions) }
              : state.currentProject

          return { projects, currentProject }
        })
        break
      }
    }
  },
}))
