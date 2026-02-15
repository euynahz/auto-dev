import type { ProjectData } from '../types.js'

export type ProjectStatus = ProjectData['status']

// 状态转换事件
export type StateEvent =
  | { type: 'START'; hasInitialized: boolean }
  | { type: 'INIT_COMPLETE'; hasFeatures: boolean; reviewMode: boolean }
  | { type: 'INIT_FAILED' }
  | { type: 'REVIEW_CONFIRMED' }
  | { type: 'SESSION_COMPLETE'; allDone: boolean }
  | { type: 'SESSION_FAILED'; allAgentsStopped: boolean }
  | { type: 'STOP'; allAgentsStopped: boolean }
  | { type: 'ERROR' }

export interface TransitionResult {
  newStatus: ProjectStatus | null  // null = 不转换
  stopWatcher?: boolean
}

/**
 * 纯函数：根据当前状态和事件，返回转换结果。
 * 不产生副作用，所有 IO 由调用方处理。
 */
export function transition(current: ProjectStatus, event: StateEvent): TransitionResult {
  switch (event.type) {
    case 'START':
      if (current === 'idle' || current === 'paused' || current === 'completed' || current === 'error') {
        return { newStatus: event.hasInitialized ? 'running' : 'initializing' }
      }
      return { newStatus: null }

    case 'INIT_COMPLETE':
      if (current === 'initializing') {
        if (event.hasFeatures && event.reviewMode) {
          return { newStatus: 'reviewing' }
        }
        if (event.hasFeatures) {
          return { newStatus: 'running' }
        }
      }
      return { newStatus: null }

    case 'INIT_FAILED':
      if (current === 'initializing') {
        return { newStatus: 'error', stopWatcher: true }
      }
      return { newStatus: null }

    case 'REVIEW_CONFIRMED':
      if (current === 'reviewing') {
        return { newStatus: 'running' }
      }
      return { newStatus: null }

    case 'SESSION_COMPLETE':
      if (current === 'running') {
        if (event.allDone) {
          return { newStatus: 'completed', stopWatcher: true }
        }
        return { newStatus: null } // 继续下一个 session
      }
      return { newStatus: null }

    case 'SESSION_FAILED':
      if (current === 'running' && !event.allAgentsStopped) {
        return { newStatus: null } // 继续重试
      }
      return { newStatus: null }

    case 'STOP':
      if (event.allAgentsStopped) {
        return { newStatus: 'paused', stopWatcher: true }
      }
      return { newStatus: null }

    case 'ERROR':
      return { newStatus: 'error', stopWatcher: true }

    default:
      return { newStatus: null }
  }
}
