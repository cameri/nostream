
const punctuations = /[!"#\$%&'()*+-.\/:;<=>?@\[\\\]^`{|}~]/

const hasPunctuation = (input) => punctuations.test(input)

// Reference: https://github.com/rustyrussell/runes/blob/master/runes/runes.py

export class Alternative {
  public constructor(
    private readonly field: string,
    private readonly cond: string,
    private readonly value: string,
  ) {
    if (Array.from(this.field).some(hasPunctuation)) {
      throw Error('Field is not valid')
    }

    if (!new Set(['!', '=', '/', '^', '$', '~', '<', '>', '}', '{', '#']).has(this.cond)) {
      throw new Error('Cond not valid')
    }
  }

  public test(values: Record<string, any>): string | undefined {
    if (this.cond === '#') {
      return
    }

    const why = (cond: boolean, field: string, explanation: string): string | undefined =>
      (cond) ? undefined : `${field}: ${explanation}`

    if (!(this.field in values)) {
      return why(this.cond === '!', this.field, 'is missing')
    }

    if (typeof values[this.field] === 'function') {
      return values[this.field](this)
    }

    const val = String(values[this.field])

    switch (this.cond) {
      case '!':
        return why(false, this.field, 'is present')
      case '=':
        return why(val === this.value, this.field, `!= ${this.value}`)
      case '/':
        return why(val !== this.value, this.field, `= ${this.value}`)
      case '^':
        return why(val.startsWith(this.value), this.field, `does not start with ${this.value}`)
      case '$':
        return why(val.endsWith(this.value), this.field, `does not end with ${this.value}`)
      case '~':
        return why(values[this.field].includes(this.value), this.field, `does not contain ${this.value}`)
      case '<':
      case '>':
        const actualInt = Number.parseInt(val)
        if (Number.isNaN(actualInt)) {
          return why(false, this.field, 'not an integer field')
        }
        const restrictionVal = Number.parseInt(this.value)
        if (Number.isNaN(restrictionVal)) {
          return why(false, this.field, 'not a valid integer')
        }

        if (this.cond === '<') {
          return why(actualInt < restrictionVal, this.field, `>= ${restrictionVal}`)
        } else {
          return why(actualInt > restrictionVal, this.field, `<= ${restrictionVal}`)
        }
      case '{':
        return why(val < this.value, this.field, `is the same or ordered after ${this.value}`)
      case '{':
        return why(val > this.value, this.field, `is the same or ordered before ${this.value}`)
      default:
        throw new Error('Invalid condition')
    }
  }

  public encode(): string {
    return `${this.field}${this.cond}${this.value.replace(/[\\|&]/g, '\\$&')}`
  }

  public valueOf(): string {
    return this.encode()
  }

  public toString() {
    return this.encode()
  }

  public static decode(encodedStr: string): [Alternative, string] {
    let cond = undefined
    let endOff = 0

    while (endOff < encodedStr.length) {
      if (hasPunctuation(encodedStr[endOff])) {
        cond = encodedStr[endOff]
        break
      }
      endOff++
    }

    if (typeof cond === 'undefined') {
      throw new Error(`${encodedStr} does not contain any operator`)
    }

    const field = encodedStr.slice(0, endOff++)

    let value = ''

    while (endOff < encodedStr.length) {
      if (encodedStr[endOff] === '|') {
        endOff++
        break
      }

      if (encodedStr[endOff] === '&') {
        break
      }

      if (encodedStr[endOff] === '\\') {
        endOff++
      }

      value += encodedStr[endOff++]
    }

    return [new Alternative(field, cond, value), encodedStr.slice(endOff)]
  }

  public static from(encodedStr: string): Alternative {
    const [field, cond, value] = encodedStr.replace(/\s+/g, '').split(new RegExp(`(${punctuations.source})`, 'g'))

    return new Alternative(field, cond, value)
  }

}

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

  public valueOf(): string {
    return this.encode()
  }

  public toString() {
    return this.encode()
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

  public static from(encodedStr: string): Restriction {
    const [restriction, remainder] = Restriction.decode(encodedStr.replace(/\s+/g, ''))

    if (remainder.length) {
      throw new Error(`Restriction had extra characters at end: ${remainder}`)
    }

    return restriction
  }
}

export class Rune {
  public constructor(
    private readonly restrictions: Restriction[] = []
  ) { }

  public test(values: Record<string, string | string[]>): [boolean, string] {
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

  public valueOf() {
    return this.encode()
  }

  public toString() {
    return this.encode()
  }

  public static from(encodedStr: string): Rune {
    const restrictions: Restriction[] = []
    let restriction: Restriction
    let encStr = encodedStr.replace(/\s+/g, '')

    while (encStr.length) {
      [restriction, encStr] = Restriction.decode(encStr)
      restrictions.push(restriction)
    }

    return new Rune(restrictions)
  }
}
