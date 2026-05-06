import { EventEmitter } from 'node:events'

const bus = new EventEmitter()
bus.setMaxListeners(200)

const state = {
  analyticsVersion: 0,
  configVersion: 0,
  lastEventAt: null,
}

function nowIso() {
  return new Date().toISOString()
}

function snapshot() {
  return {
    analyticsVersion: state.analyticsVersion,
    configVersion: state.configVersion,
    lastEventAt: state.lastEventAt,
    serverTime: nowIso(),
  }
}

function bump(topic) {
  if (topic === 'analytics') state.analyticsVersion += 1
  if (topic === 'config') state.configVersion += 1
}

export const liveSyncBus = {
  on: (...args) => bus.on(...args),
  off: (...args) => bus.off(...args),
  snapshot,
  publish(event, payload = {}) {
    const topics = Array.isArray(payload.topics) ? payload.topics : []
    for (const topic of topics) bump(topic)
    state.lastEventAt = nowIso()
    const packet = {
      event: String(event || 'sync'),
      payload,
      ...snapshot(),
    }
    bus.emit('sync', packet)
    for (const topic of topics) {
      bus.emit(`topic:${topic}`, packet)
    }
  },
}
