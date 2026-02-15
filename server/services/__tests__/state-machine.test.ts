import { describe, it, expect } from 'vitest'
import { transition } from '../state-machine.js'
import type { ProjectStatus, StateEvent } from '../state-machine.js'

describe('state-machine transition', () => {
  // ===== START =====
  describe('START', () => {
    const startable: ProjectStatus[] = ['idle', 'paused', 'completed', 'error']

    for (const status of startable) {
      it(`${status} + START (未初始化) → initializing`, () => {
        expect(transition(status, { type: 'START', hasInitialized: false }))
          .toEqual({ newStatus: 'initializing' })
      })

      it(`${status} + START (已初始化) → running`, () => {
        expect(transition(status, { type: 'START', hasInitialized: true }))
          .toEqual({ newStatus: 'running' })
      })
    }

    const notStartable: ProjectStatus[] = ['initializing', 'reviewing', 'running']
    for (const status of notStartable) {
      it(`${status} + START → 不转换`, () => {
        expect(transition(status, { type: 'START', hasInitialized: false }))
          .toEqual({ newStatus: null })
      })
    }
  })

  // ===== INIT_COMPLETE =====
  describe('INIT_COMPLETE', () => {
    it('initializing + INIT_COMPLETE (有features, reviewMode) → reviewing', () => {
      expect(transition('initializing', { type: 'INIT_COMPLETE', hasFeatures: true, reviewMode: true }))
        .toEqual({ newStatus: 'reviewing' })
    })

    it('initializing + INIT_COMPLETE (有features, !reviewMode) → running', () => {
      expect(transition('initializing', { type: 'INIT_COMPLETE', hasFeatures: true, reviewMode: false }))
        .toEqual({ newStatus: 'running' })
    })

    it('initializing + INIT_COMPLETE (无features) → 不转换', () => {
      expect(transition('initializing', { type: 'INIT_COMPLETE', hasFeatures: false, reviewMode: false }))
        .toEqual({ newStatus: null })
    })

    it('running + INIT_COMPLETE → 不转换', () => {
      expect(transition('running', { type: 'INIT_COMPLETE', hasFeatures: true, reviewMode: false }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== INIT_FAILED =====
  describe('INIT_FAILED', () => {
    it('initializing + INIT_FAILED → error + stopWatcher', () => {
      expect(transition('initializing', { type: 'INIT_FAILED' }))
        .toEqual({ newStatus: 'error', stopWatcher: true })
    })

    it('running + INIT_FAILED → 不转换', () => {
      expect(transition('running', { type: 'INIT_FAILED' }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== REVIEW_CONFIRMED =====
  describe('REVIEW_CONFIRMED', () => {
    it('reviewing + REVIEW_CONFIRMED → running', () => {
      expect(transition('reviewing', { type: 'REVIEW_CONFIRMED' }))
        .toEqual({ newStatus: 'running' })
    })

    it('running + REVIEW_CONFIRMED → 不转换', () => {
      expect(transition('running', { type: 'REVIEW_CONFIRMED' }))
        .toEqual({ newStatus: null })
    })

    it('idle + REVIEW_CONFIRMED → 不转换', () => {
      expect(transition('idle', { type: 'REVIEW_CONFIRMED' }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== SESSION_COMPLETE =====
  describe('SESSION_COMPLETE', () => {
    it('running + SESSION_COMPLETE (allDone) → completed + stopWatcher', () => {
      expect(transition('running', { type: 'SESSION_COMPLETE', allDone: true }))
        .toEqual({ newStatus: 'completed', stopWatcher: true })
    })

    it('running + SESSION_COMPLETE (!allDone) → 不转换（继续下一个）', () => {
      expect(transition('running', { type: 'SESSION_COMPLETE', allDone: false }))
        .toEqual({ newStatus: null })
    })

    it('initializing + SESSION_COMPLETE → 不转换', () => {
      expect(transition('initializing', { type: 'SESSION_COMPLETE', allDone: true }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== SESSION_FAILED =====
  describe('SESSION_FAILED', () => {
    it('running + SESSION_FAILED (!allAgentsStopped) → 不转换（继续重试）', () => {
      expect(transition('running', { type: 'SESSION_FAILED', allAgentsStopped: false }))
        .toEqual({ newStatus: null })
    })

    it('running + SESSION_FAILED (allAgentsStopped) → 不转换', () => {
      expect(transition('running', { type: 'SESSION_FAILED', allAgentsStopped: true }))
        .toEqual({ newStatus: null })
    })

    it('idle + SESSION_FAILED → 不转换', () => {
      expect(transition('idle', { type: 'SESSION_FAILED', allAgentsStopped: false }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== STOP =====
  describe('STOP', () => {
    const allStatuses: ProjectStatus[] = ['idle', 'initializing', 'reviewing', 'running', 'paused', 'completed', 'error']

    for (const status of allStatuses) {
      it(`${status} + STOP (allAgentsStopped) → paused + stopWatcher`, () => {
        expect(transition(status, { type: 'STOP', allAgentsStopped: true }))
          .toEqual({ newStatus: 'paused', stopWatcher: true })
      })
    }

    it('running + STOP (!allAgentsStopped) → 不转换', () => {
      expect(transition('running', { type: 'STOP', allAgentsStopped: false }))
        .toEqual({ newStatus: null })
    })
  })

  // ===== ERROR =====
  describe('ERROR', () => {
    const allStatuses: ProjectStatus[] = ['idle', 'initializing', 'reviewing', 'running', 'paused', 'completed', 'error']

    for (const status of allStatuses) {
      it(`${status} + ERROR → error + stopWatcher`, () => {
        expect(transition(status, { type: 'ERROR' }))
          .toEqual({ newStatus: 'error', stopWatcher: true })
      })
    }
  })
})
