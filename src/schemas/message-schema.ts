import Joi from 'joi'
import Schema from 'joi'
import { MessageType } from '../@types/messages'
import { subscriptionSchema } from './base-schema'
import { eventSchema } from './event-schema'
import { filterSchema } from './filter-schema'

export const eventMessageSchema = Schema.array().ordered(
  Schema.string().valid('EVENT').required(),
  eventSchema.required(),
)
  .label('EVENT message')

export const reqMessageSchema = Schema.array()
  .ordered(Schema.string().valid('REQ').required(), Schema.string().required().label('subscriptionId'))
  .items(filterSchema.required().label('filter')).max(12)
  .label('REQ message')

export const closeMessageSchema = Schema.array().ordered(
  Schema.string().valid('CLOSE').required(),
  subscriptionSchema.required().label('subscriptionId'),
).label('CLOSE message')


export const messageSchema = Schema.alternatives()
  .conditional(Joi.ref('.'), {
    switch: [
      { is: Joi.array().ordered(Joi.string().equal(MessageType.EVENT)).items(Joi.any()), then: eventMessageSchema },
      { is: Joi.array().ordered(Joi.string().equal(MessageType.REQ)).items(Joi.any()), then: reqMessageSchema },
      { is: Joi.array().ordered(Joi.string().equal(MessageType.CLOSE)).items(Joi.any()), then: closeMessageSchema },
    ],
  })
