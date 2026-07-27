import { z } from 'zod'

const adminSettingsChangeSchema = z
  .object({
    path: z.string().min(1),
    value: z.custom<unknown>((input) => input !== undefined, { message: 'value is required' }),
  })
  .strict()

export const adminSettingsPatchBodySchema = z.union([
  adminSettingsChangeSchema,
  z
    .object({
      changes: z.array(adminSettingsChangeSchema).min(1),
    })
    .strict(),
])

export const adminSettingsRestoreBodySchema = z
  .object({
    filename: z.string().min(1),
  })
  .strict()
