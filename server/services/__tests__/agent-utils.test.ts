import { describe, it, expect } from 'vitest'
import { textSimilarity, parseThinkingContent } from '../agent.js'

describe('textSimilarity', () => {
  it('identical strings → 1.0', () => {
    expect(textSimilarity('hello world foo', 'hello world foo')).toBe(1)
  })

  it('completely different strings → 0', () => {
    expect(textSimilarity('aaa bbb ccc', 'xxx yyy zzz')).toBe(0)
  })

  it('partial overlap → 0 < result < 1', () => {
    const result = textSimilarity('hello world foo bar', 'hello world baz qux')
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(1)
  })

  it('empty string → 0', () => {
    expect(textSimilarity('', 'hello world foo')).toBe(0)
    expect(textSimilarity('hello world foo', '')).toBe(0)
    expect(textSimilarity('', '')).toBe(0)
  })

  it('short words (<=2 chars) are ignored', () => {
    // only short words → filtered set is empty → 0
    expect(textSimilarity('a b c', 'a b c')).toBe(0)
    // mixed: short words excluded from calculation
    expect(textSimilarity('is a hello', 'is a world')).toBe(0) // hello vs world, no overlap
  })
})

describe('parseThinkingContent', () => {
  it('single tool_use object → "toolName → summary"', () => {
    const json = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/test.ts' },
    })
    expect(parseThinkingContent(json)).toBe('Read → /tmp/test.ts')
  })

  it('tool_use without key params → returns name only', () => {
    const json = JSON.stringify({
      type: 'tool_use',
      name: 'ListFiles',
      input: {},
    })
    expect(parseThinkingContent(json)).toBe('ListFiles')
  })

  it('content array with text + tool_use → concatenated', () => {
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

  it('has message field (string) → returns message', () => {
    const json = JSON.stringify({ message: 'Something went wrong' })
    expect(parseThinkingContent(json)).toBe('Something went wrong')
  })

  it('type + model fallback → "type · model"', () => {
    const json = JSON.stringify({ type: 'response', model: 'claude-opus-4-6' })
    const result = parseThinkingContent(json)
    expect(result).toContain('response')
    expect(result).toContain('claude-opus-4-6')
  })

  it('non-JSON → truncated raw text', () => {
    const text = 'This is not JSON at all, just plain text'
    expect(parseThinkingContent(text)).toBe(text)
  })

  it('long non-JSON → truncated to 200 chars', () => {
    const text = 'x'.repeat(300)
    expect(parseThinkingContent(text)).toBe('x'.repeat(200))
  })
})
