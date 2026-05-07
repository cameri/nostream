import { EventTags } from '../constants/base'

export const isGenericTagQuery = (key: string) => /^#[a-zA-Z]$/.test(key)

// NIP-12 geohash filter helpers
export const geohashTagQuery = `#${EventTags.Geohash}`

export const isGeohashTagQuery = (key: string): boolean => key === geohashTagQuery

export const isGeohashPrefixCriterion = (key: string, criterion: string): boolean =>
  isGeohashTagQuery(key) && criterion.endsWith('*')

export const stripGeohashPrefixWildcard = (criterion: string): string => criterion.slice(0, -1)
