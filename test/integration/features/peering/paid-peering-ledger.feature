@paid-peering-ledger
Feature: Paid peering billing ledger

  The ledger records a peering invoice, grants exactly one paid period, and keeps
  the payment separate from the user admission and balance flow.

  Scenario: A paid peering invoice activates exactly one term
    When the peer pays a 21000 msat peering invoice
    Then the peer has an active peering period for 60 seconds
    And the peering payment did not credit a user balance
    When the same peering invoice is paid again
    Then the peer period did not change

  Scenario: An underpaid peering invoice is recorded without activating access
    When the peer underpays a 21000 msat peering invoice with 1000 msats
    Then the underpayment is recorded without activating the peer

  Scenario: A completed but unconfirmed peering invoice is retryable
    When a peering invoice is marked completed without a confirmation
    Then the unconfirmed peering invoice is returned for retry
    When the retryable peering invoice is paid
    Then the unconfirmed peering invoice is no longer returned for retry

  Scenario: Terms, invoice requests, notification switches and creation boundaries
    When I parse the paid peering terms
    Then only all-invoice peering requests are exempt
    And the peering notification switches are accepted
    And the peering invoice creation boundary rejects invalid terms
    When the peering invoice notification is published
    Then the invoice notification is published once with peering tags
