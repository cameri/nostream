import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { Settings } from '../../@types/settings'
import {
  buildNetworkHealthMismatchContext,
  enrichSnapshotWithMismatches,
} from '../../utils/network-health-mismatches'
import { MAX_PROBE_HISTORY_API_LIMIT, RelayProbeHistoryStore } from '../../utils/relay-probe-history'
import { loadMergedSettings } from '../../utils/settings-config'

export const DEFAULT_NETWORK_HEALTH_HISTORY_LIMIT = 24

export const parseNetworkHealthHistoryLimit = (raw: unknown): number | null => {
  if (raw === undefined) {
    return DEFAULT_NETWORK_HEALTH_HISTORY_LIMIT
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null
  }

  return Math.min(Math.floor(parsed), MAX_PROBE_HISTORY_API_LIMIT)
}

export class GetAdminNetworkHealthHistoryController implements IController {
  public constructor(
    private readonly historyStore: RelayProbeHistoryStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const limit = parseNetworkHealthHistoryLimit(request.query.limit)
    if (limit === null) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: 'limit must be a positive integer' })
      return
    }

    const settings = this.getSettings()
    const runs = await this.historyStore.list(limit)
    const enriched = runs.map((snapshot) =>
      enrichSnapshotWithMismatches(snapshot, buildNetworkHealthMismatchContext(snapshot, settings)),
    )

    response.status(200).setHeader('content-type', 'application/json').send({ runs: enriched })
  }
}
