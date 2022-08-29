import { Alternative } from './alternative'


export class Restriction {
  public constructor(
    private readonly alternatives: Alternative[]
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

  public static decode(encodedStr: string): [Restriction, string] {
    let encStr = encodedStr
    let alternative: Alternative
    const alternatives: Alternative[] = []
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
