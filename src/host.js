import { log } from 'io.maana.shared'

import { addResolversToSchema } from 'graphql-tools'
const {
  GraphQLBoolean,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLList,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLSchema,
  GraphQLID,
} = require('graphql')
const {
  GraphQLDate,
  GraphQLDateTime,
  GraphQLTime,
} = require('graphql-iso-date')
const { GraphQLJSON } = require('graphql-type-json')

const SELF = process.env.SERVICE_ID || 'maana-ws-svc-host'

const scalars = {
  BOOLEAN: GraphQLBoolean,
  FLOAT: GraphQLFloat,
  ID: GraphQLID,
  INT: GraphQLInt,
  STRING: GraphQLString,
  //
  JSON: GraphQLJSON,
  //
  DATE: GraphQLDate,
  DATETIME: GraphQLDateTime,
  TIME: GraphQLTime,
}

// ---

const compose = (...funcs) => (initialArg) =>
  funcs.reduce((acc, func) => func(acc), initialArg)

// ---

const preprocessServices = (state) => ({
  ...state,
  svcIndex: state.ws.services.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
})

const preprocessKinds = (state) => ({
  ...state,
  kindIndex: state.ws.kinds.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
})

const preprocessFunctions = (state) => ({
  ...state,
  fnIndex: state.ws.functions.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
  lambdaIndex: state.ws.lambda.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
})

const preprocessWorkspace = (state) =>
  compose(preprocessServices, preprocessKinds, preprocessFunctions)(state)

// ---

const kindToGraphQLObject = (state, kind, isInput) => {
  const cache = isInput ? state.inputKinds : state.outputKinds
  const make = () => {
    const body = {
      name: `${kind.name}${isInput ? 'AsInput' : ''}`,
      description: kind.description,
      fields: () =>
        kind.schema.reduce((acc, cur) => {
          acc[cur.name] = {
            type: kindToGraphQLType(
              state,
              cur.type,
              cur.typeKindId,
              cur.modifiers,
              isInput
            ),
          }
          return acc
        }, {}),
    }
    return isInput
      ? new GraphQLInputObjectType(body)
      : new GraphQLObjectType(body)
  }
  cache[kind.id] = cache[kind.id] || make()
  return cache[kind.id]
}

const kindToGraphQLType = (state, type, kindId, modifiers, isInput) => {
  let base
  if (type !== 'KIND') {
    base = scalars[type]
    if (!base) throw new Error(`Unknown scalar: ${type}`)
  } else if (kindId) {
    const kind = state.kindIndex[kindId]
    base = kindToGraphQLObject(state, kind, isInput)
    if (!base) throw new Error(`Unknown kind: ${kindId}`)
  } else {
    throw new Error(`Either 'type' or 'kind' must be supplied`)
  }
  if (modifiers.includes('LIST')) {
    return new GraphQLNonNull(GraphQLList(new GraphQLNonNull(base)))
  } else if (modifiers.includes('NONULL')) {
    return new GraphQLNonNull(base)
  }
  return base
}

const fnToGraphQLField = (state, fn) => {
  const field = {
    type: kindToGraphQLType(
      state,
      fn.outputType,
      fn.outputKindId,
      fn.outputModifiers
    ),
    description: fn.description,
    args: fn.arguments.reduce((acc, cur) => {
      acc[cur.name] = {
        type: kindToGraphQLType(
          state,
          cur.type,
          cur.typeKindId,
          cur.modifiers,
          true
        ),
      }
      return acc
    }, {}),
  }
  return field
}

// ---

const buildSchema = (state) => {
  log(SELF).info(`Building schema for ${state.serviceId}`)

  const queries = {
    info: {
      type: new GraphQLObjectType({
        name: 'Info',
        fields: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          name: { type: GraphQLString },
          description: { type: GraphQLString },
          version: { type: GraphQLString },
        },
      }),
    },
  }
  const mutations = {}

  state.ws.functions.forEach((fn) => {
    if (fn.functionType === 'CKG') {
      if (fn.graphqlOperationType === 'QUERY') {
        queries[fn.name] = fnToGraphQLField(state, fn)
      } else if (fn.graphqlOperationType === 'MUTATION') {
        mutations[fn.name] = fnToGraphQLField(state, fn)
      } else {
        throw new Error(
          `Unknown GraphQL operation type: ${fn.graphqlOperationType}`
        )
      }
    } else {
      console.log(`[WARN] fn.functionType !== 'CKG': ${fn.functionType}`)
    }
  })

  if (!Object.keys(queries).length) {
    throw new Error('Schema must have at least one query.')
  }

  const query = new GraphQLObjectType({
    name: 'RootQuery',
    fields: queries,
  })

  if (!Object.keys(mutations).length) {
    return new GraphQLSchema({
      query,
    })
  }

  const mutation = new GraphQLObjectType({
    name: 'RootMutation',
    fields: mutations,
  })

  state.schemaOnly = new GraphQLSchema({
    query,
    mutation,
  })
  return state
}

const resolveFunctionGraph = (fn, root, args, context) => {
  console.log(
    `Resolver for ${fn.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

// const resolveLambda = (lambda, execContext) => {}
// const resolveRemoteFynction = (fn, execContext) => {}

const buildResolver = (fn) => {
  console.log(
    'fn',
    fn.name,
    JSON.stringify(fn.implementation.operations, null, 2)
  )
  const resolver = (root, args, context) =>
    resolveFunctionGraph(fn, root, args, context)
  return resolver
}

const buildResolvers = (state) => {
  log(SELF).info(`Building resolvers for ${state.serviceId}`)

  const resolvers = {
    RootQuery: {
      info() {
        return {
          id: state.serviceId,
          name: state.ws.name,
          description: 'Maana Q standalone workspace service',
          version: state.ws.version,
        }
      },
    },
    RootMutation: {},
  }

  state.ws.functions.reduce((acc, cur) => {
    acc[cur.graphqlOperationType === 'QUERY' ? 'RootQuery' : 'RootMutation'][
      cur.name
    ] = buildResolver(cur)
    return acc
  }, resolvers)

  state.resolvers = resolvers
  return state
}

// ---

export const createHost = (ws) => {
  let state = {
    ws,
    serviceId: ws.endpointServiceId,
    lambdaServiceId: `${ws.endpointServiceId}_lambda`,
    inputKinds: {},
    outputKinds: {},
  }

  state = compose(preprocessWorkspace, buildSchema, buildResolvers)(state)

  state.schema = addResolversToSchema({
    schema: state.schemaOnly,
    resolvers: state.resolvers,
  })
  return state
}

export const getSchema = (state) => state.schema
