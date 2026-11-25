import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin'

const output = await Bun.build({
  entrypoints: ['src/opencode/tui.tsx'],
  outdir: 'dist',
  target: 'bun',
  format: 'esm',
  naming: 'tui.js',
  external: ['solid-js', 'solid-js/store', '@opentui/core', '@opentui/solid', '@opencode/plugin'],
  plugins: [createSolidTransformPlugin()],
})

for (const log of output.logs) {
  console[log.level === 'error' ? 'error' : 'log'](String(log))
}
if (!output.success) {
  process.exit(1)
}
