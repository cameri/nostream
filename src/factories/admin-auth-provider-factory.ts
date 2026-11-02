import { PasswordAdminAuthProvider } from '../admin/password-admin-auth-provider'
import { IAdminAuthProvider } from '../@types/admin'
import { recordAdminAuditFromRequest } from '../utils/record-admin-audit'
import { createSettings } from './settings-factory'

export const createAdminAuthProvider = (): IAdminAuthProvider => {
  return new PasswordAdminAuthProvider(createSettings, async (event, request) => {
    await recordAdminAuditFromRequest(event === 'login' ? 'admin.login' : 'admin.logout', request)
  })
}
