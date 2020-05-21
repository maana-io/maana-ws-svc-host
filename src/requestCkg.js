// --- External imports
const urljoin = require('url-join')
const { GraphQLClient } = require('graphql-request')

// --- Internal imports
const { log, truncate } = require('./utils')

// --- Environment variables

const env = require('./environment')

// --- Constants
const TruncateAt = 50

// --- Implementation

export const requestCkg = async ({ svcRef, query, variables, token }) => {
  const endpointUrl = urljoin(env.ckgEndpointUrl, svcRef, 'graphql')
  return requestCkgEndpointUrl({ endpointUrl, query, variables, token })
}

let reqId = 0
export const requestCkgEndpointUrl = async ({
  endpointUrl,
  query,
  variables,
  token,
}) => {
  const thisReqId = reqId
  reqId += 1
  log.info(
    `📞 CKG request(${thisReqId}): url=${endpointUrl}, query=${truncate(
      query.replace(/(\r\n|\n|\r)/gm, ''),
      TruncateAt
    )}, vars=${truncate(JSON.stringify(variables), TruncateAt)}`
  )

  const graphQLClient = new GraphQLClient(endpointUrl, {
    headers: {
      authorization: token ? `Bearer ${token}` : '',
    },
  })

  const data = await graphQLClient.request(query, variables)
  log.info(
    `📞 CKG response(${thisReqId}): data=${truncate(
      JSON.stringify(data),
      TruncateAt
    )}`
  )

  return data
}
