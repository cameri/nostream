import helmet from 'helmet'

// Security headers for every web response.
//
// `contentSecurityPolicy` stays off here on purpose: `createWebApp` already emits
// its own CSP, with the per-request nonce the pages use and the CDN origins they
// load from. Helmet's default policy would be sent as a second CSP header, and a
// browser enforces the intersection of every CSP on a response — the nonce the
// app relies on is absent from Helmet's, so inline scripts would be blocked and
// the dashboard would stop rendering. One policy, owned by the app, is the rule.
//
// The rest of Helmet's defaults are wanted as-is: HSTS, `X-Content-Type-Options`,
// `X-Frame-Options` (clickjacking), `Referrer-Policy`, `X-DNS-Prefetch-Control`,
// `X-Permitted-Cross-Domain-Policies` and cross-origin isolation headers.
export const securityHeaders = () => helmet({ contentSecurityPolicy: false })
