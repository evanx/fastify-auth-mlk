# fastify-auth-mlk

Provide `/register` and `/login` endpoints for Redis-based API bearer token auth.

## Usage

See https://github.com/evanx/fastify-auth-mlk/blob/master/bin/test.sh

The Administrator will generate a registration token and deadline for a Client.

```shell
regToken=`node bin/bcrypt.js hash test-regToken`
```

```shell
regBy=`node -e 'console.log(Date.now()+3600*1000)'`
```

The registration details, namely `regToken` and `regBy,` are stored in Redis for the Client e.g. `test-client.`

```shell
redis-cli hset fr:client:test-client:h regToken "${regToken}"
redis-cli hset fr:client:test-client:h regBy "${regBy}"
```

The Client generates their `secret.`

```
openssl rand 24 -base64
```

The Client registers their `secret` using the `regToken` provided by the Administrator.

```shell
curl -s -X 'POST' \
  -d 'client=test-client&secret=my-secret&regToken=test-regToken' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  http://127.0.0.1:3000/register
```

The Client logs in using their `secret,` and receives a session token.

```shell
token=`curl -s -X 'POST' -d 'client=test-client&secret=my-secret' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'Accept: application/json' \
  http://127.0.0.1:3000/login | jq -r '.token'`
```

The Client accesses a related API using the session token as a `Bearer` token in the `Authorization` header.

```
Authorization: Bearer {token}
```

<hr>

![test.sh](/docs/20190903-test.jpg?raw=true 'test.sh')

## Endpoints

See implementation:

https://github.com/evanx/fastify-auth-mlk/blob/master/lib/server.js

### /register

- `client` - the ID of the Client
- `secret` - the secret chosen by the Client
- `regToken` - the token provided for registration

#### Requires

Pre-authorisation of the registration via hashes key `client:${client}:h` with fields:

- `regToken` - the bcrypted hash of the token issued to the Client for registration
- `regBy` - the epoch deadline for the registration by the Client

#### Result

The secret is hashed using Bcrypt and stored in Redis.

See https://github.com/kelektiv/node.bcrypt.js

#### Usage

The Client might generate its secret as follows:

```shell
$ openssl rand 24 -base64
TTDJ2uqo6VxIvaqiX52xEn8b2daxEhFV
```

The `regToken` might be similarly generated by the Administrator and provisioned to the Client.

#### Implementation

We retrieve the `regToken` and `regBy` details from Redis.

```javascript
const [regTokenRes, regBy] = await redis.hmget(
  `client:${client}:h`,
  'regToken',
  'regBy',
)
```

We authenticate the `regToken` provided.

```javascript
const compareRes = await bcrypt.compare(regToken, regTokenRes)
```

We salt and hash the `secret` using Bcrypt.

```javascript
const bcryptRes = await bcrypt.hash(secret, config.bcrypt.rounds)
```

We persist the bcrypted `secret` in Redis.

```javascript
await redis.hset(`client:${client}:h`, 'secret', bcryptRes)
```

### /login

- `client` - the ID of the Client
- `secret` - the secret chosen by the Client

#### Requires

Hashes key `client:${client}:h` with field:

- `secret` - the `/register` secret, salted and hashed using Bcrypt

#### Returns

- `token` - a session token

#### Implementation

We get the `hash` of the `secret` from Redis.

```javascript
const hash = await redis.hget(`client:${client}:h`, 'secret')
```

We compare the provided `secret` to the `hash.`

```javascript
await bcrypt.compare(secret, hash)
```

We generate a session `token` using `Math.random().`

```javascript
const randomToken = () =>
  Math.random()
    .toString(36)
    .substring(2)
```

```javascript
const token = randomToken() + randomToken()
```

We store and expire the session in Redis.

```javascript
const { ttlSeconds } = config.session
```

```javascript
await redis
  .multi([
    ['del', `session:${token}:h`],
    ['hset', `session:${token}:h`, 'client', client],
    ['expire', `session:${token}:h`, ttlSeconds],
  ])
  .exec()
```

## Related

### xadd

See https://github.com/evanx/fastify-xadd-mlk

This project enables Redis stream ingress from authenticated clients via "Bearer" token.

```javascript
fastify.register(require('fastify-bearer-auth'), {
  auth: async (token, request) => {
    const client = await fastify.redis.hget(`session:${token}:h`, 'client')
    if (client) {
      request.client = client
      return true
    }
    return false
  },
  errorResponse: err => {
    return { code: 401, message: err.message }
  },
})
```

where the client includes the `token` from `/login` in the HTTP `Authorization` header:

```
Authorization: Bearer {token}
```
