export interface IAlternative {
  test(values: Record<string, any>): string | undefined
  encode(): string
}

export interface IRestriction {
  test(values: Record<string, any>): string | undefined
  encode(): string
}

export interface IRuneLike {
  test(values: Record<string, unknown>): [boolean, string]
  encode(): string
}
