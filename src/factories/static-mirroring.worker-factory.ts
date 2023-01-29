import { createSettings } from './settings-factory'
import { StaticMirroringWorker } from '../app/static-mirroring-worker'

export const staticMirroringWorkerFactory = () => {
  return new StaticMirroringWorker(process, createSettings)
}
