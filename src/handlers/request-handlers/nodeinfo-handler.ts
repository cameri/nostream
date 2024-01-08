import { NextFunction, Request, Response } from 'express'
import packageJson from '../../../package.json'

export const nodeinfoHandler = (req: Request, res: Response, next: NextFunction) => {
  res.json({
    links: [{
      rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
      href: `https://${req.hostname}/nodeinfo/2.0`,
    }, {
      rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
      href: `https://${req.hostname}/nodeinfo/2.1`,
    }],
  }).send()
  next()
}

export const nodeinfo21Handler = (_req: Request, res: Response, next: NextFunction) => {
  res.json({
    version: '2.1',
    software: {
      name: 'nostream',
      version: packageJson.version,
      repository: packageJson.repository.url,
      homepage: packageJson.homepage,
    },
    protocols: ['nostr'],
    services: {
      inbound: [],
      outbound: [],
    },
    openRegistrations: true,
    usage: {
      users: {},
    },
    metadata: {
      features: ['nostr_relay'],
    },
  }).send()
  next()
}