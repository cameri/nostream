import { Request, Response } from 'express'

import { ICacheAdapter } from '../../@types/adapters'
import { IController } from '../../@types/controllers'
import { IRelayProbeSnapshotStore, RelayProbeRunSnapshot } from '../../@types/relay-probe-snapshot'
import { Settings } from '../../@types/settings'
import { buildProbeOptions, RunProbeFn } from '../../app/relay-monitor-worker'
import { createLogger } from '../../factories/logger-factory'
import { recordProbeRunMetrics } from '../../telemetry/ops-metrics'
import { recordAdminAuditFromRequest } from '../../utils/record-admin-audit'
import { notifyProbeRunTransition } from '../../utils/ops-trust-notifications'
import { getEffectiveProbeIntervalSeconds, getNip66HistoryRetention } from '../../utils/nip66-schedule'
import { runProbe } from '../../utils/relay-probe'
import { RelayProbeHistoryStore } from '../../utils/relay-probe-history'
import { deriveRelayProbeRunStatus, serializeProbeResults } from '../../utils/relay-probe-snapshot'
import {
  filterValidProbeTargets,
  resolveProbeTargets,
  resolvePublicProbeTargetKeys,
} from '../../utils/relay-probe-targets'
import { loadMergedSettings } from '../../utils/settings-config'
import { ProbeResult } from '../../utils/relay-probe/types'

const logger = createLogger('post-admin-network-health-run')

export class PostAdminNetworkHealthRunController implements IController {
  public constructor(
    private readonly snapshotStore: IRelayProbeSnapshotStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
    private readonly probeRunner: RunProbeFn = runProbe,
    private readonly historyStore?: RelayProbeHistoryStore,
    private readonly opsCache?: ICacheAdapter,
  ) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const started = Date.now()
    const currentSettings = this.getSettings()

    if (!currentSettings.nip66?.enabled) {
      response.status(409).setHeader('content-type', 'application/json').send({ error: 'NIP-66 monitoring is disabled' })
      return
    }

    const configuredTargets = resolveProbeTargets(currentSettings)
    const { valid, invalid } = filterValidProbeTargets(configuredTargets)

    if (valid.length === 0) {
      response
        .status(400)
        .setHeader('content-type', 'application/json')
        .send({ error: 'No valid probe targets configured', invalid })
      return
    }

    const probeOptions = buildProbeOptions(currentSettings)
    const results: ProbeResult[] = []

    for (const target of valid) {
      try {
        results.push(await this.probeRunner(target, probeOptions))
      } catch (error) {
        logger.error('manual probe failed for %s: %o', target, error)
      }
    }

    if (results.length === 0) {
      response.status(502).setHeader('content-type', 'application/json').send({ error: 'Probe run produced no results' })
      return
    }

    const publicTargetKeys = resolvePublicProbeTargetKeys(currentSettings)
    const snapshot: RelayProbeRunSnapshot = {
      runAt: new Date().toISOString(),
      targets: valid,
      results: serializeProbeResults(results),
      status: deriveRelayProbeRunStatus(results),
      probeContext: {
        configuredRelayUrl: currentSettings.info?.relay_url,
        publicTargetKeys: [...publicTargetKeys],
      },
    }

    const expirySeconds = getEffectiveProbeIntervalSeconds(currentSettings) * 2
    await this.snapshotStore.saveLatest(snapshot, expirySeconds)

    if (this.historyStore) {
      try {
        await this.historyStore.append(snapshot, getNip66HistoryRetention(currentSettings))
      } catch (error) {
        logger.error('failed to save probe history: %o', error)
      }
    }

    recordProbeRunMetrics(snapshot.status, Date.now() - started)
    await notifyProbeRunTransition(this.opsCache, snapshot)
    await recordAdminAuditFromRequest('probe.manual_run', request, {
      status: snapshot.status,
      targets: valid,
    })

    response.status(200).setHeader('content-type', 'application/json').send({ snapshot })
  }
}
