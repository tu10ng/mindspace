import { ASSET_BASE, ROLE_META } from '../shared/protocol.js'
import { createMindspaceApi } from './api.js'
import { buildSceneElements, consIdFromElement, extractPositionsFromScene } from './graph-layout.js'
import { ensureStyle, loadVendor } from './vendor-loader.js'

const SAVE_DEBOUNCE_MS = 500

function positionsChanged(prev, next) {
  const keys = Object.keys(next)
  if (keys.length === 0) return false
  for (const key of keys) {
    const a = prev?.[key]
    const b = next[key]
    if (!a) return true
    if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) return true
  }
  return false
}

export function createPanel({ React, require, ctx }) {
  const { useCallback, useEffect, useMemo, useRef, useState } = React
  const h = React.createElement

  ensureStyle(`${ASSET_BASE}/client/panel.css`, 'panel')
  const api = createMindspaceApi()

  function useColorScheme() {
    const read = () => {
      try {
        return ctx?.get?.('theme')?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
      } catch {
        return 'light'
      }
    }
    const [scheme, setScheme] = useState(read)
    useEffect(() => {
      let off
      try {
        off = ctx?.on?.('theme/change', () => setScheme(read()))
      } catch {
        off = undefined
      }
      return () => {
        try {
          off?.()
        } catch {
        }
      }
    }, [])
    return scheme
  }

  function ModelConfigModal({ modelConfig, onClose, onSaved, onRefreshCatalog }) {
    const [mode, setMode] = useState(modelConfig?.mode === 'custom' ? 'custom' : 'dsh')
    const [dshProvider, setDshProvider] = useState(modelConfig?.dshProvider ?? '')
    const [dshModel, setDshModel] = useState(modelConfig?.dshModel ?? '')
    const [customBaseUrl, setCustomBaseUrl] = useState(modelConfig?.customBaseUrl ?? '')
    const [customModel, setCustomModel] = useState(modelConfig?.customModel ?? '')
    const [customApiKey, setCustomApiKey] = useState('')
    const [clearApiKey, setClearApiKey] = useState(false)
    const [saving, setSaving] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState('')

    const providers = modelConfig?.dshCatalog?.providers ?? []
    const currentProvider = providers.find((p) => p.id === dshProvider) ?? providers[0]
    const availableModels = currentProvider?.models ?? []

    useEffect(() => {
      if (mode === 'dsh' && dshProvider === '' && currentProvider) {
        setDshProvider(currentProvider.id)
        if (currentProvider.models.length > 0) {
          setDshModel(currentProvider.models[0].id)
        }
      }
    }, [mode, dshProvider, currentProvider])

    useEffect(() => {
      const onKeyDown = (event) => {
        if (event.key === 'Escape') onClose()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose])

    const handleProviderChange = (nextProviderId) => {
      setDshProvider(nextProviderId)
      const found = providers.find((p) => p.id === nextProviderId)
      setDshModel(found?.models?.[0]?.id ?? '')
    }

    const handleRefresh = async () => {
      setRefreshing(true)
      setError('')
      try {
        const refreshed = await onRefreshCatalog()
        const list = refreshed?.dshCatalog?.providers ?? []
        if (list.length > 0 && !list.some((p) => p.id === dshProvider)) {
          setDshProvider(list[0].id)
          setDshModel(list[0].models?.[0]?.id ?? '')
        }
      } catch (err) {
        setError(err?.message ?? String(err))
      } finally {
        setRefreshing(false)
      }
    }

    const handleSave = async () => {
      setError('')
      if (mode === 'dsh') {
        if (!dshProvider || !dshModel) {
          setError('请选择一个 DSH Provider 和模型，或切换到自定义 OpenAI 兼容模式')
          return
        }
      } else {
        if (customBaseUrl.trim() === '' || customModel.trim() === '') {
          setError('请填写 Base URL 和 Model')
          return
        }
        const willHaveKey = (customApiKey.trim() !== '') || (!clearApiKey && modelConfig?.hasCustomApiKey)
        if (!willHaveKey) {
          setError('请填写 API Key')
          return
        }
      }
      setSaving(true)
      try {
        const res = await api.updateModels({
          mode,
          dshProvider,
          dshModel,
          customBaseUrl: customBaseUrl.trim(),
          customModel: customModel.trim(),
          ...(customApiKey.trim() !== '' ? { customApiKey: customApiKey.trim() } : {}),
          ...(clearApiKey ? { clearApiKey: true } : {}),
        })
        onSaved(res.modelConfig)
        onClose()
      } catch (err) {
        setError(err?.message ?? String(err))
      } finally {
        setSaving(false)
      }
    }

    return h(
      'div',
      {
        className: 'dsh-ms-modal-backdrop',
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose()
        },
      },
      h(
        'div',
        { className: 'dsh-ms-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '模型配置' },
        h(
          'div',
          { className: 'dsh-ms-modal-head' },
          h('span', { className: 'dsh-ms-modal-title' }, '运行时模型配置'),
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: onClose }, '关闭'),
        ),
        h(
          'div',
          { className: 'dsh-ms-modal-body' },
          h(
            'div',
            { className: 'dsh-ms-tabs' },
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ms-tab${mode === 'dsh' ? ' active' : ''}`,
                onClick: () => setMode('dsh'),
              },
              'DSH 已配置模型',
            ),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-ms-tab${mode === 'custom' ? ' active' : ''}`,
                onClick: () => setMode('custom'),
              },
              '自定义 OpenAI 兼容',
            ),
          ),
          mode === 'dsh'
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dsh-ms-row' },
                  h('span', { className: 'dsh-ms-hint' }, '直接复用 DSH 的 ctx.llm 通道，无需重新填写 API Key。'),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ms-link-btn', onClick: handleRefresh, disabled: refreshing },
                    refreshing ? '刷新中…' : '刷新列表',
                  ),
                ),
                providers.length === 0
                  ? h(
                      'div',
                      { className: 'dsh-ms-text-block' },
                      '当前 DSH 未检测到可用的已配置 Provider/模型，可切换到「自定义 OpenAI 兼容」手动配置。',
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'dsh-ms-field' },
                        h('label', null, 'Provider'),
                        h(
                          'select',
                          {
                            className: 'dsh-ms-select',
                            value: dshProvider,
                            onChange: (e) => handleProviderChange(e.target.value),
                          },
                          providers.map((p) =>
                            h('option', { key: p.id, value: p.id }, `${p.label} (${p.models.length})`),
                          ),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dsh-ms-field' },
                        h('label', null, 'Model'),
                        availableModels.length > 0
                          ? h(
                              'select',
                              {
                                className: 'dsh-ms-select',
                                value: dshModel,
                                onChange: (e) => setDshModel(e.target.value),
                              },
                              availableModels.map((m) =>
                                h('option', { key: m.id, value: m.id }, m.label !== m.id ? `${m.label} (${m.id})` : m.id),
                              ),
                            )
                          : h('input', {
                              className: 'dsh-ms-input',
                              value: dshModel,
                              onChange: (e) => setDshModel(e.target.value),
                              placeholder: '手动输入模型 ID',
                            }),
                      ),
                    ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dsh-ms-field' },
                  h('label', null, 'Base URL'),
                  h('input', {
                    className: 'dsh-ms-input',
                    value: customBaseUrl,
                    onChange: (e) => setCustomBaseUrl(e.target.value),
                    placeholder: 'https://api.deepseek.com/v1',
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-ms-field' },
                  h('label', null, 'Model'),
                  h('input', {
                    className: 'dsh-ms-input',
                    value: customModel,
                    onChange: (e) => setCustomModel(e.target.value),
                    placeholder: 'deepseek-chat',
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-ms-field' },
                  h(
                    'div',
                    { className: 'dsh-ms-row' },
                    h('label', null, 'API Key'),
                    modelConfig?.hasCustomApiKey && !clearApiKey
                      ? h(
                          'span',
                          { className: 'dsh-ms-hint' },
                          `已保存 (${modelConfig.customApiKeyPreview || '••••'}) `,
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsh-ms-link-btn',
                              onClick: () => setClearApiKey(true),
                            },
                            '清除',
                          ),
                        )
                      : null,
                  ),
                  h('input', {
                    type: 'password',
                    className: 'dsh-ms-input',
                    value: customApiKey,
                    onChange: (e) => {
                      setCustomApiKey(e.target.value)
                      if (e.target.value !== '') setClearApiKey(false)
                    },
                    placeholder: modelConfig?.hasCustomApiKey && !clearApiKey ? '留空以沿用已保存的 API Key' : 'sk-...',
                  }),
                ),
              ),
          error !== '' ? h('div', { className: 'dsh-ms-status-error' }, error) : null,
        ),
        h(
          'div',
          { className: 'dsh-ms-modal-foot' },
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: onClose }, '取消'),
          h(
            'button',
            { type: 'button', className: 'dsh-ms-btn dsh-ms-btn-primary', onClick: handleSave, disabled: saving },
            saving ? '保存中…' : '保存并生效',
          ),
        ),
      ),
    )
  }

  function NodeDetailDrawer({ node, graph, onClose, onSelectNode }) {
    const [showSpec, setShowSpec] = useState(false)
    const nodeMap = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])
    const edges = useMemo(() => {
      const list = graph?.edges ?? []
      return {
        out: list.filter((e) => e.from?.consId === node.id),
        in: list.filter((e) => e.to?.consId === node.id),
      }
    }, [graph, node.id])

    const relTitle = (relId) => nodeMap.get(relId)?.title || relId
    const nodeTitle = (id) => nodeMap.get(id)?.title || id

    return h(
      'aside',
      { className: 'dsh-ms-detail' },
      h(
        'div',
        { className: 'dsh-ms-detail-head' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { className: 'dsh-ms-detail-title' }, node.title || node.id),
          h('div', { className: 'dsh-ms-detail-id' }, `${node.id} · r${node.currentRevision} · ${node.status}`),
        ),
        h('button', { type: 'button', className: 'dsh-ms-btn', onClick: onClose }, '×'),
      ),
      h(
        'div',
        { className: 'dsh-ms-detail-body' },
        h(
          'div',
          { className: 'dsh-ms-tags' },
          (node.roles ?? []).map((role) => {
            const meta = ROLE_META[role]
            return h(
              'span',
              {
                key: role,
                className: 'dsh-ms-tag',
                style: meta ? { borderColor: meta.stroke, color: meta.stroke, background: meta.fill } : undefined,
              },
              meta ? `${meta.label} (${role})` : role,
            )
          }),
          node.provenance?.source ? h('span', { className: 'dsh-ms-tag' }, `来源: ${node.provenance.source}`) : null,
        ),
        h(
          'div',
          null,
          h('div', { className: 'dsh-ms-section-label' }, '正文'),
          h('div', { className: 'dsh-ms-text-block' }, node.body || '(空)'),
        ),
        node.applicabilityText
          ? h(
              'div',
              null,
              h('div', { className: 'dsh-ms-section-label' }, '适用范围'),
              h('div', { className: 'dsh-ms-text-block' }, node.applicabilityText),
            )
          : null,
        (node.aliases?.length > 0 || node.searchTerms?.length > 0)
          ? h(
              'div',
              null,
              h('div', { className: 'dsh-ms-section-label' }, '别名与检索词'),
              h(
                'div',
                { className: 'dsh-ms-tags' },
                [...(node.aliases ?? []), ...(node.searchTerms ?? [])].map((term, idx) =>
                  h('span', { key: `${term}-${idx}`, className: 'dsh-ms-tag' }, term),
                ),
              ),
            )
          : null,
        edges.out.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dsh-ms-section-label' }, `出边 (${edges.out.length})`),
              h(
                'div',
                { className: 'dsh-ms-edge-list' },
                edges.out.map((e) =>
                  h(
                    'button',
                    {
                      key: e.id,
                      type: 'button',
                      className: 'dsh-ms-edge-item',
                      onClick: () => onSelectNode(e.to.consId),
                    },
                    h('span', { className: 'dsh-ms-edge-rel' }, `—[${relTitle(e.relationConsId)}]→`),
                    h('span', { className: 'dsh-ms-edge-target' }, nodeTitle(e.to.consId)),
                  ),
                ),
              ),
            )
          : null,
        edges.in.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'dsh-ms-section-label' }, `入边 (${edges.in.length})`),
              h(
                'div',
                { className: 'dsh-ms-edge-list' },
                edges.in.map((e) =>
                  h(
                    'button',
                    {
                      key: e.id,
                      type: 'button',
                      className: 'dsh-ms-edge-item',
                      onClick: () => onSelectNode(e.from.consId),
                    },
                    h('span', { className: 'dsh-ms-edge-target' }, nodeTitle(e.from.consId)),
                    h('span', { className: 'dsh-ms-edge-rel' }, `—[${relTitle(e.relationConsId)}]→`),
                  ),
                ),
              ),
            )
          : null,
        node.spec !== undefined
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dsh-ms-row' },
                h('span', { className: 'dsh-ms-section-label' }, 'Spec'),
                h(
                  'button',
                  { type: 'button', className: 'dsh-ms-link-btn', onClick: () => setShowSpec((v) => !v) },
                  showSpec ? '收起' : '展开',
                ),
              ),
              showSpec ? h('pre', { className: 'dsh-ms-pre' }, JSON.stringify(node.spec, null, 2)) : null,
            )
          : null,
      ),
    )
  }

  return function Panel() {
    const colorScheme = useColorScheme()

    const [phase, setPhase] = useState('loading')
    const [loadError, setLoadError] = useState('')
    const [graph, setGraph] = useState({ nodes: [], edges: [] })
    const [layout, setLayout] = useState({})
    const [modelConfig, setModelConfig] = useState(null)
    const [activeJob, setActiveJob] = useState(null)
    const [queuedCount, setQueuedCount] = useState(0)
    const [lastFinished, setLastFinished] = useState(null)
    const [connected, setConnected] = useState(false)
    const [selectedConsId, setSelectedConsId] = useState(null)
    const [showModelModal, setShowModelModal] = useState(false)
    const [inputText, setInputText] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState('')
    const [highlightIds, setHighlightIds] = useState([])
    const [reloadKey, setReloadKey] = useState(0)

    const vendorRef = useRef(null)
    const excalidrawApiRef = useRef(null)
    const initialSceneRef = useRef(null)
    const savedLayoutRef = useRef({})
    const saveTimerRef = useRef(null)
    const hasFittedRef = useRef(false)
    const graphRef = useRef(graph)
    graphRef.current = graph

    const applyGraphToScene = useCallback((nextGraph, nextLayout, nextHighlights, fitAfter = false) => {
      const vendor = vendorRef.current
      if (!vendor) return
      const built = buildSceneElements({
        graph: nextGraph,
        savedPositions: nextLayout,
        highlightNodeIds: nextHighlights,
        convertToExcalidrawElements: vendor.convertToExcalidrawElements,
      })
      savedLayoutRef.current = built.positions
      const instance = excalidrawApiRef.current
      if (instance) {
        instance.updateScene({ elements: built.elements })
        if (fitAfter) {
          requestAnimationFrame(() => {
            try {
              instance.scrollToContent(built.elements, { fitToContent: true, animate: false })
            } catch {
            }
          })
        }
      } else {
        initialSceneRef.current = { elements: built.elements }
      }
      return built
    }, [])

    useEffect(() => {
      let alive = true
      setPhase('loading')
      setLoadError('')
      Promise.all([loadVendor(require), api.getState()])
        .then(([vendor, state]) => {
          if (!alive) return
          vendorRef.current = vendor
          setGraph(state.graph)
          setLayout(state.layout ?? {})
          setModelConfig(state.modelConfig ?? null)
          setActiveJob(state.activeJob ?? null)
          setQueuedCount(state.queuedCount ?? 0)
          setLastFinished(state.recentJobs?.[0] ?? null)
          const built = buildSceneElements({
            graph: state.graph,
            savedPositions: state.layout ?? {},
            highlightNodeIds: [],
            convertToExcalidrawElements: vendor.convertToExcalidrawElements,
          })
          savedLayoutRef.current = built.positions
          initialSceneRef.current = { elements: built.elements }
          hasFittedRef.current = false
          setPhase('ready')
        })
        .catch((err) => {
          if (!alive) return
          setLoadError(err?.message ?? String(err))
          setPhase('error')
        })
      return () => {
        alive = false
      }
    }, [reloadKey])

    useEffect(() => {
      if (phase !== 'ready') return undefined
      const close = api.openStream(
        (frame) => {
          if (frame?.frame === 'queue') {
            setActiveJob(frame.activeJob ?? null)
            setQueuedCount(frame.queuedCount ?? 0)
            if (frame.lastFinished) setLastFinished(frame.lastFinished)
          } else if (frame?.frame === 'run-progress') {
            setActiveJob(frame.activeJob ?? null)
            setQueuedCount(frame.queuedCount ?? 0)
          } else if (frame?.frame === 'graph-updated') {
            const nextGraph = frame.graph ?? graphRef.current
            const nextLayout = frame.layout ?? savedLayoutRef.current
            const newIds = frame.job?.newNodeIds ?? []
            setGraph(nextGraph)
            setLayout(nextLayout)
            setActiveJob(null)
            setQueuedCount(frame.queuedCount ?? 0)
            if (frame.job) setLastFinished(frame.job)
            setHighlightIds(newIds)
            const built = applyGraphToScene(nextGraph, nextLayout, newIds, false)
            if (built && positionsChanged(nextLayout, built.positions)) {
              void api.saveLayout(built.positions, false).catch(() => undefined)
            }
          } else if (frame?.frame === 'config-updated' && frame.modelConfig) {
            setModelConfig(frame.modelConfig)
          }
        },
        (isOpen) => setConnected(isOpen),
      )
      return () => {
        close()
      }
    }, [phase, applyGraphToScene])

    useEffect(() => {
      return () => {
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      }
    }, [])

    const handleSceneChange = useCallback((elements, appState) => {
      const selectedIds = Object.keys(appState?.selectedElementIds ?? {}).filter((id) => appState.selectedElementIds[id])
      if (selectedIds.length === 1) {
        const picked = elements.find((el) => el.id === selectedIds[0])
        if (picked) {
          let consId = consIdFromElement(picked)
          if (consId === null && picked.containerId) {
            const container = elements.find((el) => el.id === picked.containerId)
            consId = consIdFromElement(container)
          }
          if (consId !== null) {
            setSelectedConsId((prev) => (prev === consId ? prev : consId))
            return
          }
        }
      }
      if (selectedIds.length === 0) {
        setSelectedConsId((prev) => (prev === null ? prev : null))
      }
    }, [])

    const handlePointerUp = useCallback(() => {
      const instance = excalidrawApiRef.current
      if (!instance) return
      const extracted = extractPositionsFromScene(instance.getSceneElements())
      if (!positionsChanged(savedLayoutRef.current, extracted)) return
      savedLayoutRef.current = { ...savedLayoutRef.current, ...extracted }
      setLayout(savedLayoutRef.current)
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void api.saveLayout(savedLayoutRef.current, false).catch(() => undefined)
      }, SAVE_DEBOUNCE_MS)
    }, [])

    const focusNodes = useCallback((consIds) => {
      const instance = excalidrawApiRef.current
      if (!instance) return
      const targetSet = new Set(consIds)
      const matched = instance
        .getSceneElements()
        .filter((el) => !el.isDeleted && el.type === 'rectangle' && targetSet.has(consIdFromElement(el)))
      if (matched.length === 0) return
      const selectedElementIds = {}
      for (const el of matched) selectedElementIds[el.id] = true
      instance.updateScene({ appState: { selectedElementIds } })
      instance.scrollToContent(matched, { fitToContent: false, animate: true })
      if (consIds.length === 1) {
        setSelectedConsId(consIds[0])
      }
    }, [])

    const handleFitAll = useCallback(() => {
      const instance = excalidrawApiRef.current
      if (!instance) return
      const elements = instance.getSceneElements().filter((el) => !el.isDeleted)
      if (elements.length > 0) {
        instance.scrollToContent(elements, { fitToContent: true, animate: true })
      }
    }, [])

    const handleResetLayout = useCallback(async () => {
      try {
        await api.saveLayout({}, true)
        setLayout({})
        savedLayoutRef.current = {}
        const built = applyGraphToScene(graphRef.current, {}, highlightIds, true)
        if (built) {
          void api.saveLayout(built.positions, false).catch(() => undefined)
        }
      } catch (err) {
        setSubmitError(err?.message ?? String(err))
      }
    }, [applyGraphToScene, highlightIds])

    const handleRefreshAll = useCallback(async () => {
      try {
        const state = await api.getState()
        setGraph(state.graph)
        setLayout(state.layout ?? {})
        setModelConfig(state.modelConfig ?? null)
        setActiveJob(state.activeJob ?? null)
        setQueuedCount(state.queuedCount ?? 0)
        applyGraphToScene(state.graph, state.layout ?? {}, [], false)
      } catch (err) {
        setSubmitError(err?.message ?? String(err))
      }
    }, [applyGraphToScene])

    const handleRefreshCatalog = useCallback(async () => {
      const res = await api.getModels()
      setModelConfig(res.modelConfig)
      return res.modelConfig
    }, [])

    const handleSubmit = async () => {
      const text = inputText.trim()
      if (text === '' || submitting) return
      setSubmitError('')
      setSubmitting(true)
      try {
        await api.ingest(text)
        setInputText('')
      } catch (err) {
        setSubmitError(err?.message ?? String(err))
        if (err?.code === 'model-not-configured') {
          setShowModelModal(true)
        }
      } finally {
        setSubmitting(false)
      }
    }

    const selectedNode = useMemo(
      () => (selectedConsId ? (graph.nodes ?? []).find((n) => n.id === selectedConsId) ?? null : null),
      [graph.nodes, selectedConsId],
    )

    if (phase === 'loading') {
      return h(
        'div',
        { className: 'dsh-ms-state' },
        h('div', { className: 'dsh-ms-spinner', 'aria-hidden': 'true' }),
        h('p', null, '正在加载心智空间与画布…'),
      )
    }

    if (phase === 'error') {
      return h(
        'div',
        { className: 'dsh-ms-state dsh-ms-state-error', role: 'alert' },
        h('p', null, `加载失败：${loadError}`),
        h('button', { type: 'button', className: 'dsh-ms-btn', onClick: () => setReloadKey((v) => v + 1) }, '重试'),
      )
    }

    const vendor = vendorRef.current
    const modelReady = modelConfig?.ready === true

    const renderStatusLeft = () => {
      if (activeJob) {
        const stepDesc = activeJob.currentAction
          ? `${activeJob.currentNode} (${activeJob.currentAction})`
          : (activeJob.currentNode || '启动中')
        const queueSuffix = queuedCount > 0 ? ` · 队列还有 ${queuedCount} 条` : ''
        return h(
          'div',
          { className: 'dsh-ms-status-left' },
          h('span', { className: 'dsh-ms-spinner dsh-ms-spinner-sm', 'aria-hidden': 'true' }),
          h('span', null, `正在执行 flow.ingest：${stepDesc}（已完成 ${activeJob.completedSteps ?? 0} 步${queueSuffix}）`),
        )
      }
      if (submitError !== '') {
        return h('div', { className: 'dsh-ms-status-left dsh-ms-status-error' }, submitError)
      }
      if (!modelReady) {
        return h(
          'div',
          { className: 'dsh-ms-status-left' },
          h('span', { className: 'dsh-ms-dot warn' }),
          h('span', null, '尚未配置可用模型，提交前请先配置。'),
          h(
            'button',
            { type: 'button', className: 'dsh-ms-link-btn', onClick: () => setShowModelModal(true) },
            '去配置',
          ),
        )
      }
      if (lastFinished) {
        if (lastFinished.status === 'failed') {
          return h(
            'div',
            { className: 'dsh-ms-status-left dsh-ms-status-error' },
            `上次执行失败：${lastFinished.error || '未知错误'}`,
          )
        }
        const newIds = lastFinished.newNodeIds ?? []
        return h(
          'div',
          { className: 'dsh-ms-status-left dsh-ms-status-ok' },
          h('span', null, `最近一次 ingest 已完成，新增 ${newIds.length} 个节点`),
          newIds.length > 0
            ? h(
                'button',
                { type: 'button', className: 'dsh-ms-link-btn', onClick: () => focusNodes(newIds) },
                '定位新节点',
              )
            : null,
        )
      }
      return h('div', { className: 'dsh-ms-status-left' }, '输入语料后将通过 flow.ingest 自动拆解并接入图谱')
    }

    return h(
      'div',
      { className: 'dsh-ms-root' },
      h(
        'header',
        { className: 'dsh-ms-header' },
        h(
          'div',
          { className: 'dsh-ms-header-left' },
          h('span', { className: `dsh-ms-dot${connected ? ' ok' : ''}`, title: connected ? '实时流已连接' : '实时流重连中' }),
          h('span', { className: 'dsh-ms-title' }, '心智空间'),
          h('span', { className: 'dsh-ms-meta' }, `${graph.nodes.length} 节点 · ${graph.edges.length} 边`),
        ),
        h(
          'div',
          { className: 'dsh-ms-header-right' },
          h(
            'button',
            {
              type: 'button',
              className: `dsh-ms-btn dsh-ms-model-pill${modelReady ? '' : ' dsh-ms-btn-warn'}`,
              onClick: () => setShowModelModal(true),
              title: modelConfig?.summary ?? '配置运行时模型',
            },
            modelConfig?.summary ?? '模型配置',
          ),
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: handleFitAll }, '全图适配'),
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: handleResetLayout }, '重新排版'),
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: handleRefreshAll }, '刷新'),
        ),
      ),
      h(
        'div',
        { className: 'dsh-ms-stage' },
        h(
          'div',
          { className: 'dsh-ms-canvas-wrap' },
          h(vendor.Excalidraw, {
            initialData: initialSceneRef.current,
            excalidrawAPI: (instance) => {
              excalidrawApiRef.current = instance
              if (!hasFittedRef.current && instance && initialSceneRef.current?.elements?.length > 0) {
                hasFittedRef.current = true
                requestAnimationFrame(() => {
                  try {
                    instance.scrollToContent(instance.getSceneElements(), { fitToContent: true, animate: false })
                  } catch {
                  }
                })
              }
            },
            theme: colorScheme === 'dark' ? 'dark' : 'light',
            langCode: 'zh-CN',
            isCollaborating: false,
            autoFocus: false,
            handleKeyboardGlobally: false,
            UIOptions: {
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
              },
            },
            onChange: handleSceneChange,
            onPointerUp: handlePointerUp,
          }),
        ),
        selectedNode
          ? h(NodeDetailDrawer, {
              node: selectedNode,
              graph,
              onClose: () => setSelectedConsId(null),
              onSelectNode: (id) => focusNodes([id]),
            })
          : null,
      ),
      h(
        'footer',
        { className: 'dsh-ms-footer' },
        h(
          'div',
          { className: 'dsh-ms-status-bar' },
          renderStatusLeft(),
          queuedCount > 0 && !activeJob ? h('span', null, `排队中：${queuedCount}`) : null,
        ),
        h(
          'div',
          { className: 'dsh-ms-composer' },
          h('textarea', {
            className: 'dsh-ms-textarea',
            rows: 1,
            value: inputText,
            onChange: (e) => setInputText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSubmit()
              }
            },
            placeholder: '输入一段知识、想法或规则（Enter 提交 flow.ingest，Shift+Enter 换行）…',
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ms-btn dsh-ms-btn-primary',
              onClick: () => void handleSubmit(),
              disabled: submitting || inputText.trim() === '',
              style: { height: '38px', padding: '0 16px' },
            },
            submitting ? '提交中…' : '输入',
          ),
        ),
      ),
      showModelModal
        ? h(ModelConfigModal, {
            modelConfig,
            onClose: () => setShowModelModal(false),
            onSaved: (nextConfig) => setModelConfig(nextConfig),
            onRefreshCatalog: handleRefreshCatalog,
          })
        : null,
    )
  }
}
