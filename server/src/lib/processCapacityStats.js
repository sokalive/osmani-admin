/**
 * Process + host capacity metrics for load validation (no subscription logic).
 */
import os from 'node:os'

export function readProcessCapacityStats() {
  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const load = os.loadavg()
  const cpus = os.cpus().length || 1
  return {
    uptime_sec: Math.round(process.uptime()),
    node_rss_mb: Math.round(mem.rss / 1024 / 1024),
    node_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    node_heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    system_ram_total_mb: Math.round(totalMem / 1024 / 1024),
    system_ram_used_mb: Math.round(usedMem / 1024 / 1024),
    system_ram_used_pct: totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : null,
    load_avg_1m: Math.round(load[0] * 100) / 100,
    load_avg_5m: Math.round(load[1] * 100) / 100,
    cpu_count: cpus,
    /** Approximate CPU utilization from 1m load average (can exceed 100% on multi-core). */
    cpu_load_pct_approx: Math.round((load[0] / cpus) * 1000) / 10,
  }
}
