Feature: NIP-42
  Scenario: Alice gets an event by ID
    Given someone called Alice
    And the relay requires the client to authenticate
    When Alice sends a text_note event with content "hello nostr" unsuccessfully
    Then Alice receives an authentication challenge

  Scenario: Alice sends a signed challenge event
    Given someone called Alice
    And the relay requires the client to authenticate
    When Alice sends a text_note event with content "hello nostr" unsuccessfully
    And Alice receives an authentication challenge
    Then Alice sends a signed_challenge_event

  Scenario: Alice authenticates and sends an event
    Given someone called Alice
    And the relay requires the client to authenticate
    When Alice sends a text_note event with content "hello nostr" unsuccessfully
    And Alice receives an authentication challenge
    Then Alice sends a signed_challenge_event
    Then Alice sends a text_note event with content "hello nostr" successfully
