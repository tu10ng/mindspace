window.__ModuleLoader__.load({
  id: '@local/dsh-mindspace',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'mindspace'
    const PANEL_ORDER = 85
    const LOCALE_NS = 'dsh-mindspace'
    const ASSET = 'api/mindspace/assets'
    const VERSION = '0.1.0'

    const SHELL = {
      zh: {
        'entry.label': '心智空间',
        'view.loading': '正在加载心智空间…',
        'view.loadFailed': '心智空间加载失败：{message}',
        'boundary.error': '面板出错了：{message}',
        'action.retry': '重试',
      },
      en: {
        'entry.label': 'Mindspace',
        'view.loading': 'Loading Mindspace…',
        'view.loadFailed': 'Mindspace failed to load: {message}',
        'boundary.error': 'Panel error: {message}',
        'action.retry': 'Retry',
      },
    }

    function resolveLang(ctx) {
      try {
        const snapshot = ctx?.locale?.getLocale?.() ?? ctx?.locale?.getSnapshot?.()
        const id = snapshot?.active ?? snapshot?.id ?? snapshot?.locale ?? 'en'
        return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    function translate(lang, key, vars) {
      const dict = SHELL[lang] ?? SHELL.en
      const template = dict[key] ?? SHELL.en[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = () => this.setState({ error: null })
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-mindspace] 面板渲染出错', error)
        } catch {
        }
      }

      render() {
        const lang = resolveLang(this.props.ctx)
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'dsh-ms-state dsh-ms-state-error', role: 'alert' },
            h('p', null, translate(lang, 'boundary.error', { message: this.state.error?.message ?? String(this.state.error) })),
            h('button', { type: 'button', className: 'dsh-ms-btn', onClick: this.retry }, translate(lang, 'action.retry')),
          )
        }
        return h(this.props.component, this.props.componentProps)
      }
    }

    function PanelHost(props) {
      const { ctx } = props
      const lang = resolveLang(ctx)
      const t = (key, vars) => translate(lang, key, vars)
      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({ module: null, error: null })

      React.useEffect(() => {
        let live = true
        setState({ module: null, error: null })
        const panelUrl = new URL(`${ASSET}/client/panel.js?v=${VERSION}`, document.baseURI).href
        import(panelUrl)
          .then((module) => {
            if (live) setState({ module, error: null })
          })
          .catch((error) => {
            if (live) setState({ module: null, error })
          })
        return () => {
          live = false
        }
      }, [attempt])

      const Panel = React.useMemo(
        () => (state.module === null ? null : state.module.createPanel({ React, require: props.require, ctx })),
        [state.module, ctx, props.require],
      )

      if (state.error !== null) {
        return h(
          'div',
          { className: 'dsh-ms-state dsh-ms-state-error', role: 'alert' },
          h('p', null, t('view.loadFailed', { message: state.error?.message ?? String(state.error) })),
          h('button', { type: 'button', className: 'dsh-ms-btn', onClick: () => setAttempt((v) => v + 1) }, t('action.retry')),
        )
      }

      if (Panel === null) {
        return h(
          'div',
          { className: 'dsh-ms-state' },
          h('div', { className: 'dsh-ms-spinner', 'aria-hidden': 'true' }),
          h('p', null, t('view.loading')),
        )
      }

      return h(Panel, props)
    }

    function Glyph({ size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M7 7.5 12 12M17 7 12 12M7.5 17 12 12M17 16.5 12 12' }),
        h('circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6.5, cy: 7, r: 1.9 }),
        h('circle', { cx: 17.5, cy: 6.8, r: 1.9 }),
        h('circle', { cx: 7, cy: 17.5, r: 1.9 }),
        h('circle', { cx: 17.5, cy: 17, r: 1.7 }),
      )
    }

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, SHELL), `${LOCALE_NS}: dictionaries`)

        ctx.effect(
          () => () => {
            for (const node of document.querySelectorAll('[data-dsh-mindspace]')) {
              node.parentNode?.removeChild(node)
            }
            delete window.__DSH_MINDSPACE_EXCALIDRAW__
            delete window.__DSH_MINDSPACE_EXCALIDRAW_REQUIRE__
          },
          `${LOCALE_NS}: assets`,
        )

        const Bounded = (props) =>
          h(PanelBoundary, {
            ctx,
            component: PanelHost,
            componentProps: { ...props, ctx, require },
          })

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => translate(resolveLang(ctx), 'entry.label'),
              locale: LOCALE_NS,
            },
            Glyph,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: LOCALE_NS,
            },
            Bounded,
          ),
        )
      },
    }
  },
})
