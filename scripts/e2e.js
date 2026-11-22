import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { file, serve, sleep, spawn } from 'bun'

const frame = (delta, reason) =>
  `data: ${JSON.stringify({ id: 'chunk', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`

async function eventually(read, description) {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const value = await read()
    if (value) {
      return value
    }
    await sleep(40)
  }
  throw new Error(`Timed out: ${description}`)
}

const cases = ['go', 'claude', 'codex', 'restart', 'cancel', 'manual']
const selected = process.argv[2] ? [process.argv[2]] : cases
assert.ok(selected.every((item) => cases.includes(item)))

for (const scenario of selected) {
  const root = await mkdtemp(join(tmpdir(), 'wsb-'))
  const config = join(root, 'config', 'opencode')
  await mkdir(config, { recursive: true })
  const sessionID = `ses_test${randomUUID().replaceAll('-', '')}`
  const model = {
    providerID: { claude: 'anthropic', codex: 'openai' }[scenario] ?? 'opencode-go',
    id: 'local-test',
  }
  const password = randomUUID()
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    PWD: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_TELEMETRY: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  }
  const hits = []
  const manualRequests = []
  let until = 0
  const mock = serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/quota/all')) {
        return Response.json({
          profiles: [
            { id: 'demo', type: 'claude-max', isActive: true, windows: [], fetchedAt: Date.now() },
          ],
        })
      }
      if (url.pathname.endsWith('/usage/quota')) {
        return Response.json({
          profile: 'demo',
          buckets: [
            { type: 'five_hour', status: 'rejected', resetsAt: until - 1000 },
            { type: 'seven_day', status: 'rejected', resetsAt: until },
          ],
          sources: { oauth: { fetchedAt: Date.now() } },
        })
      }
      if (!url.pathname.endsWith('/chat/completions')) {
        return new Response(null, { status: 404 })
      }
      const input = await req.json()
      const primary =
        JSON.stringify(input.messages).includes('QUOTA_FIXTURE') &&
        !JSON.stringify(input.messages).includes('You name conversations')
      if (primary) {
        const now = Date.now()
        if (!until) {
          until = now + (scenario === 'restart' ? 9000 : 4000)
        }
        hits.push(now)
        const manual =
          scenario === 'manual' &&
          JSON.stringify(input.messages).includes('EXPLICIT_MANUAL_OVERRIDE')
        if (manual) {
          manualRequests.push(now)
        }
        if (now < until && !manual) {
          const error =
            scenario === 'claude'
              ? { type: 'rate_limit_error', message: 'Claude Max rate limit reached.' }
              : scenario === 'codex'
                ? {
                    type: 'usage_limit_reached',
                    message: 'The usage limit has been reached',
                    resets_at: until,
                    account_id: 'fixture',
                  }
                : { type: 'GoUsageLimitError', message: 'OpenCode Go rolling usage limit reached' }
          const headers =
            scenario === 'claude' || scenario === 'codex'
              ? {}
              : { 'retry-after': String(Math.ceil((until - now) / 1000)) }
          return Response.json(
            { error, metadata: { limitName: 'rolling' } },
            { status: 429, headers },
          )
        }
      }
      return new Response(
        `${frame({ role: 'assistant', content: 'DONE' }, null)}${frame({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const reserve = serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const { port } = reserve
  await reserve.stop(true)
  const endpoint = `http://127.0.0.1:${port}`
  const api = async (path, body) => {
    const response = await fetch(
      `${endpoint}${path}${path.includes('?') ? '&' : '?'}location[directory]=${encodeURIComponent(root)}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      throw new Error(`${path}: ${response.status} ${await response.text()}`)
    }
    return (await response.json()).data
  }
  const launch = () =>
    spawn(['opencode', 'serve', '--service', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      env,
      stdout: file(join(root, 'server.log')),
      stderr: file(join(root, 'stderr.log')),
    })
  const ready = () =>
    eventually(
      () =>
        api('/api/plugin')
          .then((plugins) => plugins.some((p) => p.id === 'wsb' && !p.error))
          .catch(() => false),
      'plugin active',
    )
  let service
  try {
    const entry = process.env.QUOTA_RESUME_PLUGIN
      ? resolve(process.env.QUOTA_RESUME_PLUGIN)
      : resolve(import.meta.dir, '..')
    await writeFile(join(config, 'service.json'), JSON.stringify({ password, port }))
    await writeFile(
      join(config, 'opencode.json'),
      JSON.stringify({
        plugins: [entry],
        model: `${model.providerID}/${model.id}`,
        providers: {
          [model.providerID]: {
            package: '@opencode/ai/providers/openai-compatible',
            activation: 'enabled',
            settings: {
              apiKey: 'dummy',
              baseURL: `http://127.0.0.1:${mock.port}/v1`,
              headers: { 'x-opencode-session': sessionID },
            },
            models: {
              [model.id]: {
                name: 'Local Test',
                limit: { context: 100_000, output: 8192 },
                capabilities: { tools: false },
              },
            },
          },
        },
      }),
    )
    service = launch()
    await ready()
    if (scenario === 'codex') {
      await api('/api/credential', {
        integrationID: 'openai',
        activate: true,
        value: {
          type: 'oauth',
          methodID: 'oauth',
          access: 'fixture',
          refresh: 'fixture',
          expires: Date.now() + 86_400_000,
          metadata: { accountID: 'fixture' },
        },
      })
    }
    await api('/api/session', {
      id: sessionID,
      agent: 'build',
      model,
      title: 'quota fixture',
      location: { directory: root },
    })
    await api(`/api/session/${sessionID}/prompt`, {
      text: 'QUOTA_FIXTURE Reply DONE without tools.',
    })
    await eventually(() => hits.length, 'first primary request')
    await sleep(350)
    if (scenario === 'restart') {
      service.kill('SIGKILL')
      await service.exited
      service = launch()
      await ready()
      assert.ok(Date.now() < until, 'restart had to finish before the deadline')
    }
    if (scenario === 'cancel' || scenario === 'manual') {
      await api(`/api/session/${sessionID}/interrupt`, { resume: false })
      if (scenario === 'manual') {
        assert.ok(Date.now() < until)
        await api(`/api/session/${sessionID}/prompt`, {
          text: 'QUOTA_FIXTURE EXPLICIT_MANUAL_OVERRIDE',
        })
      } else {
        await sleep(Math.max(0, until - Date.now()) + 500)
        assert.equal(hits.length, 1)
      }
    }
    if (scenario !== 'cancel') {
      const history = await eventually(async () => {
        const messages = await api(`/api/session/${sessionID}/message?limit=100`)
        return (
          messages.some(
            (m) =>
              m.type === 'assistant' &&
              m.model?.id === model.id &&
              m.model.providerID === model.providerID &&
              m.content?.some((p) => p.text?.includes('DONE')),
          ) && messages
        )
      }, 'answer in original session and model')
      assert.equal(history.filter((m) => m.type === 'user').length, scenario === 'manual' ? 2 : 1)
      assert.equal(
        history.filter((m) => m.type === 'synthetic' && m.metadata?.notice !== 'restart').length,
        0,
      )
      if (scenario === 'manual') {
        assert.equal(manualRequests.length, 1)
        assert.ok(manualRequests[0] < until, 'user input is not held by the previous deadline')
        await sleep(Math.max(0, until - Date.now()) + 500)
      } else {
        assert.ok(hits[1] >= until, 'no inference before the latest blocking reset')
      }
      assert.equal(hits.length, 2, JSON.stringify(hits.map((t) => t - until)))
    }
    process.stdout.write(`PASS ${scenario} on OpenCode: ${hits.length} primary request(s)\n`)
  } finally {
    service?.kill()
    if (service) {
      await service.exited
    }
    await mock.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}
