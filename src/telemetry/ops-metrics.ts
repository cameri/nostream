import { metrics, type Counter, type Histogram } from '@opentelemetry/api'

import { createLogger } from '../factories/logger-factory'
import { getWorkerAttributes } from './metrics'

const logger = createLogger('telemetry-ops-metrics')

export interface OpsMetricInstruments {
  probeRunsTotal: Counter
  probeRunDurationMs: Histogram
}

let opsMetricInstruments: OpsMetricInstruments | undefined

const createOpsMetricInstruments = (): OpsMetricInstruments => {
  const meter = metrics.getMeter('nostream-ops')

  return {
    probeRunsTotal: meter.createCounter('nostream.probe.runs_total', {
      description: 'NIP-66 probe runs by outcome',
    }),
    probeRunDurationMs: meter.createHistogram('nostream.probe.run_duration_ms', {
      description: 'Wall-clock duration of a probe run in milliseconds',
      unit: 'ms',
    }),
  }
}

export const getOpsMetricInstruments = (): OpsMetricInstruments => {
  if (!opsMetricInstruments) {
    try {
      opsMetricInstruments = createOpsMetricInstruments()
    } catch (error) {
      logger.warn('unable to initialize ops metrics: %o', error)
      opsMetricInstruments = createOpsMetricInstruments()
    }
  }

  return opsMetricInstruments
}

export const recordProbeRunMetrics = (status: string, durationMs: number): void => {
  const instruments = getOpsMetricInstruments()
  const attributes = { ...getWorkerAttributes(), status }
  instruments.probeRunsTotal.add(1, attributes)
  instruments.probeRunDurationMs.record(durationMs, attributes)
}
