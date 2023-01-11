import { andThen, pipe } from 'ramda'
import { Request, Response } from 'express'
import cluster from 'cluster'

import { Event, UnidentifiedEvent } from '../../@types/event'
import { EventKinds, PaymentsProcessors } from '../../constants/base'
import { getPrivateKeyFromSecret, getPublicKey, identifyEvent, signEvent } from '../../utils/event'
import { IEventRepository, IInvoiceRepository } from '../../@types/repositories'
import { InvoiceStatus, InvoiceUnit } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { fromZebedeeInvoice } from '../../utils/transform'
import { IController } from '../../@types/controllers'
import { WebSocketServerAdapterEvent } from '../../constants/adapter'

const debug = createLogger('zebedee-callback-controller')

export class ZebedeeCallbackController implements IController {
  public constructor(
    private readonly invoiceRepository: IInvoiceRepository,
    private readonly eventRepository: IEventRepository,
  ) {}

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('request body: %o', request.body)

    const invoice = fromZebedeeInvoice(request.body)

    try {
      await this.invoiceRepository.upsert(invoice)
    } catch (error) {
      console.error('Unable to persist invoice:', invoice.bolt11)

      throw error
    }

    if (invoice.status !== InvoiceStatus.COMPLETED) {
      response
        .status(200)
        .send()

      return
    }

    // Generate deterministic private key for given pubkey
    const privkey = getPrivateKeyFromSecret(process.env.SECRET)(invoice.pubkey)
    const pubkey = getPublicKey(privkey)

    const amountPaid = (invoice.unit === InvoiceUnit.MSATS) ? invoice.amountPaid / 1000n : invoice.amountPaid

    const newEvent: UnidentifiedEvent = {
      pubkey,
      kind: EventKinds.INVOICE_UPDATE,
      created_at: Math.floor(invoice.confirmedAt.getTime() / 1000),
      content: `✅ ${amountPaid.toString()} ${(invoice.unit === InvoiceUnit.BTC) ? 'BTC' : 'sats'} received`,
      tags: [
        ['p', invoice.pubkey],
        ['status', invoice.status],
        ['payments-processor', PaymentsProcessors.ZEBEDEE],
        ['r', `lightning:${invoice.bolt11}`],
      ],
    }

    const event: Event = await pipe(
      identifyEvent,
      andThen(signEvent(privkey)),
    )(newEvent)

    try {
      await this.eventRepository.create(event)
    } catch (error) {
      response.status(500).send(`Unable to save event for invoice: ${invoice.bolt11}`)
      return
    } finally {
      this.broadcastEvent(event)
    }

    response
      .status(200)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('OK')
  }

  private broadcastEvent(event: Event) {
    if (cluster.isWorker) {
      process.send({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      })
    }
  }
}
