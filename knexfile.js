module.exports = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST ?? 'localhost',
    port: process.env.DB_PORT ?? 5432,
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nostr-ts-relay',
  },
  pool: { min: 4, max: 16 },
  seeds: {
    directory: './seeds',
  },
}
