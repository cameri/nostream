export enum WebSocketAdapterEvent {
  Send = 'send',
  Broadcast = 'broadcast'
}

export enum WebSocketServerAdapterEvent {
  Broadcast = 'broadcast',
  Close = 'close',
  Connection = 'connection'
}
