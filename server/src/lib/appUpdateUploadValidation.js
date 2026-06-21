import { parseVersionCode } from './appUpdateTargeting.js'

/** Stable production package — same-version APK re-upload is allowed only for this id. */
export const APP_UPDATE_STABLE_PACKAGE = 'com.burudanitv.app'

/**
 * Validate APK upload versionCode against stored catalog.
 * Allows re-upload when uploaded code equals stored (refresh APK URL/hash for v16–v23 rollout).
 * Rejects downgrades and same-code uploads with wrong package.
 *
 * @param {{ versionCode?: unknown, packageName?: unknown }} meta — parsed APK metadata
 * @param {unknown} storedVersionCode
 * @returns {{ ok: true, reupload: boolean, currentVersionCode: number, uploadedVersionCode: number } | { ok: false, error: string, currentVersionCode: number, uploadedVersionCode: number }}
 */
export function validateApkUploadVersionCode(meta, storedVersionCode) {
  const uploaded = parseVersionCode(meta?.versionCode)
  const current = parseVersionCode(storedVersionCode)
  const pkg = String(meta?.packageName ?? '').trim()

  if (uploaded <= 0) {
    return {
      ok: false,
      error: 'APK versionCode is missing or invalid',
      currentVersionCode: current,
      uploadedVersionCode: uploaded,
    }
  }

  if (uploaded < current) {
    return {
      ok: false,
      error: `APK versionCode must not be less than current (${current}). Uploaded: ${uploaded}`,
      currentVersionCode: current,
      uploadedVersionCode: uploaded,
    }
  }

  if (uploaded === current) {
    if (pkg !== APP_UPDATE_STABLE_PACKAGE) {
      return {
        ok: false,
        error: `Re-upload of versionCode ${current} requires package ${APP_UPDATE_STABLE_PACKAGE}. Uploaded package: ${pkg || '(unknown)'}`,
        currentVersionCode: current,
        uploadedVersionCode: uploaded,
      }
    }
    return {
      ok: true,
      reupload: true,
      currentVersionCode: current,
      uploadedVersionCode: uploaded,
    }
  }

  return {
    ok: true,
    reupload: false,
    currentVersionCode: current,
    uploadedVersionCode: uploaded,
  }
}
