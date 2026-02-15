import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Play, Square, CheckCircle2, Circle, Loader2, FolderOpen, Trash2, Sparkles, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ProgressBar } from '@/components/ui/progress'
import { useStore } from '@/store'
import { api } from '@/lib/api'
import { CreateProjectDialog } from '@/components/project/CreateProjectDialog'
import { ImportProjectDialog } from '@/components/project/ImportProjectDialog'
import type { ProjectStatus } from '@/types'

const statusConfig: Record<ProjectStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' }> = {
  idle: { label: '空闲', variant: 'secondary' },
  initializing: { label: '初始化中', variant: 'warning' },
  reviewing: { label: '待审查', variant: 'warning' },
  running: { label: '运行中', variant: 'default' },
  paused: { label: '已暂停', variant: 'warning' },
  completed: { label: '已完成', variant: 'success' },
  error: { label: '错误', variant: 'destructive' },
}

function SkeletonCard() {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="h-5 w-32 rounded shimmer" />
          <div className="h-5 w-16 rounded shimmer" />
        </div>
        <div className="space-y-2 mt-3">
          <div className="h-3 w-full rounded shimmer" />
          <div className="h-3 w-2/3 rounded shimmer" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex justify-between">
            <div className="h-3 w-12 rounded shimmer" />
            <div className="h-3 w-8 rounded shimmer" />
          </div>
          <div className="h-2 w-full rounded-full shimmer" />
        </div>
        <div className="flex justify-between mt-4">
          <div className="h-3 w-24 rounded shimmer" />
          <div className="h-3 w-16 rounded shimmer" />
        </div>
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const { projects, setProjects, removeProject } = useStore()
  const [loading, setLoading] = useState(true)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)

  const handleDelete = async (e: React.MouseEvent, projectId: string, projectName: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`确定要删除项目「${projectName}」吗？此操作不可撤销。`)) return
    try {
      await api.deleteProject(projectId)
      removeProject(projectId)
    } catch (err) {
      console.error('删除失败:', err)
    }
  }

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [setProjects])

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8 animate-fade-in">
          <div>
            <div className="h-8 w-40 rounded shimmer" />
            <div className="h-4 w-64 rounded shimmer mt-2" />
          </div>
          <div className="flex gap-2">
            <div className="h-9 w-24 rounded-md shimmer" />
            <div className="h-9 w-24 rounded-md shimmer" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8 animate-fade-in-up">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">项目列表</h1>
          <p className="text-muted-foreground mt-1">管理你的 AI Agent 自动开发项目</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportDialogOpen(true)} className="gap-2 cursor-pointer">
            <FolderOpen className="h-4 w-4" />
            导入项目
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)} className="gap-2 cursor-pointer">
            <Plus className="h-4 w-4" />
            新建项目
          </Button>
        </div>
      </div>

      {/* Project grid */}
      {projects.length === 0 ? (
        <Card className="border-dashed animate-fade-in-up">
          <CardContent className="flex flex-col items-center justify-center py-20">
            <div className="relative mb-6">
              <Sparkles className="h-16 w-16 text-muted-foreground/30 animate-float" />
              <div className="absolute inset-0 bg-primary/5 rounded-full blur-2xl" />
            </div>
            <p className="text-lg text-muted-foreground mb-1">还没有项目</p>
            <p className="text-sm text-muted-foreground/60 mb-6">创建或导入一个项目开始 AI 自动开发</p>
            <div className="flex gap-3">
              <Button onClick={() => setImportDialogOpen(true)} variant="outline" className="gap-2 cursor-pointer">
                <FolderOpen className="h-4 w-4" />
                导入已有项目
              </Button>
              <Button onClick={() => setCreateDialogOpen(true)} className="gap-2 cursor-pointer">
                <Zap className="h-4 w-4" />
                创建新项目
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
          {projects.map((project) => {
            const config = statusConfig[project.status]
            const isRunning = project.status === 'running'
            return (
              <Link key={project.id} to={`/project/${project.id}`}>
                <Card className="card-glow glow-border cursor-pointer h-full group">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-lg group-hover:text-primary transition-colors duration-200">{project.name}</CardTitle>
                      <div className="flex items-center gap-1.5">
                        {(project.concurrency || 1) > 1 && (
                          <Badge variant="secondary" className="text-[10px]">
                            x{project.concurrency}
                          </Badge>
                        )}
                        <Badge variant={config.variant} className={isRunning ? 'animate-pulse' : ''}>
                          {isRunning && <span className="relative flex h-1.5 w-1.5 mr-1"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" /></span>}
                          {config.label}
                        </Badge>
                        <button
                          onClick={(e) => handleDelete(e, project.id, project.name)}
                          className="ml-1 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                      {project.spec.slice(0, 120)}
                      {project.spec.length > 120 ? '...' : ''}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">进度</span>
                        <span className="flex items-center gap-1.5">
                          {project.status === 'running' && <Play className="h-3 w-3 text-primary" />}
                          {project.status === 'completed' && <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
                          {project.status === 'error' && <Square className="h-3 w-3 text-red-400" />}
                          <span className="font-mono font-medium text-xs">
                            {project.progress.passed}/{project.progress.total}
                          </span>
                        </span>
                      </div>
                      <ProgressBar value={project.progress.percentage} />
                    </div>

                    <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
                      <span className="font-mono">{project.model}</span>
                      <span>{new Date(project.createdAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}

      <CreateProjectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <ImportProjectDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
    </div>
  )
}
