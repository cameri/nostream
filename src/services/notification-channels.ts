import axios from 'axios'

import {
  OperatorNotificationChannelType,
  OperatorNotificationEnvelope,
  OperatorNotificationTarget,
} from '../@types/operator-notifications'

const REQUEST_TIMEOUT_MS = 15_000

export const deliverToTarget = async (
  target: OperatorNotificationTarget,
  envelope: OperatorNotificationEnvelope,
): Promise<void> => {
  switch (target.type) {
    case 'http':
      return deliverHttp(target, envelope)
    case 'discord':
      return deliverDiscord(target, envelope)
    case 'slack':
      return deliverSlack(target, envelope)
    case 'telegram':
      return deliverTelegram(target, envelope)
    default:
      throw new Error(`Unsupported notification target type: ${target.type as string}`)
  }
}

const deliverHttp = async (target: OperatorNotificationTarget, envelope: OperatorNotificationEnvelope): Promise<void> => {
  if (!target.url) {
    throw new Error('HTTP notification target requires url')
  }

  await axios.post(target.url, envelope, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'content-type': 'application/json' },
    validateStatus: (status) => status >= 200 && status < 300,
  })
}

const deliverDiscord = async (
  target: OperatorNotificationTarget,
  envelope: OperatorNotificationEnvelope,
): Promise<void> => {
  if (!target.url) {
    throw new Error('Discord notification target requires webhook url')
  }

  const content = `[${envelope.event}] ${envelope.relay}\n\`\`\`json\n${JSON.stringify(envelope.data, null, 2).slice(0, 1800)}\n\`\`\``

  await axios.post(
    target.url,
    { content },
    {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    },
  )
}

const deliverSlack = async (target: OperatorNotificationTarget, envelope: OperatorNotificationEnvelope): Promise<void> => {
  if (!target.url) {
    throw new Error('Slack notification target requires webhook url')
  }

  await axios.post(
    target.url,
    {
      text: `[${envelope.event}] ${envelope.relay}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${envelope.event}* on \`${envelope.relay}\`\n\`\`\`${JSON.stringify(envelope.data).slice(0, 2800)}\`\`\``,
          },
        },
      ],
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    },
  )
}

const deliverTelegram = async (
  target: OperatorNotificationTarget,
  envelope: OperatorNotificationEnvelope,
): Promise<void> => {
  if (!target.botToken || !target.chatId) {
    throw new Error('Telegram notification target requires botToken and chatId')
  }

  const text = `[${envelope.event}] ${envelope.relay}\n${JSON.stringify(envelope.data).slice(0, 3500)}`
  const url = `https://api.telegram.org/bot${target.botToken}/sendMessage`

  await axios.post(
    url,
    {
      chat_id: target.chatId,
      text,
      disable_web_page_preview: true,
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    },
  )
}

export const validateTargetConfig = (target: OperatorNotificationTarget): string | undefined => {
  if (!target.id?.trim()) {
    return 'target id is required'
  }

  if (target.type === 'http' || target.type === 'discord' || target.type === 'slack') {
    if (!target.url?.trim()) {
      return `${target.type} target requires url`
    }
  }

  if (target.type === 'telegram') {
    if (!target.botToken?.trim() || !target.chatId?.trim()) {
      return 'telegram target requires botToken and chatId'
    }
  }

  return undefined
}

export const maskTargetForLog = (target: OperatorNotificationTarget): OperatorNotificationChannelType | string => {
  return `${target.type}:${target.id}`
}
