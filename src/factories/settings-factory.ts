import { ISettings } from '../@types/settings'
import { SettingsStatic } from '../utils/settings'

export const createSettings = (): ISettings => SettingsStatic.createSettings()
