export type GuidedSettingFieldType = 'boolean' | 'number' | 'string' | 'select' | 'stringArray'

export type GuidedSettingFieldValidator = (value: string) => string | undefined

export type GuidedSettingField = {
  label: string
  path: string
  type: GuidedSettingFieldType
  options?: string[]
  placeholder?: string
  validate?: GuidedSettingFieldValidator
}

export type GuidedSettingCategory = {
  value: string
  label: string
  settings: GuidedSettingField[]
}

export const requireNonEmptySettingValue = (value: string): string | undefined => {
  return value.trim() ? undefined : 'Value is required'
}

export const requireSafeNonNegativeIntegerSettingValue = (value: string): string | undefined => {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    return 'Value must be a non-negative integer'
  }

  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) {
    return 'Value must be a safe integer'
  }

  return undefined
}

export const guidedSettingCategories: GuidedSettingCategory[] = [
  {
    value: 'relay-info',
    label: 'Relay Info',
    settings: [
      {
        label: 'Relay URL',
        path: 'info.relay_url',
        type: 'string',
        placeholder: 'wss://relay.example.com',
        validate: requireNonEmptySettingValue,
      },
      {
        label: 'Relay name',
        path: 'info.name',
        type: 'string',
        placeholder: 'relay.example.com',
        validate: requireNonEmptySettingValue,
      },
      {
        label: 'Description',
        path: 'info.description',
        type: 'string',
        placeholder: 'A nostr relay written in Typescript.',
      },
      {
        label: 'Contact',
        path: 'info.contact',
        type: 'string',
        placeholder: 'mailto:operator@your-domain.com',
      },
      {
        label: 'Relay pubkey (hex)',
        path: 'info.pubkey',
        type: 'string',
        placeholder: 'replace-with-your-pubkey-in-hex',
      },
    ],
  },
  {
    value: 'payments',
    label: 'Payments',
    settings: [
      { label: 'Enable payments', path: 'payments.enabled', type: 'boolean' },
      {
        label: 'Payment processor',
        path: 'payments.processor',
        type: 'select',
        options: ['zebedee', 'lnbits', 'lnurl', 'nodeless', 'opennode'],
      },
      {
        label: 'Admission fee enabled',
        path: 'payments.feeSchedules.admission[0].enabled',
        type: 'boolean',
      },
      {
        label: 'Admission fee amount (msats)',
        path: 'payments.feeSchedules.admission[0].amount',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
    ],
  },
  {
    value: 'network',
    label: 'Network',
    settings: [
      {
        label: 'Max payload size',
        path: 'network.maxPayloadSize',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Worker count',
        path: 'workers.count',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
    ],
  },
  {
    value: 'limits',
    label: 'Limits',
    settings: [
      {
        label: 'Rate limiter strategy',
        path: 'limits.rateLimiter.strategy',
        type: 'select',
        options: ['ewma', 'sliding_window'],
      },
      {
        label: 'Maximum event content length',
        path: 'limits.event.content[0].maxLength',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Minimum pubkey balance',
        path: 'limits.event.pubkey.minBalance',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Maximum future event time (seconds)',
        path: 'limits.event.createdAt.maxPositiveDelta',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Pubkey blacklist',
        path: 'limits.event.pubkey.blacklist',
        type: 'stringArray',
        placeholder: 'One hex pubkey per line',
      },
      {
        label: 'Kind whitelist',
        path: 'limits.event.kind.whitelist',
        type: 'stringArray',
        placeholder: 'One kind or range per line, e.g. 1 or 10000-19999',
      },
    ],
  },
  {
    value: 'client',
    label: 'Client',
    settings: [
      {
        label: 'Max subscriptions per connection',
        path: 'limits.client.subscription.maxSubscriptions',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Max filters per subscription',
        path: 'limits.client.subscription.maxFilters',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Max filter values',
        path: 'limits.client.subscription.maxFilterValues',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      {
        label: 'Max REQ limit value',
        path: 'limits.client.subscription.maxLimit',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
    ],
  },
  {
    value: 'retention',
    label: 'Retention',
    settings: [
      {
        label: 'Event retention (days)',
        path: 'limits.event.retention.maxDays',
        type: 'number',
      },
    ],
  },
  {
    value: 'nip-features',
    label: 'NIP Features',
    settings: [
      {
        label: 'NIP-05 mode',
        path: 'nip05.mode',
        type: 'select',
        options: ['enabled', 'passive', 'disabled'],
      },
      {
        label: 'NIP-05 domain whitelist',
        path: 'nip05.domainWhitelist',
        type: 'stringArray',
        placeholder: 'One domain per line',
      },
      {
        label: 'NIP-05 domain blacklist',
        path: 'nip05.domainBlacklist',
        type: 'stringArray',
        placeholder: 'One domain per line',
      },
      { label: 'Enable NIP-45', path: 'nip45.enabled', type: 'boolean' },
      { label: 'Enable NIP-50', path: 'nip50.enabled', type: 'boolean' },
      {
        label: 'NIP-50 max query length',
        path: 'nip50.maxQueryLength',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
      { label: 'Enable Web of Trust', path: 'wot.enabled', type: 'boolean' },
      {
        label: 'WoT seed pubkey (hex)',
        path: 'wot.seedPubkey',
        type: 'string',
        placeholder: 'Relay owner pubkey in hex',
      },
      {
        label: 'WoT minimum followers',
        path: 'wot.minimumFollowers',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
    ],
  },
  {
    value: 'admin',
    label: 'Admin',
    settings: [
      { label: 'Enable admin console', path: 'admin.enabled', type: 'boolean' },
      {
        label: 'Session TTL (seconds)',
        path: 'admin.sessionTtlSeconds',
        type: 'number',
        validate: requireSafeNonNegativeIntegerSettingValue,
      },
    ],
  },
]

export const getGuidedSettingCategory = (value: string): GuidedSettingCategory | undefined => {
  return guidedSettingCategories.find((entry) => entry.value === value)
}

export const getGuidedSettingField = (categoryValue: string, path: string): GuidedSettingField | undefined => {
  return getGuidedSettingCategory(categoryValue)?.settings.find((entry) => entry.path === path)
}
