import { expect, test } from 'bun:test'

const publicDir = new URL('../web/public/', import.meta.url)
const headers = await Bun.file(new URL('_headers', publicDir)).text()
const html = await Bun.file(new URL('index.html', publicDir)).text()
const markdown = await Bun.file(new URL('index.md', publicDir)).text()
const llms = await Bun.file(new URL('llms.txt', publicDir)).text()

test('the homepage advertises its Markdown representation and LLM guide', () => {
  expect(html).toContain(
    '<link rel="alternate" type="text/markdown" title="wsb in Markdown" href="/index.md" />',
  )
  expect(html).toContain('<link rel="describedby" type="text/markdown" href="/llms.txt" />')
  expect(headers).toContain('Link: </index.md>; rel="alternate"; type="text/markdown"')
  expect(headers).toContain('Link: </llms.txt>; rel="describedby"; type="text/markdown"')
  expect(headers).toContain(
    'Link: </.well-known/ard.json>; rel="service-desc"; type="application/json"',
  )
  expect(headers).not.toContain('api-catalog')
})

test('agent resources use crawler-friendly media types and CORS', () => {
  expect(headers).toMatch(/\/llms\.txt\n\s+Content-Type: text\/markdown; charset=utf-8/)
  expect(headers).toMatch(/\/index\.md\n\s+Content-Type: text\/markdown; charset=utf-8/)
  expect(headers).toMatch(/\/\.well-known\/ard\.json\n\s+Access-Control-Allow-Origin: \*/)
})

test('agent guides include installation and resource discovery', () => {
  for (const content of [markdown, llms]) {
    expect(content).toContain('opencode plugin add')
    expect(content).toContain('tsu-ld/wsb')
    expect(content).toContain('/.well-known/ard.json')
  }
  expect(markdown).toContain('/llms.txt')
})
