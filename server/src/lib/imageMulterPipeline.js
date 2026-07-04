/**
 * Shared multer callback: persist memory uploads to disk with ENOSPC-safe errors.
 */
import { finalizeMemoryImageUpload, isEnospcError, sendUploadError } from './uploadDiskSafety.js'

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {import('multer').MulterError | Error | null} err
 */
export async function afterImageMulter(req, res, next, err) {
  if (err) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Image file is too large'
        : isEnospcError(err)
          ? 'Server storage is full. Image upload is temporarily unavailable. Contact support.'
          : String(err.message || err)
    const status = isEnospcError(err) ? 507 : 400
    return res.status(status).json({
      ok: false,
      success: false,
      error: message,
      code: isEnospcError(err) ? 'UPLOAD_DISK_FULL' : 'UPLOAD_REJECTED',
    })
  }
  try {
    if (req.file?.buffer?.length) {
      await finalizeMemoryImageUpload(req)
    }
    return next()
  } catch (e) {
    return sendUploadError(res, e, req)
  }
}
