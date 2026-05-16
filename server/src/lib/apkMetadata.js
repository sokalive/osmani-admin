import fs from 'node:fs'
import ApkReader from '@devicefarmer/adbkit-apkreader'

/**
 * Read packageName, versionCode, versionName from an APK on disk.
 * @returns {Promise<{ packageName: string, versionCode: number, versionName: string } | null>}
 */
export async function parseApkMetadata(filePath) {
  const p = String(filePath ?? '').trim()
  if (!p || !fs.existsSync(p)) return null
  try {
    const reader = await ApkReader.open(p)
    const manifest = await reader.readManifest()
    const packageName = String(manifest?.package ?? '').trim()
    const versionCode = Number(manifest?.versionCode)
    const versionName = String(manifest?.versionName ?? '').trim()
    if (!packageName || !Number.isFinite(versionCode) || versionCode < 1) {
      return null
    }
    return {
      packageName,
      versionCode: Math.trunc(versionCode),
      versionName: versionName || String(versionCode),
    }
  } catch (e) {
    console.warn('[apkMetadata] parse failed:', e?.message || e)
    return null
  }
}
