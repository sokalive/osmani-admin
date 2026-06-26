import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'

function ffprobePath() {
  return String(process.env.INSTRUCTION_VIDEO_FFPROBE_PATH || 'ffprobe').trim()
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function probeVideoFileWithFfprobe(filePath) {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]
    const child = spawn(ffprobePath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        if (stderr) console.warn('[instruction-video-metadata] ffprobe:', stderr.slice(0, 200))
        resolve(null)
        return
      }
      try {
        const json = JSON.parse(stdout)
        const videoStream = (json.streams || []).find((s) => s.codec_type === 'video') || {}
        const durationRaw = Number(json.format?.duration ?? videoStream.duration ?? 0)
        const durationSec =
          Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw * 1000) / 1000 : null
        const width = Number(videoStream.width) || null
        const height = Number(videoStream.height) || null
        resolve({ durationSec, width, height })
      } catch {
        resolve(null)
      }
    })
  })
}

export async function collectInstructionVideoMetadata(filePath, { sizeBytes = null } = {}) {
  let fileSize = sizeBytes
  if (fileSize == null) {
    try {
      const st = await fs.stat(filePath)
      fileSize = st.size
    } catch {
      fileSize = null
    }
  }
  const [checksum, probe] = await Promise.all([
    sha256File(filePath).catch(() => null),
    probeVideoFileWithFfprobe(filePath),
  ])
  return {
    fileSize,
    checksum,
    durationSec: probe?.durationSec ?? null,
    width: probe?.width ?? null,
    height: probe?.height ?? null,
  }
}
