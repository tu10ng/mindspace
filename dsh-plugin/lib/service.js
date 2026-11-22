import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createApp } from '../../dist/app.js'

async function writeJsonAtomic(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
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

export function createMindspaceService({ dbPath, llmBridge, logger }) {
  const dataDir = path.dirname(dbPath)
  const layoutFile = path.join(dataDir, 'layout.json')

  let appPromise = null
  let appInstance = null
  let unsubEvents = null
  let closed = false

  let positions = {}
  let layoutLoaded = false

  const listeners = new Set()
  const queue = []
  let activeJob = null
  const recentJobs = []
  let pumping = false

  function broadcast(frame) {
    for (const listener of listeners) {
      try {
        listener(frame)
      } catch {
      }
    }
  }

  async function ensureLayout() {
    if (layoutLoaded) return
    layoutLoaded = true
    const saved = await readJsonSafe(layoutFile)
    if (saved && saved.positions && typeof saved.positions === 'object') {
      positions = saved.positions
    }
  }

  async function ensureApp() {
    if (closed) throw new Error('Mindspace 服务已关闭')
    if (appInstance !== null) return appInstance
    if (appPromise === null) {
      appPromise = (async () => {
        await mkdir(dataDir, { recursive: true })
        await ensureLayout()
        const app = await createApp({ dbPath, llm: llmBridge.adapter })
        appInstance = app
        unsubEvents = app.store.subscribeEvents((ev) => {
          if (activeJob === null) return
          if (ev.eventType === 'step_started' || ev.eventType === 'step_finished' || ev.eventType === 'step_failed' || ev.eventType === 'llm_repair_requested') {
            const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
            activeJob.runId = ev.runId ?? activeJob.runId
            activeJob.currentNode = typeof payload.nodeId === 'string' ? payload.nodeId : activeJob.currentNode
            activeJob.currentAction = typeof payload.actionId === 'string' ? payload.actionId : activeJob.currentAction
            activeJob.lastEvent = ev.eventType
            activeJob.updatedAt = ev.createdAt
            if (ev.eventType === 'step_finished') {
              activeJob.completedSteps = (activeJob.completedSteps ?? 0) + 1
            }
            broadcast({
              frame: 'run-progress',
              activeJob: { ...activeJob },
              queuedCount: queue.length,
              event: {
                type: ev.eventType,
                nodeId: payload.nodeId ?? null,
                actionId: payload.actionId ?? null,
                errorCode: payload.errorCode ?? null,
              },
            })
          }
        })
        return app
      })().catch((err) => {
        appPromise = null
        throw err
      })
    }
    return appPromise
  }

  function recordFinishedJob(job) {
    recentJobs.unshift({ ...job })
    if (recentJobs.length > 20) recentJobs.length = 20
  }

  async function pumpQueue() {
    if (pumping || closed) return
    pumping = true
    try {
      while (queue.length > 0 && !closed) {
        const job = queue.shift()
        activeJob = {
          ...job,
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedSteps: 0,
          currentNode: 'starting',
          currentAction: null,
          runId: null,
          error: null,
          newNodeIds: [],
        }
        broadcast({
          frame: 'queue',
          activeJob: { ...activeJob },
          queuedCount: queue.length,
          recentJobs: recentJobs.slice(0, 10),
        })
        try {
          const app = await ensureApp()
          const before = await app.store.getGraphSnapshot()
          const beforeIds = new Set(before.nodes.map((n) => n.id))
          const run = await app.runIngest(job.text)
          const after = await app.store.getGraphSnapshot()
          const newNodeIds = after.nodes.filter((n) => !beforeIds.has(n.id)).map((n) => n.id)
          activeJob.runId = run.id
          activeJob.status = run.status === 'completed' ? 'completed' : 'failed'
          activeJob.finishedAt = new Date().toISOString()
          activeJob.newNodeIds = newNodeIds
          if (run.status !== 'completed') {
            const steps = await app.store.listSteps(run.id)
            const failedStep = [...steps].reverse().find((s) => s.status === 'failed')
            activeJob.error = failedStep?.errorCode ?? `run ${run.status}`
          }
          recordFinishedJob(activeJob)
          const finishedJob = { ...activeJob }
          activeJob = null
          broadcast({
            frame: 'graph-updated',
            graph: after,
            layout: positions,
            job: finishedJob,
            queuedCount: queue.length,
            recentJobs: recentJobs.slice(0, 10),
          })
        } catch (err) {
          logger?.warn?.(`dsh-mindspace: ingest 失败：${err?.message ?? err}`)
          activeJob.status = 'failed'
          activeJob.finishedAt = new Date().toISOString()
          activeJob.error = err instanceof Error ? err.message : String(err)
          recordFinishedJob(activeJob)
          const failedJob = { ...activeJob }
          activeJob = null
          broadcast({
            frame: 'queue',
            activeJob: null,
            lastFinished: failedJob,
            queuedCount: queue.length,
            recentJobs: recentJobs.slice(0, 10),
          })
        }
      }
    } finally {
      pumping = false
    }
  }

  async function getState() {
    const app = await ensureApp()
    const [graph, runs, modelConfig] = await Promise.all([
      app.store.getGraphSnapshot(),
      app.store.listRuns(20),
      llmBridge.describeState(),
    ])
    return {
      dbPath,
      graph,
      layout: positions,
      activeJob: activeJob ? { ...activeJob } : null,
      queuedCount: queue.length,
      recentJobs: recentJobs.slice(0, 10),
      runs,
      modelConfig,
    }
  }

  async function enqueueIngest(text) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') {
      const err = new Error('输入内容不能为空')
      err.code = 'invalid-request'
      throw err
    }
    const modelState = await llmBridge.describeState()
    if (!modelState.ready) {
      const err = new Error('模型尚未配置完成，请先在右上角「模型配置」中选择或填写模型')
      err.code = 'model-not-configured'
      throw err
    }
    await ensureApp()
    const job = {
      id: randomUUID(),
      text: trimmed,
      status: 'queued',
      createdAt: new Date().toISOString(),
    }
    queue.push(job)
    broadcast({
      frame: 'queue',
      activeJob: activeJob ? { ...activeJob } : null,
      queuedCount: queue.length,
      recentJobs: recentJobs.slice(0, 10),
    })
    void pumpQueue()
    return job
  }

  async function saveLayout(nextPositions, reset = false) {
    await ensureLayout()
    if (reset) {
      positions = {}
    } else if (nextPositions && typeof nextPositions === 'object') {
      const merged = { ...positions }
      for (const [id, rect] of Object.entries(nextPositions)) {
        if (
          rect !== null &&
          typeof rect === 'object' &&
          Number.isFinite(rect.x) &&
          Number.isFinite(rect.y)
        ) {
          merged[id] = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            ...(Number.isFinite(rect.width) ? { width: Math.round(rect.width) } : {}),
            ...(Number.isFinite(rect.height) ? { height: Math.round(rect.height) } : {}),
          }
        }
      }
      positions = merged
    }
    await writeJsonAtomic(layoutFile, { positions })
    return { positions }
  }

  async function updateModelConfig(patch) {
    const modelConfig = await llmBridge.updateConfig(patch)
    broadcast({ frame: 'config-updated', modelConfig })
    return modelConfig
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  async function close() {
    closed = true
    listeners.clear()
    try {
      unsubEvents?.()
    } catch {
    }
    unsubEvents = null
    if (appInstance !== null) {
      try {
        appInstance.close()
      } catch {
      }
      appInstance = null
    }
  }

  return {
    ready: ensureApp,
    getState,
    enqueueIngest,
    saveLayout,
    updateModelConfig,
    describeModels: () => llmBridge.describeState(),
    subscribe,
    close,
  }
}
