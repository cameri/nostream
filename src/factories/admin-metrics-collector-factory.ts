import { AdminMetricsCollector } from '../utils/admin-metrics'

let collector: AdminMetricsCollector | undefined

export const getAdminMetricsCollector = (): AdminMetricsCollector => {
  if (!collector) {
    collector = new AdminMetricsCollector()
  }

  return collector
}
