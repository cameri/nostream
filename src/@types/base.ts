export type Pubkey = string
export type TagName = string
export type Signature = string

type Enumerate<
  N extends number,
  Acc extends number[] = [],
> = Acc['length'] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc['length']]>

export type Range<F extends number, T extends number> = Exclude<
  Enumerate<T>,
  Enumerate<F>
>

export type Factory<TOutput = any, TInput = any> = (input: TInput) => TOutput