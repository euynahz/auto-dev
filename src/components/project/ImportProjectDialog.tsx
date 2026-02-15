import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, FolderOpen, Rows3, Columns3, ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'
import { useStore } from '@/store'
import { useProviders } from '@/hooks/useProviders'
import { ProviderSettings } from './ProviderSettings'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function extractNameFromPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '').trim()
  return trimmed.split(/[/\\]/).pop() || ''
}

export function ImportProjectDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const addProject = useStore((s) => s.addProject)
  const { providers, getProvider } = useProviders()

  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [provider, setProvider] = useState('claude')
  const [model, setModel] = useState('claude-opus-4-6')
  const [providerSettings, setProviderSettings] = useState<Record<string, unknown>>({})
  const [concurrency, setConcurrency] = useState(1)
  const [useAgentTeams, setUseAgentTeams] = useState(false)
  const [reviewBeforeCoding, setReviewBeforeCoding] = useState(false)
  const [verifyCommand, setVerifyCommand] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [layout, setLayout] = useState<'vertical' | 'horizontal'>('horizontal')
  const [nameManuallySet, setNameManuallySet] = useState(false)

  const currentProvider = getProvider(provider)
  const caps = currentProvider?.capabilities

  const handleProviderChange = useCallback((newProvider: string) => {
    setProvider(newProvider)
    const p = getProvider(newProvider)
    if (p?.defaultModel) setModel(p.defaultModel)
    else setModel('')
    if (!p?.capabilities.agentTeams) setUseAgentTeams(false)
    if (!p?.capabilities.systemPrompt) setSystemPrompt('')
    const defaults: Record<string, unknown> = {}
    p?.settings?.forEach(s => { defaults[s.key] = s.default })
    setProviderSettings(defaults)
  }, [getProvider])

  const handleProviderSettingChange = useCallback((key: string, value: unknown) => {
    setProviderSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleDirPathChange = (value: string) => {
    setDirPath(value)
    if (!nameManuallySet) {
      const extracted = extractNameFromPath(value)
      if (extracted) setName(extracted)
    }
  }

  const handleNameChange = (value: string) => {
    setName(value)
    setNameManuallySet(true)
  }

  const handleImport = async () => {
    if (!name.trim() || !dirPath.trim()) return
    setLoading(true)
    setError('')
    try {
      const hasCustomSettings = Object.keys(providerSettings).length > 0
      const project = await api.importProject({
        name, path: dirPath, taskPrompt: taskPrompt.trim() || undefined,
        provider, model: model.trim() || undefined,
        ...(hasCustomSettings ? { providerSettings } : {}),
        concurrency, useAgentTeams,
        systemPrompt: systemPrompt.trim() || undefined,
        reviewBeforeCoding: reviewBeforeCoding || undefined,
        verifyCommand: verifyCommand.trim() || undefined,
      })
      addProject(project)
      onOpenChange(false)
      setName(''); setDirPath(''); setTaskPrompt(''); setError(''); setNameManuallySet(false)
      navigate(`/project/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  const isHorizontal = layout === 'horizontal'
  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(isHorizontal ? 'sm:max-w-[900px]' : 'sm:max-w-[600px]')}>
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <FolderOpen className="h-5 w-5" />
                Import Existing Project
              </DialogTitle>
              <DialogDescription>Import a local project directory. The AI Agent will analyze the project structure and develop automatically.</DialogDescription>
            </div>
            <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-0.5 mr-6">
              <button onClick={() => setLayout('vertical')} className={cn('p-1.5 rounded-md transition-colors cursor-pointer', layout === 'vertical' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')} title="Vertical Layout">
                <Rows3 className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setLayout('horizontal')} className={cn('p-1.5 rounded-md transition-colors cursor-pointer', layout === 'horizontal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')} title="Horizontal Layout">
                <Columns3 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className={cn(isHorizontal ? 'flex gap-6' : 'space-y-4', 'py-4')}>
          <div className={cn(isHorizontal ? 'w-1/2 space-y-4' : 'space-y-4')}>
            <div className="space-y-2">
              <label className="text-sm font-medium">Local Directory Path</label>
              <Input placeholder="e.g. /home/user/projects/my-project" value={dirPath} onChange={(e) => handleDirPathChange(e.target.value)} />
              <p className="text-xs text-muted-foreground">The Agent will work directly in this directory without copying files.</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Project Name</label>
              <Input placeholder="Auto-extracted from path" value={name} onChange={(e) => handleNameChange(e.target.value)} />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={reviewBeforeCoding} onChange={(e) => setReviewBeforeCoding(e.target.checked)} className="accent-primary" />
              <span className="text-sm font-medium">Review task list after initialization</span>
              <span className="text-xs text-muted-foreground">— Review before coding starts</span>
            </label>

            <div>
              <label className="block text-sm font-medium mb-1">Quality Gate Command <span className="text-xs text-muted-foreground">(optional)</span></label>
              <input type="text" value={verifyCommand} onChange={(e) => setVerifyCommand(e.target.value)} placeholder="e.g. npm test && npm run lint" className="w-full px-3 py-2 rounded-md bg-muted border border-border text-sm font-mono" />
              <p className="text-xs text-muted-foreground mt-1">Runs before marking each feature as passed</p>
            </div>

            {error && <div className="text-sm text-red-400 bg-red-400/10 rounded-md px-3 py-2">{error}</div>}

            {!isHorizontal && (
              <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', !showAdvanced && '-rotate-90')} />
                Advanced Options
              </button>
            )}

            {(showAdvanced || isHorizontal) && (
              <div className={cn('space-y-3', !isHorizontal && 'pl-4 border-l-2 border-border')}>
                <div className="space-y-2">
                  <label className="text-sm font-medium">AI Provider</label>
                  <select value={provider} onChange={(e) => handleProviderChange(e.target.value)} className={selectClass}>
                    {providers.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
                  </select>
                </div>

                {caps?.modelSelection && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={currentProvider?.defaultModel || 'Default model'} />
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-sm font-medium">{useAgentTeams ? 'Suggested Parallel Agent Count' : 'Concurrent Agent Count'}</label>
                  <div className="flex items-center gap-3">
                    <input type="range" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="flex-1 accent-primary" />
                    <span className="text-sm font-mono w-6 text-center">{concurrency}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {useAgentTeams ? 'In Agent Teams mode, the AI will autonomously decide the actual parallelism' : 'Multiple Agents will develop different features in parallel on separate git branches'}
                  </p>
                </div>

                {caps?.agentTeams && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={useAgentTeams} onChange={(e) => setUseAgentTeams(e.target.checked)} className="accent-primary" />
                      <span className="text-sm font-medium">Agent Teams Mode</span>
                    </label>
                    <p className="text-xs text-muted-foreground">When enabled, the system launches a single AI session that internally coordinates multiple sub-Agents for end-to-end development</p>
                  </div>
                )}

                {caps?.systemPrompt && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">System Prompt (optional)</label>
                    <Textarea placeholder="Additional instructions for all Agents, e.g. coding standards, tech stack preferences..." value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} className="resize-none" />
                    <p className="text-xs text-muted-foreground">Injected via --system-prompt, applies to all Agent sessions</p>
                  </div>
                )}

                {currentProvider?.settings && currentProvider.settings.length > 0 && (
                  <ProviderSettings settings={currentProvider.settings} values={providerSettings} onChange={handleProviderSettingChange} />
                )}
              </div>
            )}
          </div>

          <div className={cn(isHorizontal ? 'w-1/2' : '', 'space-y-2')}>
            <label className="text-sm font-medium">Task Prompt</label>
            <Textarea
              placeholder={"Describe what you want the AI Agent to do with this project, e.g.:\n\n• Add user login based on existing code\n• Refactor the API layer to RESTful style\n• Fix the bug described in issue #42\n\nLeave empty for AI to auto-analyze from project files"}
              value={taskPrompt} onChange={(e) => setTaskPrompt(e.target.value)}
              rows={isHorizontal ? 14 : 6} className="resize-none"
            />
            <p className="text-xs text-muted-foreground">Tell the AI Agent your goal, otherwise it may not understand what you want to do</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="cursor-pointer">Cancel</Button>
          <Button onClick={handleImport} disabled={loading || !name.trim() || !dirPath.trim()} className="cursor-pointer">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Import Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
