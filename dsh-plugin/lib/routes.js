import { ROUTE_BASE, ROUTES } from './shared/protocol.js'
import { readAsset, resolveAsset } from './assets.js'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const PING_MS = 25_000

export function createRoutes({ service, assetsRoot, logger, rootCtx, connection }) {
  const fence = () => {
    if (connection !== undefined) return connection
    try {
      return rootCtx?.get?.('connection') ?? undefined
    } catch {
      return undefined
    }
  }

  function refuse(request, response) {
    let rejection
    let fenceFailed = false
    const conn = fence()
    try {
      rejection = conn?.requestRejection?.(request)
    } catch (error) {
      logger?.warn?.(`dsh-mindspace: 连接围栏异常：${error?.message ?? error}`)
      rejection = 403
      fenceFailed = true
    }
    const fenced = rejection !== undefined && rejection !== null && rejection !== false
    const localScript = !fenceFailed && isLoopback(request) && !hasBrowserCredentials(request)
    if (fenced && !localScript) {
      sendJson(response, typeof rejection === 'number' ? rejection : 403, {
        ok: false,
        reason: 'forbidden',
        error: '请求被宿主连接围栏拒绝',
      })
      return true
    }
    if (!fenced && (conn === undefined || conn === null) && !isLoopback(request)) {
      sendJson(response, 403, { ok: false, reason: 'forbidden', error: '只接受本机请求' })
      return true
    }
    return false
  }

  function wrap(handler) {
    return async (request, response) => {
      if (refuse(request, response)) return
      try {
        const result = await handler(request, response)
        if (result !== undefined && !response.writableEnded) {
          sendJson(response, 200, result)
        }
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal'
        const status = statusOf(code)
        if (status >= 500) {
          logger?.warn?.(`dsh-mindspace: ${request.method} ${request.url} 失败：${error?.stack ?? error?.message ?? error}`)
        }
        if (response.writableEnded) return
        sendJson(response, status, {
          ok: false,
          reason: code,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  function verbs(suffix, handlers) {
    return {
      kind: 'exact',
      path: `${ROUTE_BASE}${suffix}`,
      handler: async (request, response) => {
        const handler = handlers[request.method]
        if (handler === undefined) {
          response.setHeader('allow', Object.keys(handlers).join(', '))
          sendJson(response, 405, {
            ok: false,
            reason: 'method-not-allowed',
            error: `请用 ${Object.keys(handlers).join(' / ')}`,
          })
          return
        }
        await wrap(handler)(request, response)
      },
    }
  }

  const state = verbs('/state', {
    GET: async () => ({ ok: true, ...(await service.getState()) }),
  })

  const ingest = verbs('/ingest', {
    POST: async (request) => {
      const body = await readJson(request)
      const job = await service.enqueueIngest(body.text)
      return { ok: true, job }
    },
  })

  const layout = verbs('/layout', {
    POST: async (request) => {
      const body = await readJson(request)
      const saved = await service.saveLayout(body.positions, body.reset === true)
      return { ok: true, ...saved }
    },
  })

  const models = verbs('/models', {
    GET: async () => ({ ok: true, modelConfig: await service.describeModels() }),
    POST: async (request) => {
      const body = await readJson(request)
      const modelConfig = await service.updateModelConfig(body)
      return { ok: true, modelConfig }
    },
  })

  const stream = {
    kind: 'exact',
    path: ROUTES.stream,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: '请用 GET' })
        return
      }
      if (refuse(request, response)) return
      response.statusCode = 200
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.setHeader('cache-control', 'no-cache, no-transform')
      response.setHeader('connection', 'keep-alive')
      response.setHeader('x-accel-buffering', 'no')
      response.flushHeaders?.()

      const send = (payload) => {
        if (response.writableEnded) return
        try {
          response.write(`data: ${JSON.stringify(payload)}\n\n`)
        } catch {
        }
      }

      send({ frame: 'ready', ts: Date.now() })
      const unsub = service.subscribe(send)
      const ping = setInterval(() => {
        if (response.writableEnded) return
        try {
          response.write(': ping\n\n')
        } catch {
        }
      }, PING_MS)
      ping.unref?.()

      let settle
      const done = new Promise((resolve) => {
        settle = resolve
      })
      const cleanup = () => {
        clearInterval(ping)
        unsub()
        if (!response.writableEnded) {
          try {
            response.end()
          } catch {
          }
        }
        settle()
      }
      request.on('close', cleanup)
      request.on('error', cleanup)
      response.on('close', cleanup)
      return done
    },
  }

  const assets = {
    kind: 'prefix',
    path: ROUTES.assets,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD')
        sendJson(response, 405, { ok: false, reason: 'method-not-allowed', error: '请用 GET' })
        return
      }
      if (refuse(request, response)) return
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const suffix = pathname.slice(ROUTES.assets.length)
      const file = resolveAsset(assetsRoot, suffix)
      const asset = file === null ? null : await readAsset(file)
      if (asset === null) {
        sendJson(response, 404, { ok: false, reason: 'not-found', error: '没有这个资源' })
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', asset.type)
      response.setHeader('cache-control', asset.cache)
      response.setHeader('x-content-type-options', 'nosniff')
      if (request.method === 'HEAD') response.end()
      else response.end(asset.body)
    },
  }

  return [state, ingest, layout, models, stream, assets]
}

function statusOf(code) {
  if (code === 'invalid-request' || code === 'model-not-configured') return 400
  if (code === 'payload-too-large') return 413
  if (code === 'forbidden') return 403
  return 500
}

function sendJson(response, status, body) {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
      error.code = 'payload-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('请求体必须是 JSON 对象')
      error.code = 'invalid-request'
      throw error
    }
    return parsed
  } catch (error) {
    if (error?.code === 'invalid-request') throw error
    const wrapped = new Error(`请求体不是合法 JSON：${error?.message ?? error}`)
    wrapped.code = 'invalid-request'
    throw wrapped
  }
}

function hasBrowserCredentials(request) {
  const cookie = request.headers?.cookie
  if (typeof cookie === 'string' && cookie.trim() !== '') return true
  const origin = request.headers?.origin
  return typeof origin === 'string' && origin.trim() !== ''
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  let hostname
  try {
    hostname = new URL(`http://${request.headers?.host ?? ''}`).hostname
  } catch {
    return false
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false
  return request.headers?.['sec-fetch-site'] !== 'cross-site'
}
