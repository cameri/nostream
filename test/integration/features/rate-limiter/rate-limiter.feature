Feature: Rate Limiter
  @rate-limiter
  Scenario: Alice is rate limited when message rate exceeds the limit
    Given someone called Alice
    And Alice's message rate is already at the limit
    When Alice sends a text_note event expecting to be rate limited
    Then Alice receives a notice with rate limited