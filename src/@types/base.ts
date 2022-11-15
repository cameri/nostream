import { Knex } from 'knex'

export type EventId = string
export type Pubkey = string
export type TagName = string
export type Signature = string
export type Tag = TagBase & string[]

export interface TagBase {
  0: TagName
  [index: number]: string
}

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

export type Factory<TOutput = any, TInput = void> = (input: TInput) => TOutput

export type DatabaseClient = Knex

export interface IRunnable {
  run(): void
}