import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { Settings } from '../../@types/settings'
import { buildAdminDiagnosticsExport } from '../../utils/admin-diagnostics-export'
import { loadMergedSettings } from '../../utils/settings-config'

export class GetAdminDiagnosticsExportController implements IController {
  public constructor(private readonly getSettings: () => Settings = loadMergedSettings) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const payload = await buildAdminDiagnosticsExport(this.getSettings)
    const download = request.query.download === '1' || request.query.download === 'true'

    response.status(200).setHeader('content-type', 'application/json')
    if (download) {
      const stamp = payload.generatedAt.replace(/[:.]/g, '-')
      response.setHeader('content-disposition', `attachment; filename="nostream-diagnostics-${stamp}.json"`)
    }

    response.send(payload)
  }
}
