module.exports = {
  client: 'pg',
  connection: process.env.DATABASE_URI ? process.env.DATABASE_URI : {
    host: process.env.DB_HOST ?? 'localhost',
    port: process.env.DB_PORT ?? 5432,
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nostream',
  },
  seeds: {
    directory: './seeds',
  },
}
