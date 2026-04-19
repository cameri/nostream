Feature: NIP-17 Gift wrap validation
  Scenario: Alice publishes a valid gift wrap with one recipient
    Given someone called Alice
    And someone called Bob
    When Alice sends a valid gift_wrap event for Bob
    Then Alice receives a successful gift_wrap command result

  Scenario: Alice cannot publish a gift wrap without a recipient p tag
    Given someone called Alice
    When Alice sends an invalid gift_wrap event without a p tag
    Then Alice receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap event (kind 1059) must have a p tag identifying the recipient"

  Scenario: Alice cannot publish a gift wrap with multiple recipient p tags
    Given someone called Alice
    And someone called Bob
    And someone called Charlie
    When Alice sends an invalid gift_wrap event with recipients Bob and Charlie
    Then Alice receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap event (kind 1059) must have exactly one p tag"

  Scenario: Alice cannot publish a gift wrap with malformed NIP-44 payload
    Given someone called Alice
    And someone called Bob
    When Alice sends an invalid gift_wrap event for Bob with malformed NIP-44 payload
    Then Alice receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap content must be a valid NIP-44 v2 payload"

  Scenario: Bob can query gift wraps addressed to him via #p
    Given someone called Alice
    And someone called Bob
    And someone called Charlie
    When Alice sends a valid gift_wrap event for Bob
    And Alice sends a valid gift_wrap event for Charlie
    And Bob subscribes to gift_wrap events tagged for Bob
    Then Bob receives 1 gift_wrap event from Alice tagged for Bob and EOSE
