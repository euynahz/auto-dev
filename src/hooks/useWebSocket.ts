import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '@/store'
import { api } from '@/lib/api'
import type { WSMessage } from '@/types'

const BASE_DELAY = 3000
const MAX_DELAY = 30000

// WebSocket 连接 hook
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
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => {
      console.log('[WS] 已连接')
      setWsConnected(true)

      // 重连成功：重置退避计数，拉取最新项目状态
      if (retriesRef.current > 0) {
        console.log('[WS] 重连成功，刷新项目状态')
        api.getProjects().then(setProjects).catch((e) => {
          console.error('[WS] 刷新项目状态失败:', e)
        })
      }
      retriesRef.current = 0
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
      setWsConnected(false)
      const delay = Math.min(BASE_DELAY * Math.pow(2, retriesRef.current), MAX_DELAY)
      retriesRef.current++
      console.log(`[WS] 连接断开，${delay / 1000}s 后重连 (第${retriesRef.current}次)`)
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = (err) => {
      console.error('[WS] 错误:', err)
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
