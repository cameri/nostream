export interface TopTalker {
  pubkey: string
  count: number
}

export interface EventsByKindCount {
  kind: string
  count: number
}

export interface DashboardMetrics {
  eventsByKind: EventsByKindCount[]
  admittedUsers: number
  satsPaid: number
  topTalkers: {
    allTime: TopTalker[]
    recent: TopTalker[]
  }
}

export interface KPISnapshot {
  sequence: number
  generatedAt: string
  status: 'live' | 'stale'
  metrics: DashboardMetrics
}

export interface DashboardWebSocketEnvelope<TType extends string, TPayload> {
  type: TType
  payload: TPayload
}

export type DashboardServerMessage =
  | DashboardWebSocketEnvelope<'dashboard.connected', { at: string }>
  | DashboardWebSocketEnvelope<'kpi.snapshot', KPISnapshot>
  | DashboardWebSocketEnvelope<'kpi.tick', { at: string, sequence: number }>
