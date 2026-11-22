import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ALLOWED_ROOTS = new Set(['client', 'vendor', 'shared'])

const MIME_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
}

export function resolveAsset(assetsRoot, rawSuffix) {
  let decoded
  try {
    decoded = decodeURIComponent(rawSuffix)
  } catch {
    return null
  }
  const normalized = decoded.replace(/^\/+/, '')
  if (normalized === '' || normalized.includes('\0')) return null
  const firstSegment = normalized.split('/')[0]
  if (!ALLOWED_ROOTS.has(firstSegment)) return null
  const resolvedRoot = path.resolve(assetsRoot)
  const resolved = path.resolve(resolvedRoot, normalized)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return { file: resolved, isVendor: firstSegment === 'vendor' }
}

export async function readAsset(target) {
  try {
    const body = await readFile(target.file)
    const ext = path.extname(target.file).toLowerCase()
    const type = MIME_TYPES[ext] ?? 'application/octet-stream'
    const cache = target.isVendor ? 'public, max-age=31536000, immutable' : 'no-cache'
    return { body, type, cache }
  } catch {
    return null
  }
}
