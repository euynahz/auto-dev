import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Rows3, Columns3, ChevronDown, AlertTriangle } from 'lucide-react'
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

export function CreateProjectDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate()
  const addProject = useStore((s) => s.addProject)
  const { providers, getProvider } = useProviders()

  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [spec, setSpec] = useState('')
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
  const [dirConflict, setDirConflict] = useState<{ entries: string[] } | null>(null)

  const currentProvider = getProvider(provider)
  const caps = currentProvider?.capabilities

  const handleProviderChange = useCallback((newProvider: string) => {
    setProvider(newProvider)
    const p = getProvider(newProvider)
    if (p?.defaultModel) setModel(p.defaultModel)
    else setModel('')
    // 重置不兼容的选项
    if (!p?.capabilities.agentTeams) setUseAgentTeams(false)
    if (!p?.capabilities.systemPrompt) setSystemPrompt('')
    // 重置 provider 专属设置为默认值
    const defaults: Record<string, unknown> = {}
    p?.settings?.forEach(s => { defaults[s.key] = s.default })
    setProviderSettings(defaults)
  }, [getProvider])

  const handleProviderSettingChange = useCallback((key: string, value: unknown) => {
    setProviderSettings(prev => ({ ...prev, [key]: value }))
  }, [])

  const handleDirPathChange = (value: string) => {
    setDirPath(value)
    setDirConflict(null)
    if (!nameManuallySet) {
      const extracted = extractNameFromPath(value)
      if (extracted) setName(extracted)
    }
  }

  const handleNameChange = (value: string) => {
    setName(value)
    setNameManuallySet(true)
  }

  const doCreate = async (forceClean?: boolean) => {
    setLoading(true)
    setError('')
    try {
      const hasCustomSettings = Object.keys(providerSettings).length > 0
      const project = await api.createProject({
        name, spec, path: dirPath.trim() || undefined, forceClean,
        provider, model: model.trim() || undefined,
        ...(hasCustomSettings ? { providerSettings } : {}),
        concurrency, useAgentTeams,
        systemPrompt: systemPrompt.trim() || undefined,
        reviewBeforeCoding: reviewBeforeCoding || undefined,
      })
      addProject(project)
      onOpenChange(false)
      resetForm()
      navigate(`/project/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!name.trim() || !spec.trim()) return
    const targetPath = dirPath.trim()
    if (targetPath) {
      setLoading(true)
      setError('')
      try {
        const check = await api.checkDir(targetPath)
        if (check.hasContent) {
          setDirConflict({ entries: check.entries })
          setLoading(false)
          return
        }
      } catch { /* 目录不存在，可以直接创建 */ }
      setLoading(false)
    }
    doCreate()
  }

  const resetForm = () => {
    setName(''); setDirPath(''); setSpec(''); setError('')
    setDirConflict(null); setNameManuallySet(false)
  }

  const isHorizontal = layout === 'horizontal'
  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(isHorizontal ? 'sm:max-w-[900px]' : 'sm:max-w-[600px]')}>
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>新建项目</DialogTitle>
              <DialogDescription>描述你想要构建的应用，AI Agent 将自动完成开发</DialogDescription>
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

        {dirConflict ? (
          <div className="py-4 space-y-4">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
              <div className="space-y-2">
                <p className="text-sm font-medium">目录已有内容</p>
                <p className="text-sm text-muted-foreground">
                  <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">{dirPath}</code> 下已存在以下文件：
                </p>
                <div className="text-xs text-muted-foreground font-mono bg-secondary/50 rounded p-2 max-h-32 overflow-y-auto">
                  {dirConflict.entries.map((e) => <div key={e}>{e}</div>)}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDirConflict(null)} className="cursor-pointer">返回修改</Button>
              <Button variant="outline" onClick={() => { setDirConflict(null); doCreate(false) }} className="cursor-pointer">保留内容，直接创建</Button>
              <Button variant="destructive" onClick={() => { setDirConflict(null); doCreate(true) }} className="cursor-pointer">清空目录后创建</Button>
            </div>
          </div>
        ) : (
          <>
            <div className={cn(isHorizontal ? 'flex gap-6' : 'space-y-4', 'py-4')}>
              <div className={cn(isHorizontal ? 'w-1/2 space-y-4' : 'space-y-4')}>
                <div className="space-y-2">
                  <label className="text-sm font-medium">项目目录</label>
                  <Input placeholder="例如：/home/user/projects/my-app（留空则自动生成）" value={dirPath} onChange={(e) => handleDirPathChange(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Agent 将在此目录下工作，留空则在 workspace/ 下自动创建</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">项目名称</label>
                  <Input placeholder="例如：todo-app" value={name} onChange={(e) => handleNameChange(e.target.value)} />
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
                    {/* Provider 选择 */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">AI Provider</label>
                      <select value={provider} onChange={(e) => handleProviderChange(e.target.value)} className={selectClass}>
                        {providers.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}
                      </select>
                    </div>

                    {/* 模型 — 仅 modelSelection 能力 */}
                    {caps?.modelSelection && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">模型</label>
                        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={currentProvider?.defaultModel || '默认模型'} />
                      </div>
                    )}

                    {/* 并发 */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium">
                        {useAgentTeams ? '建议的并行 Agent 数量' : '并发 Agent 数量'}
                      </label>
                      <div className="flex items-center gap-3">
                        <input type="range" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="flex-1 accent-primary" />
                        <span className="text-sm font-mono w-6 text-center">{concurrency}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {useAgentTeams ? 'Agent Teams 模式下，AI 将自主决定实际并行数量' : '多个 Agent 将在独立 git 分支上并行开发不同 feature'}
                      </p>
                    </div>

                    {/* Agent Teams — 仅 agentTeams 能力 */}
                    {caps?.agentTeams && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={useAgentTeams} onChange={(e) => setUseAgentTeams(e.target.checked)} className="accent-primary" />
                          <span className="text-sm font-medium">Agent Teams 模式</span>
                        </label>
                        <p className="text-xs text-muted-foreground">启用后，系统只启动一个 AI 会话，由 AI 内部自主协调多个子 Agent 完成全流程开发</p>
                      </div>
                    )}

                    {/* 系统提示词 — 仅 systemPrompt 能力 */}
                    {caps?.systemPrompt && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">系统提示词（可选）</label>
                        <Textarea placeholder="对所有 Agent 生效的额外指令，如编码规范、技术栈偏好等..." value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={3} className="resize-none" />
                        <p className="text-xs text-muted-foreground">通过 --system-prompt 注入，所有 Agent Session 均生效</p>
                      </div>
                    )}

                    {/* Provider 专属设置 */}
                    {currentProvider?.settings && currentProvider.settings.length > 0 && (
                      <ProviderSettings settings={currentProvider.settings} values={providerSettings} onChange={handleProviderSettingChange} />
                    )}
                  </div>
                )}
              </div>

              <div className={cn(isHorizontal ? 'w-1/2' : '', 'space-y-2')}>
                <label className="text-sm font-medium">项目需求描述</label>
                <Textarea placeholder="详细描述你想要构建的应用，包括功能、技术栈、UI 风格等..." value={spec} onChange={(e) => setSpec(e.target.value)} rows={isHorizontal ? 14 : 8} className="resize-none" />
                <p className="text-xs text-muted-foreground">支持 Markdown 格式，描述越详细效果越好</p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="cursor-pointer">取消</Button>
              <Button onClick={handleCreate} disabled={loading || !name.trim() || !spec.trim()} className="cursor-pointer">
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                创建项目
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
