import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '@/store'
import type { WSMessage } from '@/types'

// WebSocket 连接 hook
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setWsConnected = useStore((s) => s.setWsConnected)
  const handleWSMessage = useStore((s) => s.handleWSMessage)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      console.log('[WS] 已连接')
      setWsConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        handleWSMessage(msg)
      } catch (e) {
        console.error('[WS] 解析消息失败:', e)
      }
    }

    ws.onclose = () => {
      console.log('[WS] 连接断开，3秒后重连...')
      setWsConnected(false)
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = (err) => {
      console.error('[WS] 错误:', err)
      ws.close()
    }

    wsRef.current = ws
  }, [setWsConnected, handleWSMessage])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return wsRef
}
