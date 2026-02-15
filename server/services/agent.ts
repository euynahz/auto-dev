import { spawn, type ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import * as projectService from './project.js'
import { transition } from './state-machine.js'
import type { TransitionResult } from './state-machine.js'
import { requireProvider } from '../providers/registry.js'
import type { AgentEvent } from '../providers/types.js'
import { log } from '../lib/logger.js'
import type { BroadcastMessage, LogEntryData, ProjectData, SessionData, HelpRequestData } from '../types.js'

// 广播函数，由 index.ts 注入
let broadcast: (msg: BroadcastMessage) => void = () => {}

export function setBroadcast(fn: (msg: BroadcastMessage) => void) {
  broadcast = fn
}

// 统一处理状态转换结果
function applyTransition(projectId: string, result: TransitionResult) {
  if (result.newStatus) {
    projectService.updateProject(projectId, { status: result.newStatus })
    broadcast({ type: 'status', projectId, status: result.newStatus })
  }
  if (result.stopWatcher) {
    stopFeatureWatcher(projectId)
  }
}

// Agent 原始日志目录
const LOGS_DIR = path.join(process.cwd(), '.autodev-data', 'claude-logs') // 保持路径兼容
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
}

// ===== 常量 =====
const SIGKILL_DELAY_MS = 5000        // SIGTERM 后等待多久发 SIGKILL
const SESSION_CHAIN_DELAY_MS = 3000  // session 结束后多久启动下一个
const SESSION_RETRY_DELAY_MS = 5000  // 失败后重试延迟
const MAX_RETRY_PER_FEATURE = 3      // 单个 feature 最大重试次数
const SESSION_WALL_TIMEOUT_MS = 30 * 60 * 1000  // 30 分钟墙钟超时

// 创建 session 日志文件，返回写入流
function createLogFile(sessionId: string): { filePath: string; stream: fs.WriteStream } {
  ensureLogsDir()
  const filePath = path.join(LOGS_DIR, `${sessionId}.log`)
  const stream = fs.createWriteStream(filePath, { flags: 'a' })
  stream.write(`=== Session ${sessionId} started at ${new Date().toLocaleString()} ===\n`)
  return { filePath, stream }
}

// 检查 PID 是否存活
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = just check
    return true
  } catch {
    return false
  }
}

// 强杀进程树（AI agent 可能 spawn 子进程）
function killProcessTree(pid: number) {
  try {
    // 先尝试 SIGTERM
    process.kill(pid, 'SIGTERM')
    log.agent(`发送 SIGTERM 到 PID ${pid}`)
    setTimeout(() => {
      try {
        if (isProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL')
          log.agent(`发送 SIGKILL 到 PID ${pid}`)
        }
      } catch { /* already dead */ }
    }, SIGKILL_DELAY_MS)
  } catch {
    log.agent(`PID ${pid} 已不存在`)
  }
}

// Agent 实例
interface AgentInstance {
  process: ChildProcess
  sessionId: string
  stopped: boolean
  agentIndex: number
  featureId?: string
  branch?: string
}

// 运行中的 Agent 进程：projectId -> Map<agentIndex, AgentInstance>
const runningAgents = new Map<string, Map<number, AgentInstance>>()

// Feature 认领表：projectId -> Map<featureId, agentIndex>
const claimedFeatures = new Map<string, Map<string, number>>()

// Git 操作锁：projectId -> Promise 队列
const gitLocks = new Map<string, Promise<unknown>>()

// 文件监控定时器
const watchers = new Map<string, ReturnType<typeof setInterval>>()

// 循环检测：sessionId -> 最近的 assistant 消息
const recentMessages = new Map<string, string[]>()
const LOOP_DETECT_COUNT = 5 // 连续相似消息数阈值

// Feature 重试计数：projectId:featureId -> 失败次数
const featureRetryCount = new Map<string, number>()

// 文本相似度（Jaccard 系数，忽略短词）
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  return intersection / Math.max(wordsA.size, wordsB.size)
}

// 检测循环并自动终止卡住的 Agent
function checkLoopAndKill(sessionId: string, projectId: string, content: string, agentIndex: number) {
  if (!recentMessages.has(sessionId)) {
    recentMessages.set(sessionId, [])
  }
  const msgs = recentMessages.get(sessionId)!
  msgs.push(content)
  if (msgs.length > LOOP_DETECT_COUNT + 2) msgs.shift()
  if (msgs.length < LOOP_DETECT_COUNT) return

  const recent = msgs.slice(-LOOP_DETECT_COUNT)
  const allSimilar = recent.every((msg, i) => i === 0 || textSimilarity(recent[0], msg) > 0.5)
  if (!allSimilar) return

  log.agent(`🔄 检测到 Agent ${agentIndex} 陷入循环 (session=${sessionId.slice(0, 8)})，自动终止`)

  const entry = createLogEntry(sessionId, 'error',
    `⚠️ Agent ${agentIndex} 检测到重复循环（连续 ${LOOP_DETECT_COUNT} 条相似输出），已自动终止`, agentIndex)
  projectService.addLog(projectId, entry)
  broadcast({ type: 'log', projectId, entry })

  // 创建 HUMAN_HELP 请求
  const ctx = gatherAgentContext(projectId, sessionId, agentIndex)
  const helpRequest: HelpRequestData = {
    id: uuidv4(),
    projectId,
    sessionId,
    agentIndex,
    message: `Agent 陷入循环，最后输出: "${recent[recent.length - 1].slice(0, 200)}"`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    featureId: ctx.featureId,
    featureDescription: ctx.featureDescription,
    recentLogs: ctx.recentLogs,
  }
  projectService.addHelpRequest(projectId, helpRequest)
  broadcast({ type: 'human_help', projectId, request: helpRequest })

  // 找到并杀掉对应进程
  const agents = runningAgents.get(projectId)
  if (agents) {
    for (const [, agent] of agents) {
      if (agent.sessionId === sessionId) {
        agent.stopped = true
        agent.process.kill('SIGTERM')
        setTimeout(() => {
          try { agent.process.kill('SIGKILL') } catch { /* already dead */ }
        }, SIGKILL_DELAY_MS)
        break
      }
    }
  }
  recentMessages.delete(sessionId)
}

// 读取 prompt 模板
function loadPrompt(name: string): string {
  const promptPath = path.join(import.meta.dirname, '..', 'prompts', `${name}.md`)
  return fs.readFileSync(promptPath, 'utf-8')
}

// Agent CLI 参数构建已迁移到 provider.buildArgs()

// 构建 initializer prompt
function buildInitializerPrompt(project: ReturnType<typeof projectService.getProject>): string {
  if (!project) return ''
  let template = loadPrompt('initializer')
  template = template.replace('{{PROJECT_NAME}}', project.name)
  return template
}

// 构建增量 initializer prompt
function buildAppendInitializerPrompt(project: ReturnType<typeof projectService.getProject>, appendSpec: string): string {
  if (!project) return ''
  let template = loadPrompt('append-initializer')
  const features = projectService.getFeatures(project.id)
  const summary = features.map((f) => `- [${f.id}] ${f.category}: ${f.description} (passes=${f.passes})`).join('\n')
  template = template.replace('{{EXISTING_FEATURES}}', summary || '（暂无）')
  template = template.replace('{{APPEND_SPEC}}', appendSpec)
  return template
}

// 构建 coding prompt（串行模式）
function buildCodingPrompt(): string {
  return loadPrompt('coding')
}

// 构建 agent-teams prompt
function buildAgentTeamsPrompt(project: ReturnType<typeof projectService.getProject>): string {
  if (!project) return ''
  let template = loadPrompt('agent-teams')
  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name)
  template = template.replace(/\{\{CONCURRENCY\}\}/g, String(project.concurrency))
  return template
}

// 构建 coding-parallel prompt（并行模式）
function buildParallelCodingPrompt(agentIndex: number, branch: string, feature: { id: string; description: string; steps: string[] }): string {
  let template = loadPrompt('coding-parallel')
  template = template.replace('{{AGENT_INDEX}}', String(agentIndex))
  template = template.replace('{{BRANCH_NAME}}', branch)
  template = template.replace('{{FEATURE_ID}}', feature.id)
  template = template.replace('{{FEATURE_DESCRIPTION}}', feature.description)
  template = template.replace('{{FEATURE_STEPS}}', feature.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))
  return template
}

// 创建日志条目
function createLogEntry(sessionId: string, type: LogEntryData['type'], content: string, agentIndex?: number, toolName?: string, toolInput?: string): LogEntryData {
  return {
    id: uuidv4(),
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    content,
    toolName,
    toolInput,
    agentIndex,
  }
}

// 收集 Agent 当前上下文，用于 help request
function gatherAgentContext(projectId: string, sessionId: string, agentIndex: number): {
  featureId?: string; featureDescription?: string; recentLogs: string[]
} {
  // 从运行中的 agent 实例获取 featureId
  let featureId: string | undefined
  const agents = runningAgents.get(projectId)
  if (agents) {
    for (const [, agent] of agents) {
      if (agent.sessionId === sessionId) {
        featureId = agent.featureId
        break
      }
    }
  }
  // 也从 claimed features 查找
  if (!featureId) {
    const claimed = claimedFeatures.get(projectId)
    if (claimed) {
      for (const [fid, idx] of claimed) {
        if (idx === agentIndex) { featureId = fid; break }
      }
    }
  }

  let featureDescription: string | undefined
  if (featureId) {
    const features = projectService.getFeatures(projectId)
    featureDescription = features.find((f) => f.id === featureId)?.description
  }

  // 最近 N 条该 session 的非临时日志
  const allLogs = projectService.getLogs(projectId)
  const recentLogs = allLogs
    .filter((l) => l.sessionId === sessionId && !l.temporary)
    .slice(-8)
    .map((l) => `[${l.type}] ${l.content.slice(0, 200)}`)

  return { featureId, featureDescription, recentLogs }
}

// 检测并创建人工协助请求
const HELP_PATTERN = /\[HUMAN_HELP\]\s*([\s\S]+)/
function detectHelpRequest(content: string, sessionId: string, projectId: string, agentIndex: number) {
  const match = content.match(HELP_PATTERN)
  if (!match) return
  const message = match[1].trim()
  if (!message) return

  const ctx = gatherAgentContext(projectId, sessionId, agentIndex)
  const request: HelpRequestData = {
    id: uuidv4(),
    projectId,
    sessionId,
    agentIndex,
    message,
    status: 'pending',
    createdAt: new Date().toISOString(),
    featureId: ctx.featureId,
    featureDescription: ctx.featureDescription,
    recentLogs: ctx.recentLogs,
  }
  projectService.addHelpRequest(projectId, request)
  broadcast({ type: 'human_help', projectId, request })
  log.agent(`Agent ${agentIndex} 请求人工协助: ${message.slice(0, 100)}`)
}

// 检测内容是否为 JSON 格式（Agent 思考过程）
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
         (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

// parseThinkingContent 已迁移到 server/providers/claude.ts
// 为了测试兼容性，从 provider 重新导出
import { parseThinkingContent } from '../providers/claude.js'

// ===== Provider-agnostic 输出处理 =====
// 将 provider.parseLine() 返回的标准化事件转为 UI 日志
function handleProviderEvent(
  event: AgentEvent,
  sessionId: string,
  projectId: string,
  agentIndex?: number,
): void {
  switch (event.type) {
    case 'text':
      detectHelpRequest(event.content, sessionId, projectId, agentIndex ?? 0)
      checkLoopAndKill(sessionId, projectId, event.content, agentIndex ?? 0)
      {
        const entry = createLogEntry(sessionId, 'assistant', event.content.slice(0, 800), agentIndex)
        projectService.addLog(projectId, entry)
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'thinking':
      {
        const entry = { ...createLogEntry(sessionId, 'thinking', event.content, agentIndex), temporary: true }
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'tool_use':
      {
        const entry = createLogEntry(sessionId, 'tool_use', `调用工具: ${event.name}`, agentIndex, event.name, event.input)
        projectService.addLog(projectId, entry)
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'system':
      {
        const entry = createLogEntry(sessionId, 'system', event.content, agentIndex)
        projectService.addLog(projectId, entry)
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'error':
      {
        const entry = createLogEntry(sessionId, 'error', event.content, agentIndex)
        projectService.addLog(projectId, entry)
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'ignore':
    default:
      break
  }
}

// Git 操作加锁
async function withGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = gitLocks.get(projectId) || Promise.resolve()
  const next = prev.then(fn, fn)
  gitLocks.set(projectId, next)
  return next
}

// 执行 git 命令
function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }))
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }))
  })
}

// 创建并切换到工作分支
async function createWorkBranch(projectDir: string, branch: string): Promise<boolean> {
  log.git(`checkout main & 创建分支 ${branch}`)
  await execGit(projectDir, ['checkout', 'main'])
  const result = await execGit(projectDir, ['checkout', '-b', branch])
  if (result.code !== 0) log.error(`创建分支失败: ${result.stderr}`)
  return result.code === 0
}

// 合并分支回 main
async function mergeBranch(projectDir: string, branch: string): Promise<{ success: boolean; error?: string }> {
  log.git(`合并分支 ${branch} -> main`)
  const checkoutResult = await execGit(projectDir, ['checkout', 'main'])
  if (checkoutResult.code !== 0) {
    log.error(`checkout main 失败: ${checkoutResult.stderr}`)
    return { success: false, error: `checkout main 失败: ${checkoutResult.stderr}` }
  }

  const mergeResult = await execGit(projectDir, ['merge', '--no-ff', branch, '-m', `Merge ${branch}`])
  if (mergeResult.code !== 0) {
    log.error(`合并冲突: ${mergeResult.stderr}`)
    await execGit(projectDir, ['merge', '--abort'])
    return { success: false, error: `合并冲突: ${mergeResult.stderr}` }
  }

  await execGit(projectDir, ['branch', '-d', branch])
  log.git(`分支 ${branch} 合并成功并已删除`)
  return { success: true }
}

// 获取未完成的 features
function getUnfinishedFeatures(projectId: string) {
  const features = projectService.getFeatures(projectId)
  const claimed = claimedFeatures.get(projectId) || new Map()
  return features.filter((f) => !f.passes && !claimed.has(f.id))
}

// 认领一个 feature
function claimFeature(projectId: string, agentIndex: number): { id: string; description: string; steps: string[] } | null {
  const unfinished = getUnfinishedFeatures(projectId)
  if (unfinished.length === 0) return null

  const feature = unfinished[0]
  if (!claimedFeatures.has(projectId)) {
    claimedFeatures.set(projectId, new Map())
  }
  claimedFeatures.get(projectId)!.set(feature.id, agentIndex)

  // 持久化 claimed 状态
  const claimedData = Object.fromEntries(claimedFeatures.get(projectId)!)
  projectService.saveClaimedFeaturesData(projectId, claimedData)

  // 系统级设置 inProgress
  projectService.setFeatureInProgress(projectId, feature.id, true)

  return { id: feature.id, description: feature.description, steps: feature.steps }
}

// 释放 feature 认领
function releaseFeature(projectId: string, featureId: string) {
  claimedFeatures.get(projectId)?.delete(featureId)

  // 持久化 claimed 状态
  const claimed = claimedFeatures.get(projectId)
  if (claimed) {
    projectService.saveClaimedFeaturesData(projectId, Object.fromEntries(claimed))
  } else {
    projectService.saveClaimedFeaturesData(projectId, {})
  }

  // 系统级清除 inProgress
  projectService.setFeatureInProgress(projectId, featureId, false)
}

// 广播活跃 Agent 数量
function broadcastAgentCount(projectId: string) {
  const agents = runningAgents.get(projectId)
  const project = projectService.getProject(projectId)
  const active = agents ? agents.size : 0
  const total = project?.concurrency || 1
  broadcast({ type: 'agent_count', projectId, active, total })
}

// 获取 feature 认领信息（供前端查询）
export function getClaimedFeatures(projectId: string): Map<string, number> {
  return claimedFeatures.get(projectId) || new Map()
}

// 启动 feature_list.json 文件监控
function startFeatureWatcher(projectId: string) {
  stopFeatureWatcher(projectId)
  log.watch(`启动 feature 监控 (project=${projectId}, interval=3s)`)

  const interval = setInterval(() => {
    const oldFeatures = projectService.getFeatures(projectId)
    const newFeatures = projectService.syncFeaturesFromDisk(projectId)

    // 检测是否有任何变化（数量或 passes 状态）
    let hasChanges = newFeatures.length !== oldFeatures.length
    if (!hasChanges) {
      for (const nf of newFeatures) {
        const of = oldFeatures.find((f) => f.id === nf.id)
        if (of && (of.passes !== nf.passes || of.inProgress !== nf.inProgress)) {
          hasChanges = true
          break
        }
      }
    }

    if (hasChanges) {
      // 发送完整 features 列表，确保前端始终同步
      broadcast({ type: 'features_sync', projectId, features: newFeatures })
    }

    const progress = projectService.getProgress(projectId)
    broadcast({ type: 'progress', projectId, progress })

    if (progress.total > 0 && progress.passed === progress.total) {
      const currentStatus = projectService.getProject(projectId)?.status
      if (currentStatus) {
        applyTransition(projectId, transition(currentStatus, { type: 'SESSION_COMPLETE', allDone: true }))
      }
      stopAgent(projectId)
    }
  }, 3000)

  watchers.set(projectId, interval)
}

function stopFeatureWatcher(projectId: string) {
  const interval = watchers.get(projectId)
  if (interval) {
    clearInterval(interval)
    watchers.delete(projectId)
    log.watch(`停止 feature 监控 (project=${projectId})`)
  }
}

// ===== 通用 Agent Session 启动器 =====

interface SpawnCloseContext {
  code: number | null
  wasStopped: boolean
  endStatus: 'completed' | 'failed' | 'stopped'
  sessionId: string
  session: SessionData
  agentIndex: number
  projectId: string
}

interface SpawnSessionConfig {
  projectId: string
  project: ProjectData
  sessionType: SessionData['type']
  agentIndex: number
  prompt: string
  maxTurns: number
  startMessage: string       // 🚀 启动 xxx Session...
  heartbeat?: boolean         // 是否启用 15s 无输出心跳提示
  heartbeatMessage?: string   // 心跳提示文字
  branch?: string
  featureId?: string
  onClose?: (ctx: SpawnCloseContext) => void  // close 后的自定义行为
}

/**
 * 通用 Agent session 启动器，封装进程生命周期管理。
 * 通过 provider 接口适配不同 AI 工具（Claude、Codex、Gemini 等）。
 */
function spawnAgentSession(config: SpawnSessionConfig): void {
  const {
    projectId, project, sessionType, agentIndex, prompt, maxTurns,
    startMessage, heartbeat: useHeartbeat, heartbeatMessage,
    branch, featureId, onClose,
  } = config

  const provider = requireProvider(project.provider || 'claude')

  const sessionId = uuidv4()
  log.agent(`启动 ${sessionType} session (project=${projectId}, agent=${agentIndex}, provider=${provider.name}, session=${sessionId.slice(0, 8)})`)

  const session: SessionData = {
    id: sessionId,
    projectId,
    type: sessionType,
    status: 'running',
    agentIndex,
    startedAt: new Date().toISOString(),
    ...(branch ? { branch } : {}),
    ...(featureId ? { featureId } : {}),
  }
  projectService.addSession(projectId, session)
  broadcast({ type: 'session_update', projectId, session })

  const sysEntry = createLogEntry(sessionId, 'system', startMessage, agentIndex)
  projectService.addLog(projectId, sysEntry)
  broadcast({ type: 'log', projectId, entry: sysEntry })

  const logFile = createLogFile(sessionId)
  log.agent(`日志文件: ${logFile.filePath}`)

  const args = provider.buildArgs({
    prompt,
    model: project.model,
    maxTurns,
    systemPrompt: project.systemPrompt,
    projectDir: project.projectDir,
    dangerousMode: true,
    disableSlashCommands: true,
    verbose: true,
    providerSettings: project.providerSettings,
  })
  const extraEnv = provider.buildEnv?.({
    prompt, model: project.model, maxTurns,
    projectDir: project.projectDir,
    providerSettings: project.providerSettings,
  }) || {}

  const proc = spawn(provider.binary, args, {
    cwd: project.projectDir,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  log.agent(`${provider.displayName} 进程已启动 (pid=${proc.pid}, cwd=${project.projectDir}, model=${project.model})`)

  projectService.updateSession(projectId, sessionId, {
    pid: proc.pid,
    logFile: logFile.filePath,
  })

  if (!runningAgents.has(projectId)) {
    runningAgents.set(projectId, new Map())
  }
  const agentInstance: AgentInstance = {
    process: proc, sessionId, stopped: false, agentIndex,
    ...(featureId ? { featureId } : {}),
    ...(branch ? { branch } : {}),
  }
  runningAgents.get(projectId)!.set(agentIndex, agentInstance)
  broadcastAgentCount(projectId)

  // 可选心跳：15s 无输出提示
  let gotOutput = false
  const heartbeatTimer = useHeartbeat ? setTimeout(() => {
    if (!gotOutput) {
      const waitEntry = createLogEntry(sessionId, 'system', heartbeatMessage || 'Agent 正在初始化，请稍候...', agentIndex)
      projectService.addLog(projectId, waitEntry)
      broadcast({ type: 'log', projectId, entry: waitEntry })
    }
  }, 15000) : null

  // 墙钟超时：30 分钟无 stdout 输出自动 kill
  let wallTimer: ReturnType<typeof setTimeout> | null = null
  function resetWallTimer() {
    if (wallTimer) clearTimeout(wallTimer)
    wallTimer = setTimeout(() => {
      log.agent(`⏰ Session 墙钟超时 (${SESSION_WALL_TIMEOUT_MS / 60000}min 无输出)，自动终止 (agent=${agentIndex})`)
      const entry = createLogEntry(sessionId, 'error',
        `⏰ 墙钟超时：${SESSION_WALL_TIMEOUT_MS / 60000} 分钟无输出，自动终止`, agentIndex)
      projectService.addLog(projectId, entry)
      broadcast({ type: 'log', projectId, entry })
      const agent = runningAgents.get(projectId)?.get(agentIndex)
      if (agent) {
        agent.stopped = true
        agent.process.kill('SIGTERM')
        setTimeout(() => {
          try { agent.process.kill('SIGKILL') } catch { /* already dead */ }
        }, SIGKILL_DELAY_MS)
      }
    }, SESSION_WALL_TIMEOUT_MS)
  }
  resetWallTimer()

  let buffer = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (!gotOutput) {
      gotOutput = true
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
    }
    resetWallTimer()
    const raw = chunk.toString()
    logFile.stream.write(raw)
    buffer += raw
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) {
        const event = provider.parseLine(line)
        if (event) handleProviderEvent(event, sessionId, projectId, agentIndex)
      }
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) {
      logFile.stream.write(`[STDERR] ${text}\n`)
      if (!gotOutput) {
        gotOutput = true
        if (heartbeatTimer) clearTimeout(heartbeatTimer)
      }
      const entry = createLogEntry(sessionId, 'error', text.slice(0, 500), agentIndex)
      projectService.addLog(projectId, entry)
      broadcast({ type: 'log', projectId, entry })
    }
  })

  proc.on('close', (code) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    if (wallTimer) clearTimeout(wallTimer)
    logFile.stream.write(`\n=== Session ended at ${new Date().toISOString()} (exit code: ${code}) ===\n`)
    logFile.stream.end()
    recentMessages.delete(sessionId)

    const agents = runningAgents.get(projectId)
    const agent = agents?.get(agentIndex)
    const wasStopped = agent?.stopped || false
    agents?.delete(agentIndex)
    if (agents && agents.size === 0) {
      runningAgents.delete(projectId)
    }
    broadcastAgentCount(projectId)

    const endStatus = wasStopped ? 'stopped' : (provider.isSuccessExit(code ?? 1) ? 'completed' : 'failed')
    log.agent(`session 结束 (agent=${agentIndex}, status=${endStatus}, exit=${code})`)
    projectService.updateSession(projectId, sessionId, {
      status: endStatus,
      endedAt: new Date().toISOString(),
    })

    const updatedSession = { ...session, status: endStatus as SessionData['status'], endedAt: new Date().toISOString() }
    broadcast({ type: 'session_update', projectId, session: updatedSession })

    const endEntry = createLogEntry(sessionId, 'system',
      `Session 结束 (${endStatus}, exit code: ${code})`, agentIndex)
    projectService.addLog(projectId, endEntry)
    broadcast({ type: 'log', projectId, entry: endEntry })

    // 调用自定义 close 回调
    onClose?.({ code, wasStopped, endStatus: endStatus as SpawnCloseContext['endStatus'], sessionId, session: updatedSession, agentIndex, projectId })
  })

  proc.on('error', (err) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    if (wallTimer) clearTimeout(wallTimer)
    logFile.stream.end()
    const entry = createLogEntry(sessionId, 'error', `进程错误: ${err.message}`, agentIndex)
    projectService.addLog(projectId, entry)
    broadcast({ type: 'log', projectId, entry })

    const agents = runningAgents.get(projectId)
    agents?.delete(agentIndex)
    if (agents && agents.size === 0) {
      runningAgents.delete(projectId)
      const currentStatus = projectService.getProject(projectId)?.status
      if (currentStatus) {
        applyTransition(projectId, transition(currentStatus, { type: 'ERROR' }))
      }
    }
    broadcastAgentCount(projectId)
  })
}

// 启动一个 session（串行模式，concurrency=1 时使用）
function startSession(projectId: string, type: 'initializer' | 'coding', agentIndex = 0) {
  const project = projectService.getProject(projectId)
  if (!project) return

  const prompt = type === 'initializer'
    ? buildInitializerPrompt(project)
    : buildCodingPrompt()

  spawnAgentSession({
    projectId, project,
    sessionType: type,
    agentIndex,
    prompt,
    maxTurns: 200,
    startMessage: `🚀 启动 ${type === 'initializer' ? '初始化' : '编码'} Session...`,
    heartbeat: true,
    onClose({ wasStopped, endStatus, sessionId, agentIndex: ai }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })

      // initializer 结束后的状态转换
      const currentStatus = projectService.getProject(projectId)?.status
      if (currentStatus === 'initializing') {
        if (progress.total > 0) {
          const latestProject = projectService.getProject(projectId)
          const result = transition('initializing', {
            type: 'INIT_COMPLETE',
            hasFeatures: true,
            reviewMode: latestProject?.reviewBeforeCoding || false,
          })
          applyTransition(projectId, result)
          log.agent(result.newStatus === 'reviewing'
            ? `初始化完成，进入审查模式 (${progress.total} 个 feature)`
            : `初始化完成，features 已生成 (${progress.total} 个)，状态转为 running`)
        } else if (!wasStopped) {
          applyTransition(projectId, transition('initializing', { type: 'INIT_FAILED' }))
          log.agent(`初始化失败，未生成任何 feature，状态转为 error`)
        }
      }

      // reviewing 状态下不自动启动 coding session
      const postStatus = projectService.getProject(projectId)?.status
      if (!wasStopped && progress.total > 0 && progress.passed < progress.total && postStatus !== 'reviewing') {
        const currentProject = projectService.getProject(projectId)
        if (currentProject && currentProject.concurrency > 1) {
          const nextEntry = createLogEntry(sessionId, 'system', `Agent ${ai}: 3 秒后尝试领取下一个 Feature...`, ai)
          projectService.addLog(projectId, nextEntry)
          broadcast({ type: 'log', projectId, entry: nextEntry })
          setTimeout(() => {
            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') startParallelSession(projectId, ai)
          }, SESSION_CHAIN_DELAY_MS)
        } else {
          const nextEntry = createLogEntry(sessionId, 'system', '3 秒后启动下一个 Session...', ai)
          projectService.addLog(projectId, nextEntry)
          broadcast({ type: 'log', projectId, entry: nextEntry })
          setTimeout(() => {
            const currentProj = projectService.getProject(projectId)
            if (currentProj && currentProj.status === 'running') startSession(projectId, 'coding', 0)
          }, SESSION_CHAIN_DELAY_MS)
        }
      } else if (progress.total > 0 && progress.passed >= progress.total) {
        applyTransition(projectId, transition(postStatus || 'running', { type: 'SESSION_COMPLETE', allDone: true }))
      } else if (wasStopped) {
        const agents2 = runningAgents.get(projectId)
        const allStopped = !agents2 || agents2.size === 0
        applyTransition(projectId, transition(postStatus || 'running', { type: 'STOP', allAgentsStopped: allStopped }))
      }
    },
  })
}

// 启动并行 session（每个 agent 在独立 branch 上工作）
function startParallelSession(projectId: string, agentIndex: number) {
  const project = projectService.getProject(projectId)
  if (!project) return

  const feature = claimFeature(projectId, agentIndex)
  if (!feature) {
    log.agent(`Agent ${agentIndex}: 没有更多未完成的 Feature`)
    const sysEntry = createLogEntry('', 'system', `Agent ${agentIndex}: 没有更多未完成的 Feature`, agentIndex)
    projectService.addLog(projectId, sysEntry)
    broadcast({ type: 'log', projectId, entry: sysEntry })
    broadcastAgentCount(projectId)
    return
  }

  const branch = `agent-${agentIndex}/feature-${feature.id}`
  log.agent(`Agent ${agentIndex}: 认领 Feature ${feature.id} — ${feature.description}`)
  log.git(`Agent ${agentIndex}: 创建分支 ${branch}`)

  withGitLock(projectId, async () => {
    const ok = await createWorkBranch(project.projectDir, branch)
    if (!ok) {
      const errEntry = createLogEntry('', 'error', `创建分支 ${branch} 失败`, agentIndex)
      projectService.addLog(projectId, errEntry)
      broadcast({ type: 'log', projectId, entry: errEntry })
      releaseFeature(projectId, feature.id)
      return
    }

    spawnAgentSession({
      projectId, project,
      sessionType: 'coding',
      agentIndex,
      prompt: buildParallelCodingPrompt(agentIndex, branch, feature),
      maxTurns: 200,
      startMessage: `🚀 Agent ${agentIndex} 启动并行编码 Session — Feature: ${feature.description} — Branch: ${branch}`,
      branch,
      featureId: feature.id,
      onClose({ code, wasStopped, endStatus, sessionId }) {
        // 失败时记录尝试次数
        if (endStatus === 'failed') {
          projectService.markFeatureAttempt(projectId, feature.id)
        }
        releaseFeature(projectId, feature.id)

        if (!wasStopped && endStatus === 'completed') {
          // 成功完成，清理重试计数
          featureRetryCount.delete(`${projectId}:${feature.id}`)
          withGitLock(projectId, async () => {
            const mergeEntry = createLogEntry(sessionId, 'system',
              `🔀 Agent ${agentIndex}: 合并分支 ${branch} 到 main...`, agentIndex)
            projectService.addLog(projectId, mergeEntry)
            broadcast({ type: 'log', projectId, entry: mergeEntry })

            const result = await mergeBranch(project.projectDir, branch)
            if (result.success) {
              const successEntry = createLogEntry(sessionId, 'system',
                `✅ Agent ${agentIndex}: 分支 ${branch} 合并成功`, agentIndex)
              projectService.addLog(projectId, successEntry)
              broadcast({ type: 'log', projectId, entry: successEntry })
            } else {
              const failEntry = createLogEntry(sessionId, 'error',
                `⚠️ Agent ${agentIndex}: 合并失败 — ${result.error}（需要人工处理）`, agentIndex)
              projectService.addLog(projectId, failEntry)
              broadcast({ type: 'log', projectId, entry: failEntry })
            }

            projectService.syncFeaturesFromDisk(projectId)
            const progress = projectService.getProgress(projectId)
            broadcast({ type: 'progress', projectId, progress })

            if (progress.total > 0 && progress.passed >= progress.total) {
              applyTransition(projectId, transition('running', { type: 'SESSION_COMPLETE', allDone: true }))
              return
            }

            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') {
              setTimeout(() => startParallelSession(projectId, agentIndex), SESSION_CHAIN_DELAY_MS)
            }
          }).catch(() => { /* git lock error */ })
        } else if (wasStopped) {
          const agents2 = runningAgents.get(projectId)
          const allStopped = !agents2 || agents2.size === 0
          applyTransition(projectId, transition('running', { type: 'STOP', allAgentsStopped: allStopped }))
        } else {
          // 非正常退出，检查重试上限
          const retryKey = `${projectId}:${feature.id}`
          const retries = (featureRetryCount.get(retryKey) || 0) + 1
          featureRetryCount.set(retryKey, retries)

          if (retries >= MAX_RETRY_PER_FEATURE) {
            log.agent(`Agent ${agentIndex}: Feature ${feature.id} 已失败 ${retries} 次，达到重试上限，跳过`)
            const skipEntry = createLogEntry(sessionId, 'error',
              `⚠️ Feature ${feature.id} 已失败 ${retries} 次（上限 ${MAX_RETRY_PER_FEATURE}），不再重试`, agentIndex)
            projectService.addLog(projectId, skipEntry)
            broadcast({ type: 'log', projectId, entry: skipEntry })
            featureRetryCount.delete(retryKey)
            // 继续领取下一个 feature
            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') {
              setTimeout(() => startParallelSession(projectId, agentIndex), SESSION_CHAIN_DELAY_MS)
            }
          } else {
            log.agent(`Agent ${agentIndex}: Feature ${feature.id} 失败，第 ${retries}/${MAX_RETRY_PER_FEATURE} 次重试`)
            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') {
              setTimeout(() => startParallelSession(projectId, agentIndex), SESSION_RETRY_DELAY_MS)
            }
          }
        }
      },
    })
  }).catch(() => {
    releaseFeature(projectId, feature.id)
  })
}

// 启动 Agent Teams session（provider 支持时，内部协调多 Agent）
function startAgentTeamsSession(projectId: string) {
  const project = projectService.getProject(projectId)
  if (!project) return

  spawnAgentSession({
    projectId, project,
    sessionType: 'agent-teams',
    agentIndex: 0,
    prompt: buildAgentTeamsPrompt(project),
    maxTurns: 500,
    startMessage: '🚀 启动 Agent Teams 模式 — AI 将自主协调多个子 Agent 完成全流程开发',
    heartbeat: true,
    heartbeatMessage: 'Agent Teams 正在初始化，请稍候...',
    onClose({ wasStopped }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })

      const currentStatus = projectService.getProject(projectId)?.status || 'running'
      if (progress.total > 0 && progress.passed >= progress.total) {
        applyTransition(projectId, transition(currentStatus, { type: 'SESSION_COMPLETE', allDone: true }))
      } else if (wasStopped) {
        applyTransition(projectId, transition(currentStatus, { type: 'STOP', allAgentsStopped: true }))
      } else {
        applyTransition(projectId, transition(currentStatus, { type: 'ERROR' }))
      }
    },
  })
}

// ===== 公开 API =====

// 服务启动时恢复：清理孤儿进程，重置卡住的状态
export function initRecovery() {
  log.server(`执行启动恢复检查...`)
  const projects = projectService.getAllProjects()
  let recovered = 0

  for (const project of projects) {
    // 恢复 claimedFeatures 从 claimed.json
    const claimedData = projectService.getClaimedFeaturesData(project.id)
    if (Object.keys(claimedData).length > 0) {
      const features = projectService.getFeatures(project.id)
      const passedIds = new Set(features.filter((f) => f.passes).map((f) => f.id))
      const cleanedData: Record<string, number> = {}
      for (const [fid, idx] of Object.entries(claimedData)) {
        if (!passedIds.has(fid)) {
          cleanedData[fid] = idx
        }
      }
      // 服务重启后进程已不在，清空认领记录并重置 inProgress
      for (const fid of Object.keys(claimedData)) {
        projectService.setFeatureInProgress(project.id, fid, false)
      }
      projectService.saveClaimedFeaturesData(project.id, {})
      log.server(`清理项目 ${project.name} 的 claimed features (${Object.keys(claimedData).length} 个)`)
    }

    if (project.status !== 'running' && project.status !== 'initializing' && project.status !== 'reviewing') continue

    log.server(`发现未正常关闭的项目: ${project.name} (${project.id}), status=${project.status}`)

    // 查找该项目所有 running 状态的 session，尝试杀掉孤儿进程
    const sessions = projectService.getSessions(project.id)
    for (const session of sessions) {
      if (session.status !== 'running') continue

      if (session.pid && isProcessAlive(session.pid)) {
        log.server(`杀掉孤儿 agent 进程 PID=${session.pid} (session=${session.id.slice(0, 8)})`)
        killProcessTree(session.pid)
      }

      // 标记 session 为 stopped
      projectService.updateSession(project.id, session.id, {
        status: 'stopped',
        endedAt: new Date().toISOString(),
      })
    }

    // 重置项目状态为 paused
    projectService.updateProject(project.id, { status: 'paused' })
    log.server(`项目 ${project.name} 状态已重置为 paused`)
    recovered++
  }

  if (recovered > 0) {
    log.server(`恢复完成: ${recovered} 个项目已重置`)
  } else {
    log.server(`无需恢复，所有项目状态正常`)
  }
}

export function startAgent(projectId: string) {
  const existingAgents = runningAgents.get(projectId)
  if (existingAgents && existingAgents.size > 0) {
    throw new Error('Agent 已在运行中')
  }

  const project = projectService.getProject(projectId)
  if (!project) throw new Error('项目不存在')

  log.agent(`启动 Agent (project=${projectId}, model=${project.model}, concurrency=${project.concurrency}, agentTeams=${project.useAgentTeams})`)

  // 判断是否已初始化
  const sessions = projectService.getSessions(projectId)
  const hasInitialized = sessions.some((s) => s.type === 'initializer' && s.status === 'completed')

  // Agent Teams 模式
  if (project.useAgentTeams) {
    // 如果需要审查且尚未初始化，先跑 initializer 生成 feature list
    if (project.reviewBeforeCoding && !hasInitialized) {
      log.agent(`Agent Teams + 审查模式：先启动 initializer 生成 feature list`)
      applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: false }))
      startFeatureWatcher(projectId)
      startSession(projectId, 'initializer', 0)
      return
    }
    applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: true }))
    startFeatureWatcher(projectId)
    startAgentTeamsSession(projectId)
    return
  }

  startFeatureWatcher(projectId)

  if (!hasInitialized) {
    log.agent(`项目未初始化，启动 initializer session`)
    applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: false }))
    startSession(projectId, 'initializer', 0)
    return
  }

  applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: true }))

  const concurrency = project.concurrency || 1

  if (concurrency <= 1) {
    log.agent(`串行模式，启动单个 coding session`)
    startSession(projectId, 'coding', 0)
  } else {
    const features = getUnfinishedFeatures(projectId)
    const agentCount = Math.min(concurrency, features.length)
    log.agent(`并行模式: ${agentCount} 个 Agent, ${features.length} 个待完成 Feature`)

    if (agentCount === 0) {
      applyTransition(projectId, transition('running', { type: 'SESSION_COMPLETE', allDone: true }))
      return
    }

    for (let i = 0; i < agentCount; i++) {
      setTimeout(() => {
        startParallelSession(projectId, i)
      }, i * 2000)
    }
  }
}

export function stopAgent(projectId: string) {
  const agents = runningAgents.get(projectId)

  if (agents && agents.size > 0) {
    // 正常路径：内存中有进程引用
    log.agent(`停止所有 Agent (project=${projectId}, count=${agents.size})`)
    for (const [, agent] of agents) {
      agent.stopped = true
      agent.process.kill('SIGTERM')

      const proc = agent.process
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // 进程可能已退出
        }
      }, SIGKILL_DELAY_MS)
    }
  } else {
    // 恢复路径：服务重启后内存中无进程，但项目状态仍为 running
    // 通过 session 中保存的 PID 尝试杀掉孤儿进程
    const project = projectService.getProject(projectId)
    if (project && (project.status === 'running' || project.status === 'initializing' || project.status === 'reviewing')) {
      log.agent(`内存中无进程引用，尝试通过 PID 清理孤儿进程 (project=${projectId})`)
      const sessions = projectService.getSessions(projectId)
      for (const session of sessions) {
        if (session.status !== 'running') continue
        if (session.pid && isProcessAlive(session.pid)) {
          killProcessTree(session.pid)
        }
        projectService.updateSession(projectId, session.id, {
          status: 'stopped',
          endedAt: new Date().toISOString(),
        })
      }
      applyTransition(projectId, transition(project.status, { type: 'STOP', allAgentsStopped: true }))
      log.agent(`孤儿进程已清理，项目状态重置为 paused`)
    }
  }

  claimedFeatures.delete(projectId)
  // 清理该项目的重试计数
  for (const key of featureRetryCount.keys()) {
    if (key.startsWith(`${projectId}:`)) featureRetryCount.delete(key)
  }
  projectService.saveClaimedFeaturesData(projectId, {})
  gitLocks.delete(projectId)
  stopFeatureWatcher(projectId)
}

export function isRunning(projectId: string): boolean {
  // 检查内存中的进程
  const agents = runningAgents.get(projectId)
  if (agents && agents.size > 0) return true
  // 也检查持久化状态（服务重启后内存为空但项目可能仍标记为 running）
  const project = projectService.getProject(projectId)
  return project?.status === 'running' || project?.status === 'initializing' || project?.status === 'reviewing'
}

export function getActiveAgentCount(projectId: string): number {
  return runningAgents.get(projectId)?.size || 0
}

// 启动增量 initializer（追加需求）
export function startAppendInitializer(projectId: string, appendSpec: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('项目不存在')

  log.agent(`启动增量 initializer (project=${projectId})`)

  // 追加 spec 到 app_spec.txt
  const specPath = path.join(project.projectDir, 'app_spec.txt')
  const separator = '\n\n---\n\n# 追加需求\n\n'
  fs.appendFileSync(specPath, separator + appendSpec)
  projectService.updateProject(projectId, { spec: project.spec + separator + appendSpec })

  startFeatureWatcher(projectId)

  spawnAgentSession({
    projectId, project,
    sessionType: 'initializer',
    agentIndex: 99,
    prompt: buildAppendInitializerPrompt(project, appendSpec),
    maxTurns: 100,
    startMessage: '📝 启动增量需求拆解...',
    onClose({ endStatus }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })
      log.agent(`增量 initializer 结束 (status=${endStatus}, features=${progress.total})`)
    },
  })
}

// 构建审查 prompt
function buildReviewPrompt(selectedFeatures: { id: string; category: string; description: string; steps: string[] }[], instruction: string): string {
  let template = loadPrompt('review-features')
  const summary = selectedFeatures.map(f =>
    `- [${f.id}] ${f.category}: ${f.description}\n  Steps: ${f.steps.join('; ')}`
  ).join('\n')
  template = template.replace('{{SELECTED_FEATURES}}', summary)
  template = template.replace('{{INSTRUCTION}}', instruction)
  return template
}

// 启动审查修改 session
export function startReviewSession(projectId: string, featureIds: string[], instruction: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('项目不存在')

  const features = projectService.getFeatures(projectId)
  const selected = features.filter(f => featureIds.includes(f.id))
  if (selected.length === 0) throw new Error('未选中任何 Feature')

  log.agent(`启动审查修改 session (project=${projectId}, features=${selected.length})`)

  spawnAgentSession({
    projectId, project,
    sessionType: 'initializer',
    agentIndex: 98,
    prompt: buildReviewPrompt(selected, instruction),
    maxTurns: 100,
    startMessage: `🔍 启动 Feature 审查修改 (${selected.length} 个 Feature)...`,
    onClose({ endStatus }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })
      broadcast({ type: 'features_sync', projectId, features: projectService.getFeatures(projectId) })
      log.agent(`审查修改 session 结束 (status=${endStatus}, features=${progress.total})`)
    },
  })
}

// 确认审查并开始编码
// ===== 导出纯函数用于测试 =====
export { textSimilarity, parseThinkingContent }

export function confirmReview(projectId: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('项目不存在')
  if (project.status !== 'reviewing') throw new Error('项目不在审查状态')

  log.agent(`确认审查，开始编码 (project=${projectId})`)

  applyTransition(projectId, transition('reviewing', { type: 'REVIEW_CONFIRMED' }))
  startFeatureWatcher(projectId)

  // Agent Teams 模式：审查确认后启动 agent-teams session
  if (project.useAgentTeams) {
    log.agent(`Agent Teams 模式，审查确认后启动 agent-teams session`)
    startAgentTeamsSession(projectId)
    return
  }

  const concurrency = project.concurrency || 1
  if (concurrency <= 1) {
    log.agent(`串行模式，启动单个 coding session`)
    startSession(projectId, 'coding', 0)
  } else {
    const features = getUnfinishedFeatures(projectId)
    const agentCount = Math.min(concurrency, features.length)
    log.agent(`并行模式: ${agentCount} 个 Agent, ${features.length} 个待完成 Feature`)

    if (agentCount === 0) {
      applyTransition(projectId, transition('running', { type: 'SESSION_COMPLETE', allDone: true }))
      return
    }

    for (let i = 0; i < agentCount; i++) {
      setTimeout(() => {
        startParallelSession(projectId, i)
      }, i * 2000)
    }
  }
}
