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

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' })

const clients = new Set<WebSocket>()

wss.on('connection', (ws, req) => {
  // WebSocket token auth
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
  log.ws(`Client connected, ${clients.size} total`)

  ws.on('close', () => {
    clients.delete(ws)
    log.ws(`Client disconnected, ${clients.size} total`)
  })
})

// Heartbeat: ping every 30s, terminate if no pong within 10s
const heartbeatInterval = setInterval(() => {
  for (const ws of clients) {
    if (!(ws as any).isAlive) {
      log.ws('Heartbeat timeout, terminating connection')
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

// Broadcast function
function broadcast(msg: BroadcastMessage) {
  const data = JSON.stringify(msg)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

// Inject broadcast function into agent service
setBroadcast(broadcast)

// Startup recovery: clean up orphan processes, reset stuck project states
initRecovery()

// Middleware
app.use(express.json({ limit: '10mb' }))

// API routes
app.use('/api', apiRouter)

// Serve frontend static assets
const publicDir = path.join(import.meta.dirname, '..', 'public')
app.use(express.static(publicDir))
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'))
})

// Start server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`
  log.server(`AutoDev Server running at ${url}`)
  log.server(`WebSocket listening on ws://localhost:${PORT}/ws`)
})
