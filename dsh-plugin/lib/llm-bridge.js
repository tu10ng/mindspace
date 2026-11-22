import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createOpenAiCompatibleLlm } from '../../dist/llm/openai.js'

const CREDENTIAL_RECORD_KEY = 'dsh-mindspace/custom-openai'
const STREAM_TIMEOUT_MS = 120_000

const DEFAULT_CONFIG = Object.freeze({
  mode: 'dsh',
  dshProvider: '',
  dshModel: '',
  customBaseUrl: '',
  customModel: '',
})

async function writeJsonAtomic(filePath, data, mode) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 2), mode !== undefined ? { encoding: 'utf8', mode } : 'utf8')
  await rename(temp, filePath)
}

async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}••••`
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

export function createLlmBridge({ ctx, dataDir, logger }) {
  const configFile = path.join(dataDir, 'model-config.json')
  const secretFile = path.join(dataDir, 'model-secret.json')
  let loaded = false
  let config = { ...DEFAULT_CONFIG }

  function getLlmService() {
    try {
      return ctx?.get?.('llm') ?? undefined
    } catch {
      return undefined
    }
  }

  function getCredentialsService() {
    try {
      return ctx?.get?.('credentials') ?? undefined
    } catch {
      return undefined
    }
  }

  async function readCustomApiKey() {
    const creds = getCredentialsService()
    if (creds && typeof creds.readRecord === 'function') {
      try {
        const rec = await creds.readRecord(CREDENTIAL_RECORD_KEY)
        const val = rec?.payload?.apiKey
        if (typeof val === 'string' && val.trim() !== '') {
          return { key: val.trim(), source: 'credentials' }
        }
      } catch {
      }
    }
    const local = await readJsonSafe(secretFile)
    if (typeof local?.apiKey === 'string' && local.apiKey.trim() !== '') {
      return { key: local.apiKey.trim(), source: 'file' }
    }
    const envKey = process.env.MINDSPACE_LLM_APIKEY
    if (typeof envKey === 'string' && envKey.trim() !== '') {
      return { key: envKey.trim(), source: 'env' }
    }
    return { key: '', source: 'none' }
  }

  async function writeCustomApiKey(apiKey) {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : ''
    const creds = getCredentialsService()
    if (creds && typeof creds.modifyRecord === 'function' && typeof creds.deleteRecord === 'function') {
      try {
        if (trimmed === '') {
          await creds.deleteRecord(CREDENTIAL_RECORD_KEY)
        } else {
          await creds.modifyRecord(CREDENTIAL_RECORD_KEY, async () => ({
            kind: 'api-key',
            payload: { apiKey: trimmed },
          }))
        }
        await writeJsonAtomic(secretFile, { apiKey: '' }, 0o600).catch(() => undefined)
        return
      } catch (err) {
        logger?.warn?.(`dsh-mindspace: credentials 写入回退到本地文件：${err?.message ?? err}`)
      }
    }
    await writeJsonAtomic(secretFile, { apiKey: trimmed }, 0o600)
  }

  async function listDshCatalog() {
    const llm = getLlmService()
    if (!llm || typeof llm.listProviders !== 'function') {
      return { available: false, providers: [] }
    }
    let rawProviders = []
    try {
      rawProviders = llm.listProviders() ?? []
    } catch {
      return { available: false, providers: [] }
    }
    const providers = await Promise.all(
      rawProviders.map(async (entry) => {
        const id = typeof entry?.id === 'string' ? entry.id : (typeof entry?.provider === 'string' ? entry.provider : '')
        if (id === '') return null
        const label = typeof entry?.displayName === 'string' && entry.displayName !== ''
          ? entry.displayName
          : (typeof entry?.name === 'string' && entry.name !== '' ? entry.name : id)
        let models = []
        if (typeof llm.listModels === 'function') {
          try {
            const list = await llm.listModels(id)
            models = (Array.isArray(list) ? list : [])
              .map((m) => {
                const mid = typeof m?.id === 'string' ? m.id : (typeof m?.model === 'string' ? m.model : '')
                if (mid === '') return null
                const mlabel = typeof m?.displayName === 'string' && m.displayName !== ''
                  ? m.displayName
                  : (typeof m?.name === 'string' && m.name !== '' ? m.name : mid)
                return { id: mid, label: mlabel }
              })
              .filter(Boolean)
          } catch {
            models = []
          }
        }
        return { id, label, models }
      }),
    )
    return { available: true, providers: providers.filter(Boolean) }
  }

  async function ensureLoaded() {
    if (loaded) return
    loaded = true
    const saved = await readJsonSafe(configFile)
    if (saved !== null) {
      config = {
        mode: saved.mode === 'custom' ? 'custom' : 'dsh',
        dshProvider: typeof saved.dshProvider === 'string' ? saved.dshProvider : '',
        dshModel: typeof saved.dshModel === 'string' ? saved.dshModel : '',
        customBaseUrl: typeof saved.customBaseUrl === 'string' ? saved.customBaseUrl : '',
        customModel: typeof saved.customModel === 'string' ? saved.customModel : '',
      }
      return
    }
    const envBase = process.env.MINDSPACE_LLM_BASEURL?.trim() ?? ''
    const envModel = process.env.MINDSPACE_LLM_MODEL?.trim() ?? ''
    const envKey = process.env.MINDSPACE_LLM_APIKEY?.trim() ?? ''
    const catalog = await listDshCatalog()
    const firstWithModel = catalog.providers.find((p) => p.models.length > 0)
    if (firstWithModel !== undefined) {
      config = {
        mode: 'dsh',
        dshProvider: firstWithModel.id,
        dshModel: firstWithModel.models[0].id,
        customBaseUrl: envBase,
        customModel: envModel,
      }
    } else if (envBase !== '' && envModel !== '' && envKey !== '') {
      config = {
        mode: 'custom',
        dshProvider: '',
        dshModel: '',
        customBaseUrl: envBase,
        customModel: envModel,
      }
    } else {
      config = {
        ...DEFAULT_CONFIG,
        customBaseUrl: envBase,
        customModel: envModel,
      }
    }
  }

  async function resolveEffectiveDshRoute(catalog) {
    if (config.dshProvider !== '' && config.dshModel !== '') {
      return { provider: config.dshProvider, model: config.dshModel }
    }
    const first = catalog.providers.find((p) => p.models.length > 0)
    if (first !== undefined) {
      return { provider: first.id, model: first.models[0].id }
    }
    return { provider: config.dshProvider, model: config.dshModel }
  }

  async function describeState() {
    await ensureLoaded()
    const catalog = await listDshCatalog()
    const keyInfo = await readCustomApiKey()
    const dshRoute = await resolveEffectiveDshRoute(catalog)
    const dshReady = catalog.available && dshRoute.provider !== '' && dshRoute.model !== ''
    const customReady = config.customBaseUrl.trim() !== '' && config.customModel.trim() !== '' && keyInfo.key !== ''
    const ready = config.mode === 'dsh' ? dshReady : customReady
    const summary = config.mode === 'dsh'
      ? (dshReady ? `DSH: ${dshRoute.provider} / ${dshRoute.model}` : '未选择 DSH 模型')
      : (customReady ? `自定义: ${config.customModel.trim()}` : '未完成自定义模型配置')
    return {
      mode: config.mode,
      dshProvider: dshRoute.provider,
      dshModel: dshRoute.model,
      customBaseUrl: config.customBaseUrl,
      customModel: config.customModel,
      hasCustomApiKey: keyInfo.key !== '',
      customApiKeySource: keyInfo.source,
      customApiKeyPreview: maskKey(keyInfo.key),
      ready,
      summary,
      dshCatalog: catalog,
    }
  }

  async function updateConfig(patch) {
    await ensureLoaded()
    const next = {
      mode: patch.mode === 'custom' ? 'custom' : (patch.mode === 'dsh' ? 'dsh' : config.mode),
      dshProvider: typeof patch.dshProvider === 'string' ? patch.dshProvider.trim() : config.dshProvider,
      dshModel: typeof patch.dshModel === 'string' ? patch.dshModel.trim() : config.dshModel,
      customBaseUrl: typeof patch.customBaseUrl === 'string' ? patch.customBaseUrl.trim() : config.customBaseUrl,
      customModel: typeof patch.customModel === 'string' ? patch.customModel.trim() : config.customModel,
    }
    config = next
    await writeJsonAtomic(configFile, config)
    if (patch.clearApiKey === true) {
      await writeCustomApiKey('')
    } else if (typeof patch.customApiKey === 'string' && patch.customApiKey.trim() !== '') {
      await writeCustomApiKey(patch.customApiKey)
    }
    return describeState()
  }

  async function completeViaDsh(req) {
    const llm = getLlmService()
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('当前 DSH 宿主未提供 ctx.llm 服务，请切换到自定义模型配置')
    }
    const catalog = await listDshCatalog()
    const route = await resolveEffectiveDshRoute(catalog)
    if (route.provider === '' || route.model === '') {
      throw new Error('尚未选择 DSH 模型，请点击右上角「模型配置」选择模型')
    }
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        system: req.systemPrompt,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: req.userPrompt }],
          },
        ],
        maxTokens: req.maxOutputTokens,
        signal: controller.signal,
      }
      let text = ''
      let usage
      let finish
      for await (const chunk of llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && text === '' && typeof chunk.block.text === 'string') {
          text = chunk.block.text
        } else if (chunk?.type === 'usage' && chunk.usage !== undefined) {
          usage = {
            inputTokens: Number(chunk.usage.inputTokens ?? chunk.usage.input ?? 0),
            outputTokens: Number(chunk.usage.outputTokens ?? chunk.usage.output ?? 0),
          }
        } else if (chunk?.type === 'finish') {
          finish = chunk.reason
        }
      }
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        const msg = finish?.failure?.message ?? `DSH LLM 调用失败 (${finish.kind})`
        throw new Error(msg)
      }
      const response = {
        text,
        latencyMs: Date.now() - started,
        model: `${route.provider}/${route.model}`,
      }
      if (finish?.kind === 'max-tokens') {
        response.stopReason = 'max_tokens'
      } else if (typeof finish?.kind === 'string') {
        response.stopReason = finish.kind
      }
      if (usage !== undefined) {
        response.usage = usage
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }

  async function completeViaCustom(req) {
    const baseUrl = config.customBaseUrl.trim()
    const model = config.customModel.trim()
    const { key } = await readCustomApiKey()
    if (baseUrl === '' || model === '' || key === '') {
      throw new Error('自定义模型未配置完整，请点击右上角「模型配置」填写 Base URL、Model 与 API Key')
    }
    const client = createOpenAiCompatibleLlm({ baseUrl, apiKey: key, model })
    return client.complete(req)
  }

  const adapter = {
    async complete(req) {
      await ensureLoaded()
      if (config.mode === 'custom') {
        return completeViaCustom(req)
      }
      return completeViaDsh(req)
    },
  }

  return {
    adapter,
    describeState,
    updateConfig,
    listDshCatalog,
  }
}
