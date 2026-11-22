import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.js';
import type { ConsStoreApi } from '../../src/store/api.js';
import { loadSeeds } from '../../src/seed/load-main.js';
import {
  createPrimitives,
  REL_DESCRIBES,
  TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
  type TrustedEntityContextSnapshot,
} from '../../src/primitives/index.js';
import { makeCtx } from '../primitives/helpers.js';
import type { EntityCandidate, StatementCandidate } from '../../src/types.js';

let store: ConsStoreApi;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-ctx-search-'));
  store = openStore(join(dir, 'ctx.db'));
  await loadSeeds(store);
});

afterEach(() => {
  store.close();
});

async function createActive(
  id: string,
  fields: {
    title: string;
    roles: ('object' | 'concept' | 'proposition')[];
    body: string;
    aliases?: string[];
    source?: 'input' | 'llm' | 'human';
    sourceRefs?: Array<{ consId: string; revision: number }>;
  },
) {
  await store.createCons(
    {
      consId: id,
      title: fields.title,
      roles: fields.roles,
      body: fields.body,
      aliases: fields.aliases ?? [],
      searchTerms: [fields.title],
      provenance: { source: fields.source ?? 'llm', sourceRefs: fields.sourceRefs ?? [] },
    },
    { stableId: id },
  );
  await store.setStatus(id, 'active');
}

describe('P0 context retrieval and input-corpus filtering', () => {
  it('searches object + concept, excludes provenance.source=input, and attaches body, sourceRefs, and relatedStatements', async () => {
    await createActive('input-1', {
      title: '屠天勤小学在北京景山学校就读',
      roles: ['object'],
      body: '屠天勤小学在北京景山学校就读',
      source: 'input',
    });
    await createActive('person-1', {
      title: '屠天勤',
      roles: ['object'],
      body: '此前记录中就读北京景山学校的人物。',
      aliases: ['小屠'],
      sourceRefs: [{ consId: 'input-1', revision: 1 }],
    });
    await createActive('school-1', {
      title: '北京景山学校',
      roles: ['concept'],
      body: '位于北京的一所学校实体。',
      sourceRefs: [{ consId: 'input-1', revision: 1 }],
    });
    await createActive('prop-1', {
      title: '小学就读北京景山学校',
      roles: ['proposition'],
      body: '屠天勤小学在北京景山学校就读。',
      sourceRefs: [{ consId: 'input-1', revision: 1 }],
    });
    await store.createEdge({
      from: { consId: 'prop-1', revision: 1 },
      relationConsId: REL_DESCRIBES,
      to: { consId: 'person-1', revision: 1 },
      status: 'active',
    });
    await store.createEdge({
      from: { consId: 'prop-1', revision: 1 },
      relationConsId: REL_DESCRIBES,
      to: { consId: 'school-1', revision: 1 },
      status: 'active',
    });

    const ctx = makeCtx(store, {
      mode: 'context',
      queries: ['屠天勤', '北京景山学校'],
      roles: ['object', 'concept'],
      excludeInputProvenance: true,
      sourceText: '屠天勤高考考上了北京工业大学，也提到北京景山学校',
      maxObjects: 20,
      maxStatements: 20,
      maxRelatedPerObject: 5,
    });
    await store.createRun(ctx.run);
    const out = (await createPrimitives()['search']?.run(ctx, ctx.step.id)) as {
      objects: EntityCandidate[];
      statements: StatementCandidate[];
      truncated: { objects: boolean; statements: boolean };
      hasExistingContext: boolean;
    };

    expect(out.hasExistingContext).toBe(true);
    expect(out.truncated).toEqual({ objects: false, statements: false });
    const objIds = out.objects.map((o) => o.ref.consId);
    expect(objIds).toContain('person-1');
    expect(objIds).toContain('school-1');
    // Raw input corpus object must NOT enter entity alignment candidates.
    expect(objIds).not.toContain('input-1');

    const person = out.objects.find((o) => o.ref.consId === 'person-1');
    expect(person?.body).toContain('就读北京景山学校的人物');
    expect(person?.aliases).toEqual(['小屠']);
    expect(person?.sourceRefs).toEqual([{ consId: 'input-1', revision: 1 }]);
    expect(person?.relatedStatements).toHaveLength(1);
    expect(person?.relatedStatements[0]?.body).toBe('屠天勤小学在北京景山学校就读。');

    expect(out.statements.some((s) => s.ref.consId === 'prop-1')).toBe(true);

    // Trusted snapshot must be recorded server-side.
    const snap = await store.getTrustedSnapshot<TrustedEntityContextSnapshot>(
      ctx.run.id,
      TRUSTED_SNAPSHOT_ENTITY_CONTEXT,
    );
    expect(snap).not.toBeNull();
    expect(snap?.payload.objectRefs.map((r) => r.consId).sort()).toEqual(['person-1', 'school-1']);
    expect(snap?.payload.statementRefs.map((r) => r.consId)).toContain('prop-1');
  });

  it('finds entities mentioned verbatim in sourceText even when queries miss them', async () => {
    await createActive('school-bjut', {
      title: '北京工业大学',
      roles: ['object'],
      body: '位于北京的高等院校。',
    });
    await createActive('school-jingshan', {
      title: '北京景山学校',
      roles: ['object'],
      body: '位于北京的学校。',
    });

    const ctx = makeCtx(store, {
      mode: 'context',
      queries: ['食堂口味比较'],
      roles: ['object', 'concept'],
      excludeInputProvenance: true,
      sourceText: '北京工业大学的食堂比北京景山学校的食堂好吃',
    });
    await store.createRun(ctx.run);
    const out = (await createPrimitives()['search']?.run(ctx, ctx.step.id)) as {
      objects: EntityCandidate[];
    };
    const ids = out.objects.map((o) => o.ref.consId);
    expect(ids).toContain('school-bjut');
    expect(ids).toContain('school-jingshan');
  });

  it('marks truncated=true when candidate objects or related statements exceed configured limits', async () => {
    await createActive('ent-a', { title: '测试实体甲', roles: ['object'], body: '实体甲正文' });
    await createActive('ent-b', { title: '测试实体乙', roles: ['object'], body: '实体乙正文' });
    await createActive('ent-c', { title: '测试实体丙', roles: ['object'], body: '实体丙正文' });
    for (let i = 1; i <= 3; i++) {
      await createActive(`p-${String(i)}`, {
        title: `命题${String(i)}`,
        roles: ['proposition'],
        body: `关于测试实体甲的命题${String(i)}`,
      });
      await store.createEdge({
        from: { consId: `p-${String(i)}`, revision: 1 },
        relationConsId: REL_DESCRIBES,
        to: { consId: 'ent-a', revision: 1 },
        status: 'active',
      });
    }

    const ctx = makeCtx(store, {
      mode: 'context',
      queries: ['测试实体'],
      roles: ['object', 'concept'],
      maxObjects: 2,
      maxStatements: 2,
      maxRelatedPerObject: 2,
    });
    await store.createRun(ctx.run);
    const out = (await createPrimitives()['search']?.run(ctx, ctx.step.id)) as {
      objects: EntityCandidate[];
      statements: StatementCandidate[];
      truncated: { objects: boolean; statements: boolean };
    };
    expect(out.objects).toHaveLength(2);
    expect(out.truncated.objects).toBe(true);
    expect(out.truncated.statements).toBe(true);
    const entA = out.objects.find((o) => o.ref.consId === 'ent-a');
    expect(entA?.relatedStatements.length).toBeLessThanOrEqual(2);
  });

  it('upgrades seed-owned flows/actions on reload while preserving human-revised cons', async () => {
    // Simulate a human revision on a seed tendency; loadSeeds must NOT overwrite it.
    await store.createRevision('tendency.case_before_method', {
      title: '人工自定义倾向',
      roles: ['tendency'],
      body: '人工修订正文',
      aliases: [],
      searchTerms: ['人工'],
      provenance: { source: 'human', sourceRefs: [] },
    });
    await store.activateRevision('tendency.case_before_method', 2);

    // Reload seeds: human revision remains active at rev 2.
    await loadSeeds(store);
    const rev = await store.getRevision('tendency.case_before_method');
    expect(rev?.revision).toBe(2);
    expect(rev?.title).toBe('人工自定义倾向');
  });
});
