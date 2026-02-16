import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import * as projectService from '../services/project.js'
import * as agentService from '../services/agent.js'
import { getProviderSummaries } from '../providers/registry.js'
import { log } from '../lib/logger.js'

const router = Router()

// Token auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = process.env.AUTODEV_TOKEN
  if (!token) return next() // Skip auth if not set

  // Get token from Authorization header or query param
  const authHeader = req.headers.authorization
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const queryToken = req.query.token as string | undefined

  if (headerToken === token || queryToken === token) {
    return next()
  }

  res.status(401).json({ error: 'Unauthorized' })
}

router.use(authMiddleware)

// Get project list
router.get('/projects', (_req, res) => {
  const projects = projectService.getAllProjects()
  log.api(`GET /projects — returning ${projects.length} projects`)
  const result = projects.map((p) => ({
    ...p,
    features: projectService.getFeatures(p.id),
    sessions: projectService.getSessions(p.id),
    progress: projectService.getProgress(p.id),
  }))
  res.json(result)
})

// Get project details
router.get('/projects/:id', (req, res) => {
  log.api(`GET /projects/${req.params.id}`)
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: 'Project not found' })

  res.json({
    ...project,
    features: projectService.getFeatures(project.id),
    sessions: projectService.getSessions(project.id),
    progress: projectService.getProgress(project.id),
  })
})

// Get available AI providers
router.get('/providers', (_req, res) => {
  res.json(getProviderSummaries())
})

// Check directory content
router.post('/check-dir', (req, res) => {
  const { path: dirPath } = req.body
  if (!dirPath) return res.status(400).json({ message: 'Path is required' })
  if (!projectService.isPathSafe(dirPath)) {
    return res.status(400).json({ error: 'Path is not within allowed range' })
  }
  const result = projectService.checkDir(dirPath)
  res.json(result)
})

// Create project
router.post('/projects', (req, res) => {
  const { name, spec, path: dirPath, forceClean, model, concurrency, useAgentTeams, systemPrompt, reviewArchitecture, reviewBeforeCoding, verifyCommand, provider, providerSettings } = req.body
  if (!name || !spec) {
    return res.status(400).json({ message: 'Name and spec are required' })
  }

  log.api(`POST /projects — creating project: ${name} (path=${dirPath || '(auto)'}, provider=${provider || 'claude'}, model=${model}, concurrency=${concurrency || 1}, agentTeams=${!!useAgentTeams})`)
  const project = projectService.createProject({
    name, spec, model, concurrency, useAgentTeams, systemPrompt,
    reviewArchitecture, reviewBeforeCoding, verifyCommand, projectDir: dirPath, forceClean, provider, providerSettings,
  })
  res.json({
    ...project,
    features: [],
    sessions: [],
    progress: { total: 0, passed: 0, percentage: 0 },
  })
})

// Import existing project
router.post('/projects/import', (req, res) => {
  const { name, path: dirPath, taskPrompt, model, concurrency, useAgentTeams, systemPrompt, reviewArchitecture, reviewBeforeCoding, verifyCommand, provider, providerSettings } = req.body
  if (!name || !dirPath) {
    return res.status(400).json({ message: 'Name and directory path are required' })
  }

  log.api(`POST /projects/import — importing project: ${name} (path=${dirPath}, agentTeams=${!!useAgentTeams})`)
  try {
    const project = projectService.importProject({
      name, dirPath, model, concurrency, useAgentTeams, systemPrompt,
      reviewArchitecture, reviewBeforeCoding, verifyCommand, taskPrompt, provider, providerSettings,
    })
    res.json({
      ...project,
      features: [],
      sessions: [],
      progress: { total: 0, passed: 0, percentage: 0 },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Import failed'
    log.error(`Failed to import project: ${message}`)
    res.status(400).json({ message })
  }
})

// Start agent
router.post('/projects/:id/start', (req, res) => {
  log.api(`POST /projects/${req.params.id}/start — starting agent`)
  try {
    agentService.startAgent(req.params.id)
    res.json({ message: 'Agent started' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Start failed'
    log.error(`Failed to start agent (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// Stop agent
router.post('/projects/:id/stop', (req, res) => {
  log.api(`POST /projects/${req.params.id}/stop — stopping agent`)
  agentService.stopAgent(req.params.id)
  res.json({ message: 'Agent stopped' })
})

// Delete project
router.delete('/projects/:id', (req, res) => {
  const id = req.params.id
  log.api(`DELETE /projects/${id} — deleting project`)
  // Stop running agent first
  if (agentService.isRunning(id)) {
    log.api(`Project ${id} has running agent, stopping first`)
    agentService.stopAgent(id)
  }
  const deleted = projectService.deleteProject(id)
  if (!deleted) return res.status(404).json({ message: 'Project not found' })
  res.json({ message: 'Project deleted' })
})

// Get feature list
router.get('/projects/:id/features', (req, res) => {
  const features = projectService.syncFeaturesFromDisk(req.params.id)
  res.json(features)
})

// Get session history
router.get('/projects/:id/sessions', (req, res) => {
  const sessions = projectService.getSessions(req.params.id)
  res.json(sessions)
})

// Get historical logs
router.get('/projects/:id/logs', (req, res) => {
  const logs = projectService.getLogs(req.params.id)
  log.api(`GET /projects/${req.params.id}/logs — returning ${logs.length} log entries`)
  res.json(logs)
})

// Get raw claude log file for a session (for debugging)
router.get('/projects/:id/sessions/:sessionId/raw-log', (req, res) => {
  const sessions = projectService.getSessions(req.params.id)
  const session = sessions.find((s) => s.id === req.params.sessionId)
  if (!session) return res.status(404).json({ message: 'Session not found' })
  if (!session.logFile) return res.status(404).json({ message: 'No log file for this session' })

  // Path sandbox: log files must be under .autodev-data/claude-logs/
  const resolvedLog = path.resolve(session.logFile)
  const allowedLogDir = path.resolve(path.join('.autodev-data', 'claude-logs'))
  if (!resolvedLog.startsWith(allowedLogDir + path.sep) && resolvedLog !== allowedLogDir) {
    return res.status(400).json({ error: 'Path is not within allowed range' })
  }

  if (!fs.existsSync(session.logFile)) {
    return res.status(404).json({ message: 'Log file not found' })
  }

  // Return last 200KB of content (to avoid oversized responses)
  const stat = fs.statSync(session.logFile)
  const maxBytes = 200 * 1024
  const start = Math.max(0, stat.size - maxBytes)
  const stream = fs.createReadStream(session.logFile, { start })
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  stream.pipe(res)
})

// Get pending human help requests
router.get('/projects/:id/help-requests', (req, res) => {
  const requests = projectService.getHelpRequests(req.params.id)
  const pending = requests.filter((r) => r.status === 'pending')
  log.api(`GET /projects/${req.params.id}/help-requests — ${pending.length} pending`)
  res.json(pending)
})

// Submit human help response
router.post('/projects/:id/help-response', (req, res) => {
  const { requestId, response } = req.body
  if (!requestId || !response) {
    return res.status(400).json({ message: 'Request ID and response are required' })
  }
  log.api(`POST /projects/${req.params.id}/help-response — responding to request ${requestId}`)
  const resolved = projectService.resolveHelpRequest(req.params.id, requestId, response)
  if (!resolved) return res.status(404).json({ message: 'Request not found' })

  // Auto-restart agent after human response (if not currently running)
  const project = projectService.getProject(req.params.id)
  if (project && !agentService.isRunning(req.params.id) && project.status !== 'completed') {
    log.api(`Auto-restarting agent after human response (project=${req.params.id})`)
    try {
      agentService.startAgent(req.params.id)
    } catch (err) {
      log.api(`Auto-restart failed: ${err}`)
    }
  }

  res.json(resolved)
})

// Update system prompt
router.put('/projects/:id/system-prompt', (req, res) => {
  const { systemPrompt } = req.body
  if (typeof systemPrompt !== 'string') {
    return res.status(400).json({ message: 'systemPrompt must be a string' })
  }
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: 'Project not found' })

  log.api(`PUT /projects/${req.params.id}/system-prompt — updating system prompt`)
  const updated = projectService.updateProject(req.params.id, { systemPrompt })
  if (!updated) return res.status(500).json({ message: 'Update failed' })

  res.json({
    ...updated,
    features: projectService.getFeatures(updated.id),
    sessions: projectService.getSessions(updated.id),
    progress: projectService.getProgress(updated.id),
  })
})

// Append requirements
router.post('/projects/:id/append-spec', (req, res) => {
  const { spec } = req.body
  if (!spec || !spec.trim()) {
    return res.status(400).json({ message: 'Appended spec content is required' })
  }
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: 'Project not found' })

  log.api(`POST /projects/${req.params.id}/append-spec — appending spec`)
  try {
    agentService.startAppendInitializer(req.params.id, spec.trim())
    res.json({ message: 'Spec append started' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Append failed'
    log.error(`Failed to append spec (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// Review and modify features
router.post('/projects/:id/review-features', (req, res) => {
  const { featureIds, instruction } = req.body
  if (!featureIds?.length || !instruction?.trim()) {
    return res.status(400).json({ message: 'Please select features and enter modification instructions' })
  }
  log.api(`POST /projects/${req.params.id}/review-features — reviewing ${featureIds.length} features`)
  try {
    agentService.startReviewSession(req.params.id, featureIds, instruction.trim())
    res.json({ message: 'Review modification started' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Review modification failed'
    log.error(`Review modification failed (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// Confirm review and start coding
router.post('/projects/:id/confirm-review', (req, res) => {
  log.api(`POST /projects/${req.params.id}/confirm-review — confirming review and starting coding`)
  try {
    agentService.confirmReview(req.params.id)
    res.json({ message: 'Coding started' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to start coding'
    log.error(`Confirm review failed (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

export default router
