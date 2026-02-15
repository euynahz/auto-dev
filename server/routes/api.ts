import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import * as projectService from '../services/project.js'
import * as agentService from '../services/agent.js'
import { getProviderSummaries } from '../providers/registry.js'
import { log } from '../lib/logger.js'

const router = Router()

// Token 认证中间件
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = process.env.AUTODEV_TOKEN
  if (!token) return next() // 未设置则跳过认证

  // 从 Authorization header 或查询参数获取 token
  const authHeader = req.headers.authorization
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const queryToken = req.query.token as string | undefined

  if (headerToken === token || queryToken === token) {
    return next()
  }

  res.status(401).json({ error: 'Unauthorized' })
}

router.use(authMiddleware)

// 获取项目列表
router.get('/projects', (_req, res) => {
  const projects = projectService.getAllProjects()
  log.api(`GET /projects — 返回 ${projects.length} 个项目`)
  const result = projects.map((p) => ({
    ...p,
    features: projectService.getFeatures(p.id),
    sessions: projectService.getSessions(p.id),
    progress: projectService.getProgress(p.id),
  }))
  res.json(result)
})

// 获取项目详情
router.get('/projects/:id', (req, res) => {
  log.api(`GET /projects/${req.params.id}`)
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: '项目不存在' })

  res.json({
    ...project,
    features: projectService.getFeatures(project.id),
    sessions: projectService.getSessions(project.id),
    progress: projectService.getProgress(project.id),
  })
})

// 获取可用 AI providers
router.get('/providers', (_req, res) => {
  res.json(getProviderSummaries())
})

// 检查目录内容
router.post('/check-dir', (req, res) => {
  const { path: dirPath } = req.body
  if (!dirPath) return res.status(400).json({ message: '路径不能为空' })
  if (!projectService.isPathSafe(dirPath)) {
    return res.status(400).json({ error: '路径不在允许范围内' })
  }
  const result = projectService.checkDir(dirPath)
  res.json(result)
})

// 创建项目
router.post('/projects', (req, res) => {
  const { name, spec, path: dirPath, forceClean, model, concurrency, useAgentTeams, systemPrompt, reviewBeforeCoding, provider } = req.body
  if (!name || !spec) {
    return res.status(400).json({ message: '名称和需求描述不能为空' })
  }

  log.api(`POST /projects — 创建项目: ${name} (path=${dirPath || '(auto)'}, provider=${provider || 'claude'}, model=${model}, concurrency=${concurrency || 1}, agentTeams=${!!useAgentTeams})`)
  const project = projectService.createProject(name, spec, model, concurrency, useAgentTeams, systemPrompt, reviewBeforeCoding, dirPath, forceClean, provider)
  res.json({
    ...project,
    features: [],
    sessions: [],
    progress: { total: 0, passed: 0, percentage: 0 },
  })
})

// 导入已有项目
router.post('/projects/import', (req, res) => {
  const { name, path: dirPath, taskPrompt, model, concurrency, useAgentTeams, systemPrompt, reviewBeforeCoding, provider } = req.body
  if (!name || !dirPath) {
    return res.status(400).json({ message: '名称和目录路径不能为空' })
  }

  log.api(`POST /projects/import — 导入项目: ${name} (path=${dirPath}, agentTeams=${!!useAgentTeams})`)
  try {
    const project = projectService.importProject(name, dirPath, model, concurrency, useAgentTeams, systemPrompt, reviewBeforeCoding, taskPrompt, provider)
    res.json({
      ...project,
      features: [],
      sessions: [],
      progress: { total: 0, passed: 0, percentage: 0 },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '导入失败'
    log.error(`导入项目失败: ${message}`)
    res.status(400).json({ message })
  }
})

// 启动 Agent
router.post('/projects/:id/start', (req, res) => {
  log.api(`POST /projects/${req.params.id}/start — 启动 Agent`)
  try {
    agentService.startAgent(req.params.id)
    res.json({ message: 'Agent 已启动' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '启动失败'
    log.error(`启动 Agent 失败 (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// 停止 Agent
router.post('/projects/:id/stop', (req, res) => {
  log.api(`POST /projects/${req.params.id}/stop — 停止 Agent`)
  agentService.stopAgent(req.params.id)
  res.json({ message: 'Agent 已停止' })
})

// 删除项目
router.delete('/projects/:id', (req, res) => {
  const id = req.params.id
  log.api(`DELETE /projects/${id} — 删除项目`)
  // 先停止运行中的 Agent
  if (agentService.isRunning(id)) {
    log.api(`项目 ${id} 有运行中的 Agent，先停止`)
    agentService.stopAgent(id)
  }
  const deleted = projectService.deleteProject(id)
  if (!deleted) return res.status(404).json({ message: '项目不存在' })
  res.json({ message: '项目已删除' })
})

// 获取 feature list
router.get('/projects/:id/features', (req, res) => {
  const features = projectService.syncFeaturesFromDisk(req.params.id)
  res.json(features)
})

// 获取 session 历史
router.get('/projects/:id/sessions', (req, res) => {
  const sessions = projectService.getSessions(req.params.id)
  res.json(sessions)
})

// 获取历史日志
router.get('/projects/:id/logs', (req, res) => {
  const logs = projectService.getLogs(req.params.id)
  log.api(`GET /projects/${req.params.id}/logs — 返回 ${logs.length} 条日志`)
  res.json(logs)
})

// 获取 session 的 claude 原始日志文件（用于调试）
router.get('/projects/:id/sessions/:sessionId/raw-log', (req, res) => {
  const sessions = projectService.getSessions(req.params.id)
  const session = sessions.find((s) => s.id === req.params.sessionId)
  if (!session) return res.status(404).json({ message: 'Session 不存在' })
  if (!session.logFile) return res.status(404).json({ message: '该 Session 无日志文件' })

  // 路径沙箱：日志文件必须在 .autodev-data/claude-logs/ 目录下
  const resolvedLog = path.resolve(session.logFile)
  const allowedLogDir = path.resolve(path.join('.autodev-data', 'claude-logs'))
  if (!resolvedLog.startsWith(allowedLogDir + path.sep) && resolvedLog !== allowedLogDir) {
    return res.status(400).json({ error: '路径不在允许范围内' })
  }

  if (!fs.existsSync(session.logFile)) {
    return res.status(404).json({ message: '日志文件不存在' })
  }

  // 返回最后 200KB 内容（避免文件过大）
  const stat = fs.statSync(session.logFile)
  const maxBytes = 200 * 1024
  const start = Math.max(0, stat.size - maxBytes)
  const stream = fs.createReadStream(session.logFile, { start })
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  stream.pipe(res)
})

// 获取待处理的人工协助请求
router.get('/projects/:id/help-requests', (req, res) => {
  const requests = projectService.getHelpRequests(req.params.id)
  const pending = requests.filter((r) => r.status === 'pending')
  log.api(`GET /projects/${req.params.id}/help-requests — ${pending.length} 个待处理`)
  res.json(pending)
})

// 提交人工协助回复
router.post('/projects/:id/help-response', (req, res) => {
  const { requestId, response } = req.body
  if (!requestId || !response) {
    return res.status(400).json({ message: '请求 ID 和回复内容不能为空' })
  }
  log.api(`POST /projects/${req.params.id}/help-response — 回复请求 ${requestId}`)
  const resolved = projectService.resolveHelpRequest(req.params.id, requestId, response)
  if (!resolved) return res.status(404).json({ message: '请求不存在' })

  // 人工回复后自动重启 Agent（如果当前未运行）
  const project = projectService.getProject(req.params.id)
  if (project && !agentService.isRunning(req.params.id) && project.status !== 'completed') {
    log.api(`人工回复后自动重启 Agent (project=${req.params.id})`)
    try {
      agentService.startAgent(req.params.id)
    } catch (err) {
      log.api(`自动重启失败: ${err}`)
    }
  }

  res.json(resolved)
})

// 更新系统提示词
router.put('/projects/:id/system-prompt', (req, res) => {
  const { systemPrompt } = req.body
  if (typeof systemPrompt !== 'string') {
    return res.status(400).json({ message: 'systemPrompt 必须是字符串' })
  }
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: '项目不存在' })

  log.api(`PUT /projects/${req.params.id}/system-prompt — 更新系统提示词`)
  const updated = projectService.updateProject(req.params.id, { systemPrompt })
  if (!updated) return res.status(500).json({ message: '更新失败' })

  res.json({
    ...updated,
    features: projectService.getFeatures(updated.id),
    sessions: projectService.getSessions(updated.id),
    progress: projectService.getProgress(updated.id),
  })
})

// 追加需求
router.post('/projects/:id/append-spec', (req, res) => {
  const { spec } = req.body
  if (!spec || !spec.trim()) {
    return res.status(400).json({ message: '追加需求内容不能为空' })
  }
  const project = projectService.getProject(req.params.id)
  if (!project) return res.status(404).json({ message: '项目不存在' })

  log.api(`POST /projects/${req.params.id}/append-spec — 追加需求`)
  try {
    agentService.startAppendInitializer(req.params.id, spec.trim())
    res.json({ message: '需求追加已启动' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '追加失败'
    log.error(`追加需求失败 (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// 审查修改 Feature
router.post('/projects/:id/review-features', (req, res) => {
  const { featureIds, instruction } = req.body
  if (!featureIds?.length || !instruction?.trim()) {
    return res.status(400).json({ message: '请选择 Feature 并输入修改指令' })
  }
  log.api(`POST /projects/${req.params.id}/review-features — 审查修改 ${featureIds.length} 个 Feature`)
  try {
    agentService.startReviewSession(req.params.id, featureIds, instruction.trim())
    res.json({ message: '审查修改已启动' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '审查修改失败'
    log.error(`审查修改失败 (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

// 确认审查并开始编码
router.post('/projects/:id/confirm-review', (req, res) => {
  log.api(`POST /projects/${req.params.id}/confirm-review — 确认审查并开始编码`)
  try {
    agentService.confirmReview(req.params.id)
    res.json({ message: '编码已启动' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '启动编码失败'
    log.error(`确认审查失败 (${req.params.id}): ${message}`)
    res.status(400).json({ message })
  }
})

export default router
