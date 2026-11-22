import { providers } from './providers.js'
import { Definition } from './rpc.ts'
import { holdFor, setup } from './runner.ts'

export default {
  id: 'wsb',
  setup: async (ctx) => {
    const state = { notify: () => undefined }
    const dispose = await setup(ctx, providers(), (sessionID) => state.notify(sessionID))
    const registration = await ctx.rpc.register(Definition, {
      get: ({ sessionID }) => holdFor(ctx, sessionID),
    })
    state.notify = (sessionID) => {
      void registration.events.emit('changed', { sessionID }).catch(() => undefined)
    }
    return async () => {
      await registration.dispose()
      dispose()
    }
  },
}
