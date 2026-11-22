import cloudflare from '@cloudflare/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [
    ...(cloudflare.ignorePatterns ?? []),
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.cursor/**',
    '.opencode/**',
  ],
  jsPlugins: [...(cloudflare.jsPlugins ?? []), { name: 'local', specifier: './local-rules.js' }],
  rules: {
    ...cloudflare.rules,
    'local/no-comments': 'error',
    'local/no-em-dash': 'error',
  },
})
