Feature: NIP-25 Reactions
  Scenario: Alice likes Bob's note
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "hello world"
    And Alice reacts to Bob's note with "+"
    And Alice subscribes to her reaction events
    Then Alice receives a reaction event with content "+"

  Scenario: Alice dislikes Bob's note
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "hello world"
    And Alice reacts to Bob's note with "-"
    And Alice subscribes to her reaction events
    Then Alice receives a reaction event with content "-"

  Scenario: Alice reacts with an emoji
    Given someone called Alice
    And someone called Bob
    When Bob sends a text_note event with content "hello world"
    And Alice reacts to Bob's note with "🤙"
    And Alice subscribes to her reaction events
    Then Alice receives a reaction event with content "🤙"