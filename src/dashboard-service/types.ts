export interface TopTalker {
  pubkey: string
  count: number
}

export interface KPISnapshot {
  sequence: number
  generatedAt: string
  status: 'placeholder'
  metrics: {
    eventsByKind: Array<{ kind: string, count: number }>
    admittedUsers: number | null
    satsPaid: number | null
    topTalkers: TopTalker[]
  }
}

export interface DashboardSnapshotResponse {
  data: KPISnapshot
}

export interface DashboardWebSocketEnvelope<TType extends string, TPayload> {
  type: TType
  payload: TPayload
}

export type DashboardServerMessage =
  | DashboardWebSocketEnvelope<'dashboard.connected', { at: string }>
  | DashboardWebSocketEnvelope<'kpi.snapshot', KPISnapshot>
  | DashboardWebSocketEnvelope<'kpi.tick', { at: string, sequence: number }>
