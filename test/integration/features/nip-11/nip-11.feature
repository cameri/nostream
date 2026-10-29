Feature: NIP-11
  Scenario: Relay returns information document for NIP-11 request
    When a client requests the relay information document
    Then the response status is 200
    And the response Content-Type includes "application/nostr+json"
    And the relay information document contains the required fields

  Scenario: Relay information document lists supported NIPs from package.json
    When a client requests the relay information document
    Then the supported_nips field matches the NIPs declared in package.json

  Scenario: Relay information response includes required CORS headers
    When a client requests the relay information document
    Then the relay information response includes required NIP-11 CORS headers

  Scenario: Relay information document includes NIP-11 limitation parity fields
    When a client requests the relay information document
    Then the limitation object contains NIP-11 parity fields and values

  Scenario: Relay does not return information document for a non-NIP-11 Accept header
    When a client requests the root path with Accept header "text/html"
    Then the response Content-Type does not include "application/nostr+json"
    And the response body is not a relay information document

  Scenario: Relay serves HTML for typical browser Accept header
    When a browser requests the root path
    Then the response Content-Type includes "text/html"
    And the response body is not a relay information document

  Scenario: Relay information document reports max_filters from settings
    When a client requests the relay information document
    Then the limitation object contains a max_filters field

  Scenario: Relay information document advertises configured peering terms
    When a client requests the relay information document
    Then the peering object matches the configured peering settings

  Scenario: Settings validation accepts a complete peering configuration
    When peering settings are validated with a complete configuration
    Then the peering settings validation reports no issues

  Scenario: Settings validation rejects invalid peering configuration
    When peering settings are validated with an invalid configuration
    Then the peering settings validation reports an issue at "peering.contact"
    And the peering settings validation reports an issue at "peering.endpoint"
    And the peering settings validation reports an issue at "peering.minRequestPowDifficulty"
    And the peering settings validation reports an issue at "peering.scopes"
    And the peering settings validation reports an issue at "peering.scopes[0]"
    And the peering settings validation reports an issue at "peering.scopes[0].kinds[0]"
    And the peering settings validation reports an issue at "peering.terms[0].amount"
    And the peering settings validation reports an issue at "peering.terms[0].period"

  Scenario: WebSocket connections coexist with HTTP on the same port
    Given someone called Alice
    When Alice sends a text_note event with content "nostr is great"
    And Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "nostr is great"
