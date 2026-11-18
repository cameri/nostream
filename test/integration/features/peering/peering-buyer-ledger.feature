@peering-buyer-ledger
Feature: Buyer invoice ledger

  Scenario: The ledger dedupes and budgets stop at their limit
    When the buyer ingests one invoice twice and reserves against a 1000 msat budget
    Then the ledger has one row with two sightings and the second reservation is refused
