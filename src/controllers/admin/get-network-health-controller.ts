import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IRelayProbeSnapshotStore } from '../../@types/relay-probe-snapshot'
import { Settings } from '../../@types/settings'
import {
  buildNetworkHealthMismatchContext,
  enrichSnapshotWithMismatches,
} from '../../utils/network-health-mismatches'
import { loadMergedSettings } from '../../utils/settings-config'

export class GetAdminNetworkHealthController implements IController {
  public constructor(
    private readonly snapshotStore: IRelayProbeSnapshotStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
  ) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const snapshot = await this.snapshotStore.getLatest()

    if (!snapshot) {
      response.status(200).setHeader('content-type', 'application/json').send({ snapshot: null })
      return
    }

    const settings = this.getSettings()
    const enriched = enrichSnapshotWithMismatches(
      snapshot,
      buildNetworkHealthMismatchContext(snapshot, settings),
    )

    response.status(200).setHeader('content-type', 'application/json').send({ snapshot: enriched })
  }
}
