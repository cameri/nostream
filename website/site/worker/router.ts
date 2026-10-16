// Production router for the website worker:
//  - /preview/<n>/...  → proxied to the per-PR preview worker
//    `nostream-web-pr-<n>` (its own workers.dev URL, assets-only), so a PR
//    preview lives at https://ema.tnsor.network/preview/<n>/ while the
//    browser stays on the production domain.
//  - anything else     → this worker's own static assets (the production
//    site build), exactly what the assets-only worker did before.
// Preview workers that do not exist (or are deleted after merge) yield 404.

interface Env {
  ASSETS: Fetcher
}

const PREVIEW_RE = /^\/preview\/(\d+)(\/|$)/
const PR_WORKER = (n: number | string) => `https://nostream-web-pr-${n}.workers.dev`

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const m = PREVIEW_RE.exec(url.pathname)
    if (m) {
      const n = m[1]
      const inner = new URL(request.url)
      // The preview worker serves its build under the same /preview/<n> base,
      // so pass the path through unchanged.
      inner.hostname = new URL(PR_WORKER(n)).hostname
      const proxied = new Request(inner.toString(), request)
      const res = await fetch(proxied)
      // A missing preview worker answers workers.dev's 404 page (not JSON);
      // surface a friendlier one without caching it.
      if (res.status === 404 || res.status === 530) {
        return new Response(
          `Preview #${n} is not available — it may have been cleaned up after merge.`,
          { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
        )
      }
      const headers = new Headers(res.headers)
      // Previews must never be cached by the CDN or browsers.
      headers.set('cache-control', 'no-store')
      headers.set('x-preview-pr', n)
      return new Response(res.body, { status: res.status, headers })
    }
    return env.ASSETS.fetch(request)
  },
}
