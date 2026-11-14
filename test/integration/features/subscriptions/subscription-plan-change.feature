@opennode-callback @subscription-plan-change
Feature: Paying for another plan while a subscription is running
  Anyone can pay an invoice for any pubkey, so a payment for a cheaper plan must not take away
  what the pubkey has already paid for. The plan limits "basic" (21000 sats) and "pro" (100000 sats)
  are each one period of 30 days.

  Scenario: a cheaper plan paid for a running dearer plan is credited to the dearer plan
    Given OpenNode callback processing is enabled
    And the relay sells the plans "basic" at 21000 sats and "pro" at 100000 sats
    And a subscriber has a running "pro" plan that ends in 10 days
    And a pending OpenNode invoice for the subscriber for 21000 sats on the plan "basic" exists
    When I post a signed OpenNode callback with status "paid"
    Then the OpenNode callback response status is 200
    And the subscriber is still on the plan "pro"
    And the subscriber's plan ends 6.3 days later than before
    And the subscriber has been admitted to the relay

  Scenario: a repeated callback does not credit the payment twice
    Given OpenNode callback processing is enabled
    And the relay sells the plans "basic" at 21000 sats and "pro" at 100000 sats
    And a subscriber has a running "pro" plan that ends in 10 days
    And a pending OpenNode invoice for the subscriber for 21000 sats on the plan "basic" exists
    When I post a signed OpenNode callback with status "paid"
    And I post a signed OpenNode callback with status "paid"
    Then the subscriber is still on the plan "pro"
    And the subscriber's plan ends 6.3 days later than before

  Scenario: a dearer plan paid for a running cheaper plan switches the plan
    Given OpenNode callback processing is enabled
    And the relay sells the plans "basic" at 21000 sats and "pro" at 100000 sats
    And a subscriber has a running "basic" plan that ends in 10 days
    And a pending OpenNode invoice for the subscriber for 100000 sats on the plan "pro" exists
    When I post a signed OpenNode callback with status "paid"
    Then the OpenNode callback response status is 200
    And the subscriber is on the plan "pro"
    And the subscriber's plan ends 30 days later than before

  Scenario: a cheaper plan paid by a pubkey with no subscription starts that plan
    Given OpenNode callback processing is enabled
    And the relay sells the plans "basic" at 21000 sats and "pro" at 100000 sats
    And a subscriber without a subscription
    And a pending OpenNode invoice for the subscriber for 21000 sats on the plan "basic" exists
    When I post a signed OpenNode callback with status "paid"
    Then the OpenNode callback response status is 200
    And the subscriber is on the plan "basic"
    And the subscriber has been admitted to the relay
