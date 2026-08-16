import { json, Request, RequestHandler } from 'express'

export type AdminRequest = Request & {
  rawBody?: Buffer
  nip98Pubkey?: string
}

const ADMIN_JSON_BODY_LIMIT = '1mb'

const parseAdminJsonBody = json({
  limit: ADMIN_JSON_BODY_LIMIT,
  verify: (request: AdminRequest, _response, buffer) => {
    request.rawBody = Buffer.from(buffer)
  },
})

export const adminJsonBodyMiddleware: RequestHandler = (request, response, next) => {
  if (!request.is('application/json')) {
    response.status(415).setHeader('content-type', 'application/json').send({ error: 'Unsupported Media Type' })
    return
  }

  parseAdminJsonBody(request, response, next)
}
