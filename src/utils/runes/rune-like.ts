import { IRestriction, IRuneLike } from '../../@types/runes'
import { Restriction } from './restriction'


export class RuneLike implements IRuneLike {
  public constructor(
    private readonly restrictions: IRestriction[]
  ) { }

  public test(values: Record<string, unknown>): [boolean, string] {
    for (const restriction of this.restrictions) {
      const reasons = restriction.test(values)
      if (typeof reasons !== 'undefined') {
        return [false, reasons]
      }
    }

    return [true, '']
  }

  public encode(): string {
    return this.restrictions.map((restriction) => restriction.encode()).join('&')
  }

  public static from(encodedStr: string): IRuneLike {
    const restrictions: IRestriction[] = []
    let restriction: IRestriction
    let encStr = encodedStr.replace(/\s+/g, '')

    while (encStr.length) {
      [restriction, encStr] = Restriction.decode(encStr)
      restrictions.push(restriction)
    }

    return new RuneLike(restrictions)
  }
}
