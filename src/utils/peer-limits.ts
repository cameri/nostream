import { ClientSubscriptionLimits, MessageLimits, Settings } from '../@types/settings'

export const subscriptionLimitsFor = (
  settings: Settings,
  isPeer: boolean,
): ClientSubscriptionLimits | undefined =>
  isPeer ? settings.limits?.peer?.subscription : settings.limits?.client?.subscription

export const messageLimitsFor = (settings: Settings, isPeer: boolean): MessageLimits | undefined =>
  isPeer ? settings.limits?.peer?.message : settings.limits?.message
