import { z } from 'zod'

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

const nonNegativeSafeIntegerSettingValueSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Value must be a non-negative integer')
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER, 'Value must be a safe integer'))

export const requireSafeNonNegativeIntegerSettingValue = (value: string): string | undefined => {
  const result = nonNegativeSafeIntegerSettingValueSchema.safeParse(value)
  return result.success ? undefined : result.error.issues[0].message
}

export const guidedSettingCategories: GuidedSettingCategory[] = [
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
        label: 'Max payload size',
        path: 'network.maxPayloadSize',
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
        label: 'Primary event content max length',
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
    ],
  },
]

export const getGuidedSettingCategory = (value: string): GuidedSettingCategory | undefined => {
  return guidedSettingCategories.find((entry) => entry.value === value)
}

export const getGuidedSettingField = (categoryValue: string, path: string): GuidedSettingField | undefined => {
  return getGuidedSettingCategory(categoryValue)?.settings.find((entry) => entry.path === path)
}
