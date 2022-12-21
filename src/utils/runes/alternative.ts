import { IAlternative } from '../../@types/runes'

const punctuations = /[!"#$%&'()*+-./:;<=>?@[\\\]^`{|}~]/

const hasPunctuation = (input: string) => punctuations.test(input)

// Reference: https://github.com/rustyrussell/runes/blob/master/runes/runes.py

export class Alternative implements IAlternative {
  public constructor(
    private readonly field: string,
    private readonly cond: string,
    private readonly value: string,
  ) {
    if (Array.from(this.field).some(hasPunctuation)) {
      throw Error('Field is not valid')
    }

    if (!new Set(['!', '=', '/', '^', '$', '~', '<', '>', '}', '{', '#']).has(this.cond)) {
      throw new Error('Cond is not valid')
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
        {
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
        }
      case '{':
        return why(val < this.value, this.field, `is the same or ordered after ${this.value}`)
      case '}':
        return why(val > this.value, this.field, `is the same or ordered before ${this.value}`)
    }
  }

  public encode(): string {
    return `${this.field}${this.cond}${this.value.replace(/[\\|&]/g, '\\$&')}`
  }

  public static decode(encodedStr: string): [IAlternative, string] {
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

  public static from(encodedStr: string): IAlternative {
    const [field, cond, value] = encodedStr.replace(/\s+/g, '').split(new RegExp(`(${punctuations.source})`, 'g'))

    return new Alternative(field, cond, value)
  }
}


