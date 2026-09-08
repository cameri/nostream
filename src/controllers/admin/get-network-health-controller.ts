import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IRelayProbeSnapshotStore } from '../../@types/relay-probe-snapshot'

export class GetAdminNetworkHealthController implements IController {
  public constructor(private readonly snapshotStore: IRelayProbeSnapshotStore) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const snapshot = await this.snapshotStore.getLatest()

    response.status(200).setHeader('content-type', 'application/json').send({ snapshot })
  }
}
