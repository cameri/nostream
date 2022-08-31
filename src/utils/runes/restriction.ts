import { IAlternative, IRestriction } from '../../@types/runes'
import { Alternative } from './alternative'


export class Restriction implements IRestriction {
  public constructor(
    private readonly alternatives: IAlternative[]
  ) {
    if (!alternatives.length) {
      throw new Error('Restriction must have some alternatives')
    }
  }

  public test(values: Record<string, any>): string | undefined {
    const reasons: string[] = []
    for (const alternative of this.alternatives) {
      const reason = alternative.test(values)
      if (typeof reason === 'undefined') {
        return
      }
      reasons.push(reason)
    }

    return reasons.join(' AND ')
  }

  public encode(): string {
    return this.alternatives.map((alternative) => alternative.encode()).join('|')
  }

  public static decode(encodedStr: string): [IRestriction, string] {
    let encStr = encodedStr
    let alternative: IAlternative
    const alternatives: IAlternative[] = []
    while (encStr.length) {
      if (encStr.startsWith('&')) {
        encStr = encStr.slice(1)
        break
      }

      [alternative, encStr] = Alternative.decode(encStr)

      alternatives.push(alternative)
    }

    return [new Restriction(alternatives), encStr]
  }
}
