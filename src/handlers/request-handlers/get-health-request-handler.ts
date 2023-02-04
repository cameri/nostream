import { NextFunction, Request, Response } from 'express'

export const getHealthRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  res.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('OK')
  next()
}
