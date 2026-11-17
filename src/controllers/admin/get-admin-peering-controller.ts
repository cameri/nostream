import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { PeeringInvoice } from '../../@types/peering'
import { IPeeringPaymentRepository } from '../../@types/repositories'
import { IPeeringBuyerService } from '../../@types/services'
import { Settings } from '../../@types/settings'
import { mergePeeringRows } from '../../utils/admin-peering'
import { PeeringRequestStatsStore } from '../../utils/peering-request-stats'
import { PeeringSyncStateStore } from '../../utils/peering-sync-state'
import { loadMergedSettings } from '../../utils/settings-config'

export const serializePeeringInvoice = (invoice: PeeringInvoice) => ({
  paymentHash: invoice.paymentHash,
  eventId: invoice.eventId,
  peerPubkey: invoice.peerPubkey,
  amountMsats: invoice.amountMsats.toString(),
  status: invoice.status,
  reason: invoice.reason ?? null,
  autoPaid: invoice.autoPaid,
  budgetPeriodStart: invoice.budgetPeriodStart ?? null,
  budgetPeriodEnd: invoice.budgetPeriodEnd ?? null,
  termPeriodSeconds: invoice.termPeriodSeconds ?? null,
  expiresAt: invoice.expiresAt ?? null,
  seenCount: invoice.seenCount,
  paidAt: invoice.paidAt ?? null,
  createdAt: invoice.createdAt,
  updatedAt: invoice.updatedAt,
})

export class GetAdminPeeringController implements IController {
  public constructor(
    private readonly stateStore: PeeringSyncStateStore,
    private readonly getSettings: () => Settings = loadMergedSettings,
    private readonly requestStatsStore?: PeeringRequestStatsStore,
    private readonly peeringPaymentRepository?: IPeeringPaymentRepository,
    private readonly peeringBuyerService?: IPeeringBuyerService,
  ) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const [states, settings, requestStats, billing, invoices, budgets] = await Promise.all([
      this.stateStore.list(),
      this.getSettings(),
      this.requestStatsStore?.list() ?? [],
      this.peeringPaymentRepository?.list() ?? [],
      this.peeringBuyerService?.list(undefined, 50) ?? [],
      this.peeringBuyerService?.budgetSummary() ?? [],
    ])
    const peers = mergePeeringRows(settings, states, undefined, requestStats, billing)

    response
      .status(200)
      .setHeader('content-type', 'application/json')
      .send({
        peers,
        invoices: invoices.map(serializePeeringInvoice),
        budgets: budgets.map((budget) => ({
          ...budget,
          limitMsats: budget.limitMsats.toString(),
          spentMsats: budget.spentMsats.toString(),
          remainingMsats: budget.remainingMsats.toString(),
        })),
      })
  }
}
