import {
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from 'redis'

export type CacheClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>
