import { IController } from '../../@types/controllers'
import { PostAdminPeeringInvoiceDecisionController } from '../../controllers/admin/post-admin-peering-invoice-decision-controller'
import { createPeeringBuyerService } from '../peering-buyer-service-factory'

export const createPostAdminPeeringInvoiceDecisionController = (): IController =>
  new PostAdminPeeringInvoiceDecisionController(createPeeringBuyerService())
