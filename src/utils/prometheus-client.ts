import axios from 'axios'

import { createLogger } from '../factories/logger-factory'

const logger = createLogger('prometheus-client')

const DEFAULT_PROMETHEUS_URL = 'http://127.0.0.1:9090'

interface PrometheusInstantQueryResponse {
  status: 'success' | 'error'
  data?: {
    resultType: 'vector' | 'scalar' | string
    result:
      | Array<{
          value?: [number, string]
        }>
      | [number, string]
  }
  error?: string
  errorType?: string
}

export const getPrometheusBaseUrl = (): string => {
  const configured = process.env.PROMETHEUS_URL?.trim()
  if (!configured) {
    return DEFAULT_PROMETHEUS_URL
  }

  return configured.replace(/\/+$/, '')
}

export const parsePrometheusInstantQueryScalar = (response: PrometheusInstantQueryResponse): number | undefined => {
  if (response.status !== 'success') {
    return undefined
  }

  const data = response.data
  let rawValue: string | undefined

  if (data?.resultType === 'scalar' && Array.isArray(data.result) && data.result.length >= 2) {
    rawValue = String(data.result[1])
  } else if (Array.isArray(data?.result)) {
    const vectorResult = data.result as Array<{ value?: [number, string] }>
    rawValue = vectorResult[0]?.value?.[1]
  }

  if (rawValue === undefined) {
    return undefined
  }

  const parsed = Number(rawValue)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const queryPrometheusInstant = async (query: string): Promise<number | undefined> => {
  const baseUrl = getPrometheusBaseUrl()

  try {
    const timeoutCandidate = Number(process.env.PROMETHEUS_QUERY_TIMEOUT_MS)
    const timeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate > 0 ? timeoutCandidate : 5000

    const response = await axios.get<PrometheusInstantQueryResponse>(`${baseUrl}/api/v1/query`, {
      params: { query },
      timeout: timeoutMs,
      validateStatus: () => true,
    })

    if (response.status !== 200) {
      logger.warn('prometheus query failed with HTTP %d: %s', response.status, query)
      return undefined
    }

    if (response.data.status !== 'success') {
      logger.warn('prometheus query error for %s: %s', query, response.data.error ?? response.data.errorType ?? 'unknown')
      return undefined
    }

    return parsePrometheusInstantQueryScalar(response.data)
  } catch (error) {
    logger.warn('prometheus query request failed for %s: %o', query, error)
    return undefined
  }
}
