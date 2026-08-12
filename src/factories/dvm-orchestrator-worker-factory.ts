import process from 'process'
import { DvmOrchestratorWorker } from '../app/dvm-orchestrator-worker'
import { createSettings } from './settings-factory'

export const dvmOrchestratorWorkerFactory = () => {
  return new DvmOrchestratorWorker(process, createSettings)
}
