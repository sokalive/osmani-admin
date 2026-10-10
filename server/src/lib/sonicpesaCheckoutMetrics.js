/**
 * In-process SonicPesa checkout counters. Aggregates only — no phone numbers.
 * Reset when the process restarts. SQL windows live in reliability metrics.
 */
const state = {
  requests: 0,
  accepted: 0,
  http429: 0,
  ambiguous: 0,
  terminalRejection: 0,
  deduped: 0,
  capacityExhausted: 0,
  slotAcquired: 0,
  providerLatencyMs: [],
  handlerLatencyMs: [],
}

const MAX_SAMPLES = 200

function pushSample(arr, n) {
  if (!Number.isFinite(n) || n < 0) return
  arr.push(Math.round(n))
  if (arr.length > MAX_SAMPLES) arr.shift()
}

function percentile(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

export function noteCheckoutMetric(name, extra = {}) {
  if (name === 'request') state.requests += 1
  else if (name === 'accepted') state.accepted += 1
  else if (name === 'http_429') state.http429 += 1
  else if (name === 'ambiguous') state.ambiguous += 1
  else if (name === 'terminal_rejection') state.terminalRejection += 1
  else if (name === 'deduped') state.deduped += 1
  else if (name === 'capacity_exhausted') state.capacityExhausted += 1
  else if (name === 'slot_acquired') state.slotAcquired += 1
  if (extra.providerMs != null) pushSample(state.providerLatencyMs, Number(extra.providerMs))
  if (extra.handlerMs != null) pushSample(state.handlerLatencyMs, Number(extra.handlerMs))
}

export function getSonicpesaCheckoutMetrics() {
  return {
    requests: state.requests,
    accepted: state.accepted,
    http_429: state.http429,
    ambiguous: state.ambiguous,
    terminal_rejection: state.terminalRejection,
    deduped: state.deduped,
    capacity_exhausted: state.capacityExhausted,
    slot_acquired: state.slotAcquired,
    provider_latency_ms: {
      p50: percentile(state.providerLatencyMs, 50),
      p95: percentile(state.providerLatencyMs, 95),
      samples: state.providerLatencyMs.length,
    },
    handler_latency_ms: {
      p50: percentile(state.handlerLatencyMs, 50),
      p95: percentile(state.handlerLatencyMs, 95),
      samples: state.handlerLatencyMs.length,
    },
  }
}
