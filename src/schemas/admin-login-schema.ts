import { z } from 'zod'

export const adminLoginBodySchema = z
  .object({
    password: z.string().min(1),
  })
  .strict()
