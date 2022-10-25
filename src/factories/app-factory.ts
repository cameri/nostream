import { App } from '../app/app'
import { SettingsStatic } from '../utils/settings'

export const appFactory = () => {
  return new App(SettingsStatic.createSettings)
}
