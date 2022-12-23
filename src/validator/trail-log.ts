import { PathLike, writeFileSync } from 'fs'

export class TrailLog {
  public constructor(
    private readonly path: PathLike | number
  ) {}

  public append(data: Buffer) {
    writeFileSync(this.path, data)
  }
}
