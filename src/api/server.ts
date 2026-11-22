import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { App } from '../app.js';
import type { ConsRef, ConsRole, ConsRevision, RunBudget, Step } from '../types.js';
import { activateConsInTx } from '../primitives/index.js';

interface ApiError {
  errorCode: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is ConsRef {
  return isRecord(value) && typeof value['consId'] === 'string' && typeof value['revision'] === 'number';
}

function statusFor(code: string): number {
  if (code === 'unknown_reference') return 404;
  if (code === 'revision_conflict') return 409;
  if (code === 'unauthorized_action' || code === 'unauthorized_effect') return 403;
  return 400;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  const errorCode = err !== null && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : err instanceof Error && err.message.startsWith('unknown flow ')
      ? 'unknown_reference'
      : 'schema_mismatch';
  const message = err instanceof Error ? err.message : String(err);
  const payload: ApiError = { errorCode, message };
  sendJson(res, statusFor(errorCode), payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid_json' }));
      }
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

function stepView(step: Step): Record<string, unknown> {
  const output = isRecord(step.output) ? step.output : {};
  const selection = output['status'] === 'selected' || output['status'] === 'no_candidate';
  return {
    stepId: step.id,
    nodeId: step.nodeId,
    action: step.actionRef.consId,
    actionRevision: step.actionRef.revision,
    method: step.methodRef !== undefined ? step.methodRef.consId : null,
    methodRevision: step.methodRef !== undefined ? step.methodRef.revision : null,
    tendencies: step.tendencyRefs.map((t) => t.consId),
    status: step.status,
    errorCode: step.errorCode ?? null,
    input: step.input,
    output: step.output ?? null,
    usedDefaultFreedom: selection ? output['usedDefaultFreedom'] === true : null,
    selected: selection ? output['selected'] : undefined,
  };
}

async function runDetail(app: App, runId: string): Promise<Record<string, unknown>> {
  const run = await app.store.getRun(runId);
  if (run === null) {
    throw Object.assign(new Error(`run ${runId} not found`), { code: 'unknown_reference' });
  }
  const steps = await app.store.listSteps(runId);
  const state = isRecord(run.state) ? run.state : {};
  const mainCase = isRecord(state['mainCase']) && isRef(state['mainCase']['caseRef']) ? state['mainCase']['caseRef'] : null;
  const reusedMethods: ConsRef[] = [];
  if (mainCase !== null) {
    const edges = await app.store.listEdges(mainCase.consId, 'from', true);
    for (const e of edges) {
      if (e.relationConsId === 'rel.used_method') {
        reusedMethods.push(e.to);
      }
    }
  }
  const formedCons: ConsRef[] = [];
  for (const key of ['connectedContent', 'connectedMethod', 'connectedTendency']) {
    const v = state[key];
    if (isRecord(v) && Array.isArray(v['connected'])) {
      for (const ref of v['connected']) {
        if (isRef(ref)) {
          formedCons.push(ref);
        }
      }
    }
  }
  const markedNode = state['_currentNode'];
  const currentNode = markedNode !== undefined
    ? (typeof markedNode === 'string' ? markedNode : null)
    : run.status === 'completed' || run.status === 'failed'
      ? null
      : (steps[steps.length - 1]?.nodeId ?? run.entryFlowRef.consId);
  return {
    runId: run.id,
    status: run.status,
    task: run.task,
    entryFlowRef: run.entryFlowRef,
    currentNode,
    budget: run.budget,
    counters: run.counters,
    result: {
      inputCons: state['inputCons'] ?? null,
      actionResult: state['actionResult'] ?? null,
      mainCase: state['mainCase'] ?? null,
      noCandidateCase: state['noCandidateCase'] ?? null,
      internalizeResult: state['internalizeResult'] ?? null,
    },
    usedDefaultFreedom: isRecord(state['methodSelection']) ? state['methodSelection']['usedDefaultFreedom'] === true : null,
    formedCons,
    reusedMethods,
    steps: steps.map(stepView),
  };
}

async function handlePostCons(app: App, body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body)) {
    throw Object.assign(new Error('body must be an object'), { code: 'schema_mismatch' });
  }
  const title = body['title'];
  const roles = body['roles'];
  const bodyText = body['body'];
  if (typeof title !== 'string' || !Array.isArray(roles) || typeof bodyText !== 'string') {
    throw Object.assign(new Error('title (string), roles (array) and body (string) are required'), { code: 'schema_mismatch' });
  }
  const rev: Omit<ConsRevision, 'revision' | 'createdAt'> = {
    consId: randomUUID(),
    title,
    roles: roles as ConsRole[],
    body: bodyText,
    aliases: Array.isArray(body['aliases']) ? (body['aliases'] as string[]).filter((a) => typeof a === 'string') : [],
    searchTerms: Array.isArray(body['searchTerms']) ? (body['searchTerms'] as string[]).filter((a) => typeof a === 'string') : [],
    provenance: { source: 'human', sourceRefs: [] },
  };
  if (typeof body['applicabilityText'] === 'string') {
    rev.applicabilityText = body['applicabilityText'];
  }
  if (body['spec'] !== undefined && isRecord(body['spec'])) {
    rev.spec = body['spec'] as unknown as NonNullable<ConsRevision['spec']>;
  }
  const cons = await app.store.createCons(rev);
  await app.store.appendEvent('human_cons_created', { consId: cons.id, revision: 1 }, null, null);
  return { id: cons.id, currentRevision: cons.currentRevision, status: cons.status };
}

async function handlePostRevision(app: App, consId: string, body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body)) {
    throw Object.assign(new Error('body must be an object'), { code: 'schema_mismatch' });
  }
  const expected = body['expectedRevision'];
  const revision = body['revision'];
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1 || !isRecord(revision)) {
    throw Object.assign(new Error('expectedRevision (positive integer) and revision (object) are required'), { code: 'schema_mismatch' });
  }
  const cons = await app.store.getCons(consId);
  if (cons === null) {
    throw Object.assign(new Error(`cons ${consId} not found`), { code: 'unknown_reference' });
  }
  if (cons.currentRevision !== expected) {
    throw Object.assign(
      new Error(`revision_conflict: expected revision ${String(expected)} but current is ${String(cons.currentRevision)}`),
      { code: 'revision_conflict' },
    );
  }
  const old = await app.store.getRevision(consId, expected);
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const fields: Omit<ConsRevision, 'consId' | 'revision' | 'createdAt'> = {
    title: str(revision['title'], old?.title ?? consId),
    roles: Array.isArray(revision['roles']) ? (revision['roles'] as ConsRole[]) : (old?.roles ?? ['object']),
    body: str(revision['body'], old?.body ?? ''),
    aliases: Array.isArray(revision['aliases']) ? (revision['aliases'] as string[]) : (old?.aliases ?? []),
    searchTerms: Array.isArray(revision['searchTerms']) ? (revision['searchTerms'] as string[]) : (old?.searchTerms ?? []),
    provenance: { source: 'human', sourceRefs: [] },
  };
  if (typeof revision['applicabilityText'] === 'string') {
    fields.applicabilityText = revision['applicabilityText'];
  } else if (old?.applicabilityText !== undefined) {
    fields.applicabilityText = old.applicabilityText;
  }
  if (revision['spec'] !== undefined && isRecord(revision['spec'])) {
    fields.spec = revision['spec'] as unknown as NonNullable<ConsRevision['spec']>;
  } else if (old?.spec !== undefined) {
    fields.spec = old.spec;
  }
  const created = await app.store.createRevision(consId, fields);
  await app.store.appendEvent('human_cons_revised', { consId, revision: created.revision, expectedRevision: expected }, null, null);
  return { consId, revision: created.revision };
}

async function handleActivate(app: App, consId: string): Promise<Record<string, unknown>> {
  const revision = await app.store.transaction(async (): Promise<number> => {
    const cons = await app.store.getCons(consId);
    if (cons === null) {
      throw Object.assign(new Error(`cons ${consId} not found`), { code: 'unknown_reference' });
    }
    await activateConsInTx(app.store, consId, cons.currentRevision, { activatedBy: 'human-api' }, { methodBinding: true });
    await app.store.appendEvent('human_cons_activated', { consId, revision: cons.currentRevision }, null, null);
    return cons.currentRevision;
  });
  return { consId, status: 'active', revision };
}

async function route(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  const method = req.method ?? 'GET';

  if (method === 'GET' && parts.length === 1 && parts[0] === 'graph') {
    sendJson(res, 200, await app.store.getGraphSnapshot());
    return;
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'runs') {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const runs = await app.store.listRuns(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50);
    sendJson(res, 200, { runs });
    return;
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'runs') {
    const body = await readBody(req);
    if (!isRecord(body)) {
      throw Object.assign(new Error('body must be an object'), { code: 'schema_mismatch' });
    }
    if (typeof body['entryFlowId'] !== 'string' || body['entryFlowId'] === '') {
      throw Object.assign(new Error('entryFlowId (string) is required'), { code: 'schema_mismatch' });
    }
    if (typeof body['task'] !== 'string' || body['task'] === '') {
      throw Object.assign(new Error('task (string) is required'), { code: 'schema_mismatch' });
    }
    const entryFlowId = body['entryFlowId'];
    const task = body['task'];
    const budget = isRecord(body['budget']) ? body['budget'] as Partial<RunBudget> : undefined;
    const run = await app.runFlow(entryFlowId, task, body['input'] ?? {}, budget);
    sendJson(res, 201, { runId: run.id });
    return;
  }
  if (method === 'GET' && parts.length === 2 && parts[0] === 'runs') {
    sendJson(res, 200, await runDetail(app, parts[1] ?? ''));
    return;
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'runs' && parts[2] === 'events') {
    const run = await app.store.getRun(parts[1] ?? '');
    if (run === null) {
      throw Object.assign(new Error(`run ${parts[1] ?? ''} not found`), { code: 'unknown_reference' });
    }
    const afterId = Number(url.searchParams.get('afterId') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const events = await app.store.listEvents(run.id, {
      afterId: Number.isFinite(afterId) ? afterId : 0,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 100,
    });
    sendJson(res, 200, { events, nextAfterId: events.length > 0 ? events[events.length - 1]?.id ?? 0 : (afterId || 0) });
    return;
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'runs' && parts[2] === 'steps') {
    const run = await app.store.getRun(parts[1] ?? '');
    if (run === null) {
      throw Object.assign(new Error(`run ${parts[1] ?? ''} not found`), { code: 'unknown_reference' });
    }
    const steps = await app.store.listSteps(run.id);
    sendJson(res, 200, { steps: steps.map(stepView) });
    return;
  }
  if (method === 'GET' && parts.length === 2 && parts[0] === 'cons') {
    const consId = parts[1] ?? '';
    const cons = await app.store.getCons(consId);
    if (cons === null) {
      throw Object.assign(new Error(`cons ${consId} not found`), { code: 'unknown_reference' });
    }
    const revParam = url.searchParams.get('revision');
    const revision = revParam !== null ? Number(revParam) : undefined;
    const rev = await app.store.getRevision(consId, Number.isFinite(revision) ? revision : undefined);
    if (rev === null) {
      throw Object.assign(new Error(`revision of ${consId} not found`), { code: 'unknown_reference' });
    }
    sendJson(res, 200, { cons, revision: rev });
    return;
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'cons' && parts[2] === 'relations') {
    const consId = parts[1] ?? '';
    const cons = await app.store.getCons(consId);
    if (cons === null) {
      throw Object.assign(new Error(`cons ${consId} not found`), { code: 'unknown_reference' });
    }
    const edges = await app.store.listEdges(consId, 'both', false);
    sendJson(res, 200, { edges });
    return;
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'search') {
    const q = url.searchParams.get('q') ?? '';
    const role = url.searchParams.get('role');
    if (q === '') {
      throw Object.assign(new Error('query parameter q is required'), { code: 'schema_mismatch' });
    }
    const resp = role !== null
      ? await app.store.searchByRole({ text: q }, [role as ConsRole])
      : await app.store.search({ text: q });
    sendJson(res, 200, resp);
    return;
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'cons') {
    sendJson(res, 201, await handlePostCons(app, await readBody(req)));
    return;
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'cons' && parts[2] === 'revisions') {
    sendJson(res, 201, await handlePostRevision(app, parts[1] ?? '', await readBody(req)));
    return;
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'cons' && parts[2] === 'activate') {
    sendJson(res, 200, await handleActivate(app, parts[1] ?? ''));
    return;
  }
  throw Object.assign(new Error(`no route for ${method} ${url.pathname}`), { code: 'unknown_reference' });
}

export function startServer(app: App, port: number): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(app, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, err);
    });
  });
  server.listen(port);
  return server;
}
