Feature: NIP-45
  Scenario: Alice counts Bob's text_note events
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "One"
    And Bob sends a text_note event with content "Two"
    And Alice counts text_note events from Bob
    Then Alice receives a count of 2

  Scenario: Alice counts Bob's events that carry two different tags
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "both tags" and tags t "nostr" and r "wss://relay.example.com"
    And Bob sends a text_note event with content "only t" and tag t containing "nostr"
    And Alice counts events from Bob with tag t "nostr" and tag r "wss://relay.example.com"
    Then Alice receives a count of 1

  Scenario: Alice counts Bob's event by ID and tag
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "tagged" and tag t containing "nostr"
    And Alice counts the last event from Bob with tag t "nostr"
    Then Alice receives a count of 1

  Scenario: Alice counts Bob's events with two filters when the first has a limit
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "One"
    And Bob sends a text_note event with content "Two"
    And Bob sends a set_metadata event
    And Alice counts text_note events from Bob with a limit of 1 or set_metadata events from Bob
    Then Alice receives a count of 2
