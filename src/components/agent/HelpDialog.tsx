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

// Send browser desktop notification
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
  const [open, setOpen] = useState(true)

  // Current pending request (first one)
  const current: HelpRequest | undefined = helpRequests[0]

  // Request notification permission (on page load)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Send desktop notification & auto-open when new request arrives
  useEffect(() => {
    if (!current || notifiedIds.has(current.id)) return
    sendDesktopNotification(
      `Agent Needs Help — ${projectName}`,
      current.message.slice(0, 120)
    )
    setNotifiedIds((prev) => new Set(prev).add(current.id))
    setOpen(true)
  }, [current, projectName, notifiedIds])

  const handleSubmit = useCallback(async () => {
    if (!current || !response.trim()) return
    setSubmitting(true)
    try {
      await api.submitHelpResponse(projectId, current.id, response.trim())
      resolveHelpRequest(projectId, current.id)
      setResponse('')
    } catch (err) {
      console.error('Submit response failed:', err)
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

  // Show floating badge when dialog is closed
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-amber-600 transition-colors cursor-pointer animate-pulse"
      >
        <MessageCircleWarning className="h-4 w-4" />
        {helpRequests.length} pending requests
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircleWarning className="h-5 w-5 text-amber-400" />
            Agent Requests Assistance
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Agent {current.agentIndex} &middot; {new Date(current.createdAt).toLocaleTimeString('en-US')}
            {helpRequests.length > 1 && (
              <span className="ml-2 text-amber-400">{helpRequests.length - 1} more pending</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Agent's question */}
        <div className="bg-secondary/50 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
          {current.message}
        </div>

        {/* User response input */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Your Response</label>
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter hints or guidance..."
            className="w-full min-h-[100px] rounded-lg border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Your response will be written to .human-response.md in the project directory. The Agent can read it in subsequent operations. Press Ctrl+Enter to submit.
          </p>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !response.trim()}
            className="gap-2 cursor-pointer"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit Response
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
