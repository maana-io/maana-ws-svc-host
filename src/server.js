//
// External imports
//

import {
  BuildGraphqlClient,
  counter,
  initMetrics,
  log,
  print,
} from 'io.maana.shared'

import { ApolloServer } from 'apollo-server-express'
import cors from 'cors'
import express from 'express'
import bodyParser from 'body-parser'
import http from 'http'
import querystring from 'querystring'
import request from 'request-promise-native'
import { createHost, getSchema } from './host.js'
import ws from '../data/simple.json'

// load .env into process.env.*
require('dotenv').config()

const host = createHost(ws)
export const schema = getSchema(host)

//
// Client setup
// - allow this service to be a client of Maana Q's Computational Knowledge Graph
//
let client
const clientSetup = (token) => {
  if (!client && CKG_ENDPOINT_URL) {
    // construct graphql client using endpoint and context
    client = BuildGraphqlClient(CKG_ENDPOINT_URL, (_, { headers }) => {
      // return the headers to the context so httpLink can read them
      return {
        headers: {
          ...headers,
          authorization: token ? `Bearer ${token}` : '',
        },
      }
    })
  }
}

//
// Server setup
//
// Our service identity
const SELF = process.env.SERVICE_ID || 'maana-ws-svc-host'

// HTTP port
const PORT = process.env.PORT | 8050

// HOSTNAME for subscriptions etc.
const HOSTNAME = process.env.HOSTNAME || 'localhost'

// External DNS name for service
const PUBLICNAME = process.env.PUBLICNAME || 'localhost'

// Remote (peer) services we use
const CKG_ENDPOINT_URL = process.env.CKG_ENDPOINT_URL

const app = express()

//
// CORS
//
const corsOptions = {
  origin: `http://${PUBLICNAME}:${PORT}`,
  credentials: true, // <-- REQUIRED backend setting
}

app.use(cors(corsOptions)) // enable all CORS requests
app.options('*', cors()) // enable pre-flight for all routes

const requestTimeout = 1200000 // 20 minutes
app.use((req, res, next) => {
  res.setTimeout(requestTimeout, () => {
    res.status(408)
    res.send('408: Request Timeout: Service aborted your connection')
  })
  next()
})

app.use(bodyParser.json({ limit: '50mb', extended: true }))
app.use(
  bodyParser.urlencoded({
    parameterLimit: 100000,
    limit: '50mb',
    extended: true,
  })
)

app.get('/', (req, res) => {
  res.send(`${SELF}\n`)
})

const defaultSocketMiddleware = (connectionParams, webSocket) => {
  return new Promise(function (resolve, reject) {
    log(SELF).warn(
      'Socket Authentication is disabled. This should not run in production.'
    )
    resolve()
  })
}

initMetrics(SELF.replace(/[\W_]+/g, ''))
const graphqlRequestCounter = counter('graphqlRequests', 'it counts')

const initServer = async (options) => {
  const { httpAuthMiddleware, socketAuthMiddleware } = options

  const socketMiddleware = socketAuthMiddleware || defaultSocketMiddleware

  const server = new ApolloServer({
    schema,
    subscriptions: {
      onConnect: socketMiddleware,
    },
    context: async ({ req }) => {
      return {
        client,
      }
    },
  })

  server.applyMiddleware({
    app,
  })

  const httpServer = http.createServer(app)
  server.installSubscriptionHandlers(httpServer)

  httpServer.listen({ port: PORT }, async () => {
    log(SELF).info(
      `listening on ${print.external(`http://${HOSTNAME}:${PORT}/graphql`)}`
    )

    // Create OIDC token URL for the specified auth provider (default to auth0).
    let token
    if (process.env.AUTH_DOMAIN) {
      const tokenUri =
        process.env.AUTH_PROVIDER === 'keycloak'
          ? `${process.env.AUTH_DOMAIN}/auth/realms/${process.env.AUTH_IDENTIFIER}/protocol/openid-connect/token`
          : `https://${process.env.AUTH_DOMAIN}/oauth/token`

      const form = {
        grant_type: 'client_credentials',
        client_id: process.env.AUTH_CLIENT_ID,
        client_secret: process.env.AUTH_CLIENT_SECRET,
        audience: process.env.AUTH_IDENTIFIER,
      }
      const formData = querystring.stringify(form)
      const contentLength = formData.length
      const requestConfig = {
        headers: {
          'Content-Length': contentLength,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        uri: tokenUri,
        body: formData,
        method: 'POST',
      }
      const response = JSON.parse(await request(requestConfig))
      token = response.access_token
    }
    clientSetup(token)
  })
}

export default initServer
