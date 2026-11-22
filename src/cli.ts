if (process.argv[1] !== undefined && process.argv[1] !== '') {
  await main();
}

async function main(): Promise<void> {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url !== pathToFileURL(process.argv[1] as string).href) return;
  const { registerHooks } = await import('node:module');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (
          (specifier.startsWith('./') || specifier.startsWith('../')) &&
          specifier.endsWith('.js')
        ) {
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        }
        throw err;
      }
    },
  });

  const argv = process.argv.slice(2);
  const command = argv[0] ?? '';
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(arg.slice(2), next);
        i += 1;
      } else {
        flags.set(arg.slice(2), '');
      }
    }
  }
  const db = flags.get('db') ?? 'mindspace.db';
  const { openStore } = await import('./store/index.js');
  const { loadSeeds } = await import('./seed/load-main.js');

  if (command === 'seed') {
    const store = openStore(db);
    await loadSeeds(store);
    console.log(`seeds loaded into ${db}`);
    store.close();
    return;
  }

  const { createApp } = await import('./app.js');
  const needsLlm: boolean = command === 'serve' || command === 'ingest' || command === 'define-action' || command === 'revise-method';
  const llm = needsLlm ? await resolveLlm(flags.get('mock') !== undefined) : null;

  if (command === 'serve') {
    const app = await createApp({ dbPath: db, llm: llm! });
    const { startServer } = await import('./api/server.js');
    const port = Number(flags.get('port') ?? '8080');
    const server = startServer(app, Number.isFinite(port) ? port : 8080);
    server.on('listening', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      console.log(`mindspace serving on http://127.0.0.1:${String(actual)}`);
    });
    return;
  }

  if (command === 'ingest') {
    const text = flags.get('text');
    if (text === undefined) {
      console.error('missing --text');
      process.exitCode = 1;
      return;
    }
    const app = await createApp({ dbPath: db, llm: llm! });
    try {
      const run = await app.runIngest(text);
      console.log(`run ${run.id} ${run.status}`);
      const steps = await app.store.listSteps(run.id);
      for (const s of steps) {
        console.log(`  ${s.nodeId}\t${s.actionRef.consId}\t${s.methodRef !== undefined ? s.methodRef.consId : '-'}\t${s.status}`);
      }
    } finally {
      app.close();
    }
    return;
  }

  if (command === 'define-action') {
    const description = flags.get('description');
    if (description === undefined) {
      console.error('missing --description');
      process.exitCode = 1;
      return;
    }
    const app = await createApp({ dbPath: db, llm: llm! });
    try {
      const run = await app.runFlow('flow.define_action', `形成一个新动作：${description}`, { description });
      console.log(`run ${run.id} ${run.status}`);
      const state = run.state as Record<string, unknown>;
      const connected = state['connectedAction'];
      if (typeof connected === 'object' && connected !== null) {
        console.log(`connected: ${JSON.stringify((connected as Record<string, unknown>)['connected'])}`);
      }
    } finally {
      app.close();
    }
    return;
  }

  if (command === 'revise-method') {
    const method = flags.get('method');
    const instructions = flags.get('instructions');
    if (method === undefined || instructions === undefined) {
      console.error('missing --method or --instructions');
      process.exitCode = 1;
      return;
    }
    const app = await createApp({ dbPath: db, llm: llm! });
    try {
      const cons = await app.store.getCons(method);
      if (cons === null) {
        console.error(`unknown method ${method}`);
        process.exitCode = 1;
        return;
      }
      const run = await app.runFlow('flow.revise_method', `修订方法 ${method}`, {
        methodId: method,
        expectedRevision: cons.currentRevision,
        revision: { body: instructions, provenance: { source: 'human', sourceRefs: [] } },
      });
      console.log(`run ${run.id} ${run.status}`);
    } finally {
      app.close();
    }
    return;
  }

  if (command === 'show') {
    const runId = flags.get('run');
    if (runId === undefined) {
      console.error('missing --run');
      process.exitCode = 1;
      return;
    }
    const store = openStore(db);
    try {
      const run = await store.getRun(runId);
      if (run === null) {
        console.error(`run ${runId} not found`);
        process.exitCode = 1;
        return;
      }
      console.log(`run ${run.id} status=${run.status} task=${run.task}`);
      console.log('node\taction\tmethod\ttendencies\tstatus\tinput\toutput');
      const steps = await store.listSteps(runId);
      for (const s of steps) {
        const summary = (v: unknown): string => {
          const text = JSON.stringify(v ?? null) ?? '';
          return text.length > 60 ? `${text.slice(0, 60)}…` : text;
        };
        console.log([
          s.nodeId,
          s.actionRef.consId,
          s.methodRef !== undefined ? s.methodRef.consId : '-',
          s.tendencyRefs.map((t) => t.consId).join(',') || '-',
          s.status,
          summary(s.input),
          summary(s.output),
        ].join('\t'));
      }
    } finally {
      store.close();
    }
    return;
  }

  console.error(`unknown command "${command}"`);
  console.error('usage: cli <seed|serve|ingest|define-action|revise-method|show> [--db path] [--port n] [--text s] [--description s] [--method id --instructions s] [--run id] [--mock]');
  process.exitCode = 1;
}

async function resolveLlm(mock: boolean): Promise<import('./types.js').LlmAdapter> {
  if (!mock) {
    const baseUrl = process.env.MINDSPACE_LLM_BASEURL;
    const apiKey = process.env.MINDSPACE_LLM_APIKEY;
    const model = process.env.MINDSPACE_LLM_MODEL;
    if (baseUrl !== undefined && apiKey !== undefined && model !== undefined) {
      const { createOpenAiCompatibleLlm } = await import('./llm/openai.js');
      return createOpenAiCompatibleLlm({ baseUrl, apiKey, model });
    }
    console.error('未配置真实模型：请设置 MINDSPACE_LLM_BASEURL / MINDSPACE_LLM_APIKEY / MINDSPACE_LLM_MODEL，或使用 --mock（固定脚本，仅用于演示）。');
    process.exit(1);
  }
  const { createMockLlm } = await import('./llm/mock.js');
  return createMockLlm((req: import('./types.js').LlmRequest): unknown => {
    const blocks = [...req.userPrompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] ?? '{}') as Record<string, unknown>);
    const action = blocks[0]?.['consId'];
    if (action === 'seed.make_query') return { queries: ['拆解'], roles: ['action'], anchorIds: [] };
    if (action === 'seed.select_action') return { status: 'selected', selected: { consId: 'seed.decompose', revision: 1 }, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    if (action === 'seed.select_method') {
      const input = blocks.find((b) => 'defaultMethod' in b && 'candidates' in b) ?? {};
      const fallback = input['defaultMethod'] as { consId: string; revision: number } | undefined;
      return { status: 'selected', selected: fallback ?? null, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.decompose') return { artifacts: [{ tempId: 'a1', kind: 'object', content: { title: '中心对象', body: '输入中的核心对象。' } }], links: [], executionSummary: 'mock 拆解' };
    if (action === 'seed.prepare_connections') return { metadata: [{ tempId: 'a1', aliases: [], searchTerms: ['中心对象'] }] };
    if (action === 'seed.extract_method') return { status: 'none' };
    if (action === 'seed.extract_tendency') return { status: 'none' };
    if (action === 'seed.define_action') return { status: 'none' };
    throw new Error(`mock script has no response for ${String(action)}`);
  });
}
