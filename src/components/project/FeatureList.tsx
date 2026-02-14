import { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Search, Loader2, Sparkles } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Feature } from '@/types'

interface Props {
  features: Feature[]
  featureAgentMap?: Map<string, number>
  reviewMode?: boolean
  onReviewSubmit?: (featureIds: string[], instruction: string) => void
  reviewLoading?: boolean
  isProjectRunning?: boolean
}

export function FeatureList({ features, featureAgentMap, reviewMode, onReviewSubmit, reviewLoading, isProjectRunning }: Props) {
  const [search, setSearch] = useState('')
  const [selectedFeatureIds, setSelectedFeatureIds] = useState<Set<string>>(new Set())
  const [reviewInstruction, setReviewInstruction] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => {
    // Auto-expand category of the first in-progress feature
    const active = features.find((f) => f.inProgress && !f.passes)
    return active ? new Set([active.category]) : new Set()
  })
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<'all' | 'passed' | 'in_progress' | 'pending'>('all')
  const activeFeatureRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)

  const activeFeatureId = useMemo(() => {
    const f = features.find((f) => f.inProgress && !f.passes)
    return f?.id ?? null
  }, [features])

  // Reset scroll lock and expand category + feature steps when active feature changes
  useEffect(() => {
    if (!activeFeatureId) return
    scrolledRef.current = false
    const active = features.find((f) => f.id === activeFeatureId)
    if (active) {
      setExpandedCategories((prev) => {
        if (prev.has(active.category)) return prev
        const next = new Set(prev)
        next.add(active.category)
        return next
      })
      setExpandedFeatures((prev) => {
        if (prev.has(activeFeatureId)) return prev
        const next = new Set(prev)
        next.add(activeFeatureId)
        return next
      })
    }
  }, [activeFeatureId, features])

  useEffect(() => {
    if (scrolledRef.current || !activeFeatureRef.current) return
    scrolledRef.current = true
    requestAnimationFrame(() => {
      activeFeatureRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  })

  const grouped = useMemo(() => {
    const map = new Map<string, Feature[]>()
    for (const f of features) {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'passed' && f.passes) ||
        (filter === 'in_progress' && !f.passes && f.inProgress) ||
        (filter === 'pending' && !f.passes && !f.inProgress)
      const filtered =
        matchesFilter &&
        (!search || f.description.toLowerCase().includes(search.toLowerCase()) || f.category.toLowerCase().includes(search.toLowerCase()))
      if (filtered) {
        const list = map.get(f.category) || []
        list.push(f)
        map.set(f.category, list)
      }
    }
    return map
  }, [features, search, filter])

  const toggleCategory = (cat: string) => {
    const next = new Set(expandedCategories)
    next.has(cat) ? next.delete(cat) : next.add(cat)
    setExpandedCategories(next)
  }

  const toggleFeature = (id: string) => {
    const next = new Set(expandedFeatures)
    next.has(id) ? next.delete(id) : next.add(id)
    setExpandedFeatures(next)
  }

  const toggleFeatureSelection = (id: string) => {
    setSelectedFeatureIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedFeatureIds.size === features.length) {
      setSelectedFeatureIds(new Set())
    } else {
      setSelectedFeatureIds(new Set(features.map(f => f.id)))
    }
  }

  const handleReviewSubmit = () => {
    if (onReviewSubmit && selectedFeatureIds.size > 0 && reviewInstruction.trim()) {
      onReviewSubmit(Array.from(selectedFeatureIds), reviewInstruction.trim())
    }
  }

  const passedCount = features.filter((f) => f.passes).length
  const inProgressCount = features.filter((f) => !f.passes && f.inProgress).length

  return (
    <div className="flex flex-col h-full">
      {/* Search and filter */}
      <div className="p-3 space-y-2.5 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索 feature..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 bg-secondary/30 border-transparent focus:border-primary/30 transition-colors"
          />
        </div>
        <div className="flex gap-1 items-center">
          {reviewMode && (
            <button
              onClick={toggleSelectAll}
              className="px-2.5 py-1 text-xs rounded-md transition-all duration-200 cursor-pointer font-medium bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary shrink-0"
            >
              {selectedFeatureIds.size === features.length ? '取消全选' : '全选'}
            </button>
          )}
          {(['all', 'passed', 'in_progress', 'pending'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-all duration-200 cursor-pointer font-medium',
                filter === f
                  ? 'bg-primary/15 text-primary shadow-sm shadow-primary/5'
                  : 'bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
              )}
            >
              {f === 'all' ? `全部 (${features.length})` : f === 'passed' ? `通过 (${passedCount})` : f === 'in_progress' ? `进行中 (${inProgressCount})` : `待做 (${features.length - passedCount - inProgressCount})`}
            </button>
          ))}
        </div>
      </div>

      {/* Feature list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-2 overflow-hidden">
          {features.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-sm animate-fade-in">
              <div className="typing-indicator flex gap-1.5 mb-3">
                <span />
                <span />
                <span />
              </div>
              <span className="text-muted-foreground">暂无 Feature，启动 Agent 后将自动生成</span>
            </div>
          ) : grouped.size === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm animate-fade-in">
              没有匹配的结果
            </div>
          ) : (
            Array.from(grouped.entries()).map(([category, items]) => {
              const catPassed = items.filter((f) => f.passes).length
              const isExpanded = expandedCategories.has(category)
              const allPassed = catPassed === items.length
              return (
                <div key={category} className="mb-1">
                  {/* Category header */}
                  <button
                    onClick={() => toggleCategory(category)}
                    className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-secondary/50 transition-all duration-200 text-left cursor-pointer group"
                  >
                    <span className="transition-transform duration-200" style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                    <span className="text-sm font-medium flex-1 truncate group-hover:text-foreground transition-colors">{category}</span>
                    <Badge variant={allPassed ? 'success' : 'secondary'} className="text-[10px] font-mono tabular-nums">
                      {catPassed}/{items.length}
                    </Badge>
                  </button>

                  {/* Feature items with animated expand */}
                  {isExpanded && (
                    <div className="pl-4 overflow-hidden space-y-0.5" style={{ animation: 'expand-height 0.25s ease-out' }}>
                      {items.map((feature) => {
                        const claimedByAgent = featureAgentMap?.get(feature.id)
                        const isInProgress = feature.inProgress || (claimedByAgent != null && !feature.passes)
                        const isSelected = selectedFeatureIds.has(feature.id)
                        return (
                          <div key={feature.id} ref={feature.id === activeFeatureId ? activeFeatureRef : undefined}>
                            <div className={cn(
                              'flex items-start gap-1',
                              reviewMode && isSelected && 'bg-primary/5 rounded-lg'
                            )}>
                              {reviewMode && (
                                <label className="flex items-center shrink-0 mt-2 ml-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleFeatureSelection(feature.id)}
                                    className="accent-primary h-3.5 w-3.5"
                                  />
                                </label>
                              )}
                              <button
                                onClick={() => toggleFeature(feature.id)}
                                className="w-full flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/30 transition-all duration-200 text-left cursor-pointer group"
                              >
                              {feature.passes ? (
                                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5 animate-scale-in" />
                              ) : isInProgress && isProjectRunning ? (
                                <Loader2 className="h-4 w-4 text-primary shrink-0 mt-0.5 animate-spin" />
                              ) : (
                                <XCircle className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5 group-hover:text-muted-foreground transition-colors" />
                              )}
                              <span className={cn(
                                'text-sm flex-1 min-w-0 break-words transition-colors',
                                feature.passes ? 'text-foreground/60' : 'text-foreground/90'
                              )}>
                                {feature.description}
                              </span>
                              {feature.steps.length > 0 && (
                                <ChevronRight className={cn(
                                  'h-3.5 w-3.5 text-muted-foreground/40 shrink-0 transition-transform duration-200',
                                  expandedFeatures.has(feature.id) && 'rotate-90'
                                )} />
                              )}
                              {isInProgress && isProjectRunning && (
                                <Badge variant="default" className="text-[10px] shrink-0 animate-pulse">
                                  {claimedByAgent != null ? `A${claimedByAgent}` : '处理中'}
                                </Badge>
                              )}
                            </button>
                            </div>
                            {/* Steps expand */}
                            {expandedFeatures.has(feature.id) && feature.steps.length > 0 && (
                              <div className={cn('mb-2 space-y-1', reviewMode ? 'ml-12' : 'ml-8')} style={{ animation: 'expand-height 0.2s ease-out' }}>
                                {feature.steps.map((step, i) => (
                                  <div key={i} className="text-xs text-muted-foreground flex items-start gap-1.5 py-0.5">
                                    <span className="text-primary/40 shrink-0 font-mono">{i + 1}.</span>
                                    <span>{step}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Review mode bottom panel */}
      {reviewMode && features.length > 0 && (
        <div className="p-3 border-t border-border space-y-2 shrink-0">
          <div className="text-xs text-muted-foreground">
            已选 <span className="font-medium text-foreground">{selectedFeatureIds.size}</span> 个 Feature
          </div>
          <Textarea
            placeholder="输入修改指令，例如：将这些 Feature 拆分为更细粒度的任务..."
            value={reviewInstruction}
            onChange={(e) => setReviewInstruction(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <Button
            size="sm"
            onClick={handleReviewSubmit}
            disabled={reviewLoading || selectedFeatureIds.size === 0 || !reviewInstruction.trim()}
            className="w-full gap-1.5 cursor-pointer"
          >
            {reviewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI 修改
          </Button>
        </div>
      )}
    </div>
  )
}
