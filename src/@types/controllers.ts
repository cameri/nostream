import { Request, Response } from 'express'

export interface IController {
  handleRequest(request: Request, response: Response): Promise<void>
}
