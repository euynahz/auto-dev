import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { log } from '../lib/logger.js'
import type { ProjectData, FeatureData, SessionData, LogEntryData, HelpRequestData } from '../types.js'

// 数据存储目录
const DATA_DIR = path.join(process.cwd(), '.autodev-data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')

// 确保目录存在
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

ensureDir(DATA_DIR)
ensureDir(PROJECTS_DIR)

// ===== 项目管理 =====

function getProjectDir(id: string) {
  return path.join(PROJECTS_DIR, id)
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

// 检查目录是否存在且有内容
export function checkDir(dirPath: string): { exists: boolean; hasContent: boolean; entries: string[] } {
  if (!fs.existsSync(dirPath)) return { exists: false, hasContent: false, entries: [] }
  const stat = fs.statSync(dirPath)
  if (!stat.isDirectory()) return { exists: false, hasContent: false, entries: [] }
  const entries = fs.readdirSync(dirPath).filter((e) => !e.startsWith('.'))
  return { exists: true, hasContent: entries.length > 0, entries: entries.slice(0, 20) }
}

// 创建项目
export function createProject(name: string, spec: string, model = 'claude-opus-4-6', concurrency = 1, useAgentTeams = false, systemPrompt?: string, reviewBeforeCoding?: boolean, projectDir?: string, forceClean?: boolean): ProjectData {
  const id = uuidv4()
  const now = new Date().toISOString()

  // 使用用户指定的目录，或自动生成
  const projectWorkDir = projectDir || path.join(process.cwd(), 'workspace', name.replace(/[^a-zA-Z0-9_-]/g, '_'))

  // 如果目录已有内容且用户选择清理
  if (forceClean && fs.existsSync(projectWorkDir)) {
    const entries = fs.readdirSync(projectWorkDir).filter((e) => !e.startsWith('.'))
    for (const entry of entries) {
      fs.rmSync(path.join(projectWorkDir, entry), { recursive: true, force: true })
    }
    log.project(`已清理目录: ${projectWorkDir}`)
  }

  ensureDir(projectWorkDir)

  // 写入 app_spec.txt
  fs.writeFileSync(path.join(projectWorkDir, 'app_spec.txt'), spec)

  const project: ProjectData = {
    id,
    name,
    spec,
    status: 'idle',
    model,
    concurrency: Math.max(1, Math.min(8, concurrency)),
    useAgentTeams,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(reviewBeforeCoding ? { reviewBeforeCoding } : {}),
    createdAt: now,
    updatedAt: now,
    projectDir: projectWorkDir,
  }

  // 保存项目元数据
  const projDataDir = getProjectDir(id)
  ensureDir(projDataDir)
  writeJson(path.join(projDataDir, 'project.json'), project)
  writeJson(path.join(projDataDir, 'features.json'), [])
  writeJson(path.join(projDataDir, 'sessions.json'), [])
  writeJson(path.join(projDataDir, 'logs.json'), [])

  log.project(`创建项目: ${name} (id=${id}, dir=${projectWorkDir}, agentTeams=${useAgentTeams})`)
  return project
}

// 导入已有项目
export function importProject(name: string, dirPath: string, model = 'claude-opus-4-6', concurrency = 1, useAgentTeams = false, systemPrompt?: string, reviewBeforeCoding?: boolean, taskPrompt?: string): ProjectData {
  // 验证目录存在
  if (!fs.existsSync(dirPath)) {
    throw new Error(`目录不存在: ${dirPath}`)
  }
  const stat = fs.statSync(dirPath)
  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录: ${dirPath}`)
  }

  // 扫描目录结构，拼接 spec
  const specParts: string[] = []
  specParts.push(`# 项目: ${name}`)
  specParts.push(`\n目录: ${dirPath}\n`)

  // 读取 README.md
  const readmePath = path.join(dirPath, 'README.md')
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf-8').slice(0, 5000)
    specParts.push(`## README.md\n\n${content}\n`)
  }

  // 读取 CLAUDE.md
  const claudePath = path.join(dirPath, 'CLAUDE.md')
  if (fs.existsSync(claudePath)) {
    const content = fs.readFileSync(claudePath, 'utf-8').slice(0, 3000)
    specParts.push(`## CLAUDE.md\n\n${content}\n`)
  }

  // 读取 package.json
  const pkgPath = path.join(dirPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const content = fs.readFileSync(pkgPath, 'utf-8').slice(0, 3000)
    specParts.push(`## package.json\n\n\`\`\`json\n${content}\n\`\`\`\n`)
  }

  // 读取 docs/*.md
  const docsDir = path.join(dirPath, 'docs')
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).slice(0, 10)
    for (const docFile of docFiles) {
      const content = fs.readFileSync(path.join(docsDir, docFile), 'utf-8').slice(0, 3000)
      specParts.push(`## docs/${docFile}\n\n${content}\n`)
    }
  }

  // 扫描目录结构（排除 node_modules 等）
  const tree = scanDirTree(dirPath, 3)
  specParts.push(`## 目录结构\n\n\`\`\`\n${tree}\n\`\`\`\n`)

  // 如果用户提供了任务提示词，放在最前面让 AI 了解目标
  const autoSpec = specParts.join('\n')
  const spec = taskPrompt?.trim()
    ? `# 任务目标\n\n${taskPrompt.trim()}\n\n---\n\n${autoSpec}`
    : autoSpec

  const id = uuidv4()
  const now = new Date().toISOString()

  const project: ProjectData = {
    id,
    name,
    spec,
    status: 'idle',
    model,
    concurrency: Math.max(1, Math.min(8, concurrency)),
    useAgentTeams,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(reviewBeforeCoding ? { reviewBeforeCoding } : {}),
    createdAt: now,
    updatedAt: now,
    projectDir: dirPath, // 直接指向用户提供的路径
  }

  // 保存项目元数据
  const projDataDir = getProjectDir(id)
  ensureDir(projDataDir)
  writeJson(path.join(projDataDir, 'project.json'), project)
  writeJson(path.join(projDataDir, 'features.json'), [])
  writeJson(path.join(projDataDir, 'sessions.json'), [])
  writeJson(path.join(projDataDir, 'logs.json'), [])

  // 自动生成 app_spec.txt（导入的项目通常没有这个文件，initializer 需要它）
  const specPath = path.join(dirPath, 'app_spec.txt')
  if (!fs.existsSync(specPath)) {
    fs.writeFileSync(specPath, spec)
    log.project(`自动生成 app_spec.txt: ${specPath}`)
  }

  log.project(`导入项目: ${name} (id=${id}, dir=${dirPath})`)
  return project
}

// 扫描目录树（简化版）
function scanDirTree(dirPath: string, maxDepth: number, prefix = '', depth = 0): string {
  if (depth >= maxDepth) return ''
  const ignoreList = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.autodev-data'])
  const lines: string[] = []

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => !ignoreList.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })
      .slice(0, 30) // 限制每层最多 30 个条目

    for (const entry of entries) {
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        const sub = scanDirTree(path.join(dirPath, entry.name), maxDepth, prefix + '  ', depth + 1)
        if (sub) lines.push(sub)
      } else {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  } catch {
    // 权限问题等，忽略
  }

  return lines.join('\n')
}

// 获取所有项目
export function getAllProjects(): ProjectData[] {
  ensureDir(PROJECTS_DIR)
  const dirs = fs.readdirSync(PROJECTS_DIR)
  return dirs
    .map((dir) => readJson<ProjectData | null>(path.join(PROJECTS_DIR, dir, 'project.json'), null))
    .filter((p): p is ProjectData => p !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

// 获取单个项目
export function getProject(id: string): ProjectData | null {
  return readJson<ProjectData | null>(path.join(getProjectDir(id), 'project.json'), null)
}

// 更新项目
export function updateProject(id: string, updates: Partial<ProjectData>): ProjectData | null {
  const project = getProject(id)
  if (!project) return null
  const updated = { ...project, ...updates, updatedAt: new Date().toISOString() }
  writeJson(path.join(getProjectDir(id), 'project.json'), updated)
  return updated
}

// 删除项目
export function deleteProject(id: string): boolean {
  const projDataDir = getProjectDir(id)
  if (!fs.existsSync(projDataDir)) return false
  fs.rmSync(projDataDir, { recursive: true, force: true })
  log.project(`删除项目: ${id}`)
  return true
}

// ===== Feature 管理 =====

export function getFeatures(projectId: string): FeatureData[] {
  return readJson<FeatureData[]>(path.join(getProjectDir(projectId), 'features.json'), [])
}

export function setFeatures(projectId: string, features: FeatureData[]) {
  writeJson(path.join(getProjectDir(projectId), 'features.json'), features)
}

export function updateFeature(projectId: string, featureId: string, passes: boolean): FeatureData | null {
  const features = getFeatures(projectId)
  const feature = features.find((f) => f.id === featureId)
  if (!feature) return null
  feature.passes = passes
  setFeatures(projectId, features)
  return feature
}

// 从项目工作目录同步 feature_list.json
export function syncFeaturesFromDisk(projectId: string): FeatureData[] {
  const project = getProject(projectId)
  if (!project) return []

  const featureListPath = path.join(project.projectDir, 'feature_list.json')
  if (!fs.existsSync(featureListPath)) return getFeatures(projectId)

  try {
    const raw = JSON.parse(fs.readFileSync(featureListPath, 'utf-8'))
    // feature_list.json 可能是数组或 { features: [...] }
    const list: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).features as Array<Record<string, unknown>> || []
    const features: FeatureData[] = list.map((f, i) => ({
      id: (f.id as string) || `feature-${i}`,
      category: (f.category as string) || 'Uncategorized',
      description: (f.description as string) || '',
      steps: (f.steps as string[]) || [],
      passes: (f.passes as boolean) || false,
      inProgress: (f.inProgress as boolean) || false,
    }))
    const passed = features.filter((f) => f.passes).length
    log.project(`同步 features (${projectId}): ${features.length} 个, ${passed} 通过`)
    setFeatures(projectId, features)
    return features
  } catch {
    log.warn(`同步 features 失败 (${projectId}): 解析 feature_list.json 出错`)
    return getFeatures(projectId)
  }
}

// ===== Session 管理 =====

export function getSessions(projectId: string): SessionData[] {
  return readJson<SessionData[]>(path.join(getProjectDir(projectId), 'sessions.json'), [])
}

export function addSession(projectId: string, session: SessionData) {
  const sessions = getSessions(projectId)
  sessions.push(session)
  writeJson(path.join(getProjectDir(projectId), 'sessions.json'), sessions)
}

export function updateSession(projectId: string, sessionId: string, updates: Partial<SessionData>) {
  const sessions = getSessions(projectId)
  const idx = sessions.findIndex((s) => s.id === sessionId)
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...updates }
    writeJson(path.join(getProjectDir(projectId), 'sessions.json'), sessions)
  }
}

// ===== 日志管理 =====

export function getLogs(projectId: string): LogEntryData[] {
  return readJson<LogEntryData[]>(path.join(getProjectDir(projectId), 'logs.json'), [])
}

export function addLog(projectId: string, entry: LogEntryData) {
  const logs = getLogs(projectId)
  logs.push(entry)
  // 只保留最近 5000 条日志
  if (logs.length > 5000) {
    logs.splice(0, logs.length - 5000)
  }
  writeJson(path.join(getProjectDir(projectId), 'logs.json'), logs)
}

// 计算进度
export function getProgress(projectId: string) {
  const features = getFeatures(projectId)
  const total = features.length
  const passed = features.filter((f) => f.passes).length
  return {
    total,
    passed,
    percentage: total > 0 ? (passed / total) * 100 : 0,
  }
}

// ===== 人工协助请求 =====

export function getHelpRequests(projectId: string): HelpRequestData[] {
  return readJson<HelpRequestData[]>(path.join(getProjectDir(projectId), 'help-requests.json'), [])
}

export function addHelpRequest(projectId: string, request: HelpRequestData) {
  const requests = getHelpRequests(projectId)
  requests.push(request)
  writeJson(path.join(getProjectDir(projectId), 'help-requests.json'), requests)
}

export function resolveHelpRequest(projectId: string, requestId: string, response: string): HelpRequestData | null {
  const requests = getHelpRequests(projectId)
  const req = requests.find((r) => r.id === requestId)
  if (!req) return null
  req.status = 'resolved'
  req.response = response
  req.resolvedAt = new Date().toISOString()
  writeJson(path.join(getProjectDir(projectId), 'help-requests.json'), requests)

  // 将回复写入项目目录，供 Agent 读取
  const project = getProject(projectId)
  if (project) {
    const responsePath = path.join(project.projectDir, '.human-response.md')
    const lines: string[] = [
      `# Human Response`,
      '',
    ]

    // 上下文：正在做什么
    if (req.featureId || req.featureDescription) {
      lines.push(`## 当前任务`)
      if (req.featureId) lines.push(`- Feature ID: ${req.featureId}`)
      if (req.featureDescription) lines.push(`- 描述: ${req.featureDescription}`)
      lines.push('')
    }

    // 遇到的问题
    lines.push(`## 遇到的问题`)
    lines.push('')
    lines.push(req.message)
    lines.push('')

    // 最近的操作记录
    if (req.recentLogs && req.recentLogs.length > 0) {
      lines.push(`## 最近操作记录`)
      lines.push('')
      for (const logLine of req.recentLogs) {
        lines.push(`- ${logLine}`)
      }
      lines.push('')
    }

    // 人工回复
    lines.push(`## 人工指导`)
    lines.push('')
    lines.push(response)
    lines.push('')

    fs.writeFileSync(responsePath, lines.join('\n'))
    log.project(`人工回复已写入: ${responsePath}`)
  }

  return req
}
