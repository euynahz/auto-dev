import { useState, useEffect } from 'react'
import type { ProviderInfo } from '@/types'
import { api } from '@/lib/api'

/** 缓存 providers，避免每次打开 Dialog 都请求 */
let cachedProviders: ProviderInfo[] | null = null

export function useProviders() {
  const [providers, setProviders] = useState<ProviderInfo[]>(cachedProviders || [])
  const [loading, setLoading] = useState(!cachedProviders)

  useEffect(() => {
    if (cachedProviders) return
    api.getProviders()
      .then((data) => {
        cachedProviders = data
        setProviders(data)
      })
      .catch(() => {
        // fallback: 至少有 claude
        const fallback: ProviderInfo[] = [{
          name: 'claude',
          displayName: 'Claude Code',
          defaultModel: 'claude-opus-4-6',
          capabilities: {
            streaming: true, maxTurns: true, systemPrompt: true,
            agentTeams: true, modelSelection: true, dangerousMode: true,
          },
        }]
        cachedProviders = fallback
        setProviders(fallback)
      })
      .finally(() => setLoading(false))
  }, [])

  const getProvider = (name: string) => providers.find(p => p.name === name)

  return { providers, loading, getProvider }
}
