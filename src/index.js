import { providers } from './providers.js'
import { setup } from './runner.ts'

export default {
  id: 'quota-resume',
  setup: (ctx) => setup(ctx, providers()),
}
