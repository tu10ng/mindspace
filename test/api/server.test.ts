import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { startServer } from '../../src/api/server.js';
import { createMockLlm } from '../../src/llm/mock.js';
import type { ConsRef, LlmRequest } from '../../src/types.js';
import type { Server } from 'node:http';

function jsonBlocks(prompt: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /```json\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    try {
      const parsed: unknown = JSON.parse(m[1] ?? '');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      void 0;
    }
  }
  return out;
}

function makeHandler() {
  return (req: LlmRequest): unknown => {
    const action = jsonBlocks(req.userPrompt)[0]?.['consId'];
    if (action === 'seed.make_query') {
      return { queries: ['拆解'], roles: ['action'], anchorIds: [] };
    }
    if (action === 'seed.select_action') {
      return { status: 'selected', selected: { consId: 'seed.decompose', revision: 1 }, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.select_method') {
      const input = jsonBlocks(req.userPrompt).find((b) => 'defaultMethod' in b && 'candidates' in b) ?? {};
      const fallback = input['defaultMethod'] as ConsRef | undefined;
      return { status: 'selected', selected: fallback ?? null, usedTendencies: [], basisSummary: 'mock', usedDefaultFreedom: true };
    }
    if (action === 'seed.decompose') {
      return {
        artifacts: [{ tempId: 'a1', kind: 'object', content: { title: '中心对象' } }],
        links: [],
        executionSummary: 'mock 拆解',
      };
    }
    if (action === 'seed.prepare_connections') {
      const artifactsBlock = jsonBlocks(req.userPrompt).find((b) => 'artifacts' in b) ?? {};
      const artifacts = Array.isArray(artifactsBlock['artifacts']) ? (artifactsBlock['artifacts'] as Array<Record<string, unknown>>) : [];
      return {
        candidates: artifacts.map((a) => ({ tempId: a['tempId'], kind: a['kind'], content: a['content'] })),
        edges: [],
      };
    }
    if (action === 'seed.extract_method') {
      return { status: 'none' };
    }
    if (action === 'seed.extract_tendency') {
      return { status: 'none' };
    }
    throw new Error(`unexpected llm call for action ${String(action)}`);
  };
}

let app: App;
let server: Server;
let base = '';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindspace-api-'));
  app = await createApp({ dbPath: join(dir, 'api.db'), llm: createMockLlm(makeHandler()) });
  server = startServer(app, 0);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
  app.close();
});

describe('POST /runs and GET /runs/:id', () => {
  let runId = '';

  it('creates a run returning only runId and completes it through the default flow.ingest (§15)', async () => {
    const res = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryFlowId: 'flow.ingest', task: '处理输入语料并内化', input: { text: '草原上的草很高。' } }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as Record<string, unknown>;
    expect(Object.keys(created)).toEqual(['runId']);
    runId = created['runId'] as string;
    const detail = await (await fetch(`${base}/runs/${runId}`)).json() as { status: string; steps: Array<Record<string, unknown>>; formedCons: ConsRef[]; usedDefaultFreedom: boolean };
    expect(detail.status).toBe('completed');
    const actions = detail.steps.map((s) => s['action']);
    expect(actions).toContain('seed.receive');
    expect(actions).toContain('seed.decompose');
    const exec = detail.steps.find((s) => s['nodeId'] === 'execute_action');
    expect(exec?.['method']).toBe('seed.decompose.default');
    expect(detail.usedDefaultFreedom).toBe(true);
    expect(detail.formedCons.length).toBeGreaterThan(0);
  });

  it('rejects a run without entryFlowId or task with 400 schema_mismatch (§15)', async () => {
    const noFlow = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    expect(noFlow.status).toBe(400);
    expect(((await noFlow.json()) as { errorCode: string }).errorCode).toBe('schema_mismatch');
    const noTask = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryFlowId: 'flow.ingest' }),
    });
    expect(noTask.status).toBe(400);
    expect(((await noTask.json()) as { errorCode: string }).errorCode).toBe('schema_mismatch');
  });

  it('returns run detail with budget and current node', async () => {
    const res = await fetch(`${base}/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; currentNode: unknown; budget: { maxSteps: number }; counters: { steps: number } };
    expect(body.status).toBe('completed');
    expect(body.currentNode).toBeNull();
    expect(body.budget.maxSteps).toBeGreaterThan(0);
    expect(body.counters.steps).toBeGreaterThan(0);
  });

  it('404s for an unknown run', async () => {
    const res = await fetch(`${base}/runs/nope`);
    expect(res.status).toBe(404);
    const body = await res.json() as { errorCode: string };
    expect(body.errorCode).toBe('unknown_reference');
  });
});

describe('GET /runs/:id/events pagination', () => {
  it('pages through events with afterId and limit', async () => {
    const created = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryFlowId: 'flow.ingest', task: 't', input: { text: '第二句。' } }),
    });
    const runId = ((await created.json()) as { runId: string }).runId;
    const first = await (await fetch(`${base}/runs/${runId}/events?limit=4`)).json() as { events: Array<{ id: number; eventType: string }>; nextAfterId: number };
    expect(first.events).toHaveLength(4);
    const second = await (await fetch(`${base}/runs/${runId}/events?afterId=${String(first.nextAfterId)}&limit=1000`)).json() as { events: Array<{ id: number; eventType: string }> };
    expect(second.events.length).toBeGreaterThan(0);
    expect(second.events.every((e) => e.id > first.nextAfterId)).toBe(true);
    const all = [...first.events, ...second.events].map((e) => e.eventType);
    expect(all).toContain('run_started');
    expect(all).toContain('step_succeeded');
    expect(all).toContain('run_finished');
  });
});

describe('GET /runs/:id/steps', () => {
  it('lists steps with action, method and tendencies', async () => {
    const runs = await (await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryFlowId: 'flow.ingest', task: 't', input: { text: '第三句。' } }),
    })).json() as { runId: string };
    const res = await fetch(`${base}/runs/${runs.runId}/steps`);
    expect(res.status).toBe(200);
    const body = await res.json() as { steps: Array<Record<string, unknown>> };
    expect(body.steps.length).toBeGreaterThan(5);
    const select = body.steps.find((s) => s['nodeId'] === 'select_action');
    expect(select?.['action']).toBe('seed.select_action');
    expect(select).toHaveProperty('usedDefaultFreedom');
  });
});

describe('cons endpoints', () => {
  let consId = '';

  it('GET /cons/:id returns the current or pinned revision', async () => {
    const created = await (await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryFlowId: 'flow.ingest', task: 't', input: { text: '第四句。' } }),
    })).json() as { runId: string };
    const detail = await (await fetch(`${base}/runs/${created.runId}`)).json() as { formedCons: ConsRef[] };
    consId = detail.formedCons[0]?.consId ?? '';
    expect(consId).not.toBe('');
    const res = await fetch(`${base}/cons/${consId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { cons: { id: string; status: string }; revision: { revision: number; title: string } };
    expect(body.cons.id).toBe(consId);
    expect(body.cons.status).toBe('active');
    const pinned = await (await fetch(`${base}/cons/${consId}?revision=1`)).json() as { revision: { revision: number } };
    expect(pinned.revision.revision).toBe(1);
  });

  it('GET /cons/:id/relations lists edges', async () => {
    const res = await fetch(`${base}/cons/${consId}/relations`);
    expect(res.status).toBe(200);
    const body = await res.json() as { edges: unknown[] };
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it('GET /search filters by role', async () => {
    const res = await fetch(`${base}/search?q=${encodeURIComponent('中心对象')}&role=object`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ ref: ConsRef }> };
    expect(body.items.some((i) => i.ref.consId === consId)).toBe(true);
  });

  it('POST /cons, revisions with CAS and activate', async () => {
    const created = await (await fetch(`${base}/cons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '人工对象', roles: ['object'], body: '人工创建的对象', aliases: [], searchTerms: ['人工'] }),
    })).json() as { id: string };
    expect(created.id).not.toBe('');

    const conflict = await fetch(`${base}/cons/${created.id}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 5, revision: { body: 'x' } }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { errorCode: string }).errorCode).toBe('revision_conflict');

    const revised = await (await fetch(`${base}/cons/${created.id}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, revision: { body: '人工修订后的对象' } }),
    })).json() as { revision: number };
    expect(revised.revision).toBe(2);

    const badAction = await (await fetch(`${base}/cons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '违规动作',
        roles: ['action'],
        body: '试图绑定原语',
        spec: { kind: 'action', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, executor: 'primitive', primitiveKey: 'form', allowedEffects: ['read'], freedom: { chooseWithinCandidates: false, fillExecutionDetails: false, proposeNewDefinitions: false } },
      }),
    })).json() as { id: string };
    const denied = await fetch(`${base}/cons/${badAction.id}/activate`, { method: 'POST' });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { errorCode: string }).errorCode).toBe('unauthorized_effect');

    const activated = await (await fetch(`${base}/cons/${created.id}/activate`, { method: 'POST' })).json() as { status: string };
    expect(activated.status).toBe('active');
  });
});
