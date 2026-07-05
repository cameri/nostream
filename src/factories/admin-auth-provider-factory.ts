import { PasswordAdminAuthProvider } from '../admin/password-admin-auth-provider'
import { IAdminAuthProvider } from '../@types/admin'
import { createSettings } from './settings-factory'

export const createAdminAuthProvider = (): IAdminAuthProvider => {
  return new PasswordAdminAuthProvider(createSettings)
}
