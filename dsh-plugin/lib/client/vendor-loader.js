import { ASSET_BASE } from '../shared/protocol.js'

export const VENDOR_REV = '0.18.1'

let pending = null

export function ensureStyle(href, owner = 'dsh-mindspace') {
  if (typeof document === 'undefined') return () => {}
  const same = [...document.querySelectorAll(`link[data-dsh-mindspace="${owner}"]`)].some(
    (link) => link.getAttribute('href') === href,
  )
  if (same) return () => {}
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.dataset.dshMindspace = owner
  document.head.appendChild(link)
  return () => link.parentNode?.removeChild(link)
}

export function loadVendor(require) {
  if (typeof window !== 'undefined' && window.__DSH_MINDSPACE_EXCALIDRAW__) {
    return Promise.resolve(window.__DSH_MINDSPACE_EXCALIDRAW__)
  }
  if (pending !== null) return pending

  pending = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('没有浏览器环境'))
      return
    }
    ensureStyle(`${ASSET_BASE}/vendor/excalidraw.css`, 'vendor')
    window.__DSH_MINDSPACE_EXCALIDRAW_REQUIRE__ = require

    const script = document.createElement('script')
    script.src = `${ASSET_BASE}/vendor/excalidraw.js?v=${VENDOR_REV}`
    script.async = true
    script.dataset.dshMindspace = 'vendor'
    script.onload = () => {
      delete window.__DSH_MINDSPACE_EXCALIDRAW_REQUIRE__
      const module = window.__DSH_MINDSPACE_EXCALIDRAW__
      if (module && module.Excalidraw !== undefined && typeof module.convertToExcalidrawElements === 'function') {
        resolve(module)
      } else {
        reject(new Error('Excalidraw 资源已加载，但没有导出组件'))
      }
    }
    script.onerror = () => {
      delete window.__DSH_MINDSPACE_EXCALIDRAW_REQUIRE__
      reject(new Error('Excalidraw 资源加载失败'))
    }
    document.head.appendChild(script)
  })

  pending.catch(() => {
    pending = null
  })
  return pending
}
