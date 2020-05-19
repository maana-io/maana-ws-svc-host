// --- External imports
import { print } from 'io.maana.shared'
import { ApolloServer } from 'apollo-server-express'
import cors from 'cors'
import express from 'express'
import bodyParser from 'body-parser'
import http from 'http'

// --- Internal imports
import env from './environment'
import { log, SELF } from './utils.js'
import { createHost, getSchema } from './host.js'
import ws from '../data/simple.json'
import { getCKGToken } from './auth'

const initServer = async (options) => {
  // Try to get the auth token - it'll throw if not properly configured
  getCKGToken()

  // --- Host setup

  const host = await createHost(ws)

  // --- Server setup

  const app = express()

  // CORS
  const corsOptions = {
    origin: `http://${env.publicname}:${env.port}`,
    credentials: true, // <-- REQUIRED backend setting
  }
  app.use(cors(corsOptions)) // enable all CORS requests
  app.options('*', cors()) // enable pre-flight for all routes

  // Timeouts
  const requestTimeout = 1200000 // 20 minutes
  app.use((_req, res, next) => {
    res.setTimeout(requestTimeout, () => {
      res.status(408)
      res.send('408: Request Timeout: Service aborted your connection')
    })
    next()
  })

  // Request size
  app.use(bodyParser.json({ limit: '500mb', extended: true }))
  app.use(
    bodyParser.urlencoded({
      parameterLimit: 100000,
      limit: '50mb',
      extended: true,
    })
  )

  // Default route
  app.get('/', (_req, res) => {
    res.send(`${SELF}\n`)
  })

  const server = new ApolloServer({
    schema: getSchema(host),
    context: async () => ({
      vars: {}, // state used by host during resolution
    }),
  })

  server.applyMiddleware({
    app,
  })

  const httpServer = http.createServer(app)

  httpServer.listen({ port: env.port, hostname: env.hostname }, async () => {
    log.info(
      `🤓 Listening on ${print.external(
        `http://${env.hostname}:${env.port}/graphql`
      )}`
    )
  })
}

export default initServer
