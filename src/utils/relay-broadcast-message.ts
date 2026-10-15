import { Serializable } from 'child_process'

import { Event } from '../@types/event'
import { WebSocketServerAdapterEvent } from '../constants/adapter'

export type RelayBroadcastMessage = {
  eventName: WebSocketServerAdapterEvent.Broadcast
  event: Event
  source?: string
}

export const isRelayBroadcastMessage = (message: Serializable): message is RelayBroadcastMessage => {
  if (typeof message !== 'object' || message === null) {
    return false
  }

  const candidate = message as RelayBroadcastMessage

  return (
    candidate.eventName === WebSocketServerAdapterEvent.Broadcast &&
    typeof candidate.event === 'object' &&
    candidate.event !== null &&
    typeof candidate.event.id === 'string'
  )
}

export const isRelayBroadcastFanoutEnabled = (): boolean => {
  const value = process.env.RELAY_BROADCAST_FANOUT?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export const getRelayBroadcastStreamKey = (): string => {
  const key = process.env.RELAY_BROADCAST_STREAM_KEY?.trim()
  return key && key.length > 0 ? key : 'nostream:relay:broadcast'
}

const DEFAULT_STREAM_MAXLEN = 50_000

export const getRelayBroadcastStreamMaxLen = (): number => {
  const raw = process.env.RELAY_BROADCAST_STREAM_MAXLEN?.trim()
  if (raw === undefined || raw === '') {
    return DEFAULT_STREAM_MAXLEN
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_STREAM_MAXLEN
  }

  return Math.floor(parsed)
}
