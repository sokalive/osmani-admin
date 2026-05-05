import { EventEmitter } from 'node:events'

/** In-process realtime fan-out (single server instance). Use with SSE /subscription-stream. */
export const deviceSubscriptionBus = new EventEmitter()
deviceSubscriptionBus.setMaxListeners(200)
