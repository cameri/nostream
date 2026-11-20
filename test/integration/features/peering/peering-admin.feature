@peering-admin
Feature: Peering admin decisions

  Scenario: The operator can reject and approve held invoices
    When the admin rejects a held buyer invoice
    Then the invoice is marked rejected
    When the admin approves another held invoice
    Then the invoice is paid through the wallet

  Scenario: The admin payload includes invoices and budgets
    When the admin peering payload is loaded
    Then it contains the held invoice and the current budget
