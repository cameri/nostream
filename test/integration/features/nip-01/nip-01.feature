Feature: NIP-01
  Scenario: Alice posts set_metadata event
    Given I am Alice
    And I subscribe to author Alice
    When I send a set_metadata event as Alice
    Then I receive a set_metadata event from Alice
