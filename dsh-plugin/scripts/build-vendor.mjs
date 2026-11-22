import { spawnSync } from 'node:child_process'
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, 'scripts', '.vendor')
const VENDOR = path.join(ROOT, 'lib', 'vendor')
const PIN = '0.18.1'
const ESBUILD = '0.19.10'

const ENTRY = `import { Excalidraw, reconcileElements, CaptureUpdateAction, convertToExcalidrawElements, newElementWith, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
export { Excalidraw, reconcileElements, CaptureUpdateAction, convertToExcalidrawElements, newElementWith, viewportCoordsToSceneCoords }
`

const STUB = `export const parseMermaidToExcalidraw = async () => { throw new Error('mermaid is not enabled') }
export default {}
`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: WORK,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function installIfNeeded() {
  const marker = path.join(WORK, 'node_modules', '@excalidraw', 'excalidraw', 'package.json')
  if (await exists(marker)) return
  await mkdir(WORK, { recursive: true })
  await writeFile(path.join(WORK, 'package.json'), JSON.stringify({ name: 'dsh-mindspace-vendor', private: true }, null, 2))
  run('npm', ['install', '--no-audit', '--no-fund', `@excalidraw/excalidraw@${PIN}`, `esbuild@${ESBUILD}`])
}

async function main() {
  await installIfNeeded()
  const pkgDir = path.join(WORK, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod')
  const entry = path.join(WORK, 'entry.js')
  const stub = path.join(WORK, 'stub-mermaid.js')
  const raw = path.join(WORK, 'excalidraw.cjs.js')
  await writeFile(entry, ENTRY)
  await writeFile(stub, STUB)

  const bin = path.join(WORK, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  run(bin, [
    entry,
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--minify',
    '--external:react',
    '--external:react-dom',
    '--external:react/jsx-runtime',
    '--external:react-dom/client',
    '--loader:.css=empty',
    `--alias:@excalidraw/mermaid-to-excalidraw=${stub}`,
    `--outfile=${raw}`,
    '--log-level=warning',
  ])

  const bundle = await readFile(raw, 'utf8')
  const header = `window.__DSH_MINDSPACE_EXCALIDRAW__ = (function (require) {
  var module = { exports: {} };
  var exports = module.exports;
`
  const footer = `  return module.exports;
})(window.__DSH_MINDSPACE_EXCALIDRAW_REQUIRE__);
`

  await mkdir(VENDOR, { recursive: true })
  await writeFile(path.join(VENDOR, 'excalidraw.js'), header + bundle + footer)
  await copyFile(path.join(pkgDir, 'index.css'), path.join(VENDOR, 'excalidraw.css'))
  await rm(path.join(VENDOR, 'fonts'), { recursive: true, force: true })
  await cp(path.join(pkgDir, 'fonts'), path.join(VENDOR, 'fonts'), { recursive: true })
  await writeFile(
    path.join(VENDOR, 'manifest.json'),
    JSON.stringify(
      {
        excalidraw: PIN,
        esbuild: ESBUILD,
        externals: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
        stub: '@excalidraw/mermaid-to-excalidraw',
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
