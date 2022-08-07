import 'pg'
import knex, { Knex } from 'knex'

const createDbConfig = (
  onNotificationCallback: (event: any) => void,
): Knex.Config => ({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  pool: {
    min: 2,
    max: 3,
    idleTimeoutMillis: 10000,
    afterCreate: function (conn, done) {
      conn.query('LISTEN event_added', function (err) {
        if (err) {
          done(err, conn)
        }
        conn.on('notification', onNotificationCallback)
        done(err, conn)
      })
    },
  },
  acquireConnectionTimeout: 2000,
})

let client: Knex
export const getDbClient = () => {
  const onNotificationCallback = (event: { channel: string; payload: any }) => {
    if (event.channel !== 'event_added') {
      return
    }
    client.emit('event_added', JSON.parse(event.payload))
  }

  if (!client) {
    client = knex(createDbConfig(onNotificationCallback))
  }

  return client
}
