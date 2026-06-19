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

function emitPacket(packet) {
  bus.emit('sync', packet)
  const topics = Array.isArray(packet?.payload?.topics) ? packet.payload.topics : []
  for (const topic of topics) {
    bus.emit(`topic:${topic}`, packet)
  }
}

function mergeRemoteVersions(remote) {
  if (!remote || typeof remote !== 'object') return
  if (Number.isFinite(remote.configVersion)) {
    state.configVersion = Math.max(state.configVersion, Math.trunc(remote.configVersion))
  }
  if (Number.isFinite(remote.analyticsVersion)) {
    state.analyticsVersion = Math.max(state.analyticsVersion, Math.trunc(remote.analyticsVersion))
  }
  if (remote.lastEventAt) state.lastEventAt = String(remote.lastEventAt)
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
    emitPacket(packet)
    return packet
  },
  /** Replay a packet from another API instance (Postgres NOTIFY); does not re-bump versions. */
  replay(remotePacket) {
    if (!remotePacket || typeof remotePacket !== 'object') return null
    mergeRemoteVersions(remotePacket)
    const packet = {
      event: String(remotePacket.event || 'sync'),
      payload: remotePacket.payload && typeof remotePacket.payload === 'object' ? remotePacket.payload : {},
      ...snapshot(),
      relayed: true,
    }
    emitPacket(packet)
    return packet
  },
}
