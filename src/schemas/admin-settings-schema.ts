import { z } from 'zod'

export const adminSettingsPatchBodySchema = z
  .object({
    path: z.string().min(1),
    value: z.custom<unknown>((input) => input !== undefined, { message: 'value is required' }),
  })
  .strict()
