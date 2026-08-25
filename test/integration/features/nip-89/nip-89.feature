Feature: NIP-89 Recommended Application Handlers (passive accept-and-serve)
  Scenario: A DVM worker publishes a handler information event
    Given someone called Alice
    When Alice sends a handler_information event with content "1" and tag d containing "dvm-worker"
    And Alice subscribes to author Alice
    Then Alice receives a handler_information event from Alice with content "1" and tag d containing "dvm-worker"

  Scenario: A newer handler information event replaces the older one
    Given someone called Alice
    And someone called Bob
    When Alice sends a handler_information event with content "first" and tag d containing "dvm-worker"
    And Alice sends a handler_information event with content "second" and tag d containing "dvm-worker"
    And Bob subscribes to author Alice
    Then Bob receives a handler_information event from Alice with content "second" and tag d containing "dvm-worker"

  Scenario: A user publishes a handler recommendation event
    Given someone called Alice
    When Alice sends a handler_recommendation event with content "" and tag d containing "5000"
    And Alice subscribes to author Alice
    Then Alice receives a handler_recommendation event from Alice with content "" and tag d containing "5000"

  Scenario: A newer handler recommendation event replaces the older one
    Given someone called Alice
    And someone called Bob
    When Alice sends a handler_recommendation event with content "" and tag d containing "5001"
    And Alice sends a handler_recommendation event with content "updated" and tag d containing "5001"
    And Bob subscribes to author Alice
    Then Bob receives a handler_recommendation event from Alice with content "updated" and tag d containing "5001"

  Scenario: A client filters by kind alone to discover handler information events
    Given someone called Alice
    And someone called Bob
    When Alice sends a handler_information event with content "for-kind-filter" and tag d containing "kind-filter-test"
    And Bob subscribes to handler_information events
    Then Bob receives a handler_information event from Alice with content "for-kind-filter" and tag d containing "kind-filter-test"

  Scenario: A client filters by kind alone to discover handler recommendation events
    Given someone called Alice
    And someone called Bob
    When Alice sends a handler_recommendation event with content "" and tag d containing "5002"
    And Bob subscribes to handler_recommendation events
    Then Bob receives a handler_recommendation event from Alice with content "" and tag d containing "5002"
