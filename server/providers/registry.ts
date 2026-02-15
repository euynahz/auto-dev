import type { AgentProvider } from './types.js'
import { claudeProvider } from './claude.js'

// ===== Provider 注册表 =====

const providers = new Map<string, AgentProvider>()

// 内置 provider
providers.set('claude', claudeProvider)

/** 获取 provider，不存在则返回 undefined */
export function getProvider(name: string): AgentProvider | undefined {
  return providers.get(name)
}

/** 获取 provider，不存在则抛错 */
export function requireProvider(name: string): AgentProvider {
  const p = providers.get(name)
  if (!p) throw new Error(`Unknown provider: ${name}. Available: ${listProviders().join(', ')}`)
  return p
}

/** 注册自定义 provider */
export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider)
}

/** 列出所有已注册 provider 名称 */
export function listProviders(): string[] {
  return Array.from(providers.keys())
}

/** 获取所有 provider 的摘要信息（给前端用） */
export function getProviderSummaries(): Array<{
  name: string
  displayName: string
  capabilities: AgentProvider['capabilities']
}> {
  return Array.from(providers.values()).map(p => ({
    name: p.name,
    displayName: p.displayName,
    capabilities: p.capabilities,
  }))
}

export { claudeProvider } from './claude.js'
export type { AgentProvider, AgentEvent, SessionContext, ProviderCapabilities } from './types.js'
