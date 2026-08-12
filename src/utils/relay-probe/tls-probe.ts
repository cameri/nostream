import tls from 'tls'

import { ProbeTarget, TlsResult } from './types'

export interface TlsConnector {
  connect(options: {
    host: string
    port: number
    servername: string
    timeoutMs: number
  }): Promise<TlsResult>
}

const getDaysUntilExpiry = (expiresAt: Date, now = Date.now()): number => {
  return Math.floor((expiresAt.getTime() - now) / (1000 * 60 * 60 * 24))
}

const readCertificateField = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

export const createNodeTlsConnector = (): TlsConnector => ({
  connect: ({ host, port, servername, timeoutMs }) =>
    new Promise<TlsResult>((resolve, reject) => {
      const socket = tls.connect(
        {
          host,
          port,
          servername,
          rejectUnauthorized: true,
        },
        () => {
          try {
            const certificate = socket.getPeerCertificate()

            if (!certificate || Object.keys(certificate).length === 0) {
              reject(new Error('No peer certificate presented'))
              socket.destroy()
              return
            }

            const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : undefined
            const now = Date.now()
            const valid = Boolean(expiresAt && expiresAt.getTime() > now)

            resolve({
              valid,
              issuer: readCertificateField(certificate.issuer?.O) ?? readCertificateField(certificate.issuer?.CN),
              subject: readCertificateField(certificate.subject?.CN) ?? certificate.subjectaltname,
              expiresAt,
              daysUntilExpiry: expiresAt ? getDaysUntilExpiry(expiresAt, now) : undefined,
            })
          } catch (error) {
            reject(error)
          } finally {
            socket.destroy()
          }
        },
      )

      socket.setTimeout(timeoutMs, () => {
        socket.destroy()
        reject(new Error(`TLS probe timed out after ${timeoutMs}ms`))
      })

      socket.on('error', (error) => {
        socket.destroy()
        reject(error)
      })
    }),
})

export const probeTls = async (
  connector: TlsConnector,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<TlsResult> => {
  const port = target.port ?? 443

  return connector.connect({
    host: target.hostname,
    port,
    servername: target.hostname,
    timeoutMs,
  })
}
