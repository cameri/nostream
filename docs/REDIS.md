# Redis

Nostream uses Redis as a cache layer, currently for rate limiting incoming requests. This document covers how to configure Redis to work with Nostream, including the recommended ACL-based setup for production environments.

## Overview

Nostream uses Redis 7.0.5 (Alpine 3.16) and connects to it via the `redis` npm package (v4.5.1). Currently, Redis is used exclusively for rate limiting — throttling incoming requests from clients to prevent abuse.

The Redis client is initialized as a singleton instance in `src/cache/client.ts`, meaning a single connection is shared across the entire application. This connection is wrapped by a `RedisAdapter` which exposes only the specific Redis operations
Nostream needs.

Rate limiting is implemented using a sliding window strategy, which uses Redis sorted sets to track request timestamps. This allows Nostream to accurately enforce rate limits over a rolling time window rather than a fixed one, preventing clients from bursting requests at window boundaries.

## Requirements

- Redis 6.0 or higher (for ACL support)
- Nostream ships with Redis 7.0.5 (Alpine) by default via Docker Compose

If you are using your own Redis instance instead of the one provided by Docker Compose, ensure it is running Redis 6.0 or higher to take advantage of the ACL configuration described in this document.

## Configuration

### Default Setup

By default, Nostream connects to Redis using a single password on the default user via the `--requirepass` flag. This is configured in `docker-compose.yml`:

```yaml
command: redis-server --loglevel warning --requirepass nostr_ts_relay
```

While this works, it grants the connecting user full access to all Redis commands which is not recommended for production environments.

Nostream reads the Redis connection details from the following environment variables:

```
REDIS_URI=redis://default:nostr_ts_relay@localhost:6379

# or individually:
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USER=default
REDIS_PASSWORD=nostr_ts_relay
```

### ACL Setup (Recommended)

Redis ACL (Access Control List), introduced in Redis 6.0, allows you to create restricted users that can only execute specific commands. This is recommended for production environments as it follows the principle of least privilege — Nostream only gets access to the commands it actually needs.

#### Required Commands

Nostream uses the following Redis commands internally:

| Command | Used For |
|---|---|
| `EXISTS` | Checking if a rate limit key exists |
| `GET` | Retrieving a cached value |
| `SET` | Storing a cached value |
| `ZADD` | Adding a request timestamp to the sliding window |
| `ZRANGE` | Reading request timestamps from the sliding window |
| `ZREMRANGEBYSCORE` | Removing expired timestamps from the sliding window |
| `EXPIRE` | Setting expiry on rate limit keys |

#### Example Configuration

**Using redis.conf:**

Add the following to your `redis.conf`:

```conf
aclfile /etc/redis/users.acl
```

Then create `/etc/redis/users.acl` with the following:

```
user nostream on >your_password ~* &* +EXISTS +GET +SET +ZADD +ZRANGE +ZREMRANGEBYSCORE +EXPIRE
```

**Using redis-cli:**

You can also set the ACL rule directly via `redis-cli`:

```bash
ACL SETUSER nostream on >your_password ~* &* +EXISTS +GET +SET +ZADD +ZRANGE +ZREMRANGEBYSCORE +EXPIRE
```

Verify the user was created correctly:

```bash
ACL GETUSER nostream
```

**Updating docker-compose.yml:**

Replace the default `--requirepass` flag with the ACL file approach:

```yaml
nostream-cache:
    image: redis:7.0.5-alpine3.16
    container_name: nostream-cache
    volumes:
        - cache:/data
        - ./redis.conf:/usr/local/etc/redis/redis.conf
        - ./users.acl:/etc/redis/users.acl
    command: redis-server /usr/local/etc/redis/redis.conf
    networks:
      default:
    restart: always
    healthcheck:
      test: [ "CMD", "redis-cli", "-u", "redis://nostream:your_password@localhost:6379", "ping" ]
      interval: 1s
      timeout: 5s
      retries: 5
```

Then update your `.env` file:

```
REDIS_URI=redis://nostream:your_password@localhost:6379
```

## Troubleshooting

**NOAUTH Authentication required**

Redis is requiring authentication but no password was provided. Ensure your `REDIS_URI` or `REDIS_PASSWORD` environment variables are set correctly.

**WRONGPASS invalid username-password pair**

The username or password provided is incorrect. Double check your `REDIS_USER` and `REDIS_PASSWORD` environment variables match what was configured in your ACL setup.

**NOPERM this user has no permissions to run the command**

The Redis user does not have permission to run a specific command. Ensure all 7 required commands are granted in your ACL rule:

```
+EXISTS +GET +SET +ZADD +ZRANGE +ZREMRANGEBYSCORE +EXPIRE
```

**Connection refused (ECONNREFUSED)**

Redis is not running or is not reachable at the configured host and port. Verify:
- Redis is running (`docker ps` if using Docker)
- `REDIS_HOST` and `REDIS_PORT` are correct
- No firewall is blocking the connection
