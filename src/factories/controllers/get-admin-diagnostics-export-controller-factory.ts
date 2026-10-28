import { IController } from '../../@types/controllers'
import { GetAdminDiagnosticsExportController } from '../../controllers/admin/get-admin-diagnostics-export-controller'
import { createSettings } from '../settings-factory'

export const createGetAdminDiagnosticsExportController = (): IController => {
  return new GetAdminDiagnosticsExportController(createSettings)
}
