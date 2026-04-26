@nip40
@expiration
@standalone
Feature: NIP-40 Event expiration for standalone events
  Scenario: Event with expiration tag in the past is not returned in queries
    Given someone called Alice
    And someone called Bob
    When Alice sends a text_note event with content "already expired" and expiration in the past
    And Bob subscribes to text_note events from Alice
    Then Bob receives 0 text_note events and EOSE

  Scenario: Event with expiration tag in the future is returned normally
    Given someone called Alice
    And someone called Bob
    When Alice sends a text_note event with content "not yet expired" and expiration in the future
    And Bob subscribes to text_note events from Alice
    Then Bob receives a text_note event from Alice with content "not yet expired"

  Scenario: Stored expired event is not returned to new subscribers
    Given someone called Alice
    And someone called Bob
    When Alice has a stored text_note event with content "short lived" and expiration in the past
    And Bob subscribes to text_note events from Alice
    Then Bob receives 0 text_note events and EOSE
