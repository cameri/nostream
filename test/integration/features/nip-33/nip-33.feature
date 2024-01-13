Feature: NIP-33 Parameterized replaceable events
  Scenario: Alice sends a parameterized replaceable event
    Given someone called Alice
    When Alice sends a parameterized_replaceable_event_0 event with content "1" and tag d containing "variable"
    When Alice sends a parameterized_replaceable_event_0 event with content "2" and tag d containing "variable"
    When Alice subscribes to author Alice
    Then Alice receives a parameterized_replaceable_event_0 event from Alice with content "2" and tag d containing "variable"

  Scenario: Alice adds an expiration tag to a parameterized replaceable event
    Given someone called Alice
    And someone called Bob
    When Alice sends a parameterized_replaceable_event_1 event with content "woot" and tag d containing "stuff"
    And Alice sends a parameterized_replaceable_event_1 event with content "nostr.watch" and tag d containing "stuff" and expiring in the future
    And Bob subscribes to author Alice
    Then Bob receives a parameterized_replaceable_event_1 event from Alice with content "nostr.watch" and tag d containing "stuff"

  Scenario: Alice removes an expiration tag to a parameterized replaceable event
    Given someone called Alice
    And someone called Bob
    When Alice sends a parameterized_replaceable_event_1 event with content "nostr.watch" and tag d containing "hey" and expiring in the future
    And Alice sends a parameterized_replaceable_event_1 event with content "woot" and tag d containing "hey"
    And Bob subscribes to author Alice
    Then Bob receives a parameterized_replaceable_event_1 event from Alice with content "woot" and tag d containing "hey"

  Scenario: Alice adds and removes an expiration tag to a parameterized replaceable event
    Given someone called Alice
    And someone called Bob
    When Alice sends a parameterized_replaceable_event_1 event with content "first" and tag d containing "friends"
    And Alice sends a parameterized_replaceable_event_1 event with content "second" and tag d containing "friends" and expiring in the future
    And Alice sends a parameterized_replaceable_event_1 event with content "third" and tag d containing "friends"
    And Bob subscribes to author Alice
    Then Bob receives a parameterized_replaceable_event_1 event from Alice with content "third" and tag d containing "friends"

  Scenario: Alice deletes a parameterized replaceable event
    Given someone called Alice
    When Alice sends a parameterized_replaceable_event_1 event with content "exercise" and tag d containing "2023-resolutions"
    And Alice sends a delete event for their last event
    And Alice subscribes to author Alice
    Then Alice receives 1 delete event from Alice and EOSE

  Scenario: Alice deletes and replaces a parameterized replaceable event
    Given someone called Alice
    And Alice sends a parameterized_replaceable_event_1 event with content "gym" and tag d containing "2024-resolutions"
    And Alice sends a delete event for their last event
    When Alice sends a parameterized_replaceable_event_1 event with content "exercise" and tag d containing "2024-resolutions"
    And Alice subscribes to parameterized_replaceable_event_1 events from Alice
    Then Alice receives a parameterized_replaceable_event_1 event from Alice with content "exercise" and tag d containing "2024-resolutions"

  Scenario: Alice deletes before sending parameterized replaceable event
    Given someone called Alice
    And Alice drafts a parameterized_replaceable_event_2 event with content "don't worry about it" and tag d containing "topsycrets"
    When Alice sends a delete event for their last event
    And Alice sends their last draft event successfully