const REQUIRED = ['og:title', 'og:type', 'og:image', 'og:url', 'og:description', 'twitter:card']
const ABSOLUTE = ['og:image', 'og:url']

export function isPage(tags: ReadonlyMap<string, string>): boolean {
  return !tags.has('refresh') && !(tags.get('robots') ?? '').toLowerCase().includes('noindex')
}

export function problems(tags: ReadonlyMap<string, string>): Array<string> {
  if (!isPage(tags)) {
    return []
  }
  const missing = REQUIRED.flatMap((key) => (tags.get(key)?.trim() ? [] : [`missing ${key}`]))
  const relative = ABSOLUTE.flatMap((key) => {
    const value = tags.get(key)
    return value && !/^https:\/\/[^/\s]+/.test(value) ? [`${key} is not an absolute https URL`] : []
  })
  return [...missing, ...relative]
}

async function readTags(path: string): Promise<Map<string, string>> {
  const tags = new Map<string, string>()
  const rewriter = new HTMLRewriter().on('meta', {
    element(meta) {
      const key =
        meta.getAttribute('property') ??
        meta.getAttribute('name') ??
        meta.getAttribute('http-equiv')
      const content = meta.getAttribute('content')
      if (key !== null && content !== null && !tags.has(key.toLowerCase())) {
        tags.set(key.toLowerCase(), content)
      }
    },
  })
  await rewriter.transform(new Response(Bun.file(path))).text()
  return tags
}

async function main(dir: string): Promise<number> {
  let failed = false
  let pages = 0
  for await (const file of new Bun.Glob('**/*.html').scan(dir)) {
    pages += 1
    for (const problem of problems(await readTags(`${dir}/${file}`))) {
      process.stderr.write(`${dir}/${file}: ${problem}\n`)
      failed = true
    }
  }
  if (pages === 0) {
    process.stderr.write(`no HTML files in ${dir}\n`)
  }
  return failed || pages === 0 ? 1 : 0
}

if (import.meta.main) {
  process.exit(await main(Bun.argv[2] ?? 'dist'))
}
