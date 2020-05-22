// --- External imports

import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  getNullableType,
  isListType,
  isNonNullType,
} from 'graphql'
import { fetch } from 'cross-fetch'

// --- Internal imports

import { getCKGToken } from '../auth'
import env from '../environment'
import { requestCkgEndpointUrl } from '../requestCkg'
import { log } from '../utils'

// --- Implementation

// Introspect a remote service and return its schema in JSON form
const fetchRemoteSchema = async (endpointUrl) => {
  const query = getIntrospectionQuery()
  if (endpointUrl.startsWith(env.ckgEndpointUrl)) {
    let token
    try {
      token = await getCKGToken()
    } catch (error) {
      log.error(`Error getting token: ${error}`)
      throw error
    }
    const ckgResult = await requestCkgEndpointUrl({ endpointUrl, query, token })
    return { data: ckgResult }
  }
  const fetchResult = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  return fetchResult.json()
}

// Convert a possibly "wrapped" GraphQLType to a Kind/scalar reference (no schema)
const graphQLTypeToKindRef = (graphQLType) => {
  let modifiers = []
  if (isNonNullType(graphQLType)) {
    modifiers.push('NONULL')
    const innerType = getNullableType(graphQLType)
    if (isListType(innerType)) {
      modifiers.push('LIST')
    }
  } else if (isListType(graphQLType)) {
    modifiers.push('LIST')
  }
  return {
    kind: getNamedType(graphQLType),
    modifiers,
  }
}

// Convert a GraphQLType field to a Function
const graphQLFieldToFunction = (id, type, graphqlOperationType) => ({
  // Common function description
  id,
  name: type.name,
  description: type.description,
  graphqlOperationType,
  input: type.args.reduce((args, arg) => {
    args[arg.name] = {
      name: arg.name,
      description: arg.description,
      ...graphQLTypeToKindRef(arg.type),
    }
    return args
  }, {}),
  output: {
    ...graphQLTypeToKindRef(type.type),
  },
  // Remote-specific
  endpointUrl: svc.endpointUrl,
})

// ---
// await ws.services.reduce(async (idx, svc) => {
// }

export const indexRemoteService = async (id, endpointUrl) => {
  const remoteSchema = await fetchRemoteSchema(endpointUrl) // get JSON
  const clientSchema = buildClientSchema(remoteSchema.data) // convert to GraphQLSchema

  const mkId = (name) => `${id}/${name}`

  // Convert queries to functions
  let functions = Object.values(clientSchema._queryType._fields).reduce(
    (idx, type) => {
      const id = mkId(type.name)
      idx[id] = graphQLFieldToFunction(id, type, 'QUERY')
      return idx
    },
    {}
  )
  // Convert mutations to functions
  functions = Object.values(clientSchema._mutationType._fields).reduce(
    (idx, type) => {
      const id = mkId(type.name)
      idx[id] = graphQLFieldToFunction(id, type, 'MUTATION')
      return idx
    },
    functions
  )

  // Convert
  return idx
}
