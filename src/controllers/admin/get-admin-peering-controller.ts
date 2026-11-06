import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { Settings } from '../../@types/settings'
import { mergePeeringRows } from '../../utils/admin-peering'
import { PeeringRequestStatsStore } from '../../utils/peering-request-stats'
import { PeeringSyncStateStore } from '../../utils/peering-sync-state'
import { loadMergedSettings } from '../../utils/settings-config'

export class GetAdminPeeringController implements IController {
  public constructor(
    private readonly stateStore: PeeringSyncStateStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
    private readonly requestStatsStore?: PeeringRequestStatsStore,
  ) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const [states, settings, requestStats] = await Promise.all([
      this.stateStore.list(),
      this.getSettings(),
      this.requestStatsStore?.list() ?? [],
    ])
    const peers = mergePeeringRows(settings, states, undefined, requestStats)

    response.status(200).setHeader('content-type', 'application/json').send({ peers })
  }
}
