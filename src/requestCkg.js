// --- External imports
const urljoin = require('url-join')
const { GraphQLClient } = require('graphql-request')

// --- Internal imports
const { log } = require('./utils')

// --- Environment variables

const env = require('./environment')

// --- Implementation

const requestCkg = async ({ svcRef, query, variables, token }) => {
  const endpoint = urljoin(env.ckgEndpointUrl, svcRef, 'graphql')
  log.info(`proxyRequest:endpoint=${endpoint}`)

  const graphQLClient = new GraphQLClient(endpoint, {
    headers: {
      authorization: token ? `Bearer ${token}` : '',
    },
  })

  const data = await graphQLClient.request(query, variables)
  log.info(`proxyRequest:data=${JSON.stringify(data)}`)
  return data
}

// --- Exports

module.exports = requestCkg
