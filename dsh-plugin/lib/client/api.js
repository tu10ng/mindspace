const BASE = 'api/mindspace'

async function request(path, options = {}) {
  const url = new URL(`${BASE}${path}`, document.baseURI).href
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  let data = null
  try {
    data = await res.json()
  } catch {
  }
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`)
    err.code = data?.reason ?? `http_${res.status}`
    err.status = res.status
    throw err
  }
  return data
}

export function createMindspaceApi() {
  return {
    getState() {
      return request('/state', { method: 'GET' })
    },
    ingest(text) {
      return request('/ingest', {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
    },
    saveLayout(positions, reset = false) {
      return request('/layout', {
        method: 'POST',
        body: JSON.stringify({ positions, reset }),
      })
    },
    getModels() {
      return request('/models', { method: 'GET' })
    },
    updateModels(payload) {
      return request('/models', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    openStream(onFrame, onStatus) {
      const url = new URL(`${BASE}/stream`, document.baseURI).href
      const source = new EventSource(url, { withCredentials: true })
      source.onopen = () => onStatus?.(true)
      source.onerror = () => onStatus?.(false)
      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data)
          onFrame?.(parsed)
        } catch {
        }
      }
      return () => {
        try {
          source.close()
        } catch {
        }
      }
    },
  }
}
