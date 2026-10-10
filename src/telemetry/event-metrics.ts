import type { EventId } from '../@types/base'
import { createCommandResult } from '../utils/messages'
import { getRelayMetricInstruments } from './metrics'

export const createEventCommandResult = (eventId: EventId, successful: boolean, message: string, params?: string) => {
  const instruments = getRelayMetricInstruments()

  if (successful) {
    instruments.eventsAcceptedTotal.add(1)
  } else {
    instruments.eventsRejectedTotal.add(1)
  }

  return createCommandResult(eventId, successful, message, params)
}

export const recordWebsocketConnectionOpened = (): void => {
  getRelayMetricInstruments().websocketConnections.add(1)
}

export const recordWebsocketConnectionClosed = (): void => {
  getRelayMetricInstruments().websocketConnections.add(-1)
}
