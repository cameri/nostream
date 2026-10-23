import { EventTags } from '../constants/base'
import { SubscriptionFilter } from '../@types/subscription'

export const isGenericTagQuery = (key: string) => /^#[a-zA-Z]$/.test(key)

// Values are the array-valued criteria of a filter (`ids`, `authors`, `kinds`,
// `#e`, `#p`, ...). Scalars (`since`, `until`, `limit`, `search`) are criteria
// too, but they are single values and bounded by their own settings.
export const countFilterValues = (filter: SubscriptionFilter): number =>
  Object.values(filter).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0)

// NIP-12 geohash filter helpers
export const geohashTagQuery = `#${EventTags.Geohash}`

export const isGeohashTagQuery = (key: string): boolean => key === geohashTagQuery

export const isGeohashPrefixCriterion = (key: string, criterion: string): boolean =>
  isGeohashTagQuery(key) && criterion.endsWith('*')

export const stripGeohashPrefixWildcard = (criterion: string): string => criterion.slice(0, -1)
