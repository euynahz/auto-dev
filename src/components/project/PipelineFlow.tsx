import { useMemo } from 'react'
import {
  ReactFlow,
  Background,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FileText, Brain, Search, ListTree, CheckCircle, Code, Rocket, Loader2, AlertCircle, Pause } from 'lucide-react'
import type { Project } from '@/types'

// ── Pipeline stage definition ──────────────────────────────────────

type StageStatus = 'pending' | 'active' | 'completed' | 'error' | 'paused' | 'review'

interface StageData {
  label: string
  icon: React.ReactNode
  status: StageStatus
  subtitle?: string
}

const STAGE_IDS = ['spec', 'architecture', 'arch-review', 'decompose', 'feat-review', 'coding', 'done'] as const

// ── Derive stage statuses from project state ───────────────────────

function deriveStages(project: Project): Record<string, StageData> {
  const s = project.status
  const rp = project.reviewPhase
  const hasArchSession = project.sessions.some(ss => ss.type === 'architecture')
  const hasInitSession = project.sessions.some(ss => ss.type === 'initializer')
  const hasCodingSession = project.sessions.some(ss => ss.type === 'coding' || ss.type === 'agent-teams')
  const archDone = project.sessions.some(ss => ss.type === 'architecture' && ss.status === 'completed')
  const initDone = project.sessions.some(ss => ss.type === 'initializer' && ss.status === 'completed')

  const base: Record<string, StageData> = {
    'spec':         { label: 'Spec',          icon: <FileText className="h-4 w-4" />,    status: 'completed' },
    'architecture': { label: 'Architecture',  icon: <Brain className="h-4 w-4" />,       status: 'pending' },
    'arch-review':  { label: 'Review',        icon: <Search className="h-4 w-4" />,      status: 'pending' },
    'decompose':    { label: 'Decompose',     icon: <ListTree className="h-4 w-4" />,    status: 'pending' },
    'feat-review':  { label: 'Review',        icon: <Search className="h-4 w-4" />,      status: 'pending' },
    'coding':       { label: 'Coding',        icon: <Code className="h-4 w-4" />,        status: 'pending' },
    'done':         { label: 'Done',          icon: <Rocket className="h-4 w-4" />,      status: 'pending' },
  }

  // Spec is always "completed" once project exists
  // Walk forward through stages based on project state

  if (s === 'idle') return base

  // Architecture
  if (hasArchSession) {
    if (archDone || s !== 'initializing' || rp || hasInitSession) {
      base['architecture'].status = 'completed'
    } else {
      base['architecture'].status = 'active'
      base['architecture'].subtitle = 'Analyzing...'
      return base
    }
  }

  // Architecture review
  if (s === 'reviewing' && rp === 'architecture') {
    base['arch-review'].status = 'review'
    base['arch-review'].subtitle = 'Awaiting confirmation'
    return base
  }
  if (archDone && (hasInitSession || s === 'running' || s === 'completed' || s === 'reviewing')) {
    base['arch-review'].status = 'completed'
  }

  // Decompose (initializer)
  if (hasInitSession) {
    if (initDone || s === 'running' || s === 'completed' || (s === 'reviewing' && rp === 'features')) {
      base['decompose'].status = 'completed'
    } else if (s === 'initializing') {
      base['decompose'].status = 'active'
      base['decompose'].subtitle = 'Generating tasks...'
      return base
    }
  }

  // Feature review
  if (s === 'reviewing' && rp === 'features') {
    base['feat-review'].status = 'review'
    base['feat-review'].subtitle = 'Awaiting confirmation'
    return base
  }
  if (initDone && (hasCodingSession || s === 'running' || s === 'completed')) {
    base['feat-review'].status = 'completed'
  }

  // Coding
  if (hasCodingSession || s === 'running') {
    if (s === 'completed') {
      base['coding'].status = 'completed'
      base['coding'].subtitle = `${project.progress.passed}/${project.progress.total}`
    } else if (s === 'running') {
      base['coding'].status = 'active'
      base['coding'].subtitle = `${project.progress.passed}/${project.progress.total}`
    } else if (s === 'paused') {
      base['coding'].status = 'paused'
      base['coding'].subtitle = `${project.progress.passed}/${project.progress.total}`
    } else if (s === 'error') {
      base['coding'].status = 'error'
    }
  }

  // Done
  if (s === 'completed') {
    base['done'].status = 'completed'
  }

  // Error / paused overrides
  if (s === 'error') {
    // Find the last active stage and mark it error
    const activeStage = Object.entries(base).find(([, v]) => v.status === 'active')
    if (activeStage) activeStage[1].status = 'error'
  }
  if (s === 'paused' && !hasCodingSession) {
    const activeStage = Object.entries(base).find(([, v]) => v.status === 'active')
    if (activeStage) activeStage[1].status = 'paused'
  }

  return base
}

// ── Custom node component ──────────────────────────────────────────

const statusColors: Record<StageStatus, { bg: string; border: string; text: string; ring?: string }> = {
  pending:   { bg: 'bg-secondary/40',       border: 'border-border/50',       text: 'text-muted-foreground/60' },
  active:    { bg: 'bg-primary/10',          border: 'border-primary',         text: 'text-primary',           ring: 'ring-primary/20' },
  completed: { bg: 'bg-emerald-500/10',      border: 'border-emerald-500/60',  text: 'text-emerald-400' },
  error:     { bg: 'bg-destructive/10',      border: 'border-destructive/60',  text: 'text-destructive' },
  paused:    { bg: 'bg-amber-500/10',        border: 'border-amber-500/60',    text: 'text-amber-400' },
  review:    { bg: 'bg-violet-500/10',       border: 'border-violet-500/60',   text: 'text-violet-400',        ring: 'ring-violet-500/20' },
}

function StageNode({ data }: { data: StageData }) {
  const c = statusColors[data.status]
  const isActive = data.status === 'active' || data.status === 'review'

  return (
    <>
      <Handle type="target" position={Position.Left} className="!bg-border !w-1.5 !h-1.5 !border-0" />
      <div className={`
        relative flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border
        ${c.bg} ${c.border} ${c.text}
        ${c.ring ? `ring-2 ${c.ring}` : ''}
        transition-all duration-300 min-w-[120px]
      `}>
        {/* Pulse dot for active */}
        {isActive && (
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-40" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-current" />
          </span>
        )}

        {/* Icon */}
        <div className="shrink-0">
          {data.status === 'active' ? <Loader2 className="h-4 w-4 animate-spin" /> :
           data.status === 'error' ? <AlertCircle className="h-4 w-4" /> :
           data.status === 'paused' ? <Pause className="h-4 w-4" /> :
           data.status === 'completed' ? <CheckCircle className="h-4 w-4" /> :
           data.icon}
        </div>

        {/* Text */}
        <div className="flex flex-col">
          <span className="text-xs font-semibold leading-tight">{data.label}</span>
          {data.subtitle && (
            <span className="text-[10px] opacity-70 leading-tight mt-0.5">{data.subtitle}</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-border !w-1.5 !h-1.5 !border-0" />
    </>
  )
}

const nodeTypes: NodeTypes = { stage: StageNode }

// ── Layout ─────────────────────────────────────────────────────────

const NODE_W = 140
const NODE_GAP = 32
const Y = 30

function buildNodes(stages: Record<string, StageData>): Node[] {
  return STAGE_IDS.map((id, i) => ({
    id,
    type: 'stage',
    position: { x: i * (NODE_W + NODE_GAP), y: Y },
    data: stages[id],
    draggable: false,
    selectable: false,
  }))
}

function buildEdges(stages: Record<string, StageData>): Edge[] {
  return STAGE_IDS.slice(0, -1).map((id, i) => {
    const nextId = STAGE_IDS[i + 1]
    const srcDone = stages[id].status === 'completed'
    const tgtActive = stages[nextId].status === 'active' || stages[nextId].status === 'review'

    return {
      id: `${id}-${nextId}`,
      source: id,
      target: nextId,
      type: 'default',
      animated: tgtActive,
      style: {
        stroke: srcDone ? 'var(--color-emerald-500)' : 'var(--color-border)',
        strokeWidth: srcDone || tgtActive ? 2 : 1,
        opacity: srcDone || tgtActive ? 0.8 : 0.3,
      },
    }
  })
}

// ── Main component ─────────────────────────────────────────────────

interface Props {
  project: Project
}

export function PipelineFlow({ project }: Props) {
  const stages = useMemo(() => deriveStages(project), [project])
  const nodes = useMemo(() => buildNodes(stages), [stages])
  const edges = useMemo(() => buildEdges(stages), [stages])

  return (
    <div className="w-full h-[100px] rounded-lg border bg-background/50 overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.5}
        maxZoom={1}
      >
        <Background gap={20} size={0.5} color="var(--color-border)" style={{ opacity: 0.3 }} />
      </ReactFlow>
    </div>
  )
}
