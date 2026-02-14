import { useState, useEffect, useCallback } from 'react'
import { MessageCircleWarning, Send, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useStore } from '@/store'
import type { HelpRequest } from '@/types'

interface Props {
  projectId: string
  projectName: string
}

// 发送浏览器桌面通知
function sendDesktopNotification(title: string, body: string) {
  if (!('Notification' in window)) return
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/vite.svg', tag: 'autodev-help' })
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') {
        new Notification(title, { body, icon: '/vite.svg', tag: 'autodev-help' })
      }
    })
  }
}

export function HelpDialog({ projectId, projectName }: Props) {
  const helpRequests = useStore((s) => s.helpRequests[projectId] || [])
  const resolveHelpRequest = useStore((s) => s.resolveHelpRequest)
  const [response, setResponse] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [notifiedIds, setNotifiedIds] = useState<Set<string>>(new Set())

  // 当前待处理的请求（取第一个）
  const current: HelpRequest | undefined = helpRequests[0]

  // 请求通知权限（页面加载时）
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // 新请求到达时发送桌面通知
  useEffect(() => {
    if (!current || notifiedIds.has(current.id)) return
    sendDesktopNotification(
      `Agent 需要帮助 — ${projectName}`,
      current.message.slice(0, 120)
    )
    setNotifiedIds((prev) => new Set(prev).add(current.id))
  }, [current, projectName, notifiedIds])

  const handleSubmit = useCallback(async () => {
    if (!current || !response.trim()) return
    setSubmitting(true)
    try {
      await api.submitHelpResponse(projectId, current.id, response.trim())
      resolveHelpRequest(projectId, current.id)
      setResponse('')
    } catch (err) {
      console.error('提交回复失败:', err)
    } finally {
      setSubmitting(false)
    }
  }, [current, response, projectId, resolveHelpRequest])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  if (!current) return null

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-[540px]" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleWarning className="h-5 w-5 text-amber-400" />
            Agent 请求人工协助
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Agent {current.agentIndex} &middot; {new Date(current.createdAt).toLocaleTimeString('zh-CN')}
            {helpRequests.length > 1 && (
              <span className="ml-2 text-amber-400">还有 {helpRequests.length - 1} 个待处理</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Agent 的问题 */}
        <div className="bg-secondary/50 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {current.message}
        </div>

        {/* 用户回复输入 */}
        <div className="space-y-2">
          <label className="text-sm font-medium">你的回复</label>
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入提示词或指导信息..."
            className="w-full min-h-[100px] rounded-lg border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            回复将写入项目目录的 .human-response.md，Agent 可在后续操作中读取。按 Ctrl+Enter 提交。
          </p>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !response.trim()}
            className="gap-2 cursor-pointer"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            提交回复
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
