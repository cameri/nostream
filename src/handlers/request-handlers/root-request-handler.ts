import { NextFunction, Request, Response } from 'express'
import { path } from 'ramda'

import { createSettings } from '../../factories/settings-factory'
import packageJson from '../../../package.json'

export const rootRequestHandler = (request: Request, response: Response, next: NextFunction) => {
  const settings = createSettings()

  if (request.header('accept') === 'application/nostr+json') {
    const {
      info: { name, description, pubkey, contact },
    } = settings

    const relayInformationDocument = {
      name,
      description,
      pubkey,
      contact,
      supported_nips: packageJson.supportedNips,
      software: packageJson.repository.url,
      version: packageJson.version,
    }

    response
      .setHeader('conten-type', 'application/nostr+json')
      .setHeader('access-control-allow-origin', '*')
      .status(200)
      .send(relayInformationDocument)

    return
  }

  const admissionFeeEnabled = path(['payments','feeSchedules','admission', '0', 'enabled'])(settings)

  if (admissionFeeEnabled) {
    response.redirect(301, '/invoices')
  } else {
    response.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('Please use a Nostr client to connect.')
  }
  next()
}
