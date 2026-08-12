import { json, Request, RequestHandler } from 'express'

export type AdminRequest = Request & {
  rawBody?: Buffer
  nip98Pubkey?: string
}

const ADMIN_JSON_BODY_LIMIT = '1mb'

export const adminJsonBodyMiddleware: RequestHandler = json({
  limit: ADMIN_JSON_BODY_LIMIT,
  verify: (request: AdminRequest, _response, buffer) => {
    request.rawBody = Buffer.from(buffer)
  },
})
