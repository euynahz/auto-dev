import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Square, Loader2, Users, Zap, Info, Maximize2, Minimize2, Plus } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ProgressRing } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { FeatureList } from '@/components/project/FeatureList'
import { AgentLog } from '@/components/agent/AgentLog'
import { SessionTimeline } from '@/components/agent/SessionTimeline'
import { HelpDialog } from '@/components/agent/HelpDialog'
import { useStore } from '@/store'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ProjectStatus } from '@/types'

const statusConfig: Record<ProjectStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' }> = {
  idle: { label: 'Idle', variant: 'secondary' },
  initializing: { label: 'Initializing', variant: 'warning' },
  reviewing: { label: 'Reviewing', variant: 'warning' },
  running: { label: 'Running', variant: 'default' },
  paused: { label: 'Paused', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  error: { label: 'Error', variant: 'destructive' },
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>()
  const { currentProject, setCurrentProject, logs, setLogs, agentCounts, setHelpRequests } = useStore()
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [activeAgentTab, setActiveAgentTab] = useState('all')
  const [infoOpen, setInfoOpen] = useState(false)
  const [fullPanel, setFullPanel] = useState<'features' | 'logs' | 'sessions' | null>(null)
  const [appendOpen, setAppendOpen] = useState(false)
  const [appendSpec, setAppendSpec] = useState('')
  const [appendLoading, setAppendLoading] = useState(false)
  const [editingSystemPrompt, setEditingSystemPrompt] = useState('')
  const [systemPromptLoading, setSystemPromptLoading] = useState(false)
  const [systemPromptSaved, setSystemPromptSaved] = useState(false)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [confirmReviewLoading, setConfirmReviewLoading] = useState(false)

  useEffect(() => {
    if (!id) return
    Promise.all([
      api.getProject(id).then(setCurrentProject),
      api.getLogs(id).then((entries) => setLogs(id, entries)),
      api.getHelpRequests(id).then((reqs) => setHelpRequests(id, reqs)),
    ])
      .catch(console.error)
      .finally(() => setLoading(false))
    return () => setCurrentProject(null)
  }, [id, setCurrentProject, setLogs, setHelpRequests])

  const handleStart = async () => {
    if (!id) return
    setActionLoading(true)
    try {
      await api.startAgent(id)
    } catch (err) {
      console.error('Start failed:', err)
    } finally {
      setActionLoading(false)
    }
  }

  const handleStop = async () => {
    if (!id) return
    setActionLoading(true)
    try {
      await api.stopAgent(id)
    } catch (err) {
      console.error('Stop failed:', err)
    } finally {
      setActionLoading(false)
    }
  }

  const handleAppendSpec = async () => {
    if (!id || !appendSpec.trim()) return
    setAppendLoading(true)
    try {
      await api.appendSpec(id, appendSpec.trim())
      setAppendSpec('')
      setAppendOpen(false)
    } catch (err) {
      console.error('Append spec failed:', err)
    } finally {
      setAppendLoading(false)
    }
  }

  const handleSaveSystemPrompt = async () => {
    if (!id) return
    setSystemPromptLoading(true)
    setSystemPromptSaved(false)
    try {
      const updated = await api.updateSystemPrompt(id, editingSystemPrompt)
      setCurrentProject(updated)
      setSystemPromptSaved(true)
    } catch (err) {
      console.error('Save system prompt failed:', err)
    } finally {
      setSystemPromptLoading(false)
    }
  }

  const handleReviewSubmit = async (featureIds: string[], instruction: string) => {
    if (!id) return
    setReviewLoading(true)
    try {
      await api.reviewFeatures(id, featureIds, instruction)
    } catch (err) {
      console.error('Review submit failed:', err)
    } finally {
      setReviewLoading(false)
    }
  }

  const handleConfirmReview = async () => {
    if (!id) return
    setConfirmReviewLoading(true)
    try {
      await api.confirmReview(id)
    } catch (err) {
      console.error('Confirm review failed:', err)
    } finally {
      setConfirmReviewLoading(false)
    }
  }

  const projectLogs = useMemo(() => {
    if (!currentProject) return []
    const allLogs = logs[currentProject.id] || []
    if (activeAgentTab === 'all') return allLogs
    const idx = parseInt(activeAgentTab, 10)
    return allLogs.filter((l) => l.agentIndex === idx)
  }, [logs, currentProject, activeAgentTab])

  const agentIndices = useMemo(() => {
    if (!currentProject) return []
    const concurrency = currentProject.concurrency || 1
    if (concurrency <= 1) return []
    return Array.from({ length: concurrency }, (_, i) => i)
  }, [currentProject])

  const featureAgentMap = useMemo(() => {
    if (!currentProject) return new Map<string, number>()
    const map = new Map<string, number>()
    for (const session of currentProject.sessions) {
      if (session.status === 'running' && session.featureId != null && session.agentIndex != null) {
        map.set(session.featureId, session.agentIndex)
      }
    }
    return map
  }, [currentProject])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading project...</span>
        </div>
      </div>
    )
  }

  if (!currentProject) {
    return (
      <div className="text-center py-16 animate-fade-in-up">
        <p className="text-muted-foreground">Project not found</p>
        <Link to="/" className="text-primary hover:underline mt-2 inline-block">Back to Home</Link>
      </div>
    )
  }

  const project = currentProject
  const config = statusConfig[project.status]
  const isRunning = project.status === 'running' || project.status === 'initializing'
  const isReviewing = project.status === 'reviewing'
  const agentCount = agentCounts[project.id]
  const showAgentTabs = (project.concurrency || 1) > 1

  return (
    <div className="max-w-[1600px] mx-auto overflow-hidden">
      {/* Compact top bar */}
      <div className="flex items-center gap-3 mb-3 animate-fade-in-up">
        <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-secondary/50 cursor-pointer shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <h1 className="text-lg font-bold tracking-tight truncate">{project.name}</h1>
        <Badge variant={config.variant} className={isRunning ? 'animate-pulse' : ''}>
          {isRunning && <span className="relative flex h-1.5 w-1.5 mr-1"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" /></span>}
          {config.label}
        </Badge>
        {showAgentTabs && agentCount && (
          <Badge variant="secondary" className="gap-1">
            <Users className="h-3 w-3" />
            {agentCount.active}/{agentCount.total}
          </Badge>
        )}

        <button onClick={() => { setEditingSystemPrompt(project.systemPrompt || ''); setSystemPromptSaved(false); setInfoOpen(true) }} className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-secondary/50 cursor-pointer shrink-0" title="Project Details">
          <Info className="h-4 w-4" />
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground">
            <span className="font-bold text-foreground">{project.progress.passed}</span>
            <span>/</span>
            <span>{project.progress.total}</span>
          </div>
          <div className="w-24 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${project.progress.percentage}%` }} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setAppendOpen(true)} className="gap-1.5 h-7 cursor-pointer">
            <Plus className="h-3.5 w-3.5" />
            Append Spec
          </Button>
          {isReviewing && (
            <Button size="sm" onClick={handleConfirmReview} disabled={confirmReviewLoading} className="gap-1.5 h-7 cursor-pointer">
              {confirmReviewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Confirm & Start Coding
            </Button>
          )}
          {isRunning ? (
            <Button variant="destructive" size="sm" onClick={handleStop} disabled={actionLoading} className="gap-1.5 h-7 cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={actionLoading || project.status === 'completed'} className="gap-1.5 h-7 cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {project.status === 'idle' ? 'Start' : 'Resume'}
            </Button>
          )}
        </div>
      </div>

      {/* Project info dialog — fullscreen */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-none w-screen h-screen rounded-none sm:rounded-none border-0 flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>{project.name}</DialogTitle>
            <DialogDescription>Project Specification</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto pr-4">
            <div className="prose dark:prose-invert prose-sm max-w-4xl mx-auto [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mb-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1.5 [&_p]:text-sm [&_p]:text-muted-foreground [&_p]:mb-2 [&_p]:leading-relaxed [&_ul]:text-sm [&_ul]:text-muted-foreground [&_ul]:mb-2 [&_ul]:pl-4 [&_ol]:text-sm [&_ol]:text-muted-foreground [&_ol]:mb-2 [&_ol]:pl-4 [&_li]:mb-1 [&_code]:text-xs [&_code]:bg-secondary/50 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-secondary/30 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:text-xs [&_pre]:overflow-x-auto [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground">
              <ReactMarkdown>{project.spec}</ReactMarkdown>
            </div>
            <div className="max-w-4xl mx-auto mt-6 border-t pt-4 space-y-2">
              <label className="text-sm font-medium">System Prompt</label>
              <Textarea
                placeholder="Additional instructions for all Agents, e.g. coding standards, tech stack preferences..."
                value={editingSystemPrompt}
                onChange={(e) => { setEditingSystemPrompt(e.target.value); setSystemPromptSaved(false) }}
                rows={4}
                className="resize-none"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSaveSystemPrompt} disabled={systemPromptLoading} className="cursor-pointer">
                  {systemPromptLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Save
                </Button>
                {systemPromptSaved && <span className="text-xs text-green-500">Saved. Changes will take effect in the next session.</span>}
                <p className="text-xs text-muted-foreground ml-auto">Injected via --system-prompt to all Agents</p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Append spec dialog */}
      <Dialog open={appendOpen} onOpenChange={setAppendOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Append Spec</DialogTitle>
            <DialogDescription>Enter new requirements. The system will automatically break them into features and add them to the task queue.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Describe the features you want to add..."
            value={appendSpec}
            onChange={(e) => setAppendSpec(e.target.value)}
            className="min-h-[160px] resize-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setAppendOpen(false)} className="cursor-pointer">Cancel</Button>
            <Button size="sm" onClick={handleAppendSpec} disabled={appendLoading || !appendSpec.trim()} className="gap-1.5 cursor-pointer">
              {appendLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Submit
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Main content: left-right split */}
      <div className={cn('gap-4', fullPanel ? '' : 'grid grid-cols-1 lg:grid-cols-[380px_1fr]')} style={{ height: 'calc(100vh - 152px)' }}>
        {/* Left: Feature List */}
        {(!fullPanel || fullPanel === 'features') && (
          <Card className={cn('overflow-hidden animate-slide-in-left flex flex-col', fullPanel === 'features' && 'h-full')}>
            <div className="flex items-center justify-between px-3 pt-2 shrink-0">
              <span className="text-sm font-medium">Features</span>
              <button
                onClick={() => setFullPanel(fullPanel === 'features' ? null : 'features')}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary/50 cursor-pointer"
                title={fullPanel === 'features' ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {fullPanel === 'features' ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <FeatureList features={project.features} featureAgentMap={featureAgentMap} reviewMode={isReviewing} onReviewSubmit={handleReviewSubmit} reviewLoading={reviewLoading} isProjectRunning={isRunning} />
            </div>
          </Card>
        )}

        {/* Right: Agent logs + Session timeline */}
        {(!fullPanel || fullPanel === 'logs' || fullPanel === 'sessions') && (
          <div className={cn('flex flex-col gap-4 overflow-hidden animate-slide-in-right', fullPanel && 'h-full')}>
            {(!fullPanel || fullPanel === 'logs') && (
              <div className={cn('flex-1 min-h-0 overflow-hidden', fullPanel === 'logs' && 'h-full')}>
                {showAgentTabs ? (
                  <Tabs value={activeAgentTab} onValueChange={setActiveAgentTab} className="flex flex-col h-full">
                    <TabsList className="shrink-0">
                      <TabsTrigger value="all">All</TabsTrigger>
                      {agentIndices.map((i) => (
                        <TabsTrigger key={i} value={String(i)}>
                          Agent {i}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    <TabsContent value={activeAgentTab} className="flex-1 min-h-0 mt-0">
                      <AgentLog logs={projectLogs} fullscreen={fullPanel === 'logs'} onToggleFullscreen={() => setFullPanel(fullPanel === 'logs' ? null : 'logs')} />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <AgentLog logs={projectLogs} fullscreen={fullPanel === 'logs'} onToggleFullscreen={() => setFullPanel(fullPanel === 'logs' ? null : 'logs')} />
                )}
              </div>
            )}

            {/* Bottom: Session timeline */}
            {(!fullPanel || fullPanel === 'sessions') && (
              <Card className={cn('p-3 animate-fade-in', fullPanel === 'sessions' && 'h-full flex flex-col')} style={{ animationDelay: '200ms' }}>
                <div className="flex items-center gap-2 mb-2 shrink-0">
                  <span className="text-sm font-medium">Session History</span>
                  <span className="text-xs text-muted-foreground font-mono">({project.sessions.length})</span>
                  <button
                    onClick={() => setFullPanel(fullPanel === 'sessions' ? null : 'sessions')}
                    className="ml-auto text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary/50 cursor-pointer"
                    title={fullPanel === 'sessions' ? 'Exit Fullscreen' : 'Fullscreen'}
                  >
                    {fullPanel === 'sessions' ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div className={cn(fullPanel === 'sessions' && 'flex-1 min-h-0')}>
                  <SessionTimeline projectId={project.id} sessions={project.sessions} features={project.features} fullscreen={fullPanel === 'sessions'} />
                </div>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Human assistance dialog */}
      <HelpDialog projectId={project.id} projectName={project.name} />
    </div>
  )
}
