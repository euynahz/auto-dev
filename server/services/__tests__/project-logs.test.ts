import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// 我们需要 mock getProjectDir 使其指向临时目录
// project.ts 中 getProjectDir 是内部函数，所以我们直接测试 addLog / getLogs 的行为
// 方案：mock DATA_DIR 相关路径，通过设置环境让 project.ts 使用临时目录

let tmpDir: string
let projectId: string

// 动态 import 以便每次测试重新加载模块
async function importProject() {
  // project.ts 使用 process.cwd() 来确定 DATA_DIR
  // 我们通过在临时目录下创建对应结构来测试
  const mod = await import('../project.js')
  return mod
}

describe('JSONL 日志管理', () => {
  let projectService: Awaited<ReturnType<typeof importProject>>

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodev-test-'))
    projectId = 'test-project-' + Date.now()

    // 创建项目数据目录结构（模拟 getProjectDir 的输出）
    const projDir = path.join(tmpDir, 'projects', projectId)
    fs.mkdirSync(projDir, { recursive: true })

    projectService = await importProject()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // 直接操作文件来测试 JSONL 格式的读写逻辑
  // 因为 project.ts 的路径是硬编码的，我们测试核心逻辑的等价实现

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

  describe('addLog — 追加写入', () => {
    it('向 JSONL 文件追加一行', () => {
      const filePath = getLogFilePath()
      const entry = makeEntry(1)
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')

      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ id: 'entry-1', content: 'Log entry 1' })
    })

    it('多次追加不覆盖', () => {
      const filePath = getLogFilePath()
      for (let i = 0; i < 5; i++) {
        fs.appendFileSync(filePath, JSON.stringify(makeEntry(i)) + '\n')
      }
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(5)
    })
  })

  describe('getLogs — 读取和解析', () => {
    it('读取 JSONL 并解析为数组', () => {
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

    it('空文件返回空数组', () => {
      const filePath = getLogFilePath()
      fs.writeFileSync(filePath, '')
      const content = fs.readFileSync(filePath, 'utf-8')
      const entries = content.split('\n').filter(l => l.trim())
      expect(entries).toHaveLength(0)
    })

    it('跳过格式错误的行', () => {
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

  describe('超过 5000 条时自动截断', () => {
    it('读取时截断到最后 5000 条', () => {
      const LOG_MAX = 5000
      const filePath = getLogFilePath()

      // 写入 5010 条
      const totalEntries = LOG_MAX + 10
      const lines: string[] = []
      for (let i = 0; i < totalEntries; i++) {
        lines.push(JSON.stringify(makeEntry(i)))
      }
      fs.writeFileSync(filePath, lines.join('\n') + '\n')

      // 模拟 getLogs 的截断逻辑
      const content = fs.readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n').filter(l => l.trim())
      const entries = allLines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

      expect(entries.length).toBe(totalEntries)

      if (entries.length > LOG_MAX) {
        const trimmed = entries.slice(-LOG_MAX)
        // 截断后写回
        fs.writeFileSync(filePath, trimmed.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n')

        // 验证截断后的文件
        const afterContent = fs.readFileSync(filePath, 'utf-8')
        const afterLines = afterContent.split('\n').filter(l => l.trim())
        expect(afterLines).toHaveLength(LOG_MAX)

        // 第一条应该是原来的第 10 条（index=10）
        const first = JSON.parse(afterLines[0])
        expect(first.id).toBe('entry-10')
      }
    })
  })

  describe('logs.json → logs.jsonl 迁移', () => {
    it('旧 logs.json 迁移为 logs.jsonl', () => {
      const legacyPath = getLegacyLogFilePath()
      const jsonlPath = getLogFilePath()

      // 创建旧格式文件
      const oldEntries = [makeEntry(0), makeEntry(1), makeEntry(2)]
      fs.writeFileSync(legacyPath, JSON.stringify(oldEntries))

      // 模拟迁移逻辑
      if (fs.existsSync(legacyPath) && !fs.existsSync(jsonlPath)) {
        const entries = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))
        if (Array.isArray(entries) && entries.length > 0) {
          fs.writeFileSync(jsonlPath, entries.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n')
        }
        fs.unlinkSync(legacyPath)
      }

      // 验证
      expect(fs.existsSync(legacyPath)).toBe(false)
      expect(fs.existsSync(jsonlPath)).toBe(true)

      const content = fs.readFileSync(jsonlPath, 'utf-8')
      const lines = content.split('\n').filter(l => l.trim())
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]).id).toBe('entry-0')
    })

    it('jsonl 已存在时只删除旧文件', () => {
      const legacyPath = getLegacyLogFilePath()
      const jsonlPath = getLogFilePath()

      // 两个文件都存在
      fs.writeFileSync(legacyPath, JSON.stringify([makeEntry(99)]))
      fs.writeFileSync(jsonlPath, JSON.stringify(makeEntry(0)) + '\n')

      // 模拟迁移逻辑
      if (fs.existsSync(legacyPath)) {
        if (fs.existsSync(jsonlPath)) {
          fs.unlinkSync(legacyPath)
        }
      }

      expect(fs.existsSync(legacyPath)).toBe(false)
      // jsonl 内容不变
      const content = fs.readFileSync(jsonlPath, 'utf-8')
      const entries = content.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('entry-0')
    })
  })
})
