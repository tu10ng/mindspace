import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMockLlm } from '../../src/llm/mock.js';
import type { ConsRef, EntityCandidate, LlmRequest } from '../../src/types.js';

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
      // ignore non-object blocks
    }
  }
  return out;
}

function actionIdOf(prompt: string): string {
  const first = jsonBlocks(prompt)[0];
  return typeof first?.['consId'] === 'string' ? first['consId'] : '';
}

function availableRefsOf(prompt: string): Record<string, unknown> {
  return jsonBlocks(prompt).find(
    (b) =>
      'availableObjects' in b ||
      'availableActions' in b ||
      'availableMethods' in b ||
      'availableRelationTypes' in b,
  ) ?? {};
}

function inputBlockOf(prompt: string): Record<string, unknown> {
  const marker = '## 输入数据\n```json\n';
  const idx = prompt.indexOf(marker);
  if (idx === -1) return {};
  const rest = prompt.slice(idx + marker.length);
  const end = rest.indexOf('\n```');
  if (end === -1) return {};
  try {
    return JSON.parse(rest.slice(0, end)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Deterministic school-experience LLM stub that strictly respects availableObjects /
 * availableStatements / availableRelationTypes and demonstrates P0 reuse, P1 association,
 * and P2 provenance-preserving topic summarization.
 */
function createSchoolScenarioLlm(opts?: { forceReuseOnEmpty?: boolean; forceBadSummarySource?: boolean }) {
  return createMockLlm((req: LlmRequest) => {
    const action = actionIdOf(req.userPrompt);
    const refs = availableRefsOf(req.userPrompt);
    const input = inputBlockOf(req.userPrompt);
    const inputObj = (input['input'] as { text?: string; consRef?: ConsRef } | undefined) ?? {};
    const text = inputObj.text ?? '';

    if (action === 'seed.make_query') {
      const queries: string[] = [];
      if (text.includes('屠天勤')) queries.push('屠天勤');
      if (text.includes('北京景山学校')) queries.push('北京景山学校');
      if (text.includes('北京工业大学')) queries.push('北京工业大学');
      if (text.includes('食堂')) queries.push('食堂');
      if (queries.length === 0) queries.push(text.slice(0, 12));
      return { queries, roles: ['object', 'concept'], anchorIds: [] };
    }

    if (action === 'seed.select_action') {
      return {
        status: 'selected',
        selected: { consId: 'seed.decompose', revision: 1 },
        usedTendencies: [],
        basisSummary: '结构化事实陈述使用拆解动作。',
        usedDefaultFreedom: true,
      };
    }

    if (action === 'seed.select_method') {
      const defaultMethod = input['defaultMethod'] as ConsRef;
      return {
        status: 'selected',
        selected: defaultMethod,
        usedTendencies: [],
        basisSummary: '采用默认拆解方法。',
        usedDefaultFreedom: true,
      };
    }

    if (action === 'seed.decompose') {
      if (text.includes('小学在北京景山学校就读')) {
        return {
          artifacts: [
            { tempId: 'p1', kind: 'object', content: { title: '屠天勤', body: '语料中提及的人物，小学在北京景山学校就读。' } },
            { tempId: 's1', kind: 'object', content: { title: '北京景山学校', body: '位于北京的一所学校，屠天勤小学在此就读。' } },
            { tempId: 'prop1', kind: 'proposition', content: { title: '屠天勤小学就读北京景山学校', body: '屠天勤小学在北京景山学校就读。' } },
          ],
          links: [
            { fromTempId: 'prop1', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p1' },
            { fromTempId: 'prop1', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 's1' },
          ],
          executionSummary: '拆解了小学就读经历。',
        };
      }
      if (text.includes('高考考上了北京工业大学')) {
        return {
          artifacts: [
            { tempId: 'p_local', kind: 'object', content: { title: '屠天勤', body: '高考考上北京工业大学的人物。' } },
            { tempId: 'u_local', kind: 'object', content: { title: '北京工业大学', body: '位于北京的高等院校，屠天勤高考录取院校。' } },
            { tempId: 'prop_gaokao', kind: 'proposition', content: { title: '屠天勤高考考上北京工业大学', body: '屠天勤高考考上了北京工业大学（录取事实，未说明毕业情况）。' } },
          ],
          links: [
            { fromTempId: 'prop_gaokao', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p_local' },
            { fromTempId: 'prop_gaokao', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'u_local' },
          ],
          executionSummary: '拆解了高考录取经历。',
        };
      }
      if (text.includes('包含了小学')) {
        return {
          artifacts: [
            { tempId: 's_local', kind: 'object', content: { title: '北京景山学校', body: '覆盖小学、初中、高中三个学段的学校。' } },
            { tempId: 'elem', kind: 'object', content: { title: '小学学段', body: '北京景山学校的小学学段。' } },
            { tempId: 'mid', kind: 'object', content: { title: '初中学段', body: '北京景山学校的初中学段。' } },
            { tempId: 'high', kind: 'object', content: { title: '高中学段', body: '北京景山学校的高中学段。' } },
            { tempId: 'prop_stages', kind: 'proposition', content: { title: '北京景山学校包含三个学段', body: '北京景山学校包含小学、初中、高中三个学段。' } },
          ],
          links: [
            { fromTempId: 'elem', relation: { kind: 'existing', ref: { consId: 'rel.part_of', revision: 1 } }, toTempId: 's_local' },
            { fromTempId: 'mid', relation: { kind: 'existing', ref: { consId: 'rel.part_of', revision: 1 } }, toTempId: 's_local' },
            { fromTempId: 'high', relation: { kind: 'existing', ref: { consId: 'rel.part_of', revision: 1 } }, toTempId: 's_local' },
            { fromTempId: 'prop_stages', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 's_local' },
          ],
          executionSummary: '拆解了北京景山学校的三学段结构。',
        };
      }
      if (text.includes('食堂')) {
        return {
          artifacts: [
            { tempId: 'c_bjut', kind: 'object', content: { title: '北京工业大学食堂', body: '北京工业大学的食堂。' } },
            { tempId: 'c_js', kind: 'object', content: { title: '北京景山学校食堂', body: '北京景山学校的食堂。' } },
            { tempId: 'prop_canteen', kind: 'proposition', content: { title: '两校食堂口味主观比较', body: '输入主张北京工业大学的食堂比北京景山学校的食堂好吃（主观评价）。' } },
          ],
          links: [
            { fromTempId: 'prop_canteen', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'c_bjut' },
            { fromTempId: 'prop_canteen', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'c_js' },
          ],
          executionSummary: '拆解了两校食堂主观比较。',
        };
      }
      if (text.includes('物理竞赛')) {
        return {
          artifacts: [
            { tempId: 'p_comp', kind: 'object', content: { title: '屠天勤', body: '高中参加物理竞赛、本科阶段躺平未参赛的人物。' } },
            { tempId: 'prop_high', kind: 'proposition', content: { title: '高中参加物理竞赛', body: '屠天勤在高中时参加了物理竞赛。' } },
            { tempId: 'prop_ug', kind: 'proposition', content: { title: '本科阶段未参加任何竞赛', body: '屠天勤在本科阶段躺平了，没有参加任何竞赛。' } },
          ],
          links: [
            { fromTempId: 'prop_high', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p_comp' },
            { fromTempId: 'prop_ug', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p_comp' },
          ],
          executionSummary: '拆解了高中物理竞赛与本科未参赛经历。',
        };
      }
      // Homonym different-person scenario
      if (text.includes('另一个同名人物') || text.includes('软件工程师')) {
        return {
          artifacts: [
            { tempId: 'p_other', kind: 'object', content: { title: '屠天勤', body: '上海的一名资深软件工程师，与北京学生不同。' } },
            { tempId: 'prop_other', kind: 'proposition', content: { title: '上海软件工程师屠天勤', body: '上海的另一位同名软件工程师屠天勤。' } },
          ],
          links: [
            { fromTempId: 'prop_other', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p_other' },
          ],
          executionSummary: '拆解了另一位同名人物信息。',
        };
      }
      return {
        artifacts: [
          { tempId: 'p_amb', kind: 'object', content: { title: '屠天勤', body: '语料提到的屠天勤。' } },
          { tempId: 'prop_amb', kind: 'proposition', content: { title: '待消歧经历', body: text } },
        ],
        links: [
          { fromTempId: 'prop_amb', relation: { kind: 'existing', ref: { consId: 'rel.describes', revision: 1 } }, toTempId: 'p_amb' },
        ],
        executionSummary: '拆解了待消歧语料。',
      };
    }

    if (action === 'seed.resolve_entities') {
      const availableObjects = (refs['availableObjects'] as EntityCandidate[] | undefined) ?? [];
      const artifacts = (input['artifacts'] as Array<{ tempId: string; kind: string; content: { title: string; body: string } }>) ?? [];
      const entityArts = artifacts.filter((a) => a.kind === 'object' || a.kind === 'concept');

      if (opts?.forceReuseOnEmpty === true && availableObjects.length === 0 && entityArts[0] !== undefined) {
        return {
          status: 'resolved',
          resolutions: entityArts.map((a) => ({
            tempId: a.tempId,
            decision: 'reuse',
            existingRef: { consId: 'forged-person-id', revision: 1 },
            basis: '尝试在空集合中伪造复用。',
          })),
        };
      }

      const resolutions = entityArts.map((art) => {
        if (text.includes('另一个同名人物') || text.includes('软件工程师')) {
          return {
            tempId: art.tempId,
            decision: 'create',
            basis: '输入明确为上海软件工程师，与候选中北京学生身份不同，应新建独立实体。',
          };
        }
        const sameTitle = availableObjects.filter((o) => o.title === art.content.title);
        if (sameTitle.length === 1 && sameTitle[0] !== undefined) {
          return {
            tempId: art.tempId,
            decision: 'reuse',
            existingRef: sameTitle[0].ref,
            basis: `与已有对象「${sameTitle[0].title}」语境一致且唯一，予以复用。`,
          };
        }
        if (sameTitle.length > 1) {
          return {
            tempId: art.tempId,
            decision: 'unresolved',
            candidateRefs: sameTitle.map((o) => o.ref),
            basis: `候选中存在 ${String(sameTitle.length)} 个同名「${art.content.title}」，无法唯一判定。`,
          };
        }
        return {
          tempId: art.tempId,
          decision: 'create',
          basis: '候选中无对应已有对象，新建。',
        };
      });
      const hasUnresolved = resolutions.some((r) => r.decision === 'unresolved');
      return {
        status: hasUnresolved ? 'needs_resolution' : 'resolved',
        resolutions,
      };
    }

    if (action === 'seed.associate_context') {
      const availableObjects = (refs['availableObjects'] as EntityCandidate[] | undefined) ?? [];
      const associations: unknown[] = [];
      if (text.includes('食堂') && inputObj.consRef !== undefined) {
        const bjut = availableObjects.find((o) => o.title === '北京工业大学');
        const js = availableObjects.find((o) => o.title === '北京景山学校');
        if (bjut !== undefined) {
          associations.push({
            from: { kind: 'draft', tempId: 'c_bjut' },
            relation: { kind: 'existing', ref: { consId: 'rel.part_of', revision: 1 } },
            to: { kind: 'existing', ref: bjut.ref },
            evidenceRefs: [inputObj.consRef],
            basis: '语料明确提到“北京工业大学的食堂”。',
          });
        }
        if (js !== undefined) {
          associations.push({
            from: { kind: 'draft', tempId: 'c_js' },
            relation: { kind: 'existing', ref: { consId: 'rel.part_of', revision: 1 } },
            to: { kind: 'existing', ref: js.ref },
            evidenceRefs: [inputObj.consRef],
            basis: '语料明确提到“北京景山学校的食堂”。',
          });
        }
      }
      return { associations };
    }

    if (action === 'seed.prepare_connections') {
      const artifacts = (input['artifacts'] as Array<{ tempId: string; content?: { title?: string } }>) ?? [];
      return {
        metadata: artifacts.map((a) => ({
          tempId: a.tempId,
          aliases: [],
          searchTerms: a.content?.title ? [a.content.title] : [],
        })),
      };
    }

    if (action === 'seed.summarize_topic') {
      const allowedSourceRefs = (input['allowedSourceRefs'] as ConsRef[] | undefined) ?? [];
      if (opts?.forceBadSummarySource === true) {
        return {
          title: '伪造来源汇总',
          body: '测试伪造来源。',
          sourceRefs: [{ consId: 'fake-source-999', revision: 1 }],
          coverage: ['小学'],
          openQuestions: [],
        };
      }
      return {
        title: '屠天勤学校经历汇总',
        body: [
          '1. 小学阶段：在北京景山学校就读。',
          '2. 中学与竞赛：高中时期参加了物理竞赛；初中与高中具体就读学校尚未提供（已知北京景山学校包含小学、初中、高中，但未说明个人初高中就读情况）。',
          '3. 高考与本科：高考考上（被录取）北京工业大学；本科阶段躺平，未参加任何竞赛；是否已毕业尚未提供。',
          '4. 校园生活评价（来源为输入主观比较）：记录中提到北京工业大学食堂比北京景山学校食堂好吃。',
        ].join('\n'),
        sourceRefs: allowedSourceRefs,
        coverage: ['小学就读（北京景山学校）', '高中物理竞赛', '高考录取（北京工业大学）', '本科未参赛', '两校食堂主观比较'],
        openQuestions: ['初中及高中具体就读学校未提供', '北京工业大学就读时间及毕业情况未提供'],
      };
    }

    if (action === 'seed.extract_method' || action === 'seed.extract_tendency') {
      return { status: 'none' };
    }

    throw new Error(`unexpected llm action ${action}`);
  });
}

describe('P0/P1/P2 end-to-end knowledge linking acceptance suite', () => {
  it('completes the full 5-input school experience chain + P1 canteen linking + P2 topic summary with permanent ID reuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-linking-e2e-'));
    const llm = createSchoolScenarioLlm();
    const app = await createApp({ dbPath: join(dir, 'school.db'), llm });
    try {
      // 1. Primary school input -> creates first permanent Person & School objects.
      const run1 = await app.runIngest('屠天勤小学在北京景山学校就读');
      expect(run1.status).toBe('completed');
      const snap1 = await app.store.getGraphSnapshot();
      const persons1 = snap1.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '屠天勤');
      const jingshan1 = snap1.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '北京景山学校');
      expect(persons1).toHaveLength(1);
      expect(jingshan1).toHaveLength(1);
      const personId = persons1[0]!.id;
      const jingshanId = jingshan1[0]!.id;
      const originalPersonBody = persons1[0]!.body;

      // 2. Gaokao admission input -> MUST reuse personId, attach new proposition, NOT create second person or overwrite body.
      const run2 = await app.runIngest('屠天勤高考考上了北京工业大学');
      expect(run2.status).toBe('completed');
      const snap2 = await app.store.getGraphSnapshot();
      const persons2 = snap2.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '屠天勤');
      expect(persons2).toHaveLength(1);
      expect(persons2[0]!.id).toBe(personId);
      expect(persons2[0]!.body).toBe(originalPersonBody);

      const bjutNodes = snap2.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '北京工业大学');
      expect(bjutNodes).toHaveLength(1);
      const bjutId = bjutNodes[0]!.id;

      // Verify prompt injected candidate body, sourceRefs, and relatedStatements (Acceptance #7).
      const resolveCall2 = llm.calls.find(
        (c) => actionIdOf(c.userPrompt) === 'seed.resolve_entities' && c.userPrompt.includes('高考考上了北京工业大学'),
      );
      expect(resolveCall2).toBeDefined();
      expect(resolveCall2?.userPrompt).toContain(originalPersonBody);
      expect(resolveCall2?.userPrompt).toContain('屠天勤小学在北京景山学校就读');
      expect(resolveCall2?.userPrompt).toContain('sourceRefs');

      // Verify content prompt (seed.decompose) also received candidate body & relatedStatements.
      const decomposeCall2 = llm.calls.find(
        (c) => actionIdOf(c.userPrompt) === 'seed.decompose' && c.userPrompt.includes('高考考上了北京工业大学'),
      );
      expect(decomposeCall2?.userPrompt).toContain(originalPersonBody);

      // Verify audit logs on run2 answer all observability questions.
      const events2 = await app.store.listEvents(run2.id, { limit: 200 });
      const resEvent = events2.find((e) => e.eventType === 'entity_resolution_made');
      expect(resEvent).toBeDefined();
      expect((resEvent?.payload as { reusedCount: number; createdCount: number }).reusedCount).toBe(1);
      expect((resEvent?.payload as { reusedCount: number; createdCount: number }).createdCount).toBe(1);
      const matEvent = events2.find((e) => e.eventType === 'entities_materialized');
      expect((matEvent?.payload as { reusedRefs: ConsRef[] }).reusedRefs.map((r) => r.consId)).toContain(personId);

      // 3. School three-stage structure -> MUST reuse jingshanId and attach stages + proposition.
      const run3 = await app.runIngest('北京景山学校包含了小学, 初中, 高中');
      expect(run3.status).toBe('completed');
      const snap3 = await app.store.getGraphSnapshot();
      const jingshan3 = snap3.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '北京景山学校');
      expect(jingshan3).toHaveLength(1);
      expect(jingshan3[0]!.id).toBe(jingshanId);
      const partOfEdges = snap3.edges.filter((e) => e.relationConsId === 'rel.part_of' && e.to.consId === jingshanId);
      expect(partOfEdges.length).toBeGreaterThanOrEqual(3);

      // 4. P1: Canteen comparison -> keeps comparison proposition, links both canteens to existing schools, no new schools.
      const run4 = await app.runIngest('北京工业大学的食堂比北京景山学校的食堂好吃');
      expect(run4.status).toBe('completed');
      const snap4 = await app.store.getGraphSnapshot();
      expect(snap4.nodes.filter((n) => n.title === '北京工业大学' && n.provenance.source !== 'input')).toHaveLength(1);
      expect(snap4.nodes.filter((n) => n.title === '北京景山学校' && n.provenance.source !== 'input')).toHaveLength(1);
      const bjutCanteen = snap4.nodes.find((n) => n.title === '北京工业大学食堂');
      const jsCanteen = snap4.nodes.find((n) => n.title === '北京景山学校食堂');
      expect(bjutCanteen).toBeDefined();
      expect(jsCanteen).toBeDefined();
      expect(snap4.edges.some((e) => e.from.consId === bjutCanteen?.id && e.relationConsId === 'rel.part_of' && e.to.consId === bjutId)).toBe(true);
      expect(snap4.edges.some((e) => e.from.consId === jsCanteen?.id && e.relationConsId === 'rel.part_of' && e.to.consId === jingshanId)).toBe(true);

      // 5. High school competition + undergraduate no-competition -> still reuses the SAME personId.
      const run5 = await app.runIngest('屠天勤在高中时参加了物理竞赛, 在本科阶段躺平了, 没有参加任何竞赛');
      expect(run5.status).toBe('completed');
      const snap5 = await app.store.getGraphSnapshot();
      const persons5 = snap5.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '屠天勤');
      expect(persons5).toHaveLength(1);
      expect(persons5[0]!.id).toBe(personId);
      // All 4 person propositions link directly to the single permanent personId.
      const personIncoming = snap5.edges.filter((e) => e.to.consId === personId && e.relationConsId === 'rel.describes');
      expect(personIncoming.length).toBeGreaterThanOrEqual(4);

      // 6. P2: On-demand topic summary -> preserves sources, leaves unknown stages open, does not modify originals.
      const sumRun = await app.summarizeTopic({ topicQuery: '屠天勤', task: '汇总我的学校经历' });
      expect(sumRun.status).toBe('completed');
      const connectedSummary = sumRun.state['connectedSummary'] as { created: ConsRef[] };
      expect(connectedSummary.created).toHaveLength(1);
      const summaryRef = connectedSummary.created[0]!;
      const summaryRev = await app.store.getRevision(summaryRef.consId, summaryRef.revision);
      expect(summaryRev?.roles).toEqual(['record']);
      expect(summaryRev?.body).toContain('北京景山学校');
      expect(summaryRev?.body).toContain('北京工业大学');
      expect(summaryRev?.body).toContain('物理竞赛');
      expect(summaryRev?.body).toContain('待补充/未明确');
      expect(summaryRev?.provenance.sourceRefs.length).toBeGreaterThanOrEqual(4);

      // 7. Updating summary creates revision 2 while preserving revision 1; stale revision causes revision_conflict.
      const sumRun2 = await app.summarizeTopic({
        topicRef: { consId: personId, revision: 1 },
        task: '更新学校经历汇总',
        updateSummaryRef: { consId: summaryRef.consId, expectedRevision: 1 },
      });
      expect(sumRun2.status).toBe('completed');
      const sumCons = await app.store.getCons(summaryRef.consId);
      expect(sumCons?.currentRevision).toBe(2);
      expect(sumCons?.activeRevision).toBe(2);
      expect(await app.store.getRevision(summaryRef.consId, 1)).not.toBeNull();
      expect(await app.store.getRevision(summaryRef.consId, 2)).not.toBeNull();

      const staleSumRun = await app.summarizeTopic({
        topicRef: { consId: personId, revision: 1 },
        task: '过时版本更新',
        updateSummaryRef: { consId: summaryRef.consId, expectedRevision: 1 },
      });
      expect(staleSumRun.status).toBe('failed');
      const staleSteps = await app.store.listSteps(staleSumRun.id);
      expect(staleSteps.find((s) => s.status === 'failed')?.errorCode).toBe('revision_conflict');
    } finally {
      app.close();
    }
  });

  it('creates a distinct entity for homonymous different person, pauses on ambiguity with needs_resolution, refuses ambiguous summary, and commits on explicit resumeResolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-homonym-e2e-'));
    const llm = createSchoolScenarioLlm();
    const app = await createApp({ dbPath: join(dir, 'homonym.db'), llm });
    try {
      const r1 = await app.runIngest('屠天勤小学在北京景山学校就读');
      expect(r1.status).toBe('completed');
      // Distinct person with the same name -> creates a second permanent object.
      const r2 = await app.runIngest('另一个同名人物屠天勤是上海的软件工程师');
      expect(r2.status).toBe('completed');

      const snap = await app.store.getGraphSnapshot();
      const persons = snap.nodes.filter((n) => n.roles.includes('object') && n.provenance.source !== 'input' && n.title === '屠天勤');
      expect(persons).toHaveLength(2);
      const firstPersonRef: ConsRef = { consId: persons[0]!.id, revision: 1 };

      // Ambiguous topic summary must pause with needs_resolution rather than merging two people.
      const ambSum = await app.summarizeTopic({ topicQuery: '屠天勤', task: '汇总屠天勤经历' });
      expect(ambSum.status).toBe('needs_resolution');
      const pendingSum = ambSum.state['pendingResolution'] as { kind: string; ambiguousTopics: EntityCandidate[] };
      expect(pendingSum.kind).toBe('topic_disambiguation');
      expect(pendingSum.ambiguousTopics).toHaveLength(2);

      // Ambiguous ingest must pause with needs_resolution and NOT activate the batch.
      const beforePropCount = snap.nodes.filter((n) => n.roles.includes('proposition')).length;
      const ambIngest = await app.runIngest('屠天勤昨天参加了一场技术沙龙');
      expect(ambIngest.status).toBe('needs_resolution');
      const afterPauseSnap = await app.store.getGraphSnapshot();
      expect(afterPauseSnap.nodes.filter((n) => n.roles.includes('proposition'))).toHaveLength(beforePropCount);

      // Explicitly resume by choosing the first person -> completes and connects the new proposition to it.
      const resumed = await app.resumeResolution(ambIngest.id, [
        { tempId: 'p_amb', decision: 'reuse', existingRef: firstPersonRef, basis: '用户确认为第一位屠天勤。' },
      ]);
      expect(resumed.status).toBe('completed');
      const afterResumeSnap = await app.store.getGraphSnapshot();
      expect(afterResumeSnap.nodes.filter((n) => n.roles.includes('proposition'))).toHaveLength(beforePropCount + 1);
      const linked = afterResumeSnap.edges.filter(
        (e) => e.to.consId === firstPersonRef.consId && e.relationConsId === 'rel.describes',
      );
      expect(linked.length).toBeGreaterThanOrEqual(2);
    } finally {
      app.close();
    }
  });

  it('rejects reuse when availableObjects is empty and rejects fabricated summary sourceRefs (Acceptance #5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-empty-ref-e2e-'));
    const badReuseApp = await createApp({
      dbPath: join(dir, 'bad-reuse.db'),
      llm: createSchoolScenarioLlm({ forceReuseOnEmpty: true }),
    });
    try {
      const run = await badReuseApp.runIngest('屠天勤小学在北京景山学校就读');
      expect(run.status).toBe('failed');
      const steps = await badReuseApp.store.listSteps(run.id);
      const failed = steps.find((s) => s.nodeId === 'resolve_entities');
      expect(failed?.errorCode).toBe('invalid_reference');
    } finally {
      badReuseApp.close();
    }

    const badSumApp = await createApp({
      dbPath: join(dir, 'bad-summary.db'),
      llm: createSchoolScenarioLlm({ forceBadSummarySource: true }),
    });
    try {
      const r1 = await badSumApp.runIngest('屠天勤小学在北京景山学校就读');
      expect(r1.status).toBe('completed');
      const sum = await badSumApp.summarizeTopic({ topicQuery: '屠天勤', task: '汇总经历' });
      expect(sum.status).toBe('failed');
      const steps = await badSumApp.store.listSteps(sum.id);
      expect(steps.find((s) => s.nodeId === 'summarize_topic')?.errorCode).toBe('invalid_reference');
    } finally {
      badSumApp.close();
    }
  });
});
