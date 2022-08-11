import { IEventStrategy } from '../../@types/message-handlers'

/**
 * An event strategy that refuses to do anything useful
 */
export class NullEventStrategy implements IEventStrategy<void, Promise<boolean>> {
  public async execute(): Promise<boolean> {
    return true
  }
}
