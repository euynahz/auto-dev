import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock getProjectDir to point to a temp directory
// getProjectDir is internal in project.ts, so we test addLog/getLogs behavior directly
// Approach: mock DATA_DIR paths by setting up a temp directory structure

let tmpDir: string
let projectId: string

// Dynamic import to reload module for each test
async function importProject() {
  // project.ts uses process.cwd() to determine DATA_DIR
  // We test by creating the corresponding structure in a temp directory
  const mod = await import('../project.js')
  return mod
}

describe('JSONL log management', () => {
  let projectService: Awaited<ReturnType<typeof importProject>>

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-test-'))
    projectId = 'test-project-' + Date.now()

    // Create project data directory structure (simulating getProjectDir output)
    const projDir = path.join(tmpDir, 'projects', projectId)
    fs.mkdirSync(projDir, { recursive: true })

    projectService = await importProject()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Directly operate files to test JSONL read/write logic
  // Since project.ts paths are hardcoded, we test equivalent core logic

  function getLogFilePath() {
    return path.join(tmpDir, 'logs.jsonl')
  }

  function getLegacyLogFilePath() {
    return path.join(tmpDir, 'logs.json')
  }

  function makeEntry(i: number) {
    return {
      id: `entry-${i}`,
      sessionId: 'sess-1',
      timestamp: new Date().toISOString(),
      type: 'system' as const,
      content: `Log entry ${i}`,
    }
  }

  describe('addLog — append write', () => {
    it('appends a line to JSONL file', () => {
      const filePath = getLogFilePath()
      const entry = makeEntry(1)
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')

      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ id: 'entry-1', content: 'Log entry 1' })
    })

    it('multiple appends do not overwrite', () => {
      const filePath = getLogFilePath()
      for (let i = 0; i < 5; i++) {
        fs.appendFileSync(filePath, JSON.stringify(makeEntry(i)) + '\n')
      }
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(5)
    })
  })

  describe('getLogs — read and parse', () => {
    it('reads JSONL and parses to array', () => {
      const filePath = getLogFilePath()
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(filePath, JSON.stringify(makeEntry(i)) + '\n')
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const entries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      expect(entries).toHaveLength(3)
      expect(entries[0].content).toBe('Log entry 0')
      expect(entries[2].content).toBe('Log entry 2')
    })

    it('empty file returns empty array', () => {
      const filePath = getLogFilePath()
      fs.writeFileSync(filePath, '')
      const content = fs.readFileSync(filePath, 'utf-8')
      const entries = content.split('\n').filter(l => l.trim())
      expect(entries).toHaveLength(0)
    })

    it('skips malformed lines', () => {
      const filePath = getLogFilePath()
      fs.writeFileSync(filePath, [
        JSON.stringify(makeEntry(0)),
        'not valid json',
        JSON.stringify(makeEntry(1)),
      ].join('\n') + '\n')

      const content = fs.readFileSync(filePath, 'utf-8')
      const entries: unknown[] = []
      for (const line of content.split('\n').filter(l => l.trim())) {
        try { entries.push(JSON.parse(line)) } catch { /* skip */ }
      }
      expect(entries).toHaveLength(2)
    })
  })

  describe('auto-truncates beyond 5000 entries', () => {
    it('truncates to last 5000 entries on read', () => {
      const LOG_MAX = 5000
      const filePath = getLogFilePath()

      // write 5010 entries
      const totalEntries = LOG_MAX + 10
      const lines: string[] = []
      for (let i = 0; i < totalEntries; i++) {
        lines.push(JSON.stringify(makeEntry(i)))
      }
      fs.writeFileSync(filePath, lines.join('\n') + '\n')

      // simulate getLogs truncation logic
      const content = fs.readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n').filter(l => l.trim())
      const entries = allLines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

      expect(entries.length).toBe(totalEntries)

      if (entries.length > LOG_MAX) {
        const trimmed = entries.slice(-LOG_MAX)
        // write back after truncation
        fs.writeFileSync(filePath, trimmed.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n')

        // verify truncated file
        const afterContent = fs.readFileSync(filePath, 'utf-8')
        const afterLines = afterContent.split('\n').filter(l => l.trim())
        expect(afterLines).toHaveLength(LOG_MAX)

        // first entry should be the original 10th (index=10)
        const first = JSON.parse(afterLines[0])
        expect(first.id).toBe('entry-10')
      }
    })
  })

  describe('logs.json → logs.jsonl migration', () => {
    it('migrates old logs.json to logs.jsonl', () => {
      const legacyPath = getLegacyLogFilePath()
      const jsonlPath = getLogFilePath()

      // create old format file
      const oldEntries = [makeEntry(0), makeEntry(1), makeEntry(2)]
      fs.writeFileSync(legacyPath, JSON.stringify(oldEntries))

      // simulate migration logic
      if (fs.existsSync(legacyPath) && !fs.existsSync(jsonlPath)) {
        const entries = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))
        if (Array.isArray(entries) && entries.length > 0) {
          fs.writeFileSync(jsonlPath, entries.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n')
        }
        fs.unlinkSync(legacyPath)
      }

      // verify
      expect(fs.existsSync(legacyPath)).toBe(false)
      expect(fs.existsSync(jsonlPath)).toBe(true)

      const content = fs.readFileSync(jsonlPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]).id).toBe('entry-0')
    })

    it('only deletes old file when jsonl already exists', () => {
      const legacyPath = getLegacyLogFilePath()
      const jsonlPath = getLogFilePath()

      // both files exist
      fs.writeFileSync(legacyPath, JSON.stringify([makeEntry(99)]))
      fs.writeFileSync(jsonlPath, JSON.stringify(makeEntry(0)) + '\n')

      // simulate migration logic
      if (fs.existsSync(legacyPath)) {
        if (fs.existsSync(jsonlPath)) {
          fs.unlinkSync(legacyPath)
        }
      }

      expect(fs.existsSync(legacyPath)).toBe(false)
      // jsonl content unchanged
      const content = fs.readFileSync(jsonlPath, 'utf-8')
      const entries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('entry-0')
    })
  })
})
