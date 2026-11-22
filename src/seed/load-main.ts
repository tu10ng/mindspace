import type { ConsRevision } from '../types.js';
import type { ConsStoreApi } from '../store/api.js';
import { ALL_SEEDS, SEED_METHOD_OF_RELATION, type SeedCons } from './seeds.js';

const SEED_IMPORT_STEP = 'seed-import';

type RevisionInput = Omit<ConsRevision, 'revision' | 'createdAt'>;

function revisionInput(s: SeedCons): RevisionInput {
  const r: RevisionInput = {
    consId: s.id,
    title: s.title,
    roles: s.roles,
    body: s.body,
    aliases: s.aliases,
    searchTerms: s.searchTerms,
    provenance: { source: 'seed', sourceRefs: [] },
  };
  if (s.applicabilityText !== undefined) r.applicabilityText = s.applicabilityText;
  if (s.spec !== undefined) r.spec = s.spec;
  return r;
}

export async function loadSeeds(store: ConsStoreApi): Promise<void> {
  await store.transaction(async () => {
    const revisions = new Map<string, number>();
    let changed = false;

    for (const seed of ALL_SEEDS) {
      const existing = await store.getCons(seed.id);

      if (existing !== null) {
        const activeRevision = existing.activeRevision !== undefined && existing.activeRevision > 0
          ? existing.activeRevision
          : existing.currentRevision;
        revisions.set(seed.id, activeRevision);
        if (seed.binding !== undefined && (await store.getActiveExecutionBinding(seed.id)) === null) {
          const binding: Parameters<ConsStoreApi['upsertExecutionBinding']>[0] = {
            consId: seed.id,
            revision: activeRevision,
            executor: seed.binding.executor,
            active: true,
            activatedByStepId: SEED_IMPORT_STEP,
          };
          if (seed.binding.primitiveKey !== undefined) binding.primitiveKey = seed.binding.primitiveKey;
          await store.upsertExecutionBinding(binding);
        }
        if (seed.methodOf !== undefined) {
          const bindings = await store.listActiveMethodBindings(seed.methodOf);
          if (!bindings.some((b) => b.methodId === seed.id)) {
            await store.setMethodBinding(seed.methodOf, seed.id, activeRevision, true);
          }
          const edges = await store.listEdges(seed.id, 'from', true);
          const alreadyLinked = edges.some(
            (e) => e.relationConsId === SEED_METHOD_OF_RELATION && e.to.consId === seed.methodOf,
          );
          if (!alreadyLinked) {
            await store.createEdge({
              from: { consId: seed.id, revision: activeRevision },
              relationConsId: SEED_METHOD_OF_RELATION,
              to: { consId: seed.methodOf, revision: revisions.get(seed.methodOf) ?? activeRevision },
              status: 'active',
            });
          }
        }
        continue;
      }

      const input = revisionInput(seed);
      await store.createCons(input, { stableId: seed.id });
      const revision = 1;
      changed = true;
      revisions.set(seed.id, revision);

      await store.setStatus(seed.id, 'active');

      if (seed.binding !== undefined) {
        const binding: Parameters<ConsStoreApi['upsertExecutionBinding']>[0] = {
          consId: seed.id,
          revision,
          executor: seed.binding.executor,
          active: true,
          activatedByStepId: SEED_IMPORT_STEP,
        };
        if (seed.binding.primitiveKey !== undefined) binding.primitiveKey = seed.binding.primitiveKey;
        await store.upsertExecutionBinding(binding);
      }

      if (seed.methodOf !== undefined) {
        const actionRevision = revisions.get(seed.methodOf) ?? 1;
        await store.setMethodBinding(seed.methodOf, seed.id, revision, true);
        await store.createEdge({
          from: { consId: seed.id, revision },
          relationConsId: SEED_METHOD_OF_RELATION,
          to: { consId: seed.methodOf, revision: actionRevision },
          status: 'active',
        });
      }
    }

    if (changed) {
      await store.appendEvent('seeds_loaded', { count: ALL_SEEDS.length }, null, null);
    }
  });
}
