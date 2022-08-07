/**
 * Enables uuid-ossp extension for uuid_generate_v4() support
 */

exports.up = function (knex) {
  return knex.raw(
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public version "1.1";',
  )
}

exports.down = function (knex) {
  return knex.raw('DROP EXTENSION IF EXISTS "uuid-ossp";')
}
