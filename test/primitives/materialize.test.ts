import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPrimitives,
  REL_DESCRIBES,
  REL_PART_OF,
  TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
  TRUSTED_SNAPSHOT_ENTITY_RESOLUTION,
} from '../../src/primitives/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import type { ConsRef } from '../../src/types.js';
import { makeCtx, makeStore } from './helpers.js';

let store: ConsStoreApi;

beforeEach(async () => {
  store = (await makeStore()).store;
});

afterEach(() => {
  store.close();
});

async function seedExistingObject(id: string, title: string, body: string): Promise<ConsRef> {
  await store.createCons(
    {
      consId: id,
      title,
      roles: ['object'],
      body,
      aliases: ['旧别名'],
      searchTerms: [title],
      provenance: { source: 'llm', sourceRefs: [] },
    },
    { stableId: id },
  );
  await store.setStatus(id, 'active');
  return { consId: id, revision: 1 };
}

async function seedInputCons(id: string, text: string): Promise<ConsRef> {
  await store.createCons(
    {
      consId: id,
      title: text.slice(0, 30),
      roles: ['object'],
      body: text,
      aliases: [],
      searchTerms: [],
      provenance: { source: 'input', sourceRefs: [] },
    },
    { stableId: id },
  );
  await store.setStatus(id, 'active');
  return { consId: id, revision: 1 };
}

async function seedTrustedSnapshots(
  runId: string,
  objectRefs: ConsRef[],
  resolutions: Array<{ tempId: string; decision: 'reuse' | 'create' | 'unresolved'; existingRef?: ConsRef; basis: string }>,
): Promise<void> {
  if ((await store.getRun(runId)) === null) {
    await store.createRun({
      id: runId,
      entryFlowRef: { consId: 'flow.ingest', revision: 1 },
      task: 'test',
      inputRefs: [],
      status: 'running',
      budget: { maxSteps: 64, maxLlmCalls: 20, maxOutputTokensPerCall: 4096 },
      counters: { steps: 0, llmCalls: 0 },
      state: {},
    });
  }
  await store.upsertStep({
    id: `${runId}::resolve_entities`,
    runId,
    nodeId: 'resolve_entities',
    actionRef: { consId: 'seed.resolve_entities', revision: 1 },
    tendencyRefs: [],
    input: {},
    status: 'succeeded',
    output: { status: 'resolved', resolutions },
    llmAttemptCount: 1,
  });
  await store.putTrustedSnapshot(runId, TRUSTED_SNAPSHOT_ENTITY_CONTEXT, `${runId}::retrieve_context`, {
    objectRefs,
    statementRefs: [],
    truncated: { objects: false, statements: false },
  });
  const tempIdToExistingRef: Record<string, ConsRef> = {};
  const createTempIds: string[] = [];
  const unresolvedTempIds: string[] = [];
  for (const r of resolutions) {
    if (r.decision === 'reuse' && r.existingRef !== undefined) tempIdToExistingRef[r.tempId] = r.existingRef;
    else if (r.decision === 'create') createTempIds.push(r.tempId);
    else unresolvedTempIds.push(r.tempId);
  }
  await store.putTrustedSnapshot(runId, TRUSTED_SNAPSHOT_ENTITY_RESOLUTION, `${runId}::resolve_entities`, {
    batchStepId: `${runId}::execute_action`,
    candidateSnapshotStepId: `${runId}::retrieve_context`,
    resolutions,
    tempIdToExistingRef,
    createTempIds,
    unresolvedTempIds,
  });
}

describe('materialize_and_connect atomic transaction, reuse protection, idempotency, and evidence deduplication', () => {
  it('reuses existing object without mutating its body/aliases/revision and connects new propositions to it', async () => {
    const personRef = await seedExistingObject('person-1', '屠天勤', '此前记录中的人物正文。');
    const inputRef = await seedInputCons('input-2', '屠天勤高考考上了北京工业大学');
    const ctx = makeCtx(store, {
      artifacts: [
        { tempId: 'p_local', kind: 'object', content: { title: '屠天勤', body: '试图覆盖的新人物描述' } },
        { tempId: 'u_local', kind: 'object', content: { title: '北京工业大学', body: '高校实体。' } },
        { tempId: 's_local', kind: 'proposition', content: { title: '高考录取', body: '屠天勤高考考上了北京工业大学。' } },
      ],
      links: [
        { fromTempId: 's_local', relation: { kind: 'existing', ref: { consId: REL_DESCRIBES, revision: 1 } }, toTempId: 'p_local' },
        { fromTempId: 's_local', relation: { kind: 'existing', ref: { consId: REL_DESCRIBES, revision: 1 } }, toTempId: 'u_local' },
      ],
      associations: [],
      metadata: [{ tempId: 'u_local', aliases: ['北工大'], searchTerms: ['北京工业大学', '高校'] }],
      inputRef,
      activate: true,
      allowRelationTypeActivation: true,
    });
    await seedTrustedSnapshots(ctx.run.id, [personRef], [
      { tempId: 'p_local', decision: 'reuse', existingRef: personRef, basis: '同一人物' },
      { tempId: 'u_local', decision: 'create', basis: '新高校' },
    ]);

    const prim = createPrimitives()['materialize_and_connect'];
    const out = (await prim?.run(ctx, ctx.step.id)) as {
      created: ConsRef[];
      reused: ConsRef[];
      edges: string[];
      tempMappings: Record<string, ConsRef>;
    };

    expect(out.reused).toEqual([personRef]);
    expect(out.created).toHaveLength(2);
    expect(out.tempMappings['p_local']).toEqual(personRef);

    // Reused object must remain untouched (same revision, body, aliases).
    const personCons = await store.getCons(personRef.consId);
    expect(personCons?.currentRevision).toBe(1);
    const personRev = await store.getRevision(personRef.consId, 1);
    expect(personRev?.body).toBe('此前记录中的人物正文。');
    expect(personRev?.aliases).toEqual(['旧别名']);

    // New proposition edge must point to the existing permanent personRef.
    const stmtRef = out.tempMappings['s_local'];
    expect(stmtRef).toBeDefined();
    const edges = await store.listEdges(personRef.consId, 'to', true);
    const link = edges.find((e) => e.from.consId === stmtRef?.consId && e.relationConsId === REL_DESCRIBES);
    expect(link).toBeDefined();
    expect(link?.evidenceRefs).toEqual([inputRef]);
  });

  it('rejects metadata targeting a reused object and rolls back the entire batch atomically', async () => {
    const personRef = await seedExistingObject('person-1', '屠天勤', '原正文');
    const ctx = makeCtx(store, {
      artifacts: [
        { tempId: 'p_local', kind: 'object', content: { title: '屠天勤', body: '局部描述' } },
        { tempId: 'u_local', kind: 'object', content: { title: '不应落盘的学校', body: '正文' } },
      ],
      links: [],
      metadata: [{ tempId: 'p_local', aliases: ['篡改别名'], searchTerms: ['篡改'] }],
      activate: true,
    });
    await seedTrustedSnapshots(ctx.run.id, [personRef], [
      { tempId: 'p_local', decision: 'reuse', existingRef: personRef, basis: '同一人物' },
      { tempId: 'u_local', decision: 'create', basis: '新建' },
    ]);

    await expect(createPrimitives()['materialize_and_connect']?.run(ctx, ctx.step.id)).rejects.toThrow(
      /unauthorized_effect: metadata must not target reused entity/,
    );
    // Entire transaction rolled back: u_local was NOT left behind.
    const search = await store.search({ text: '不应落盘的学校' });
    expect(search.items).toHaveLength(0);
  });

  it('rejects stale candidate revisions with revision_conflict instead of silently upgrading', async () => {
    const schoolRef = await seedExistingObject('school-1', '北京景山学校', '初版正文');
    // Revise school-1 after snapshot was taken so rev 1 is stale.
    await store.createRevision('school-1', {
      title: '北京景山学校',
      roles: ['object'],
      body: '修订后正文',
      aliases: [],
      searchTerms: ['北京景山学校'],
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.activateRevision('school-1', 2);

    const ctx = makeCtx(store, {
      artifacts: [
        { tempId: 's_local', kind: 'object', content: { title: '北京景山学校', body: '局部' } },
        { tempId: 'p_local', kind: 'proposition', content: { title: '不应落盘命题', body: '正文' } },
      ],
      links: [
        { fromTempId: 'p_local', relation: { kind: 'existing', ref: { consId: REL_DESCRIBES, revision: 1 } }, toTempId: 's_local' },
      ],
      activate: true,
    });
    await seedTrustedSnapshots(ctx.run.id, [schoolRef], [
      { tempId: 's_local', decision: 'reuse', existingRef: schoolRef, basis: '复用旧版' },
    ]);

    await expect(createPrimitives()['materialize_and_connect']?.run(ctx, ctx.step.id)).rejects.toThrow(/revision_conflict/);
    const search = await store.search({ text: '不应落盘命题' });
    expect(search.items).toHaveLength(0);
  });

  it('replays the same materialize_and_connect step idempotently with zero duplicate cons or edges', async () => {
    const schoolRef = await seedExistingObject('school-1', '北京景山学校', '学校正文');
    const inputRef = await seedInputCons('input-1', '测试输入');
    const ctx = makeCtx(store, {
      artifacts: [
        { tempId: 'canteen', kind: 'object', content: { title: '景山食堂', body: '学校食堂。' } },
      ],
      links: [],
      associations: [
        {
          from: { kind: 'draft', tempId: 'canteen' },
          relation: { kind: 'existing', ref: { consId: REL_PART_OF, revision: 1 } },
          to: { kind: 'existing', ref: schoolRef },
          evidenceRefs: [inputRef],
          basis: '输入明确为该校食堂。',
        },
      ],
      inputRef,
      activate: true,
    });
    await seedTrustedSnapshots(ctx.run.id, [schoolRef], [
      { tempId: 'canteen', decision: 'create', basis: '新食堂对象' },
    ]);

    const prim = createPrimitives()['materialize_and_connect'];
    const first = await prim?.run(ctx, ctx.step.id);
    const second = await prim?.run(ctx, ctx.step.id);
    expect(second).toEqual(first);

    const edges = await store.listEdges(schoolRef.consId, 'to', true);
    expect(edges).toHaveLength(1);
    const snap = await store.getGraphSnapshot();
    const canteens = snap.nodes.filter((n) => n.title === '景山食堂');
    expect(canteens).toHaveLength(1);
  });

  it('deduplicates structural edges across different steps while appending distinct input evidenceRefs', async () => {
    const schoolRef = await seedExistingObject('school-1', '北京景山学校', '学校正文');
    const canteenRef = await seedExistingObject('canteen-1', '景山食堂', '食堂正文');
    const inputA = await seedInputCons('input-a', '输入A提到景山食堂属于景山学校');
    const inputB = await seedInputCons('input-b', '输入B再次提到景山食堂属于景山学校');

    const runStep = async (runId: string, inputRef: ConsRef) => {
      const ctx = makeCtx(
        store,
        {
          artifacts: [],
          links: [],
          associations: [
            {
              from: { kind: 'existing', ref: canteenRef },
              relation: { kind: 'existing', ref: { consId: REL_PART_OF, revision: 1 } },
              to: { kind: 'existing', ref: schoolRef },
              evidenceRefs: [inputRef],
              basis: '来自该条输入的归属陈述。',
            },
          ],
          inputRef,
          activate: true,
        },
        runId,
      );
      await seedTrustedSnapshots(runId, [schoolRef, canteenRef], []);
      return (await createPrimitives()['materialize_and_connect']?.run(ctx, ctx.step.id)) as {
        edges: string[];
        reusedEdges: string[];
      };
    };

    const res1 = await runStep('run-ev-1', inputA);
    expect(res1.edges).toHaveLength(1);
    expect(res1.reusedEdges).toHaveLength(0);

    const res2 = await runStep('run-ev-2', inputB);
    expect(res2.edges).toHaveLength(0);
    expect(res2.reusedEdges).toEqual(res1.edges);

    const edges = await store.listEdges(schoolRef.consId, 'to', true);
    expect(edges).toHaveLength(1);
    const evidenceIds = (edges[0]?.evidenceRefs ?? []).map((r) => r.consId).sort();
    expect(evidenceIds).toEqual(['input-a', 'input-b']);
  });
});
