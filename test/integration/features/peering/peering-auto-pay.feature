@peering-auto-pay
Feature: Paid peering auto-pay

  The buying side pays a trusted peer invoice only inside its advertised terms
  and budgets, and holds everything else for operator approval.

  Scenario: A trusted invoice inside budget is paid automatically
    When a trusted peer sends a 250000000 msat invoice with a 1000000000 sat budget
    Then the buyer invoice is paid and the budget records the spend

  Scenario: An invoice over the per-peer budget is held
    When a trusted peer sends a 250000000 msat invoice with a 100 sat budget
    Then the buyer invoice is held for operator approval

  Scenario: A duplicate payment hash is not paid twice
    When a trusted peer sends a 250000000 msat invoice with a 1000000000 sat budget
    And the same invoice event is delivered again
    Then the buyer wallet was called once

  Scenario: An operator can approve a held invoice
    When a trusted peer sends a 250000000 msat invoice with a 100 sat budget
    And the operator approves the held invoice
    Then the invoice is paid manually and the spend is recorded
