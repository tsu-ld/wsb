const discoveryLinks = [
  '</.well-known/ard.json>; rel="service-desc"; type="application/json"',
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</llms.txt>; rel="describedby"; type="text/markdown"',
  '</index.md>; rel="alternate"; type="text/markdown"',
].join(', ')

export function wantsMarkdown(accept) {
  return accept.split(',').some((range) => {
    const [mediaType, ...parameters] = range.trim().toLowerCase().split(';')
    if (mediaType !== 'text/markdown') {
      return false
    }
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith('q='))
    return quality === undefined || Number(quality.slice(2)) > 0
  })
}

function withDiscoveryHeaders(response) {
  const headers = new Headers(response.headers)
  headers.set('Link', discoveryLinks)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/') {
      return env.ASSETS.fetch(request)
    }
    const acceptsMarkdown =
      (request.method === 'GET' || request.method === 'HEAD') &&
      wantsMarkdown(request.headers.get('accept') ?? '')
    const assetRequest = acceptsMarkdown ? new Request(new URL('/index.md', url), request) : request
    return withDiscoveryHeaders(await env.ASSETS.fetch(assetRequest))
  },
}
