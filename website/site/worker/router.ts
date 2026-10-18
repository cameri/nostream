// Production router for the website worker:
//  - /preview/<n>/...  → proxied to the per-PR preview worker
//    `nostream-web-pr-<n>` (its own workers.dev URL, assets-only), so a PR
//    preview lives at https://ema.tnsor.network/preview/<n>/ while the
//    browser stays on the preview domain. Previews deliberately stay on the
//    older domain: a broken PR build must never sit on the production one.
//  - http://            → 301 to the same path over https.
//  - a non-canonical host → 301 to the canonical host, when CANONICAL_HOST is
//    set. Preview paths are exempt (above): they are served from their own
//    domain, and a redirect would move them off the origin their links name.
//  - anything else      → this worker's own static assets (the production
//    site build), exactly what the assets-only worker did before.
// Preview workers that do not exist (or are deleted after merge) yield 404.

interface Env {
  ASSETS: Fetcher
  /** The one host the site answers on, e.g. `nostream.dev`. Unset disables the host redirect. */
  CANONICAL_HOST?: string
}

const PREVIEW_RE = /^\/preview\/(\d+)(\/|$)/
const PR_WORKER = (n: number | string) => `https://nostream-web-pr-${n}.cameri.workers.dev`

/** A bare host, without port: the value an env var can realistically carry. */
const bareHost = (host: string) => host.split(':')[0].toLowerCase()
/** The origin form the request is being redirected TO. */
const originHost = (host: string) => host.split(':')[0].toLowerCase() + (host.includes(':') ? `:${host.split(':').pop()}` : '')

/**
 * A 301 to `url`, written by hand rather than with `Response.redirect`.
 *
 * `Response.redirect` refuses anything but `http(s)` and copies no headers, and
 * its URL round-trip re-encodes a path that was already encoded - a 301 from
 * `/docs/a%20b` came back as `/docs/a%2520b`, which sends the reader to a path
 * that does not exist. `url.pathname` is the encoded form and `url.search` is
 * already normalised, so joining them preserves both.
 */
const redirect = (url: URL) =>
  new Response(null, { status: 301, headers: { location: `${url.origin}${url.pathname}${url.search}` } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // Redirects run before the preview branch on purpose: a preview URL on
    // http should be upgraded like any other, and the proxy hop is already
    // https to the worker.
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return redirect(url)
    }
    const m = PREVIEW_RE.exec(url.pathname)
    // Preview paths are matched BEFORE the canonical-host redirect: they are
    // served from their own domain, so sending them to the production host
    // would move every preview off the origin the links point at.
    if (!m) {
      const canonical = env.CANONICAL_HOST?.trim()
      if (canonical && bareHost(url.hostname) !== bareHost(canonical)) {
        url.host = originHost(canonical)
        return redirect(url)
      }
    }
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
