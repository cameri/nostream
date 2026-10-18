// Production router for the website worker:
//  - /preview/<n>/...  → proxied to the per-PR preview worker
//    `nostream-web-pr-<n>` (its own workers.dev URL, assets-only), so a PR
//    preview lives at https://ema.tnsor.network/preview/<n>/ while the
//    browser stays on the preview domain. Previews deliberately stay on the
//    older domain: a broken PR build must never sit on the production one.
//  - http://            → 301 to the same path over https.
//  - a non-canonical host → 301 to the canonical host, when CANONICAL_HOST is
//    set - EXCEPT a preview path, which is served there: previews belong to
//    PREVIEW_HOST, so production and www send them to it rather than proxy a
//    pull request's build from the site's own address.
//  - anything else      → this worker's own static assets (the production
//    site build), exactly what the assets-only worker did before.
// Preview workers that do not exist (or are deleted after merge) yield 404.

interface Env {
  ASSETS: Fetcher
  /** The one host the site answers on, e.g. `nostream.dev`. Unset disables the host redirect. */
  CANONICAL_HOST?: string
}

const PREVIEW_RE = /^\/preview\/(\d+)(\/|$)/
/** The host previews are served from - the one their links, and this router, name. */
const PREVIEW_HOST = 'ema.tnsor.network'

const PR_WORKER = (n: number | string) => `https://nostream-web-pr-${n}.cameri.workers.dev`

/** A bare host, without port: the value an env var can realistically carry. */
const bareHost = (host: string) => host.split(':')[0].toLowerCase()
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
    const canonical = env.CANONICAL_HOST?.trim()
    // The canonical host is the one origin the site answers on. Unset disables
    // this whole layer: without a host to name there is nothing to redirect
    // toward, and treating every host as canonical is the opposite.
    if (canonical) {
      // The authority is host AND port - `nostream.dev:8443` serves the same
      // pages, so comparing hostnames alone would let a second origin through.
      const target = canonical.includes(':')
        ? bareHost(canonical) + `:${canonical.split(':').pop()}`
        : bareHost(canonical)
      const onCanonical = url.host.toLowerCase() === target
      const m = PREVIEW_RE.exec(url.pathname)
      if (onCanonical && m) {
        // A preview belongs to PREVIEW_HOST and only that host: serving one
        // from the production domain would put a pull request's build - on the
        // site's own address, with its own links.
        return redirect(new URL(`${url.protocol}//${PREVIEW_HOST}${url.pathname}${url.search}`))
      }
      if (!onCanonical) {
        // Every other authority converges on the canonical one, preview paths
        // included: only PREVIEW_HOST serves a preview, and it is reached
        // through the canonical origin like everything else.
        return redirect(new URL(`${url.protocol}//${target}${url.pathname}${url.search}`))
      }
    }
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
