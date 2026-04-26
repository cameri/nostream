@nwc-invoice
Feature: NWC invoice integration

  Scenario: creates invoice via HTTP with NWC processor
    Given NWC payments are enabled with URI scheme "nostr+walletconnect"
    And NWC wallet service make_invoice responds with a pending invoice
    When I request an admission invoice for pubkey "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then the invoice request response status is 200
    And an NWC invoice is stored as pending for pubkey "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

  Scenario: returns 500 on NWC reply timeout
    Given NWC payments are enabled with URI scheme "nostr+walletconnect"
    And NWC reply timeout is set to 75 milliseconds
    And NWC wallet service make_invoice never responds
    When I request an admission invoice for pubkey "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    Then the invoice request response status is 500
    And no invoice is stored for pubkey "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  Scenario: accepts legacy nostrwalletconnect URI
    Given NWC payments are enabled with URI scheme "nostrwalletconnect"
    And NWC wallet service make_invoice responds with a pending invoice
    When I request an admission invoice for pubkey "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    Then the invoice request response status is 200
    And an NWC invoice is stored as pending for pubkey "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
