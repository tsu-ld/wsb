import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin'

const report = (level, message) => console[level](message)
const fail = (message) => {
  report('error', message)
  process.exit(1)
}

const check = process.argv.includes('--check')
const output = await Bun.build({
  entrypoints: ['src/opencode/tui.tsx'],
  target: 'bun',
  format: 'esm',
  naming: 'tui.js',
  external: ['solid-js', 'solid-js/store', '@opentui/core', '@opentui/solid', '@opencode/plugin'],
  plugins: [createSolidTransformPlugin()],
})

for (const log of output.logs) {
  report(log.level === 'error' ? 'error' : 'log', String(log))
}
if (!output.success) {
  fail('build failed')
}

const artifact = output.outputs[0]
if (!artifact || output.outputs.length !== 1) {
  fail('build must produce exactly one output')
}

const text = await artifact.text()
if (check) {
  const current = await Bun.file('dist/tui.js')
    .bytes()
    .catch(() => undefined)
  if (!current || !Buffer.from(text).equals(current)) {
    fail('dist/tui.js is stale; run bun scripts/build.js')
  }
} else {
  await Bun.write('dist/tui.js', text)
}
