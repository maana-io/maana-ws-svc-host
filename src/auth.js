const request = require('request-promise-native')
const querystring = require('querystring')

const { print } = require('io.maana.shared')

const { log } = require('./utils')
const env = require('./environment')

// Auth state

let tokenRefreshTimestamp = null
let currentToken = null
//

const authCkg = async () => {
  if (!env.auth.AUTH_DOMAIN) {
    const msg = `No authentication domain specified.  Aborting...`
    log.error(msg)
    // As it is assumed that service cannot run without auth token, terminate server with 10s backoff
    // so that restarting container is not generating too much load on k8s cluster.
    setTimeout(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(1)
    }, 10000)
    throw new Error(msg)
  }

  // Create OIDC token URL for the specified auth provider (default to auth0).
  log.info(
    `🔑 Authenticating with ${print.internal(
      env.auth.AUTH_DOMAIN
    )} using ${print.info(env.auth.AUTH_PROVIDER)}`
  )

  const tokenUri =
    env.auth.AUTH_PROVIDER === 'keycloak'
      ? `${env.auth.AUTH_DOMAIN}/auth/realms/${env.auth.AUTH_IDENTIFIER}/protocol/openid-connect/token`
      : `https://${env.auth.AUTH_DOMAIN}/oauth/token`

  const form = {
    grant_type: 'client_credentials',
    client_id: env.auth.AUTH_CLIENT_ID,
    client_secret: env.auth.AUTH_CLIENT_SECRET,
    audience: env.auth.AUTH_IDENTIFIER,
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
  // Current timespamp + 90% of expiration time in milliseconds
  tokenRefreshTimestamp =
    Date.now() + Math.floor(response.expires_in * 0.9 * 1000)
  currentToken = response.access_token

  log.info(
    `🔑 Received token, will refresh at ${new Date(
      tokenRefreshTimestamp
    ).toISOString()}`
  )
  return currentToken
}

export const getCKGToken = async () => {
  if (currentToken === null || Date.now() > tokenRefreshTimestamp) {
    return await authCkg()
  } else {
    return currentToken
  }
}
