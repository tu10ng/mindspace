import type { ConsStoreApi } from '../store/api.js';

export async function loadSeeds(store: ConsStoreApi): Promise<void> {
  const m = await import('./load-main.js');
  await m.loadSeeds(store);
}

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
  const { openStore } = await import('../store/index.js');
  const impl = await import('./load-main.js');
  const dbPath = process.argv[2] ?? 'mindspace.db';
  const store = openStore(dbPath);
  await impl.loadSeeds(store);
  console.log(`seeds loaded into ${dbPath}`);
  store.close();
}
