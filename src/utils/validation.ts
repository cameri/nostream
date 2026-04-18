import { z } from 'zod'

export const validateSchema = (schema: z.ZodTypeAny) => (input: unknown) => {
  const result = schema.safeParse(input)
  if (!result.success) {
    return { value: undefined, error: (result as z.SafeParseError<unknown>).error }
  }
  return { value: result.data, error: undefined }
}

export const attemptValidation = (schema: z.ZodTypeAny) => (input: unknown) => schema.parse(input)
