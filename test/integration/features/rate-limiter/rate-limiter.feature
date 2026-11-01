Feature: Rate Limiter
  @rate-limiter
  Scenario: Alice is rate limited when message rate exceeds the limit
    Given someone called Alice
    And Alice's message rate is already at the limit
    When Alice sends a text_note event expecting to be rate limited
    Then Alice receives a notice with rate limited

  @rate-limiter
  Scenario: Alice's rate limit survives a sliding-window key left in Redis
    Given someone called Alice
    And Alice's Redis holds a sliding-window key left by an older version
    And Alice's message rate is already at the limit
    When Alice sends a text_note event expecting to be rate limited
    Then Alice receives a notice with rate limited
