Feature: NIP-17 Gift wrap validation
  Scenario: Anshuman publishes a valid gift wrap with one recipient
    Given someone called Anshuman
    And someone called Bob
    When Anshuman sends a valid gift_wrap event for Bob
    Then Anshuman receives a successful gift_wrap command result

  Scenario: Anshuman cannot publish a gift wrap without a recipient p tag
    Given someone called Anshuman
    When Anshuman sends an invalid gift_wrap event without a p tag
    Then Anshuman receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap event (kind 1059) must have a p tag identifying the recipient"

  Scenario: Anshuman cannot publish a gift wrap with multiple recipient p tags
    Given someone called Anshuman
    And someone called Bob
    And someone called Charlie
    When Anshuman sends an invalid gift_wrap event with recipients Bob and Charlie
    Then Anshuman receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap event (kind 1059) must have exactly one p tag"

  Scenario: Anshuman cannot publish a gift wrap with malformed NIP-44 payload
    Given someone called Anshuman
    And someone called Bob
    When Anshuman sends an invalid gift_wrap event for Bob with malformed NIP-44 payload
    Then Anshuman receives an unsuccessful gift_wrap command result with reason containing "invalid: gift wrap content must be a valid NIP-44 v2 payload"

  Scenario: Bob can query gift wraps addressed to him via #p
    Given someone called Anshuman
    And someone called Bob
    And someone called Charlie
    When Anshuman sends a valid gift_wrap event for Bob
    And Anshuman sends a valid gift_wrap event for Charlie
    And Bob subscribes to gift_wrap events tagged for Bob
    Then Bob receives 1 gift_wrap event from Anshuman tagged for Bob and EOSE
