import { clearDnsProbeCache, getCachedDnsResult, setCachedDnsResult } from './dns-cache'
import { createNodeDnsResolver, DnsResolver, resolveDnsRecords } from './dns-probe'
import { createNodeNip11Fetcher, Nip11Fetcher, probeNip11 } from './nip11-probe'
import { parseProbeTarget, shouldSkipDnsProbe } from './target'
import { createNodeTlsConnector, probeTls, TlsConnector } from './tls-probe'
import {
  DEFAULT_DNS_CACHE_TTL_SECONDS,
  DEFAULT_PROBE_TIMEOUTS,
  DnsResult,
  ProbeCheckResult,
  ProbeOptions,
  ProbeResult,
  ProbeTarget,
  ProbeTimeouts,
} from './types'
import { createNodeWebSocketConnector, probeWebSocketRtt, WebSocketConnector } from './ws-rtt-probe'

export interface ProbeClients {
  dns: DnsResolver
  tls: TlsConnector
  ws: WebSocketConnector
  nip11: Nip11Fetcher
}

export const createDefaultProbeClients = (): ProbeClients => ({
  dns: createNodeDnsResolver(),
  tls: createNodeTlsConnector(),
  ws: createNodeWebSocketConnector(),
  nip11: createNodeNip11Fetcher(),
})

const mergeTimeouts = (timeouts?: Partial<ProbeTimeouts>): ProbeTimeouts => ({
  ...DEFAULT_PROBE_TIMEOUTS,
  ...timeouts,
})

const runTimedProbe = async <T>(
  runner: () => Promise<T>,
): Promise<ProbeCheckResult<T>> => {
  const startedAt = Date.now()

  try {
    const data = await runner()

    return {
      status: 'ok',
      durationMs: Date.now() - startedAt,
      data,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: message,
    }
  }
}

const runDnsProbe = async (
  clients: ProbeClients,
  target: ProbeTarget,
  options: Required<Pick<ProbeOptions, 'dnsCacheTtlSeconds' | 'skipDnsCache'>>,
): Promise<ProbeCheckResult<DnsResult>> => {
  const startedAt = Date.now()

  if (shouldSkipDnsProbe(target.networkType)) {
    return {
      status: 'skipped',
      durationMs: Date.now() - startedAt,
      error: `DNS probe skipped for ${target.networkType} destination`,
    }
  }

  if (!options.skipDnsCache) {
    const cached = getCachedDnsResult(target.hostname)
    if (cached) {
      return {
        status: 'ok',
        durationMs: Date.now() - startedAt,
        data: cached,
      }
    }
  }

  try {
    const records = await resolveDnsRecords(clients.dns, target)

    if (!options.skipDnsCache) {
      setCachedDnsResult(target.hostname, records, options.dnsCacheTtlSeconds)
    }

    return {
      status: 'ok',
      durationMs: Date.now() - startedAt,
      data: {
        hostname: target.hostname,
        records,
        fromCache: false,
      },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)

    return {
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: message,
    }
  }
}

export const runProbe = async (
  relayUrl: string,
  options: ProbeOptions = {},
  clients: ProbeClients = createDefaultProbeClients(),
): Promise<ProbeResult> => {
  const target = parseProbeTarget(relayUrl)
  const timeouts = mergeTimeouts(options.timeouts)
  const dnsCacheTtlSeconds = options.dnsCacheTtlSeconds ?? DEFAULT_DNS_CACHE_TTL_SECONDS
  const skipDnsCache = options.skipDnsCache ?? false

  const [dns, tls, wsRtt, nip11] = await Promise.all([
    runDnsProbe(clients, target, { dnsCacheTtlSeconds, skipDnsCache }),
    runTimedProbe(() => probeTls(clients.tls, target, timeouts.tlsMs)),
    runTimedProbe(() => probeWebSocketRtt(clients.ws, target, timeouts.wsRttMs)),
    runTimedProbe(() => probeNip11(clients.nip11, target.nip11Url, timeouts.nip11Ms)),
  ])

  return {
    target,
    checkedAt: new Date(),
    dns,
    tls,
    wsRtt,
    nip11,
  }
}

export { clearDnsProbeCache, parseProbeTarget }
