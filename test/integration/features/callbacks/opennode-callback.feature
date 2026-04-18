@opennode-callback
Feature: OpenNode callback endpoint
  Scenario: rejects malformed callback body
    Given OpenNode callback processing is enabled
    When I post a malformed OpenNode callback
    Then the OpenNode callback response status is 400
    And the OpenNode callback response body is "Malformed body"

  Scenario: rejects callback with invalid signature
    Given OpenNode callback processing is enabled
    When I post an OpenNode callback with an invalid signature
    Then the OpenNode callback response status is 403
    And the OpenNode callback response body is "Forbidden"

  Scenario: accepts valid signed callback for pending invoice
    Given OpenNode callback processing is enabled
    And a pending OpenNode invoice exists
    When I post a signed OpenNode callback with status "processing"
    Then the OpenNode callback response status is 200
    And the OpenNode callback response body is empty

  Scenario: completes a pending invoice on paid callback
    Given OpenNode callback processing is enabled
    And a pending OpenNode invoice exists
    When I post a signed OpenNode callback with status "paid"
    Then the OpenNode callback response status is 200
    And the OpenNode callback response body is "OK"
    And the OpenNode invoice is marked completed
