import cluster from 'cluster'
import process from 'process'

import { App } from '../app/app'
import { SettingsStatic } from '../utils/settings'

export const appFactory = () => {
  return new App(process, cluster, SettingsStatic.createSettings)
}
