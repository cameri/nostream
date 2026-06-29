import cluster from 'cluster'
import os from 'os'

import { metrics, type Counter, type UpDownCounter } from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

import { createLogger } from '../factories/logger-factory'

const logger = createLogger('telemetry-metrics')

export interface RelayMetricInstruments {
  eventsAcceptedTotal: Counter
  eventsRejectedTotal: Counter
  websocketConnections: UpDownCounter
}

let relayMetricInstruments: RelayMetricInstruments | undefined
let meterProvider: MeterProvider | undefined

const getWorkerAttributes = () => {
  const workerType = process.env.WORKER_TYPE ?? (cluster.isPrimary ? 'primary' : 'worker')
  const workerIndex = process.env.WORKER_INDEX

  return {
    worker_type: workerType,
    ...(workerIndex ? { worker_index: workerIndex } : {}),
  }
}

const getCpuLoadPercent = (): number => {
  const cores = Math.max(os.cpus().length, 1)
  const oneMinuteLoad = os.loadavg()[0]

  return Number(((oneMinuteLoad / cores) * 100).toFixed(2))
}

const getMemoryUsedMb = (): number => {
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2))
}

const ensureExporterEndpoint = (): string | undefined => {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    return undefined
  }

  if (endpoint.endsWith('/v1/metrics')) {
    return endpoint
  }

  return `${endpoint.replace(/\/$/, '')}/v1/metrics`
}

const createRelayMetricInstruments = (): RelayMetricInstruments => {
  const meter = metrics.getMeter('nostream')

  const workerAttributes = getWorkerAttributes()
  const processCpuLoadGauge = meter.createObservableGauge('nostream.process.cpu_load_percent', {
    description: 'CPU load percent normalized by number of CPU cores',
  })
  const processMemoryGauge = meter.createObservableGauge('nostream.process.memory_used_mb', {
    description: 'Heap memory used by current process in MB',
  })

  meter.addBatchObservableCallback(
    (observableResult) => {
      observableResult.observe(processCpuLoadGauge, getCpuLoadPercent(), workerAttributes)
      observableResult.observe(processMemoryGauge, getMemoryUsedMb(), workerAttributes)
    },
    [processCpuLoadGauge, processMemoryGauge],
  )

  return {
    eventsAcceptedTotal: meter.createCounter('nostream.events.accepted_total', {
      description: 'Total number of accepted events',
    }),
    eventsRejectedTotal: meter.createCounter('nostream.events.rejected_total', {
      description: 'Total number of rejected events',
    }),
    websocketConnections: meter.createUpDownCounter('nostream.websocket.connections', {
      description: 'Active websocket connections',
    }),
  }
}

export const initializeMetricsTelemetry = (): RelayMetricInstruments => {
  if (relayMetricInstruments) {
    return relayMetricInstruments
  }

  const endpoint = ensureExporterEndpoint()
  if (!endpoint) {
    logger('OTEL_EXPORTER_OTLP_ENDPOINT is not set; metrics exporter is disabled')
    relayMetricInstruments = createRelayMetricInstruments()
    return relayMetricInstruments
  }

  meterProvider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'nostream',
      'service.version': process.env.npm_package_version ?? 'unknown',
      ...getWorkerAttributes(),
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: endpoint }),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || 10000),
      }),
    ],
  })

  metrics.setGlobalMeterProvider(meterProvider)
  relayMetricInstruments = createRelayMetricInstruments()
  logger('metrics exporter enabled; endpoint=%s', endpoint)

  return relayMetricInstruments
}

export const getRelayMetricInstruments = (): RelayMetricInstruments => {
  return relayMetricInstruments ?? initializeMetricsTelemetry()
}

export const shutdownMetricsTelemetry = async (): Promise<void> => {
  if (!meterProvider) {
    return
  }

  try {
    await meterProvider.shutdown()
  } catch (error) {
    logger.warn('error while shutting down metrics provider: %o', error)
  }
}
