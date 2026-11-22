import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLlmBridge } from './llm-bridge.js'
import { createRoutes } from './routes.js'
import { createMindspaceService } from './service.js'
import { VERSION } from './shared/protocol.js'

export const name = 'dsh-mindspace'

export const DEFAULTS = Object.freeze({
  dbPath: '',
})

function resolveDbPath(config) {
  const configured = typeof config?.dbPath === 'string' ? config.dbPath.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd()
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh')
  return path.join(dshHome, 'mindspace', 'mindspace.db')
}

export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  const logger = ctx?.logger
  const dbPath = resolveDbPath(resolved)
  const dataDir = path.dirname(dbPath)

  const llmBridge = createLlmBridge({ ctx, dataDir, logger })
  const service = createMindspaceService({ dbPath, llmBridge, logger })

  ctx.effect(() => {
    void service.ready().catch((error) => {
      logger?.warn?.(`dsh-mindspace: 数据库初始化失败：${error?.message ?? error}`)
    })
    return () => {
      void service.close()
    }
  }, 'dsh-mindspace: service')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        const routes = createRoutes({
          service,
          assetsRoot: fileURLToPath(new URL('./', import.meta.url)),
          logger,
          rootCtx: ctx,
          connection: ctx.get?.('connection') ?? undefined,
        })
        const disposers = routes.map((definition) => webCtx.webServer.register(definition))
        webCtx.logger?.info?.(`dsh-mindspace: 注册了 ${disposers.length} 条路由（/api/mindspace）`)
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
            }
          }
        }
      } catch (error) {
        webCtx.logger?.warn?.(`dsh-mindspace: 路由注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'dsh-mindspace: web routes')
  })

  logger?.info?.(`dsh-mindspace v${VERSION} 已挂载（dbPath=${dbPath}）`)
}

export default { name, apply }
