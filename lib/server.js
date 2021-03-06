const bcrypt = require('bcrypt')
const config = require('config')
const fastify = require('fastify')({ logger: config.logger })

fastify.register(require('fastify-formbody'))

fastify.register(require('fastify-redis'), config.redis)

const clock = () => Date.now()

const minTime = new Date('2019-01-01').getTime()

const counterFactory = ({ redis }, name, context) => {
  const counter = key =>
    redis.hincrby(`count:${name}:h`, key, 1).catch(console.error)
  counter('start')
  return counter
}

const register = async ({ clock, redis }, { client, secret, regToken }) => {
  const counter = counterFactory({ redis }, 'register', { client })
  const now = clock()
  const [regTokenRes, regBy] = await redis.hmget(
    `client:${client}:h`,
    'regToken',
    'regBy',
  )
  if (!regTokenRes) {
    counter('no regToken')
    return { code: 403, message: 'Unregistered (regToken`)' }
  }
  const compareRes = await bcrypt.compare(regToken, regTokenRes)
  if (!compareRes) {
    counter('incorrect regToken')
    return { code: 403, message: 'Unauthorised (regToken)' }
  }
  if (!regBy) {
    counter('no regBy')
    return { code: 403, message: 'Unregistered', field: 'regBy' }
  }
  await redis.hdel(`client:${client}:h`, 'regBy')
  const expireTime = parseInt(regBy)
  if (expireTime < minTime) {
    counter('invalid expireTime')
    return { code: 403, message: 'Invalid expiry' }
  }
  if (expireTime <= now) {
    counter('expired')
    return { code: 403, message: 'Expired' }
  }
  const bcryptRes = await bcrypt.hash(secret, config.bcrypt.rounds)
  await redis.hset(`client:${client}:h`, 'secret', bcryptRes)
  return { code: 200 }
}

const randomToken = () =>
  Math.random()
    .toString(36)
    .substring(2)

const login = async ({ redis }, { client, secret }) => {
  const hash = await redis.hget(`client:${client}:h`, 'secret')
  if (!hash) {
    return { code: 403, message: 'Unregistered' }
  }
  try {
    await bcrypt.compare(secret, hash)
  } catch (err) {
    return { code: 401, message: 'Unauthorised', errCode: err.code }
  }
  const token = randomToken() + randomToken()
  const { ttlSeconds } = config.session
  await redis
    .multi([
      ['del', `session:${token}:h`],
      ['hset', `session:${token}:h`, 'client', client],
      ['expire', `session:${token}:h`, ttlSeconds],
    ])
    .exec()
  return { code: 200, token, ttlSeconds }
}

fastify.route({
  method: 'POST',
  url: '/register',
  schema: {
    body: {
      type: 'object',
      required: ['client', 'secret', 'regToken'],
      properties: {
        client: { type: 'string' },
        secret: { type: 'string' },
        regToken: { type: 'string' },
      },
    },
  },
  handler: async (request, reply) => {
    fastify.log.debug({ client: request.body.client }, 'register')
    const res = await register({ clock, redis: fastify.redis }, request.body)
    reply.code(res.code).send(res)
  },
})

fastify.route({
  method: 'POST',
  url: '/login',
  schema: {
    body: {
      type: 'object',
      required: ['client', 'secret'],
      properties: {
        client: { type: 'string' },
        secret: { type: 'string' },
      },
    },
  },
  handler: async (request, reply) => {
    fastify.log.debug({ client: request.body.client }, 'login')
    const res = await login({ clock, redis: fastify.redis }, request.body)
    reply.code(res.code).send(res)
  },
})

const start = async () => {
  try {
    await fastify.listen(config.port)
    fastify.log.info(`server listening on ${fastify.server.address().port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
