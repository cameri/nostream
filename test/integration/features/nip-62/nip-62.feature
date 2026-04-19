Feature: NIP-62
  Scenario: Alice requests to vanish
    Given someone called Alice
    And someone called Bob
    And Alice sends a set_metadata event
    And Alice sends a text_note event with content "please forget this"
    When Alice sends a request_to_vanish event
    And Bob subscribes to author Alice
    Then Bob receives 1 request_to_vanish event from Alice and EOSE

  Scenario: Alice cannot publish after requesting to vanish
    Given someone called Alice
    When Alice sends a request_to_vanish event
    And Alice drafts a text_note event with content "I should be blocked"
    Then Alice sends their last draft event unsuccessfully because "blocked: request to vanish active for pubkey"
