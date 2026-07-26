/** Shared runtime environment detectors (Contabo vs Render). */

export function isRenderRuntime() {
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true'
}

export function isContaboVpsRuntime() {
  return String(process.env.OSMANI_VPS || '').trim() === '1'
}
