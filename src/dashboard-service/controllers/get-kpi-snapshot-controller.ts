import { Request, Response } from 'express'

import { DashboardSnapshotResponse } from '../types'
import { IController } from '../../@types/controllers'
import { SnapshotService } from '../services/snapshot-service'

export class GetKPISnapshotController implements IController {
  public constructor(private readonly snapshotService: SnapshotService) { }

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const payload: DashboardSnapshotResponse = {
      data: this.snapshotService.getSnapshot(),
    }

    response
      .status(200)
      .setHeader('content-type', 'application/json; charset=utf-8')
      .send(payload)
  }
}