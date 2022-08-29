import { Restriction } from './restriction'


export class RuneLike {
  public constructor(
    private readonly restrictions: Restriction[] = []
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

  public encode() {
    return this.restrictions.map((restriction) => restriction.encode()).join('&')
  }

  public static from(encodedStr: string): RuneLike {
    const restrictions: Restriction[] = []
    let restriction: Restriction
    let encStr = encodedStr.replace(/\s+/g, '')

    while (encStr.length) {
      [restriction, encStr] = Restriction.decode(encStr)
      restrictions.push(restriction)
    }

    return new RuneLike(restrictions)
  }
}
