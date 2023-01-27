export enum WebSocketAdapterEvent {
  Event = 'event',
  Message = 'message',
  Broadcast = 'broadcast',
  Subscribe = 'subscribe',
  Unsubscribe = 'unsubscribe',
  Heartbeat = 'heartbeat'
}

export enum WebSocketServerAdapterEvent {
  Broadcast = 'broadcast',
  Connection = 'connection'
}
