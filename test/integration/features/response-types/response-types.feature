@response-types
Feature: HTTP response types
  Scenario Outline: GET path returns expected response Content-Type
    When a client requests path "<path>" with Accept header "<acceptHeader>"
    Then the HTTP response status is <statusCode>
    And the HTTP response Content-Type includes "<contentType>"

    Examples:
      | path                   | acceptHeader            | statusCode | contentType            |
      | /                      | application/nostr+json  | 200        | application/nostr+json |
      | /                      | text/html               | 200        | text/html              |
      | /healthz               | */*                     | 200        | text/plain             |
      | /terms                 | */*                     | 200        | text/html              |
      | /.well-known/nodeinfo  | */*                     | 200        | application/json       |
      | /nodeinfo/2.1          | */*                     | 200        | application/json       |
      | /nodeinfo/2.0          | */*                     | 200        | application/json       |

  Scenario Outline: dynamic GET path returns expected response Content-Type
    When a client requests dynamic path "<path>"
    Then the HTTP response status is <statusCode>
    And the HTTP response Content-Type includes "<contentType>"

    Examples:
      | path                                                                 | statusCode | contentType      |
      | /admissions/check/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef | 200        | application/json |
      | /invoices/non-existent-invoice/status                                | 404        | application/json |

  Scenario Outline: POST path returns expected response Content-Type
    Given payments are enabled with processor "<processor>"
    When a client posts "<body>" to path "<path>" with Content-Type "<contentTypeHeader>"
    Then the HTTP response status is <statusCode>
    And the HTTP response Content-Type includes "<contentType>"

    Examples:
      | path                | processor | contentTypeHeader                  | body                | statusCode | contentType      |
      | /invoices           | lnurl     | application/x-www-form-urlencoded  |                     | 400        | text/plain       |
      | /callbacks/lnbits   | lnbits    | application/json                   | {}                  | 403        | text/html        |
