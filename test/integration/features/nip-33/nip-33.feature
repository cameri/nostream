Feature: NIP-33 Parameterized replaceable events
  Scenario: Alice sends a parameterized replaceable event
    Given someone called Alice
    And Alice subscribes to author Alice
    When Alice sends a parameterized_replaceable_event_0 event with content "1" and tag d containing "variable"
    Then Alice receives a parameterized_replaceable_event_0 event from Alice with content "1" and tag d containing "variable"
    When Alice sends a parameterized_replaceable_event_0 event with content "2" and tag d containing "variable"
    Then Alice receives a parameterized_replaceable_event_0 event from Alice with content "2" and tag d containing "variable"
    Then Alice unsubscribes from author Alice
    When Alice subscribes to author Alice
    Then Alice receives 1 parameterized_replaceable_event_0 event from Alice with content "2" and EOSE
