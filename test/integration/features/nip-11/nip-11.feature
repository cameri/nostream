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

  Scenario: WebSocket connections coexist with HTTP on the same port
    Given someone called Alice
    When Alice sends a text_note event with content "nostr is great"
    And Alice subscribes to author Alice
    Then Alice receives a text_note event from Alice with content "nostr is great"
