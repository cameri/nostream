import {
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from 'redis'

export type Cache = RedisClientType<RedisModules, RedisFunctions, RedisScripts>
