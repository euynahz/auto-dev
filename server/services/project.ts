import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { log } from '../lib/logger.js'
import type { ProjectData, FeatureData, SessionData, LogEntryData, HelpRequestData } from '../types.js'

// Data storage directory
const DATA_DIR = path.join(process.cwd(), '.autodev-data')
const PROJECTS_DIR = path.join(DATA_DIR, 'projects')

// Ensure directory exists
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

ensureDir(DATA_DIR)
ensureDir(PROJECTS_DIR)

// ===== Path sandbox =====

export function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath)
  const homeDir = os.homedir()
  const cwd = process.cwd()
  return resolved.startsWith(homeDir + path.sep) || resolved === homeDir
    || resolved.startsWith('/tmp' + path.sep) || resolved === '/tmp'
    || resolved.startsWith(cwd + path.sep) || resolved === cwd
}

// ===== Project management =====

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

// Check if directory exists and has content
export function checkDir(dirPath: string): { exists: boolean; hasContent: boolean; entries: string[] } {
  if (!isPathSafe(dirPath)) throw new Error('Path is not within allowed range')
  if (!fs.existsSync(dirPath)) return { exists: false, hasContent: false, entries: [] }
  const stat = fs.statSync(dirPath)
  if (!stat.isDirectory()) return { exists: false, hasContent: false, entries: [] }
  const entries = fs.readdirSync(dirPath).filter((e) => !e.startsWith('.'))
  return { exists: true, hasContent: entries.length > 0, entries: entries.slice(0, 20) }
}

// Create project
// ===== Project creation/import options =====
export interface CreateProjectOptions {
  name: string
  spec: string
  model?: string
  concurrency?: number
  useAgentTeams?: boolean
  systemPrompt?: string
  reviewArchitecture?: boolean
  reviewBeforeCoding?: boolean
  verifyCommand?: string
  projectDir?: string
  forceClean?: boolean
  provider?: string
  providerSettings?: Record<string, unknown>
}

export interface ImportProjectOptions {
  name: string
  dirPath: string
  model?: string
  concurrency?: number
  useAgentTeams?: boolean
  systemPrompt?: string
  reviewArchitecture?: boolean
  reviewBeforeCoding?: boolean
  verifyCommand?: string
  taskPrompt?: string
  provider?: string
  providerSettings?: Record<string, unknown>
}

export function createProject(opts: CreateProjectOptions): ProjectData {
  const {
    name, spec, model = 'claude-opus-4-6', concurrency = 1,
    useAgentTeams = false, systemPrompt, reviewArchitecture, reviewBeforeCoding, verifyCommand,
    projectDir, forceClean, provider = 'claude', providerSettings,
  } = opts
  const id = uuidv4()
  const now = new Date().toISOString()

  // Use user-specified directory, or auto-generate
  const projectWorkDir = projectDir || path.join(process.cwd(), 'workspace', name.replace(/[^a-zA-Z0-9_-]/g, '_'))

  // If directory has content and user chose to clean
  if (forceClean && fs.existsSync(projectWorkDir)) {
    const entries = fs.readdirSync(projectWorkDir).filter((e) => !e.startsWith('.'))
    for (const entry of entries) {
      fs.rmSync(path.join(projectWorkDir, entry), { recursive: true, force: true })
    }
    log.project(`Cleaned directory: ${projectWorkDir}`)
  }

  ensureDir(projectWorkDir)

  // Write app_spec.txt
  fs.writeFileSync(path.join(projectWorkDir, 'app_spec.txt'), spec)

  const project: ProjectData = {
    id,
    name,
    spec,
    status: 'idle',
    provider,
    ...(providerSettings && Object.keys(providerSettings).length ? { providerSettings } : {}),
    model,
    concurrency: Math.max(1, Math.min(8, concurrency)),
    useAgentTeams,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(reviewArchitecture ? { reviewArchitecture } : {}),
    ...(reviewBeforeCoding ? { reviewBeforeCoding } : {}),
    ...(verifyCommand ? { verifyCommand } : {}),
    createdAt: now,
    updatedAt: now,
    projectDir: projectWorkDir,
  }

  // Save project metadata
  const projDataDir = getProjectDir(id)
  ensureDir(projDataDir)
  writeJson(path.join(projDataDir, 'project.json'), project)
  writeJson(path.join(projDataDir, 'features.json'), [])
  writeJson(path.join(projDataDir, 'sessions.json'), [])
  // logs.jsonl created on demand by addLog (append-only)

  log.project(`Created project: ${name} (id=${id}, dir=${projectWorkDir}, agentTeams=${useAgentTeams})`)
  return project
}

// Import existing project
export function importProject(opts: ImportProjectOptions): ProjectData {
  const {
    name, dirPath, model = 'claude-opus-4-6', concurrency = 1,
    useAgentTeams = false, systemPrompt, reviewArchitecture, reviewBeforeCoding, verifyCommand,
    taskPrompt, provider = 'claude', providerSettings,
  } = opts
  if (!isPathSafe(dirPath)) throw new Error('Path is not within allowed range')
  // Verify directory exists
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`)
  }
  const stat = fs.statSync(dirPath)
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dirPath}`)
  }

  // Scan directory structure, build spec
  const specParts: string[] = []
  specParts.push(`# Project: ${name}`)
  specParts.push(`\nDirectory: ${dirPath}\n`)

  // Read README.md
  const readmePath = path.join(dirPath, 'README.md')
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf-8').slice(0, 5000)
    specParts.push(`## README.md\n\n${content}\n`)
  }

  // Read CLAUDE.md
  const claudePath = path.join(dirPath, 'CLAUDE.md')
  if (fs.existsSync(claudePath)) {
    const content = fs.readFileSync(claudePath, 'utf-8').slice(0, 3000)
    specParts.push(`## CLAUDE.md\n\n${content}\n`)
  }

  // Read package.json
  const pkgPath = path.join(dirPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const content = fs.readFileSync(pkgPath, 'utf-8').slice(0, 3000)
    specParts.push(`## package.json\n\n\`\`\`json\n${content}\n\`\`\`\n`)
  }

  // Read docs/*.md
  const docsDir = path.join(dirPath, 'docs')
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).slice(0, 10)
    for (const docFile of docFiles) {
      const content = fs.readFileSync(path.join(docsDir, docFile), 'utf-8').slice(0, 3000)
      specParts.push(`## docs/${docFile}\n\n${content}\n`)
    }
  }

  // Scan directory structure (excluding node_modules etc.)
  const tree = scanDirTree(dirPath, 3)
  specParts.push(`## Directory Structure\n\n\`\`\`\n${tree}\n\`\`\`\n`)

  // If user provided task prompt, put it first so AI understands the goal
  const autoSpec = specParts.join('\n')
  const spec = taskPrompt?.trim()
    ? `# Task Objective\n\n${taskPrompt.trim()}\n\n---\n\n${autoSpec}`
    : autoSpec

  const id = uuidv4()
  const now = new Date().toISOString()

  const project: ProjectData = {
    id,
    name,
    spec,
    status: 'idle',
    provider,
    ...(providerSettings && Object.keys(providerSettings).length ? { providerSettings } : {}),
    model,
    concurrency: Math.max(1, Math.min(8, concurrency)),
    useAgentTeams,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(reviewArchitecture ? { reviewArchitecture } : {}),
    ...(reviewBeforeCoding ? { reviewBeforeCoding } : {}),
    ...(verifyCommand ? { verifyCommand } : {}),
    createdAt: now,
    updatedAt: now,
    projectDir: dirPath, // Point directly to user-provided path
  }

  // Save project metadata
  const projDataDir = getProjectDir(id)
  ensureDir(projDataDir)
  writeJson(path.join(projDataDir, 'project.json'), project)
  writeJson(path.join(projDataDir, 'features.json'), [])
  writeJson(path.join(projDataDir, 'sessions.json'), [])
  // logs.jsonl created on demand by addLog (append-only)

  // Auto-generate app_spec.txt (imported projects usually don't have this, initializer needs it)
  const specPath = path.join(dirPath, 'app_spec.txt')
  if (!fs.existsSync(specPath)) {
    fs.writeFileSync(specPath, spec)
    log.project(`Auto-generated app_spec.txt: ${specPath}`)
  }

  log.project(`Imported project: ${name} (id=${id}, dir=${dirPath})`)
  return project
}

// Scan directory tree (simplified)
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
      .slice(0, 30) // Limit to 30 entries per level

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
    // Ignore permission issues etc.
  }

  return lines.join('\n')
}

// Get all projects
export function getAllProjects(): ProjectData[] {
  ensureDir(PROJECTS_DIR)
  const dirs = fs.readdirSync(PROJECTS_DIR)
  return dirs
    .map((dir) => readJson<ProjectData | null>(path.join(PROJECTS_DIR, dir, 'project.json'), null))
    .filter((p): p is ProjectData => p !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

// Get single project
export function getProject(id: string): ProjectData | null {
  return readJson<ProjectData | null>(path.join(getProjectDir(id), 'project.json'), null)
}

// Update project
export function updateProject(id: string, updates: Partial<ProjectData>): ProjectData | null {
  const project = getProject(id)
  if (!project) return null
  const updated = { ...project, ...updates, updatedAt: new Date().toISOString() }
  writeJson(path.join(getProjectDir(id), 'project.json'), updated)
  return updated
}

// Delete project
export function deleteProject(id: string): boolean {
  const projDataDir = getProjectDir(id)
  if (!fs.existsSync(projDataDir)) return false
  fs.rmSync(projDataDir, { recursive: true, force: true })
  log.project(`Deleted project: ${id}`)
  return true
}

// ===== Feature management =====

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

// Mark feature attempt as failed
export function markFeatureAttempt(projectId: string, featureId: string): void {
  const project = getProject(projectId)
  if (!project) return

  const featureListPath = path.join(project.projectDir, 'feature_list.json')
  if (!fs.existsSync(featureListPath)) return

  try {
    const raw = JSON.parse(fs.readFileSync(featureListPath, 'utf-8'))
    const list: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).features as Array<Record<string, unknown>> || []
    const feature = list.find((f) => f.id === featureId)
    if (feature) {
      feature.failCount = ((feature.failCount as number) || 0) + 1
      feature.lastAttemptAt = new Date().toISOString()
      if (Array.isArray(raw)) {
        fs.writeFileSync(featureListPath, JSON.stringify(raw, null, 2))
      } else {
        (raw as Record<string, unknown>).features = list
        fs.writeFileSync(featureListPath, JSON.stringify(raw, null, 2))
      }
    }
  } catch {
    log.warn(`markFeatureAttempt failed (${projectId}, ${featureId})`)
  }

  // Sync to internal features.json
  const features = getFeatures(projectId)
  const f = features.find((feat) => feat.id === featureId)
  if (f) {
    f.failCount = (f.failCount || 0) + 1
    f.lastAttemptAt = new Date().toISOString()
    setFeatures(projectId, features)
  }
}

// Set feature inProgress status at system level
export function setFeatureInProgress(projectId: string, featureId: string, inProgress: boolean): void {
  const project = getProject(projectId)
  if (!project) return

  const featureListPath = path.join(project.projectDir, 'feature_list.json')
  if (!fs.existsSync(featureListPath)) return

  try {
    const raw = JSON.parse(fs.readFileSync(featureListPath, 'utf-8'))
    const list: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).features as Array<Record<string, unknown>> || []
    const feature = list.find((f) => f.id === featureId)
    if (feature) {
      feature.inProgress = inProgress
      if (Array.isArray(raw)) {
        fs.writeFileSync(featureListPath, JSON.stringify(raw, null, 2))
      } else {
        (raw as Record<string, unknown>).features = list
        fs.writeFileSync(featureListPath, JSON.stringify(raw, null, 2))
      }
    }
  } catch {
    log.warn(`setFeatureInProgress failed (${projectId}, ${featureId})`)
  }

  // Sync to internal features.json
  const features = getFeatures(projectId)
  const f = features.find((feat) => feat.id === featureId)
  if (f) {
    f.inProgress = inProgress
    setFeatures(projectId, features)
  }
}

// claimedFeatures persistence
export function getClaimedFeaturesData(projectId: string): Record<string, number> {
  const filePath = path.join(getProjectDir(projectId), 'claimed.json')
  return readJson<Record<string, number>>(filePath, {})
}

export function saveClaimedFeaturesData(projectId: string, data: Record<string, number>): void {
  const filePath = path.join(getProjectDir(projectId), 'claimed.json')
  writeJson(filePath, data)
}

// Sync feature_list.json from project working directory
export function syncFeaturesFromDisk(projectId: string): FeatureData[] {
  const project = getProject(projectId)
  if (!project) return []

  const featureListPath = path.join(project.projectDir, 'feature_list.json')
  if (!fs.existsSync(featureListPath)) return getFeatures(projectId)

  try {
    const raw = JSON.parse(fs.readFileSync(featureListPath, 'utf-8'))
    // feature_list.json may be an array or { features: [...] }
    const list: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).features as Array<Record<string, unknown>> || []
    const features: FeatureData[] = list.map((f, i) => ({
      id: (f.id as string) || `feature-${i}`,
      category: (f.category as string) || 'Uncategorized',
      description: (f.description as string) || '',
      steps: (f.steps as string[]) || [],
      passes: (f.passes as boolean) || false,
      inProgress: (f.inProgress as boolean) || false,
      ...((f.failCount as number) ? { failCount: f.failCount as number } : {}),
      ...((f.lastAttemptAt as string) ? { lastAttemptAt: f.lastAttemptAt as string } : {}),
    }))
    const passed = features.filter((f) => f.passes).length
    log.project(`Synced features (${projectId}): ${features.length} total, ${passed} passed`)
    setFeatures(projectId, features)
    return features
  } catch {
    log.warn(`Failed to sync features (${projectId}): error parsing feature_list.json`)
    return getFeatures(projectId)
  }
}

// ===== Session management =====

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

// ===== Log management (JSONL append-only) =====

const LOG_MAX_ENTRIES = 5000

/** Get .jsonl log file path */
function getLogFilePath(projectId: string): string {
  return path.join(getProjectDir(projectId), 'logs.jsonl')
}

/** Get legacy .json log file path */
function getLegacyLogFilePath(projectId: string): string {
  return path.join(getProjectDir(projectId), 'logs.json')
}

/** Migrate legacy logs.json to logs.jsonl if it exists */
function migrateLogsIfNeeded(projectId: string): void {
  const legacyPath = getLegacyLogFilePath(projectId)
  const jsonlPath = getLogFilePath(projectId)
  if (!fs.existsSync(legacyPath)) return
  // If jsonl already exists, just delete the old file
  if (fs.existsSync(jsonlPath)) {
    fs.unlinkSync(legacyPath)
    return
  }
  try {
    const entries = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as LogEntryData[]
    if (Array.isArray(entries) && entries.length > 0) {
      const lines = entries.slice(-LOG_MAX_ENTRIES).map((e) => JSON.stringify(e))
      fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')
    }
    fs.unlinkSync(legacyPath)
    log.project(`Migrated logs.json → logs.jsonl (project=${projectId})`)
  } catch {
    // Migration failure is non-blocking, delete old file and continue
    try { fs.unlinkSync(legacyPath) } catch { /* ignore */ }
  }
}

export function getLogs(projectId: string): LogEntryData[] {
  migrateLogsIfNeeded(projectId)
  const filePath = getLogFilePath(projectId)
  if (!fs.existsSync(filePath)) return []
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim())
    const entries: LogEntryData[] = []
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch { /* skip malformed lines */ }
    }
    // If over limit, truncate file and return last N entries
    if (entries.length > LOG_MAX_ENTRIES) {
      const trimmed = entries.slice(-LOG_MAX_ENTRIES)
      const trimmedLines = trimmed.map((e) => JSON.stringify(e))
      fs.writeFileSync(filePath, trimmedLines.join('\n') + '\n')
      return trimmed
    }
    return entries
  } catch {
    return []
  }
}

export function addLog(projectId: string, entry: LogEntryData) {
  migrateLogsIfNeeded(projectId)
  const filePath = getLogFilePath(projectId)
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')
}

// Calculate progress
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

// ===== Human help requests =====

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

  // Write response to project directory for agent to read
  const project = getProject(projectId)
  if (project) {
    const responsePath = path.join(project.projectDir, '.human-response.md')
    const lines: string[] = [
      `# Human Response`,
      '',
    ]

    // Context: what's being worked on
    if (req.featureId || req.featureDescription) {
      lines.push(`## Current Task`)
      if (req.featureId) lines.push(`- Feature ID: ${req.featureId}`)
      if (req.featureDescription) lines.push(`- Description: ${req.featureDescription}`)
      lines.push('')
    }

    // Problem encountered
    lines.push(`## Problem Encountered`)
    lines.push('')
    lines.push(req.message)
    lines.push('')

    // Recent operation logs
    if (req.recentLogs && req.recentLogs.length > 0) {
      lines.push(`## Recent Operation Logs`)
      lines.push('')
      for (const logLine of req.recentLogs) {
        lines.push(`- ${logLine}`)
      }
      lines.push('')
    }

    // Human response
    lines.push(`## Human Guidance`)
    lines.push('')
    lines.push(response)
    lines.push('')

    fs.writeFileSync(responsePath, lines.join('\n'))
    log.project(`Human response written to: ${responsePath}`)
  }

  return req
}
