import express from 'express'
import path from 'path'
import url from 'url'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import apiRouter from './routes/api.js'
import { setBroadcast, initRecovery } from './services/agent.js'
import { log } from './lib/logger.js'
import type { BroadcastMessage } from './types.js'

const app = express()
const server = createServer(app)

// WebSocket 服务
const wss = new WebSocketServer({ server, path: '/ws' })

const clients = new Set<WebSocket>()

wss.on('connection', (ws, req) => {
  // WebSocket Token 认证
  const token = process.env.AUTODEV_TOKEN
  if (token) {
    const parsed = url.parse(req.url || '', true)
    if (parsed.query.token !== token) {
      ws.close(1008, 'Unauthorized')
      return
    }
  }

  ;(ws as any).isAlive = true
  ws.on('pong', () => { (ws as any).isAlive = true })

  clients.add(ws)
  log.ws(`客户端连接，当前 ${clients.size} 个`)

  ws.on('close', () => {
    clients.delete(ws)
    log.ws(`客户端断开，当前 ${clients.size} 个`)
  })
})

// 心跳检测：每 30 秒 ping，10 秒内无 pong 则终止
const heartbeatInterval = setInterval(() => {
  for (const ws of clients) {
    if (!(ws as any).isAlive) {
      log.ws('心跳超时，终止连接')
      clients.delete(ws)
      ws.terminate()
      continue
    }
    ;(ws as any).isAlive = false
    ws.ping()
  }
}, 30_000)

server.on('close', () => {
  clearInterval(heartbeatInterval)
})

// 广播函数
function broadcast(msg: BroadcastMessage) {
  const data = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

// 注入广播函数到 agent 服务
setBroadcast(broadcast)

// 启动恢复：清理孤儿进程，重置卡住的项目状态
initRecovery()

// 中间件
app.use(express.json({ limit: '10mb' }))

// API 路由
app.use('/api', apiRouter)

// 托管前端静态资源
const publicDir = path.join(import.meta.dirname, '..', 'public')
app.use(express.static(publicDir))
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'))
})

// 启动服务
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`
  log.server(`AutoDev Server 运行在 ${url}`)
  log.server(`WebSocket 监听 ws://localhost:${PORT}/ws`)
})
