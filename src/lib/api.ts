import type { Project, LogEntry, HelpRequest, CreateProjectRequest, ImportProjectRequest, ProviderInfo } from '@/types'

const BASE = '/api'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.message || 'Request failed')
  }
  return res.json()
}

// Project API
export const api = {
  // Get available AI Providers
  getProviders: () => request<ProviderInfo[]>('/providers'),

  // Check directory contents
  checkDir: (path: string) =>
    request<{ exists: boolean; hasContent: boolean; entries: string[] }>('/check-dir', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // Get project list
  getProjects: () => request<Project[]>('/projects'),

  // Get project details
  getProject: (id: string) => request<Project>(`/projects/${id}`),

  // Create project
  createProject: (data: CreateProjectRequest) =>
    request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Import existing project
  importProject: (data: ImportProjectRequest) =>
    request<Project>('/projects/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Delete project
  deleteProject: (id: string) =>
    request<{ message: string }>(`/projects/${id}`, { method: 'DELETE' }),

  // Start Agent
  startAgent: (id: string) =>
    request<{ message: string }>(`/projects/${id}/start`, { method: 'POST' }),

  // Stop Agent
  stopAgent: (id: string) =>
    request<{ message: string }>(`/projects/${id}/stop`, { method: 'POST' }),

  // Get feature list
  getFeatures: (id: string) => request<Project['features']>(`/projects/${id}/features`),

  // Get session history
  getSessions: (id: string) => request<Project['sessions']>(`/projects/${id}/sessions`),

  // Get historical logs
  getLogs: (id: string) => request<LogEntry[]>(`/projects/${id}/logs`),

  // Get pending human assistance requests
  getHelpRequests: (id: string) => request<HelpRequest[]>(`/projects/${id}/help-requests`),

  // Submit human assistance response
  submitHelpResponse: (id: string, requestId: string, response: string) =>
    request<HelpRequest>(`/projects/${id}/help-response`, {
      method: 'POST',
      body: JSON.stringify({ requestId, response }),
    }),

  // Append spec
  appendSpec: (id: string, spec: string) =>
    request<{ message: string }>(`/projects/${id}/append-spec`, {
      method: 'POST',
      body: JSON.stringify({ spec }),
    }),

  // Update system prompt
  updateSystemPrompt: (id: string, systemPrompt: string) =>
    request<Project>(`/projects/${id}/system-prompt`, {
      method: 'PUT',
      body: JSON.stringify({ systemPrompt }),
    }),

  // Review and modify features
  reviewFeatures: (id: string, featureIds: string[], instruction: string) =>
    request<{ message: string }>(`/projects/${id}/review-features`, {
      method: 'POST',
      body: JSON.stringify({ featureIds, instruction }),
    }),

  // Confirm review and start coding
  confirmReview: (id: string) =>
    request<{ message: string }>(`/projects/${id}/confirm-review`, {
      method: 'POST',
    }),

  // Patch project settings (model, wallTimeoutMin, etc.)
  patchProject: (id: string, patch: Record<string, unknown>) =>
    request<Project>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // Read file from project directory
  getProjectFile: (id: string, filePath: string) =>
    request<{ path: string; content: string }>(`/projects/${id}/file?path=${encodeURIComponent(filePath)}`),

  // Get session raw log
  getSessionRawLog: async (projectId: string, sessionId: string): Promise<string> => {
    const token = new URLSearchParams(window.location.search).get('token')
    const url = token
      ? `${BASE}/projects/${projectId}/sessions/${sessionId}/raw-log?token=${encodeURIComponent(token)}`
      : `${BASE}/projects/${projectId}/sessions/${sessionId}/raw-log`
    const res = await fetch(url)
    if (!res.ok) {
      if (res.status === 404) throw new Error('LOG_NOT_FOUND')
      throw new Error('Failed to fetch log')
    }
    return res.text()
  },
}
