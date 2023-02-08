Feature: NIP-42
  Scenario: Alice gets an event by ID
    Given someone called Alice
    And the relay requires the client to authenticate
    When Alice sends a text_note event with content "hello nostr"
    Then Alice receives an authentication challenge
