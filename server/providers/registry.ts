import type { AgentProvider } from './types.js'
import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'
import { opencodeProvider } from './opencode.js'

// ===== Provider Registry =====

const providers = new Map<string, AgentProvider>()

// Built-in providers
providers.set('claude', claudeProvider)
providers.set('codex', codexProvider)
providers.set('opencode', opencodeProvider)

/** Get provider, returns undefined if not found */
export function getProvider(name: string): AgentProvider | undefined {
  return providers.get(name)
}

/** Get provider, throws if not found */
export function requireProvider(name: string): AgentProvider {
  const p = providers.get(name)
  if (!p) throw new Error(`Unknown provider: ${name}. Available: ${listProviders().join(', ')}`)
  return p
}

/** Register custom provider */
export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider)
}

/** List all registered provider names */
export function listProviders(): string[] {
  return Array.from(providers.keys())
}

/** Get summary info for all providers (for frontend) */
export function getProviderSummaries(): Array<{
  name: string
  displayName: string
  defaultModel?: string
  capabilities: AgentProvider['capabilities']
  settings?: AgentProvider['settings']
}> {
  return Array.from(providers.values()).map(p => ({
    name: p.name,
    displayName: p.displayName,
    ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
    capabilities: p.capabilities,
    ...(p.settings?.length ? { settings: p.settings } : {}),
  }))
}

export { claudeProvider } from './claude.js'
export type { AgentProvider, AgentEvent, SessionContext, ProviderCapabilities } from './types.js'
