import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import plugin from '../src/index.js'
import { goUsage } from '../src/go-transport.js'

async function load() {
  const hooks = {}
  const storage = new Map()
  const dispose = await plugin.setup({
    session: {
      hook: (name, callback) => {
        hooks[name] = callback
      },
    },
    storage: {
      get: (k) => storage.get(k),
      set: (k, v) => storage.set(k, v),
      remove: (k) => storage.delete(k),
    },
  })
  return { hooks, storage, dispose }
}

test('the installed plugin follows only the Claude request that hit the local Meridian instance', async () => {
  const now = Date.now()
  const seen = []
  const proxy = createServer((req, res) => {
    seen.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/usage/quota/all') {
      res.end(
        JSON.stringify({
          profiles: [
            { id: 'work', type: 'claude-max', isActive: true, windows: [], fetchedAt: now },
          ],
        }),
      )
    } else {
      res.end(
        JSON.stringify({
          profile: 'work',
          sources: { oauth: { fetchedAt: now } },
          buckets: [{ type: 'five_hour', status: 'rejected', resetsAt: now + 40_000 }],
        }),
      )
    }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const { hooks, dispose } = await load()
    const route = {
      sessionID: 'ses_a',
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet' },
    }
    const event = {
      ...route,
      error: { type: 'provider.rate-limit', status: 429 },
      decision: { retry: false },
    }
    await hooks['http.response']({
      ...route,
      kind: 'primary',
      response: Response.json(
        { error: { type: 'rate_limit_error', message: 'Claude Max rate limit reached.' } },
        { status: 429 },
      ),
      request: new Request(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
        headers: { 'x-opencode-session': 'ses_a' },
      }),
    })
    await hooks.retry(event)
    expect(seen).toEqual(['/v1/usage/quota/all', '/v1/usage/quota?profile=work'])
    expect(event.decision.retry).toBe(true)
    expect(Math.abs(Date.now() + event.decision.delay - now - 40_000)).toBeLessThan(100)
    const other = { ...event, sessionID: 'ses_b', decision: { retry: false } }
    await hooks.retry(other)
    expect(other.decision).toEqual({ retry: false })
    dispose()
  } finally {
    proxy.closeAllConnections()
    await new Promise((resolve) => {
      proxy.close(resolve)
    })
  }
})

const make = (origin) => ({
  kind: 'primary',
  model: { providerID: 'opencode-go' },
  response: new Response(null, { status: 429 }),
  request: new Request(`${origin}/zen/go/v1/messages`, {
    headers: { authorization: 'Bearer mock', 'x-opencode-org-id': 'test-org' },
  }),
})
const meter = (at) => ({ status: 'rate-limited', resetsAt: new Date(at).toISOString() })
test('Go reads all three windows with the exact inference credential, never from a different origin', async () => {
  const deadline = Date.now() + 40_000
  const calls = []
  const read = (url, init) => {
    calls.push({ url, init })
    return Response.json({
      usage: {
        rolling: meter(deadline - 10_000),
        weekly: meter(deadline),
        monthly: { status: 'ok' },
      },
    })
  }
  expect(await goUsage(make('https://not-opencode.invalid'), read)).toBeUndefined()
  expect(await goUsage(make('https://opencode.ai'), read)).toBe(deadline)
  expect(calls.length).toBe(1)
  expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/usage')
  expect(calls[0].init).toMatchObject({
    headers: { authorization: 'Bearer mock', 'x-opencode-org-id': 'test-org' },
    redirect: 'error',
  })
})
