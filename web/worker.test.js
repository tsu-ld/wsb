import { expect, test } from 'bun:test'
import worker, { wantsMarkdown } from './worker.js'

test('recognizes an explicit Markdown preference without accepting q=0', () => {
  expect(wantsMarkdown('text/markdown')).toBe(true)
  expect(wantsMarkdown('text/html, text/markdown;q=0.5')).toBe(true)
  expect(wantsMarkdown('text/markdown;q=0')).toBe(false)
  expect(wantsMarkdown('application/json')).toBe(false)
  expect(wantsMarkdown('')).toBe(false)
})

test('serves the Markdown homepage with discovery links when requested', async () => {
  let fetched
  const response = await worker.fetch(
    new Request('https://wsb.tsu.ar/', {
      headers: { Accept: 'text/markdown' },
    }),
    {
      ASSETS: {
        fetch(request) {
          fetched = request
          return Promise.resolve(
            new Response('# wsb', {
              headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
            }),
          )
        },
      },
    },
  )

  expect(new URL(fetched.url).pathname).toBe('/index.md')
  expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  expect(response.headers.get('link')).toContain('</index.md>; rel="alternate"')
  expect(await response.text()).toBe('# wsb')
})

test('keeps HTML requests on the homepage and adds discovery links', async () => {
  const response = await worker.fetch(
    new Request('https://wsb.tsu.ar/', {
      headers: { Accept: 'text/html' },
    }),
    {
      ASSETS: {
        fetch(request) {
          expect(new URL(request.url).pathname).toBe('/')
          return Promise.resolve(
            new Response('<h1>wsb</h1>', {
              headers: { 'Content-Type': 'text/html' },
            }),
          )
        },
      },
    },
  )

  expect(response.headers.get('content-type')).toBe('text/html')
  expect(response.headers.get('link')).toContain('</llms.txt>; rel="describedby"')
  expect(await response.text()).toBe('<h1>wsb</h1>')
})
