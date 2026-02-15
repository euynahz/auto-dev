import { describe, it, expect } from 'vitest'
import { textSimilarity, parseThinkingContent } from '../agent.js'

describe('textSimilarity', () => {
  it('完全相同的字符串 → 1.0', () => {
    expect(textSimilarity('hello world foo', 'hello world foo')).toBe(1)
  })

  it('完全不同的字符串 → 0', () => {
    expect(textSimilarity('aaa bbb ccc', 'xxx yyy zzz')).toBe(0)
  })

  it('部分重叠 → 0 < result < 1', () => {
    const result = textSimilarity('hello world foo bar', 'hello world baz qux')
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(1)
  })

  it('空字符串 → 0', () => {
    expect(textSimilarity('', 'hello world foo')).toBe(0)
    expect(textSimilarity('hello world foo', '')).toBe(0)
    expect(textSimilarity('', '')).toBe(0)
  })

  it('短词（≤2字符）被忽略', () => {
    // 只有短词 → 过滤后集合为空 → 0
    expect(textSimilarity('a b c', 'a b c')).toBe(0)
    // 混合：短词不参与计算
    expect(textSimilarity('is a hello', 'is a world')).toBe(0) // hello vs world, no overlap
  })
})

describe('parseThinkingContent', () => {
  it('单层 tool_use 对象 → "toolName → summary"', () => {
    const json = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/test.ts' },
    })
    expect(parseThinkingContent(json)).toBe('Read → /tmp/test.ts')
  })

  it('tool_use 无关键参数 → 只返回 name', () => {
    const json = JSON.stringify({
      type: 'tool_use',
      name: 'ListFiles',
      input: {},
    })
    expect(parseThinkingContent(json)).toBe('ListFiles')
  })

  it('content 数组含 text + tool_use → 拼接', () => {
    const json = JSON.stringify({
      content: [
        { type: 'text', text: 'Let me check the file' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'index.ts' } },
      ],
      role: 'assistant',
    })
    const result = parseThinkingContent(json)
    expect(result).toContain('Let me check the file')
    expect(result).toContain('Read → index.ts')
  })

  it('有 message 字段（字符串） → 返回 message', () => {
    const json = JSON.stringify({ message: 'Something went wrong' })
    expect(parseThinkingContent(json)).toBe('Something went wrong')
  })

  it('type + model 兜底 → "type · model"', () => {
    const json = JSON.stringify({ type: 'response', model: 'claude-opus-4-6' })
    const result = parseThinkingContent(json)
    expect(result).toContain('response')
    expect(result).toContain('claude-opus-4-6')
  })

  it('非 JSON → 截断返回原文', () => {
    const text = 'This is not JSON at all, just plain text'
    expect(parseThinkingContent(text)).toBe(text)
  })

  it('超长非 JSON → 截断到 200 字符', () => {
    const text = 'x'.repeat(300)
    expect(parseThinkingContent(text)).toBe('x'.repeat(200))
  })
})
