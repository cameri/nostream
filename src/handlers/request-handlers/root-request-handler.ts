import { NextFunction, Request, Response } from 'express'

export const rootRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  res.redirect(301, '/invoices')
  next()
}
