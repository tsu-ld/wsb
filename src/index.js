import { asProviders, sources } from './opencode/sources/index.ts'
import { Definition } from './rpc.ts'
import { holdFor, setup } from './runner.ts'

export default {
  id: 'wsb',
  setup: async (ctx) => {
    const state = { notify: () => undefined }
    const dispose = await setup(
      ctx,
      asProviders(sources({ connection: () => ctx.integration?.connection })),
      (sessionID) => state.notify(sessionID),
    )
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
