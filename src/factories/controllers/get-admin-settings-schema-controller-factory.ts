import { GetAdminSettingsSchemaController } from '../../controllers/admin/get-settings-schema-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminSettingsSchemaController = (): IController => {
  return new GetAdminSettingsSchemaController()
}
