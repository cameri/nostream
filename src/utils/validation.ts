import { z } from 'zod'

export const validateSchema = (schema: z.ZodTypeAny) => (input: unknown) => {
  try {
    return { value: schema.parse(input), error: undefined }
  } catch (error) {
    return { value: undefined, error: error as z.ZodError }
  }
}

export const attemptValidation = (schema: z.ZodTypeAny) => (input: unknown) => schema.parse(input)
