import { useState, useEffect } from 'react'
import type { ProviderInfo } from '@/types'
import { api } from '@/lib/api'

/** Cache providers to avoid fetching on every Dialog open */
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
        // fallback: at least have claude
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
