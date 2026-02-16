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
import type { BroadcastMessage, LogEntryData, ProjectData, SessionData, HelpRequestData, FeatureProposalData } from '../types.js'

// Broadcast function, injected by index.ts
let broadcast: (msg: BroadcastMessage) => void = () => {}

export function setBroadcast(fn: (msg: BroadcastMessage) => void) {
  broadcast = fn
}

// Apply state transition result
function applyTransition(projectId: string, result: TransitionResult) {
  if (result.newStatus) {
    projectService.updateProject(projectId, { status: result.newStatus })
    broadcast({ type: 'status', projectId, status: result.newStatus })
  }
  if (result.stopWatcher) {
    stopFeatureWatcher(projectId)
  }
}

// Agent raw log directory
const LOGS_DIR = path.join(process.cwd(), '.autodev-data', 'claude-logs') // keep path compatible
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })
}

// ===== Constants =====
const SIGKILL_DELAY_MS = 5000        // Delay before sending SIGKILL after SIGTERM
const SESSION_CHAIN_DELAY_MS = 3000  // Delay before starting next session after one ends
const SESSION_RETRY_DELAY_MS = 5000  // Retry delay after failure
const MAX_RETRY_PER_FEATURE = 3      // Max retries per feature
const SESSION_WALL_TIMEOUT_MS = 30 * 60 * 1000  // 30-minute wall clock timeout

// Create session log file, return write stream
function createLogFile(sessionId: string): { filePath: string; stream: fs.WriteStream } {
  ensureLogsDir()
  const filePath = path.join(LOGS_DIR, `${sessionId}.log`)
  const stream = fs.createWriteStream(filePath, { flags: 'a' })
  stream.write(`=== Session ${sessionId} started at ${new Date().toLocaleString()} ===\n`)
  return { filePath, stream }
}

// Check if PID is alive
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = just check
    return true
  } catch {
    return false
  }
}

// Kill process tree (AI agent may spawn child processes)
function killProcessTree(pid: number) {
  try {
    // Try SIGTERM first
    process.kill(pid, 'SIGTERM')
    log.agent(`Sent SIGTERM to PID ${pid}`)
    setTimeout(() => {
      try {
        if (isProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL')
          log.agent(`Sent SIGKILL to PID ${pid}`)
        }
      } catch { /* already dead */ }
    }, SIGKILL_DELAY_MS)
  } catch {
    log.agent(`PID ${pid} no longer exists`)
  }
}

// Agent instance
interface AgentInstance {
  process: ChildProcess
  sessionId: string
  stopped: boolean
  agentIndex: number
  featureId?: string
  branch?: string
}

// Running agent processes: projectId -> Map<agentIndex, AgentInstance>
const runningAgents = new Map<string, Map<number, AgentInstance>>()

// Feature claim table: projectId -> Map<featureId, agentIndex>
const claimedFeatures = new Map<string, Map<string, number>>()

// Git operation lock: projectId -> Promise queue
const gitLocks = new Map<string, Promise<unknown>>()

// File watcher timers
const watchers = new Map<string, ReturnType<typeof setInterval>>()

// Loop detection: sessionId -> recent assistant messages
const recentMessages = new Map<string, string[]>()
const LOOP_DETECT_COUNT = 5 // consecutive similar message threshold

// Feature retry count: projectId:featureId -> failure count
const featureRetryCount = new Map<string, number>()

// Text similarity (Jaccard coefficient, ignoring short words)
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  return intersection / Math.max(wordsA.size, wordsB.size)
}

// Detect loops and auto-terminate stuck agents
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

  log.agent(`🔄 Detected Agent ${agentIndex} stuck in loop (session=${sessionId.slice(0, 8)}), auto-terminating`)

  const entry = createLogEntry(sessionId, 'error',
    `⚠️ Agent ${agentIndex} detected in repetitive loop (${LOOP_DETECT_COUNT} consecutive similar outputs), auto-terminated`, agentIndex)
  projectService.addLog(projectId, entry)
  broadcast({ type: 'log', projectId, entry })

  // Create HUMAN_HELP request
  const ctx = gatherAgentContext(projectId, sessionId, agentIndex)
  const helpRequest: HelpRequestData = {
    id: uuidv4(),
    projectId,
    sessionId,
    agentIndex,
    message: `Agent stuck in loop, last output: "${recent[recent.length - 1].slice(0, 200)}"`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    featureId: ctx.featureId,
    featureDescription: ctx.featureDescription,
    recentLogs: ctx.recentLogs,
  }
  projectService.addHelpRequest(projectId, helpRequest)
  broadcast({ type: 'human_help', projectId, request: helpRequest })

  // Find and kill the corresponding process
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

// Load prompt template
function loadPrompt(name: string): string {
  const promptPath = path.join(import.meta.dirname, '..', 'prompts', `${name}.md`)
  return fs.readFileSync(promptPath, 'utf-8')
}

// Agent CLI arg building has been moved to provider.buildArgs()

// Build architecture analysis prompt (phase 1 of initialization)
function buildArchitecturePrompt(project: ReturnType<typeof projectService.getProject>): string {
  if (!project) return ''
  let template = loadPrompt('architecture')
  template = template.replace('{{PROJECT_NAME}}', project.name)
  return template
}

// Build initializer prompt (phase 2 — reads architecture.md)
function buildInitializerPrompt(project: ReturnType<typeof projectService.getProject>): string {
  if (!project) return ''
  let template = loadPrompt('initializer')
  template = template.replace('{{PROJECT_NAME}}', project.name)
  return template
}

// Build append initializer prompt
function buildAppendInitializerPrompt(project: ReturnType<typeof projectService.getProject>, appendSpec: string): string {
  if (!project) return ''
  let template = loadPrompt('append-initializer')
  const features = projectService.getFeatures(project.id)
  const summary = features.map((f) => `- [${f.id}] ${f.category}: ${f.description} (passes=${f.passes})`).join('\n')
  template = template.replace('{{EXISTING_FEATURES}}', summary || '(none)')
  template = template.replace('{{APPEND_SPEC}}', appendSpec)
  return template
}

// Inject verifyCommand into prompt template (mustache-style {{#VERIFY_COMMAND}}...{{/VERIFY_COMMAND}})
function injectVerifyCommand(template: string, verifyCommand?: string): string {
  if (verifyCommand) {
    template = template.replace(/\{\{#VERIFY_COMMAND\}\}/g, '')
    template = template.replace(/\{\{\/VERIFY_COMMAND\}\}/g, '')
    template = template.replace(/\{\{VERIFY_COMMAND\}\}/g, verifyCommand)
  } else {
    // Strip the entire verify block
    template = template.replace(/\{\{#VERIFY_COMMAND\}\}[\s\S]*?\{\{\/VERIFY_COMMAND\}\}/g, '')
  }
  return template
}

// Build coding prompt (serial mode)
function buildCodingPrompt(project?: ReturnType<typeof projectService.getProject>): string {
  let template = loadPrompt('coding')
  return injectVerifyCommand(template, project?.verifyCommand)
}

// Build merge conflict resolution prompt
function buildMergeResolvePrompt(branch: string, featureDescription: string, conflictOutput: string): string {
  let template = loadPrompt('merge-resolve')
  template = template.replace(/\{\{BRANCH_NAME\}\}/g, branch)
  template = template.replace(/\{\{FEATURE_DESCRIPTION\}\}/g, featureDescription)
  template = template.replace(/\{\{CONFLICT_OUTPUT\}\}/g, conflictOutput)
  return template
}

// Build agent-teams prompt
function buildAgentTeamsPrompt(project: ReturnType<typeof projectService.getProject>): string {
  if (!project) return ''
  let template = loadPrompt('agent-teams')
  template = template.replace(/\{\{PROJECT_NAME\}\}/g, project.name)
  template = template.replace(/\{\{CONCURRENCY\}\}/g, String(project.concurrency))
  return template
}

// Build coding-parallel prompt (parallel mode)
function buildParallelCodingPrompt(agentIndex: number, branch: string, feature: { id: string; description: string; steps: string[] }, verifyCommand?: string): string {
  let template = loadPrompt('coding-parallel')
  template = template.replace('{{AGENT_INDEX}}', String(agentIndex))
  template = template.replace('{{BRANCH_NAME}}', branch)
  template = template.replace('{{FEATURE_ID}}', feature.id)
  template = template.replace('{{FEATURE_DESCRIPTION}}', feature.description)
  template = template.replace('{{FEATURE_STEPS}}', feature.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))
  return injectVerifyCommand(template, verifyCommand)
}

// Create log entry
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

// Gather agent context for help request
function gatherAgentContext(projectId: string, sessionId: string, agentIndex: number): {
  featureId?: string; featureDescription?: string; recentLogs: string[]
} {
  // Get featureId from running agent instance
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
  // Also check claimed features
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

  // Last N non-temporary logs for this session
  const allLogs = projectService.getLogs(projectId)
  const recentLogs = allLogs
    .filter((l) => l.sessionId === sessionId && !l.temporary)
    .slice(-8)
    .map((l) => `[${l.type}] ${l.content.slice(0, 200)}`)

  return { featureId, featureDescription, recentLogs }
}

// Detect and create human help request
const HELP_PATTERN = /\[HUMAN_HELP\]\s*([\s\S]+)/
const NEW_FEATURE_PATTERN = /\[NEW_FEATURE\]\s*(\{[\s\S]*?\})\s*$/m
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
  log.agent(`Agent ${agentIndex} requesting human help: ${message.slice(0, 100)}`)
}

// Detect [NEW_FEATURE] proposals from coding agents
function detectFeatureProposal(content: string, sessionId: string, projectId: string, agentIndex: number) {
  const match = content.match(NEW_FEATURE_PATTERN)
  if (!match) return

  let parsed: { description?: string; reason?: string; steps?: string[] }
  try {
    parsed = JSON.parse(match[1])
  } catch {
    log.error(`Agent ${agentIndex}: Failed to parse [NEW_FEATURE] JSON`)
    return
  }

  if (!parsed.description || !parsed.steps?.length) {
    log.error(`Agent ${agentIndex}: [NEW_FEATURE] missing description or steps`)
    return
  }

  const ctx = gatherAgentContext(projectId, sessionId, agentIndex)
  const project = projectService.getProject(projectId)
  if (!project) return

  // Read current features to generate next ID and deduplicate
  const features = projectService.getFeatures(projectId)
  const maxNum = features.reduce((max, f) => {
    const n = parseInt(f.id.replace('feature-', ''), 10)
    return isNaN(n) ? max : Math.max(max, n)
  }, 0)
  const newId = `feature-${String(maxNum + 1).padStart(3, '0')}`

  // Simple dedup: skip if description is too similar to existing feature
  const isDuplicate = features.some(f =>
    f.description.toLowerCase().includes(parsed.description!.toLowerCase()) ||
    parsed.description!.toLowerCase().includes(f.description.toLowerCase())
  )
  if (isDuplicate) {
    log.agent(`Agent ${agentIndex}: [NEW_FEATURE] skipped (duplicate): ${parsed.description!.slice(0, 80)}`)
    const skipEntry = createLogEntry(sessionId, 'system',
      `⏭️ Feature proposal skipped (similar feature already exists): ${parsed.description!.slice(0, 80)}`, agentIndex)
    projectService.addLog(projectId, skipEntry)
    broadcast({ type: 'log', projectId, entry: skipEntry })
    return
  }

  // Append to feature_list.json on disk
  const featureListPath = path.join(project.projectDir, 'feature_list.json')
  try {
    const raw = fs.readFileSync(featureListPath, 'utf8')
    const list = JSON.parse(raw)
    list.push({
      id: newId,
      category: 'Agent Proposed',
      description: parsed.description,
      steps: parsed.steps,
      passes: false,
    })
    fs.writeFileSync(featureListPath, JSON.stringify(list, null, 2))
  } catch (err) {
    log.error(`Failed to append feature to disk: ${err}`)
    return
  }

  // Sync to in-memory state
  projectService.syncFeaturesFromDisk(projectId)

  const proposal: FeatureProposalData = {
    id: uuidv4(),
    projectId,
    sessionId,
    agentIndex,
    feature: {
      description: parsed.description!,
      reason: parsed.reason || '',
      steps: parsed.steps!,
    },
    status: 'accepted',
    createdAt: new Date().toISOString(),
    sourceFeatureId: ctx.featureId,
  }

  broadcast({ type: 'feature_proposal', projectId, proposal })

  const logEntry = createLogEntry(sessionId, 'system',
    `💡 Agent ${agentIndex} proposed new feature → ${newId}: ${parsed.description!.slice(0, 100)}`, agentIndex)
  projectService.addLog(projectId, logEntry)
  broadcast({ type: 'log', projectId, entry: logEntry })

  // Sync progress
  const progress = projectService.getProgress(projectId)
  broadcast({ type: 'progress', projectId, progress })
  const newFeatures = projectService.getFeatures(projectId)
  broadcast({ type: 'features_sync', projectId, features: newFeatures })

  log.agent(`Agent ${agentIndex} proposed new feature ${newId}: ${parsed.description!.slice(0, 80)}`)
}

// Check if content looks like JSON (agent thinking process)
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
         (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

// parseThinkingContent has been moved to server/providers/claude.ts
// Re-exported from provider for test compatibility
import { parseThinkingContent } from '../providers/claude.js'

// ===== Provider-agnostic output handling =====
// Convert standardized events from provider.parseLine() to UI logs
function handleProviderEvent(
  event: AgentEvent,
  sessionId: string,
  projectId: string,
  agentIndex?: number,
): void {
  switch (event.type) {
    case 'text':
      detectHelpRequest(event.content, sessionId, projectId, agentIndex ?? 0)
      detectFeatureProposal(event.content, sessionId, projectId, agentIndex ?? 0)
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
        const entry = createLogEntry(sessionId, 'tool_use', `Tool call: ${event.name}`, agentIndex, event.name, event.input)
        projectService.addLog(projectId, entry)
        broadcast({ type: 'log', projectId, entry })
      }
      break

    case 'tool_result':
      {
        const entry = createLogEntry(sessionId, 'tool_result', event.output || '', agentIndex)
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

// Git operation locking
async function withGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = gitLocks.get(projectId) || Promise.resolve()
  const next = prev.then(fn, fn)
  gitLocks.set(projectId, next)
  return next
}

// Execute git command
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

// Create and switch to work branch
async function createWorkBranch(projectDir: string, branch: string): Promise<boolean> {
  log.git(`Checkout main & create branch ${branch}`)
  await execGit(projectDir, ['checkout', 'main'])
  const result = await execGit(projectDir, ['checkout', '-b', branch])
  if (result.code !== 0) log.error(`Failed to create branch: ${result.stderr}`)
  return result.code === 0
}

// Merge branch back to main
async function mergeBranch(projectDir: string, branch: string): Promise<{ success: boolean; error?: string; conflictOutput?: string }> {
  log.git(`Merging branch ${branch} -> main`)
  const checkoutResult = await execGit(projectDir, ['checkout', 'main'])
  if (checkoutResult.code !== 0) {
    log.error(`Checkout main failed: ${checkoutResult.stderr}`)
    return { success: false, error: `Checkout main failed: ${checkoutResult.stderr}` }
  }

  const mergeResult = await execGit(projectDir, ['merge', '--no-ff', branch, '-m', `Merge ${branch}`])
  if (mergeResult.code !== 0) {
    log.error(`Merge conflict: ${mergeResult.stderr}`)
    const conflictOutput = mergeResult.stderr + '\n' + mergeResult.stdout
    await execGit(projectDir, ['merge', '--abort'])
    return { success: false, error: `Merge conflict: ${mergeResult.stderr}`, conflictOutput }
  }

  await execGit(projectDir, ['branch', '-d', branch])
  log.git(`Branch ${branch} merged and deleted successfully`)
  return { success: true }
}

// Get unfinished features
function getUnfinishedFeatures(projectId: string) {
  const features = projectService.getFeatures(projectId)
  const claimed = claimedFeatures.get(projectId) || new Map()
  return features.filter((f) => !f.passes && !claimed.has(f.id))
}

// Claim a feature
function claimFeature(projectId: string, agentIndex: number): { id: string; description: string; steps: string[] } | null {
  const unfinished = getUnfinishedFeatures(projectId)
  if (unfinished.length === 0) return null

  const feature = unfinished[0]
  if (!claimedFeatures.has(projectId)) {
    claimedFeatures.set(projectId, new Map())
  }
  claimedFeatures.get(projectId)!.set(feature.id, agentIndex)

  // Persist claimed state
  const claimedData = Object.fromEntries(claimedFeatures.get(projectId)!)
  projectService.saveClaimedFeaturesData(projectId, claimedData)

  // Set inProgress at system level
  projectService.setFeatureInProgress(projectId, feature.id, true)

  return { id: feature.id, description: feature.description, steps: feature.steps }
}

// Release feature claim
function releaseFeature(projectId: string, featureId: string) {
  claimedFeatures.get(projectId)?.delete(featureId)

  // Persist claimed state
  const claimed = claimedFeatures.get(projectId)
  if (claimed) {
    projectService.saveClaimedFeaturesData(projectId, Object.fromEntries(claimed))
  } else {
    projectService.saveClaimedFeaturesData(projectId, {})
  }

  // Clear inProgress at system level
  projectService.setFeatureInProgress(projectId, featureId, false)
}

// Broadcast active agent count
function broadcastAgentCount(projectId: string) {
  const agents = runningAgents.get(projectId)
  const project = projectService.getProject(projectId)
  const active = agents ? agents.size : 0
  const total = project?.concurrency || 1
  broadcast({ type: 'agent_count', projectId, active, total })
}

// Get feature claim info (for frontend queries)
export function getClaimedFeatures(projectId: string): Map<string, number> {
  return claimedFeatures.get(projectId) || new Map()
}

// Start feature_list.json file watcher
function startFeatureWatcher(projectId: string) {
  stopFeatureWatcher(projectId)
  log.watch(`Starting feature watcher (project=${projectId}, interval=3s)`)

  const interval = setInterval(() => {
    const oldFeatures = projectService.getFeatures(projectId)
    const newFeatures = projectService.syncFeaturesFromDisk(projectId)

    // Check for any changes (count or passes status)
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
      // Send full features list to keep frontend in sync
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
    log.watch(`Stopping feature watcher (project=${projectId})`)
  }
}

// ===== Generic Agent Session Launcher =====

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
  startMessage: string       // 🚀 Starting xxx Session...
  heartbeat?: boolean         // Enable 15s no-output heartbeat hint
  heartbeatMessage?: string   // Heartbeat hint message
  branch?: string
  featureId?: string
  onClose?: (ctx: SpawnCloseContext) => void  // Custom behavior after close
}

/**
 * Generic agent session launcher. Manages process lifecycle.
 * Adapts to different AI tools (Claude, Codex, Gemini, etc.) via the provider interface.
 */
function spawnAgentSession(config: SpawnSessionConfig): void {
  const {
    projectId, project, sessionType, agentIndex, prompt, maxTurns,
    startMessage, heartbeat: useHeartbeat, heartbeatMessage,
    branch, featureId, onClose,
  } = config

  const provider = requireProvider(project.provider || 'claude')

  const sessionId = uuidv4()
  log.agent(`Starting ${sessionType} session (project=${projectId}, agent=${agentIndex}, provider=${provider.name}, session=${sessionId.slice(0, 8)})`)

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
  log.agent(`Log file: ${logFile.filePath}`)

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

  log.agent(`${provider.displayName} process started (pid=${proc.pid}, cwd=${project.projectDir}, model=${project.model})`)

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

  // Optional heartbeat: 15s no-output hint
  let gotOutput = false
  const heartbeatTimer = useHeartbeat ? setTimeout(() => {
    if (!gotOutput) {
      const waitEntry = createLogEntry(sessionId, 'system', heartbeatMessage || 'Agent initializing, please wait...', agentIndex)
      projectService.addLog(projectId, waitEntry)
      broadcast({ type: 'log', projectId, entry: waitEntry })
    }
  }, 15000) : null

  // Wall clock timeout: auto-kill after 30 min without stdout output
  let wallTimer: ReturnType<typeof setTimeout> | null = null
  function resetWallTimer() {
    if (wallTimer) clearTimeout(wallTimer)
    wallTimer = setTimeout(() => {
      log.agent(`⏰ Session wall clock timeout (${SESSION_WALL_TIMEOUT_MS / 60000}min no output), auto-terminating (agent=${agentIndex})`)
      const entry = createLogEntry(sessionId, 'error',
        `⏰ Wall clock timeout: ${SESSION_WALL_TIMEOUT_MS / 60000} min no output, auto-terminated`, agentIndex)
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
      // stderr is not necessarily an error (many CLIs write progress to stderr), downgrade to system
      const entry = createLogEntry(sessionId, 'system', text.slice(0, 500), agentIndex)
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
    log.agent(`Session ended (agent=${agentIndex}, status=${endStatus}, exit=${code})`)
    projectService.updateSession(projectId, sessionId, {
      status: endStatus,
      endedAt: new Date().toISOString(),
    })

    const updatedSession = { ...session, status: endStatus as SessionData['status'], endedAt: new Date().toISOString() }
    broadcast({ type: 'session_update', projectId, session: updatedSession })

    const endEntry = createLogEntry(sessionId, 'system',
      `Session ended (${endStatus}, exit code: ${code})`, agentIndex)
    projectService.addLog(projectId, endEntry)
    broadcast({ type: 'log', projectId, entry: endEntry })

    // Call custom close callback
    onClose?.({ code, wasStopped, endStatus: endStatus as SpawnCloseContext['endStatus'], sessionId, session: updatedSession, agentIndex, projectId })
  })

  proc.on('error', (err) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    if (wallTimer) clearTimeout(wallTimer)
    logFile.stream.end()
    const entry = createLogEntry(sessionId, 'error', `Process error: ${err.message}`, agentIndex)
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

// Start a session (serial mode, used when concurrency=1)
function startSession(projectId: string, type: 'architecture' | 'initializer' | 'coding', agentIndex = 0) {
  const project = projectService.getProject(projectId)
  if (!project) return

  const prompt = type === 'architecture'
    ? buildArchitecturePrompt(project)
    : type === 'initializer'
      ? buildInitializerPrompt(project)
      : buildCodingPrompt(project)

  const typeLabel = type === 'architecture' ? 'architecture analysis' : type === 'initializer' ? 'initializer' : 'coding'

  spawnAgentSession({
    projectId, project,
    sessionType: type,
    agentIndex,
    prompt,
    maxTurns: 200,
    startMessage: `🚀 Starting ${typeLabel} session...`,
    heartbeat: true,
    onClose({ wasStopped, endStatus, sessionId, agentIndex: ai }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })

      // Architecture phase complete → chain to initializer phase
      if (type === 'architecture' && !wasStopped) {
        const archEntry = createLogEntry(sessionId, 'system', 'Architecture analysis complete, starting task decomposition in 3s...', ai)
        projectService.addLog(projectId, archEntry)
        broadcast({ type: 'log', projectId, entry: archEntry })
        setTimeout(() => {
          const proj = projectService.getProject(projectId)
          if (proj && proj.status === 'initializing') startSession(projectId, 'initializer', 0)
        }, SESSION_CHAIN_DELAY_MS)
        return
      }

      // State transition after initializer ends
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
            ? `Initialization complete, entering review mode (${progress.total} features)`
            : `Initialization complete, features generated (${progress.total}), status changed to running`)
        } else if (!wasStopped) {
          applyTransition(projectId, transition('initializing', { type: 'INIT_FAILED' }))
          log.agent(`Initialization failed, no features generated, status changed to error`)
        }
      }

      // Do not auto-start coding session while in reviewing state
      const postStatus = projectService.getProject(projectId)?.status
      if (!wasStopped && progress.total > 0 && progress.passed < progress.total && postStatus !== 'reviewing') {
        const currentProject = projectService.getProject(projectId)
        if (currentProject && currentProject.concurrency > 1) {
          const nextEntry = createLogEntry(sessionId, 'system', `Agent ${ai}: Claiming next feature in 3s...`, ai)
          projectService.addLog(projectId, nextEntry)
          broadcast({ type: 'log', projectId, entry: nextEntry })
          setTimeout(() => {
            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') startParallelSession(projectId, ai)
          }, SESSION_CHAIN_DELAY_MS)
        } else {
          const nextEntry = createLogEntry(sessionId, 'system', 'Starting next session in 3s...', ai)
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

// Start parallel session (each agent works on an independent branch)
function startParallelSession(projectId: string, agentIndex: number) {
  const project = projectService.getProject(projectId)
  if (!project) return

  const feature = claimFeature(projectId, agentIndex)
  if (!feature) {
    log.agent(`Agent ${agentIndex}: No more unfinished features`)
    const sysEntry = createLogEntry('', 'system', `Agent ${agentIndex}: No more unfinished features`, agentIndex)
    projectService.addLog(projectId, sysEntry)
    broadcast({ type: 'log', projectId, entry: sysEntry })
    broadcastAgentCount(projectId)
    return
  }

  const branch = `agent-${agentIndex}/feature-${feature.id}`
  log.agent(`Agent ${agentIndex}: Claimed feature ${feature.id} — ${feature.description}`)
  log.git(`Agent ${agentIndex}: Creating branch ${branch}`)

  withGitLock(projectId, async () => {
    const ok = await createWorkBranch(project.projectDir, branch)
    if (!ok) {
      const errEntry = createLogEntry('', 'error', `Failed to create branch ${branch}`, agentIndex)
      projectService.addLog(projectId, errEntry)
      broadcast({ type: 'log', projectId, entry: errEntry })
      releaseFeature(projectId, feature.id)
      return
    }

    spawnAgentSession({
      projectId, project,
      sessionType: 'coding',
      agentIndex,
      prompt: buildParallelCodingPrompt(agentIndex, branch, feature, project.verifyCommand),
      maxTurns: 200,
      startMessage: `🚀 Agent ${agentIndex} starting parallel coding session — Feature: ${feature.description} — Branch: ${branch}`,
      branch,
      featureId: feature.id,
      onClose({ code, wasStopped, endStatus, sessionId }) {
        // Record attempt count on failure
        if (endStatus === 'failed') {
          projectService.markFeatureAttempt(projectId, feature.id)
        }
        releaseFeature(projectId, feature.id)

        if (!wasStopped && endStatus === 'completed') {
          // Completed successfully, clear retry count
          featureRetryCount.delete(`${projectId}:${feature.id}`)
          withGitLock(projectId, async () => {
            const mergeEntry = createLogEntry(sessionId, 'system',
              `🔀 Agent ${agentIndex}: Merging branch ${branch} to main...`, agentIndex)
            projectService.addLog(projectId, mergeEntry)
            broadcast({ type: 'log', projectId, entry: mergeEntry })

            const result = await mergeBranch(project.projectDir, branch)
            if (result.success) {
              const successEntry = createLogEntry(sessionId, 'system',
                `✅ Agent ${agentIndex}: Branch ${branch} merged successfully`, agentIndex)
              projectService.addLog(projectId, successEntry)
              broadcast({ type: 'log', projectId, entry: successEntry })
            } else if (result.conflictOutput) {
              // Merge conflict — spawn an AI agent to resolve it
              const conflictEntry = createLogEntry(sessionId, 'system',
                `⚠️ Agent ${agentIndex}: Merge conflict on ${branch}, spawning conflict resolution agent...`, agentIndex)
              projectService.addLog(projectId, conflictEntry)
              broadcast({ type: 'log', projectId, entry: conflictEntry })

              spawnAgentSession({
                projectId, project,
                sessionType: 'coding',
                agentIndex,
                prompt: buildMergeResolvePrompt(branch, feature.description, result.conflictOutput),
                maxTurns: 50,
                startMessage: `🔧 Resolving merge conflict for ${branch}...`,
                onClose({ wasStopped: ws2, endStatus: es2, sessionId: sid2 }) {
                  // Check if merge was resolved (branch should be gone if successful)
                  withGitLock(projectId, async () => {
                    const branchCheck = await execGit(project.projectDir, ['branch', '--list', branch])
                    const branchStillExists = branchCheck.stdout.trim().length > 0

                    if (!ws2 && es2 === 'completed' && !branchStillExists) {
                      const resolvedEntry = createLogEntry(sid2, 'system',
                        `✅ Merge conflict on ${branch} resolved by AI agent`, agentIndex)
                      projectService.addLog(projectId, resolvedEntry)
                      broadcast({ type: 'log', projectId, entry: resolvedEntry })
                    } else {
                      const failEntry = createLogEntry(sid2, 'error',
                        `❌ AI agent could not resolve merge conflict on ${branch} — manual intervention required`, agentIndex)
                      projectService.addLog(projectId, failEntry)
                      broadcast({ type: 'log', projectId, entry: failEntry })
                    }

                    projectService.syncFeaturesFromDisk(projectId)
                    const p2 = projectService.getProgress(projectId)
                    broadcast({ type: 'progress', projectId, progress: p2 })

                    if (p2.total > 0 && p2.passed >= p2.total) {
                      applyTransition(projectId, transition('running', { type: 'SESSION_COMPLETE', allDone: true }))
                      return
                    }
                    const proj = projectService.getProject(projectId)
                    if (proj && proj.status === 'running') {
                      setTimeout(() => startParallelSession(projectId, agentIndex), SESSION_CHAIN_DELAY_MS)
                    }
                  }).catch(() => { /* git lock error */ })
                },
              })
              return // Don't continue the normal post-merge flow
            } else {
              const failEntry = createLogEntry(sessionId, 'error',
                `⚠️ Agent ${agentIndex}: Merge failed — ${result.error}`, agentIndex)
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
          // Abnormal exit, check retry limit
          const retryKey = `${projectId}:${feature.id}`
          const retries = (featureRetryCount.get(retryKey) || 0) + 1
          featureRetryCount.set(retryKey, retries)

          if (retries >= MAX_RETRY_PER_FEATURE) {
            log.agent(`Agent ${agentIndex}: Feature ${feature.id} failed ${retries} times, retry limit reached, skipping`)
            const skipEntry = createLogEntry(sessionId, 'error',
              `⚠️ Feature ${feature.id} failed ${retries} times (limit ${MAX_RETRY_PER_FEATURE}), no more retries`, agentIndex)
            projectService.addLog(projectId, skipEntry)
            broadcast({ type: 'log', projectId, entry: skipEntry })
            featureRetryCount.delete(retryKey)
            // Continue claiming next feature
            const proj = projectService.getProject(projectId)
            if (proj && proj.status === 'running') {
              setTimeout(() => startParallelSession(projectId, agentIndex), SESSION_CHAIN_DELAY_MS)
            }
          } else {
            log.agent(`Agent ${agentIndex}: Feature ${feature.id} failed, retry ${retries}/${MAX_RETRY_PER_FEATURE}`)
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

// Start Agent Teams session (internal multi-agent coordination when provider supports it)
function startAgentTeamsSession(projectId: string) {
  const project = projectService.getProject(projectId)
  if (!project) return

  spawnAgentSession({
    projectId, project,
    sessionType: 'agent-teams',
    agentIndex: 0,
    prompt: buildAgentTeamsPrompt(project),
    maxTurns: 500,
    startMessage: '🚀 Starting Agent Teams mode — AI will autonomously coordinate multiple sub-agents for full development',
    heartbeat: true,
    heartbeatMessage: 'Agent Teams initializing, please wait...',
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

// ===== Public API =====

// Startup recovery: clean up orphan processes, reset stuck states
export function initRecovery() {
  log.server(`Running startup recovery check...`)
  const projects = projectService.getAllProjects()
  let recovered = 0

  for (const project of projects) {
    // Restore claimedFeatures from claimed.json
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
      // After service restart, processes are gone — clear claims and reset inProgress
      for (const fid of Object.keys(claimedData)) {
        projectService.setFeatureInProgress(project.id, fid, false)
      }
      projectService.saveClaimedFeaturesData(project.id, {})
      log.server(`Cleaned up claimed features for project ${project.name} (${Object.keys(claimedData).length} items)`)
    }

    if (project.status !== 'running' && project.status !== 'initializing' && project.status !== 'reviewing') continue

    log.server(`Found improperly closed project: ${project.name} (${project.id}), status=${project.status}`)

    // Find all running sessions for this project, try to kill orphan processes
    const sessions = projectService.getSessions(project.id)
    for (const session of sessions) {
      if (session.status !== 'running') continue

      if (session.pid && isProcessAlive(session.pid)) {
        log.server(`Killing orphan agent process PID=${session.pid} (session=${session.id.slice(0, 8)})`)
        killProcessTree(session.pid)
      }

      // Mark session as stopped
      projectService.updateSession(project.id, session.id, {
        status: 'stopped',
        endedAt: new Date().toISOString(),
      })
    }

    // Reset project status to paused
    projectService.updateProject(project.id, { status: 'paused' })
    log.server(`Project ${project.name} status reset to paused`)
    recovered++
  }

  if (recovered > 0) {
    log.server(`Recovery complete: ${recovered} projects reset`)
  } else {
    log.server(`No recovery needed, all projects in normal state`)
  }
}

export function startAgent(projectId: string) {
  const existingAgents = runningAgents.get(projectId)
  if (existingAgents && existingAgents.size > 0) {
    throw new Error('Agent is already running')
  }

  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Project not found')

  log.agent(`Starting agent (project=${projectId}, model=${project.model}, concurrency=${project.concurrency}, agentTeams=${project.useAgentTeams})`)

  // Check if already initialized
  const sessions = projectService.getSessions(projectId)
  const hasInitialized = sessions.some((s) => s.type === 'initializer' && s.status === 'completed')

  // Agent Teams mode
  if (project.useAgentTeams) {
    // If review is needed and not yet initialized, run initializer first to generate feature list
    if (project.reviewBeforeCoding && !hasInitialized) {
      log.agent(`Agent Teams + review mode: starting architecture analysis first`)
      applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: false }))
      startFeatureWatcher(projectId)
      startSession(projectId, 'architecture', 0)
      return
    }
    applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: true }))
    startFeatureWatcher(projectId)
    startAgentTeamsSession(projectId)
    return
  }

  startFeatureWatcher(projectId)

  if (!hasInitialized) {
    log.agent(`Project not initialized, starting architecture analysis`)
    applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: false }))
    startSession(projectId, 'architecture', 0)
    return
  }

  applyTransition(projectId, transition(project.status, { type: 'START', hasInitialized: true }))

  const concurrency = project.concurrency || 1

  if (concurrency <= 1) {
    log.agent(`Serial mode, starting single coding session`)
    startSession(projectId, 'coding', 0)
  } else {
    const features = getUnfinishedFeatures(projectId)
    const agentCount = Math.min(concurrency, features.length)
    log.agent(`Parallel mode: ${agentCount} agents, ${features.length} features remaining`)

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
    // Normal path: process references exist in memory
    log.agent(`Stopping all agents (project=${projectId}, count=${agents.size})`)
    for (const [, agent] of agents) {
      agent.stopped = true
      agent.process.kill('SIGTERM')

      const proc = agent.process
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Process may have already exited
        }
      }, SIGKILL_DELAY_MS)
    }
  } else {
    // Recovery path: no process in memory after restart, but project status is still running
    // Try to kill orphan processes using PIDs saved in sessions
    const project = projectService.getProject(projectId)
    if (project && (project.status === 'running' || project.status === 'initializing' || project.status === 'reviewing')) {
      log.agent(`No process references in memory, cleaning up orphan processes via PID (project=${projectId})`)
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
      log.agent(`Orphan processes cleaned up, project status reset to paused`)
    }
  }

  claimedFeatures.delete(projectId)
  // Clear retry counts for this project
  for (const key of featureRetryCount.keys()) {
    if (key.startsWith(`${projectId}:`)) featureRetryCount.delete(key)
  }
  projectService.saveClaimedFeaturesData(projectId, {})
  // Clear inProgress flags on all features
  const features = projectService.getFeatures(projectId)
  for (const f of features) {
    if (f.inProgress) projectService.setFeatureInProgress(projectId, f.id, false)
  }
  gitLocks.delete(projectId)
  stopFeatureWatcher(projectId)
}

export function isRunning(projectId: string): boolean {
  // Check in-memory processes
  const agents = runningAgents.get(projectId)
  if (agents && agents.size > 0) return true
  // Also check persisted state (memory is empty after restart but project may still be marked as running)
  const project = projectService.getProject(projectId)
  return project?.status === 'running' || project?.status === 'initializing' || project?.status === 'reviewing'
}

export function getActiveAgentCount(projectId: string): number {
  return runningAgents.get(projectId)?.size || 0
}

// Start append initializer (additional requirements)
export function startAppendInitializer(projectId: string, appendSpec: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Project not found')

  log.agent(`Starting append initializer (project=${projectId})`)

  // Append spec to app_spec.txt
  const specPath = path.join(project.projectDir, 'app_spec.txt')
  const separator = '\n\n---\n\n# Additional Requirements\n\n'
  fs.appendFileSync(specPath, separator + appendSpec)
  projectService.updateProject(projectId, { spec: project.spec + separator + appendSpec })

  startFeatureWatcher(projectId)

  spawnAgentSession({
    projectId, project,
    sessionType: 'initializer',
    agentIndex: 99,
    prompt: buildAppendInitializerPrompt(project, appendSpec),
    maxTurns: 100,
    startMessage: '📝 Starting incremental requirement breakdown...',
    onClose({ endStatus }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })
      log.agent(`Append initializer ended (status=${endStatus}, features=${progress.total})`)
    },
  })
}

// Build review prompt
function buildReviewPrompt(selectedFeatures: { id: string; category: string; description: string; steps: string[] }[], instruction: string): string {
  let template = loadPrompt('review-features')
  const summary = selectedFeatures.map(f =>
    `- [${f.id}] ${f.category}: ${f.description}\n  Steps: ${f.steps.join('; ')}`
  ).join('\n')
  template = template.replace('{{SELECTED_FEATURES}}', summary)
  template = template.replace('{{INSTRUCTION}}', instruction)
  return template
}

// Start review modification session
export function startReviewSession(projectId: string, featureIds: string[], instruction: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Project not found')

  const features = projectService.getFeatures(projectId)
  const selected = features.filter(f => featureIds.includes(f.id))
  if (selected.length === 0) throw new Error('No features selected')

  log.agent(`Starting review session (project=${projectId}, features=${selected.length})`)

  spawnAgentSession({
    projectId, project,
    sessionType: 'initializer',
    agentIndex: 98,
    prompt: buildReviewPrompt(selected, instruction),
    maxTurns: 100,
    startMessage: `🔍 Starting feature review (${selected.length} features)...`,
    onClose({ endStatus }) {
      projectService.syncFeaturesFromDisk(projectId)
      const progress = projectService.getProgress(projectId)
      broadcast({ type: 'progress', projectId, progress })
      broadcast({ type: 'features_sync', projectId, features: projectService.getFeatures(projectId) })
      log.agent(`Review session ended (status=${endStatus}, features=${progress.total})`)
    },
  })
}

// Confirm review and start coding
// ===== Export pure functions for testing =====
export { textSimilarity, parseThinkingContent }

export function confirmReview(projectId: string) {
  const project = projectService.getProject(projectId)
  if (!project) throw new Error('Project not found')
  if (project.status !== 'reviewing') throw new Error('Project is not in review state')

  log.agent(`Review confirmed, starting coding (project=${projectId})`)

  applyTransition(projectId, transition('reviewing', { type: 'REVIEW_CONFIRMED' }))
  startFeatureWatcher(projectId)

  // Agent Teams mode: start agent-teams session after review confirmation
  if (project.useAgentTeams) {
    log.agent(`Agent Teams mode, starting agent-teams session after review confirmation`)
    startAgentTeamsSession(projectId)
    return
  }

  const concurrency = project.concurrency || 1
  if (concurrency <= 1) {
    log.agent(`Serial mode, starting single coding session`)
    startSession(projectId, 'coding', 0)
  } else {
    const features = getUnfinishedFeatures(projectId)
    const agentCount = Math.min(concurrency, features.length)
    log.agent(`Parallel mode: ${agentCount} agents, ${features.length} features remaining`)

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
