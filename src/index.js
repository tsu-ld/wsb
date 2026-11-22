import { providers } from './providers.js'
import { setup } from './runner.ts'

export default {
  id: 'wsb',
  setup: (ctx) => setup(ctx, providers()),
}
