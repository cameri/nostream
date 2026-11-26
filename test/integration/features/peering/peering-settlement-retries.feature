@peering-settlement-retries
Feature: Peering settlement retries

  Scenario: Failed settlements are counted and alert exactly once
    Given a completed peering invoice without a term snapshot
    When its settlement fails twice
    Then the invoice has two settlement attempts and one alert
    When its settlement fails once more
    Then the invoice still has only one settlement alert
