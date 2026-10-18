import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { Settings } from '../../@types/settings'
import { AdminOpsStore } from '../../utils/admin-ops-store'
import { listConfiguredMirrors, mergeMirrorRows } from '../../utils/admin-ops-config'
import { loadMergedSettings } from '../../utils/settings-config'

export class GetAdminOpsMirrorsController implements IController {
  public constructor(
    private readonly opsStore: AdminOpsStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
  ) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const [heartbeats, settings] = await Promise.all([this.opsStore.listMirrorHeartbeats(), this.getSettings()])
    const mirrors = mergeMirrorRows(listConfiguredMirrors(settings), heartbeats)

    response.status(200).setHeader('content-type', 'application/json').send({ mirrors })
  }
}
