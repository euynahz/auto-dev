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
      })
      addProject(project)
      onOpenChange(false)
      setName(''); setDirPath(''); setTaskPrompt(''); setError(''); setNameManuallySet(false)
      navigate(`/project/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
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
                导入已有项目
              </DialogTitle>
              <DialogDescription>导入本地已有的项目目录，AI Agent 将分析项目结构并自动开发</DialogDescription>
            </div>
            <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-0.5 mr-6">
              <button onClick={() => setLayout('vertical')} className={cn('p-1.5 rounded-md transition-colors cursor-pointer', layout === 'vertical' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')} title="竖向布局">
                <Rows3 className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setLayout('horizontal')} className={cn('p-1.5 rounded-md transition-colors cursor-pointer', layout === 'horizontal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')} title="横向布局">
                <Columns3 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </DialogHeader>

        <div className={cn(isHorizontal ? 'flex gap-6' : 'space-y-4', 'py-4')}>
          <div className={cn(isHorizontal ? 'w-1/2 space-y-4' : 'space-y-4')}>
            <div className="space-y-2">
              <label className="text-sm font-medium">本地目录路径</label>
              <Input placeholder="例如：/home/user/projects/my-project" value={dirPath} onChange={(e) => handleDirPathChange(e.target.value)} />
              <p className="text-xs text-muted-foreground">Agent 将直接在此目录下工作，不会复制文件</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">项目名称</label>
              <Input placeholder="粘贴路径后自动提取" value={name} onChange={(e) => handleNameChange(e.target.value)} />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={reviewBeforeCoding} onChange={(e) => setReviewBeforeCoding(e.target.checked)} className="accent-primary" />
              <span className="text-sm font-medium">初始化后审查任务列表</span>
              <span className="text-xs text-muted-foreground">— 生成后先审查再编码</span>
            </label>

            {error && <div className="text-sm text-red-400 bg-red-400/10 rounded-md px-3 py-2">{error}</div>}

            {!isHorizontal && (
              <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200', !showAdvanced && '-rotate-90')} />
                高级选项
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
                    <label className="text-sm font-medium">模型</label>
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={currentProvider?.defaultModel || '默认模型'} />
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-sm font-medium">{useAgentTeams ? '建议的并行 Agent 数量' : '并发 Agent 数量'}</label>
                  <div className="flex items-center gap-3">
                    <input type="range" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="flex-1 accent-primary" />
                    <span className="text-sm font-mono w-6 text-center">{concurrency}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {useAgentTeams ? 'Agent Teams 模式下，AI 将自主决定实际并行数量' : '多个 Agent 将在独立 git 分支上并行开发不同 feature'}
                  </p>
                </div>

                {caps?.agentTeams && (
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={useAgentTeams} onChange={(e) => setUseAgentTeams(e.target.checked)} className="accent-primary" />
                      <span className="text-sm font-medium">Agent Teams 模式</span>
                    </label>
                    <p className="text-xs text-muted-foreground">启用后，系统只启动一个 AI 会话，由 AI 内部自主协调多个子 Agent 完成全流程开发</p>
                  </div>
                )}

                {caps?.systemPrompt && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">系统提示词（可选）</label>
                    <Textarea placeholder="对所有 Agent 生效的额外指令，如编码规范、技术栈偏好等..." value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} className="resize-none" />
                    <p className="text-xs text-muted-foreground">通过 --system-prompt 注入，所有 Agent Session 均生效</p>
                  </div>
                )}

                {currentProvider?.settings && currentProvider.settings.length > 0 && (
                  <ProviderSettings settings={currentProvider.settings} values={providerSettings} onChange={handleProviderSettingChange} />
                )}
              </div>
            )}
          </div>

          <div className={cn(isHorizontal ? 'w-1/2' : '', 'space-y-2')}>
            <label className="text-sm font-medium">任务提示词</label>
            <Textarea
              placeholder={"描述你希望 AI Agent 对这个项目做什么，例如：\n\n• 参考已有代码，添加用户登录功能\n• 重构 API 层，改用 RESTful 风格\n• 修复 issue #42 中描述的 bug\n\n留空则由 AI 根据项目文件自动分析"}
              value={taskPrompt} onChange={(e) => setTaskPrompt(e.target.value)}
              rows={isHorizontal ? 14 : 6} className="resize-none"
            />
            <p className="text-xs text-muted-foreground">告诉 AI Agent 你的目标，否则它可能无法理解你想做什么</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="cursor-pointer">取消</Button>
          <Button onClick={handleImport} disabled={loading || !name.trim() || !dirPath.trim()} className="cursor-pointer">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            导入项目
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
