import { Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'
import { buildAdminSessionCookieHeader } from '../../utils/admin-session'

export const postAdminLogoutHandler = (request: Request, response: Response) => {
  response
    .status(200)
    .setHeader('content-type', 'application/json')
    .setHeader('Set-Cookie', buildAdminSessionCookieHeader(request, createSettings(), '', 0))
    .send({ authenticated: false })
}
