import { DatabaseTransaction } from './base'

export interface ITransaction {
  begin(): Promise<void>
  get transaction (): DatabaseTransaction
  commit(): Promise<any[]>
  rollback(): Promise<any[]>
}
