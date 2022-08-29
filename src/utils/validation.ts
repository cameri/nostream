import Joi from 'joi'

const getValidationConfig = () => ({
  abortEarly: true,
  stripUnknown: false,
  convert: false,
})

export const validateSchema = (schema: Joi.Schema) => (input: any) => schema.validate(input, getValidationConfig())

export const attemptValidation = (schema: Joi.Schema) =>
  (input: any) => Joi.attempt(input, schema, getValidationConfig())
