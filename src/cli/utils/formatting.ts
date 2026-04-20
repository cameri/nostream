export const formatJson = (value: unknown): string => JSON.stringify(value, null, 2)

export const formatKeyValue = (key: string, value: string): string => `${key}: ${value}`
