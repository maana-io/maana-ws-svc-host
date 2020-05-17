// load .env into process.env.*
require('dotenv').config()

const environment = {
  port: process.env.PORT || 8050,
  hostname: process.env.HOSTNAME || 'localhost',
  publicname: process.env.PUBLICNAME || 'localhost',
  auth: {
    AUTH_PROVIDER: process.env.AUTH_PROVIDER,
    AUTH_DOMAIN: process.env.AUTH_DOMAIN,
    AUTH_IDENTIFIER: process.env.AUTH_IDENTIFIER,
    AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID,
    AUTH_CLIENT_SECRET: process.env.AUTH_CLIENT_SECRET,
  },
  ckgEndpointUrl: process.env.CKG_ENDPOINT_URL,
}

module.exports = environment
