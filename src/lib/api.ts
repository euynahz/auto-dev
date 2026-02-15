import type { Project, LogEntry, HelpRequest, CreateProjectRequest, ImportProjectRequest, ProviderInfo } from '@/types'

const BASE = '/api'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(err.message || '请求失败')
  }
  return res.json()
}

// 项目 API
export const api = {
  // 获取可用 AI Providers
  getProviders: () => request<ProviderInfo[]>('/providers'),

  // 检查目录内容
  checkDir: (path: string) =>
    request<{ exists: boolean; hasContent: boolean; entries: string[] }>('/check-dir', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // 获取项目列表
  getProjects: () => request<Project[]>('/projects'),

  // 获取项目详情
  getProject: (id: string) => request<Project>(`/projects/${id}`),

  // 创建项目
  createProject: (data: CreateProjectRequest) =>
    request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 导入已有项目
  importProject: (data: ImportProjectRequest) =>
    request<Project>('/projects/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 删除项目
  deleteProject: (id: string) =>
    request<{ message: string }>(`/projects/${id}`, { method: 'DELETE' }),

  // 启动 Agent
  startAgent: (id: string) =>
    request<{ message: string }>(`/projects/${id}/start`, { method: 'POST' }),

  // 停止 Agent
  stopAgent: (id: string) =>
    request<{ message: string }>(`/projects/${id}/stop`, { method: 'POST' }),

  // 获取 feature list
  getFeatures: (id: string) => request<Project['features']>(`/projects/${id}/features`),

  // 获取 session 历史
  getSessions: (id: string) => request<Project['sessions']>(`/projects/${id}/sessions`),

  // 获取历史日志
  getLogs: (id: string) => request<LogEntry[]>(`/projects/${id}/logs`),

  // 获取待处理的人工协助请求
  getHelpRequests: (id: string) => request<HelpRequest[]>(`/projects/${id}/help-requests`),

  // 提交人工协助回复
  submitHelpResponse: (id: string, requestId: string, response: string) =>
    request<HelpRequest>(`/projects/${id}/help-response`, {
      method: 'POST',
      body: JSON.stringify({ requestId, response }),
    }),

  // 追加需求
  appendSpec: (id: string, spec: string) =>
    request<{ message: string }>(`/projects/${id}/append-spec`, {
      method: 'POST',
      body: JSON.stringify({ spec }),
    }),

  // 更新系统提示词
  updateSystemPrompt: (id: string, systemPrompt: string) =>
    request<Project>(`/projects/${id}/system-prompt`, {
      method: 'PUT',
      body: JSON.stringify({ systemPrompt }),
    }),

  // 审查修改 Feature
  reviewFeatures: (id: string, featureIds: string[], instruction: string) =>
    request<{ message: string }>(`/projects/${id}/review-features`, {
      method: 'POST',
      body: JSON.stringify({ featureIds, instruction }),
    }),

  // 确认审查并开始编码
  confirmReview: (id: string) =>
    request<{ message: string }>(`/projects/${id}/confirm-review`, {
      method: 'POST',
    }),

  // 获取 session 原始日志
  getSessionRawLog: async (projectId: string, sessionId: string): Promise<string> => {
    const res = await fetch(`${BASE}/projects/${projectId}/sessions/${sessionId}/raw-log`)
    if (!res.ok) {
      if (res.status === 404) throw new Error('LOG_NOT_FOUND')
      throw new Error('获取日志失败')
    }
    return res.text()
  },
}
