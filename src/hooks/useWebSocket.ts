import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '@/store'
import { api } from '@/lib/api'
import type { WSMessage } from '@/types'

const BASE_DELAY = 3000
const MAX_DELAY = 30000

// WebSocket connection hook
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retriesRef = useRef(0)
  const setWsConnected = useStore((s) => s.setWsConnected)
  const handleWSMessage = useStore((s) => s.handleWSMessage)
  const setProjects = useStore((s) => s.setProjects)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    let wsUrl = `${protocol}//${window.location.host}/ws`
    // Pass token auth (from URL params or localStorage)
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) wsUrl += `?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('[WS] Connected')
      setWsConnected(true)

      // Reconnect success: reset backoff counter, fetch latest project state
      if (retriesRef.current > 0) {
        console.log('[WS] Reconnected, refreshing project state')
        api.getProjects().then(setProjects).catch((e) => {
          console.error('[WS] Failed to refresh project state:', e)
        })
      }
      retriesRef.current = 0
    }

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        handleWSMessage(msg)
      } catch (e) {
        console.error('[WS] Failed to parse message:', e)
      }
    }

    ws.onclose = () => {
      setWsConnected(false)
      const delay = Math.min(BASE_DELAY * Math.pow(2, retriesRef.current), MAX_DELAY)
      retriesRef.current++
      console.log(`[WS] Disconnected, reconnecting in ${delay / 1000}s (attempt ${retriesRef.current})`)
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = (err) => {
      console.error('[WS] Error:', err)
      ws.close()
    }

    wsRef.current = ws
  }, [setWsConnected, handleWSMessage, setProjects])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return wsRef
}
