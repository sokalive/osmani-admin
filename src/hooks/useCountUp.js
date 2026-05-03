import { useEffect, useRef, useState } from 'react'

/**
 * Smooth count-up when `target` changes (production metric animation).
 */
export function useCountUp(target, { duration = 1100, decimals = 0 } = {}) {
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)
  const targetNum = Number(target)
  const to = Number.isFinite(targetNum) ? targetNum : 0

  useEffect(() => {
    const from = fromRef.current
    let start = performance.now()
    let raf = 0

    function frame(now) {
      const elapsed = now - start
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - (1 - t) ** 3
      const next = from + (to - from) * eased
      setValue(next)
      if (t < 1) {
        raf = requestAnimationFrame(frame)
      } else {
        fromRef.current = to
        setValue(to)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [to, duration])

  if (decimals > 0) return Number(value.toFixed(decimals))
  return Math.round(value)
}
