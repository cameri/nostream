export const requireTruthy = (value: unknown, message: string): void => {
  if (!value) {
    throw new Error(message)
  }
}

export const requirePositiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}
