/**
 * Models Nostream's custom Redis-backed rate limit middleware for CodeQL's
 * js/missing-rate-limiting query.
 *
 * CodeQL only recognizes popular npm rate limiters by default. Nostream uses
 * in-repo middleware that calls isAdminRateLimited() / isRateLimited().
 */

import javascript
import semmle.javascript.security.dataflow.MissingRateLimiting

private predicate isNostreamRateLimitCheck(CallExpr call, string calleeName) {
  call.getCalleeName() = calleeName
}

private predicate isInFile(Function fn, string fileSuffix) {
  fn.getFile().getRelativePath().regexpMatch(".*/" + fileSuffix + "$")
}

/**
 * An admin route middleware function that invokes isAdminRateLimited().
 */
class NostreamAdminRateLimiterFunction extends DataFlow::FunctionNode {
  NostreamAdminRateLimiterFunction() {
    exists(CallExpr call |
      isNostreamRateLimitCheck(call, "isAdminRateLimited") and
      call.getEnclosingFunction() = this.getFunction() and
      isInFile(this.getFunction(), "admin-rate-limit-middleware.ts")
    )
  }
}

/**
 * A connection-level middleware function that invokes isRateLimited().
 */
class NostreamConnectionRateLimiterFunction extends DataFlow::FunctionNode {
  NostreamConnectionRateLimiterFunction() {
    exists(CallExpr call |
      isNostreamRateLimitCheck(call, "isRateLimited") and
      call.getEnclosingFunction() = this.getFunction() and
      isInFile(this.getFunction(), "rate-limiter-middleware.ts")
    )
  }
}

class NostreamAdminRateLimitMiddleware extends RateLimitingMiddleware instanceof NostreamAdminRateLimiterFunction {
}

class NostreamConnectionRateLimitMiddleware extends RateLimitingMiddleware instanceof NostreamConnectionRateLimiterFunction {
}
