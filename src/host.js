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

// --- Constants

const SELF = process.env.SERVICE_ID || 'maana-ws-svc-host'

const RootTypeEnum = {
  Query: 'RootQuery',
  Mutation: 'RootMutation',
}

const ScalarEnum = {
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

const indexServices = (state) => ({
  ...state,
  svcIndex: state.ws.services.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
})

const indexKinds = (state) => ({
  ...state,
  kindIndex: state.ws.kinds.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
})

const indexFunctions = (state) => ({
  ...state,
  fnIndex: state.ws.functions.reduce((acc, cur) => {
    acc[cur.id] = cur
    return acc
  }, {}),
  lambdaIndex: state.ws.lambda.reduce((acc, cur) => {
    acc[cur.name] = cur
    return acc
  }, {}),
})

const indexWorkspace = (state) =>
  compose(indexServices, indexKinds, indexFunctions)(state)

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
    base = ScalarEnum[type]
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
      throw new Error(`Unknown functionType: ${fn.functionType}`)
    }
  })

  if (!Object.keys(queries).length) {
    throw new Error('Schema must have at least one query.')
  }

  const query = new GraphQLObjectType({
    name: RootTypeEnum.Query,
    fields: queries,
  })

  if (!Object.keys(mutations).length) {
    return new GraphQLSchema({
      query,
    })
  }

  const mutation = new GraphQLObjectType({
    name: RootTypeEnum.Mutation,
    fields: mutations,
  })

  state.schemaOnly = new GraphQLSchema({
    query,
    mutation,
  })
  return state
}

// --- Resolvers

const resolveFnGraph = async (state, fn, root, args, context) => {
  console.log(
    `FG resolver for ${fn.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

const resolveLambda = async (state, lambda, root, args, context) => {
  console.log(
    `Lambda resolver for ${lambda.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

const resolveRemoteFn = async (state, fn, root, args, context) => {
  console.log(
    `Remote resolver for ${fn.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

// ---

const buildResolver = (state, fn) => {
  const ops = fn.implementation.operations
  if (ops.length > 1) {
    log(SELF).info(`⟶  ${fn.name}: [${ops.map((x) => x.function.name)}]`)
    return (root, args, context) =>
      resolveFnGraph(state, fn, root, args, context)
  }
  const op = ops[0]
  if (op.function.service.id === state.lambdaServiceId) {
    log(SELF).info(`⟶  ${fn.name}: ${state.lambdaIndex[fn.name].runtime.id}`)
    return (root, args, context) =>
      resolveLambda(state, fn, root, args, context)
  }
  const remoteSvc = state.svcIndex[op.function.service.id]
  if (remoteSvc) {
    log(SELF).info(
      `⟶  ${fn.name}: ${op.function.service.id}/${op.function.name} @ ${remoteSvc.endpointUrl}`
    )
    return (root, args, context) =>
      resolveRemoteFn(state, fn, root, args, context)
  }
  console.log('unknown ->', fn.name, JSON.stringify(fn, null, 2))
  throw new Error(`Unknown function type: ${fn.name}`)
}

const buildResolvers = (state) => {
  log(SELF).info(`Building resolvers for ${state.serviceId}`)

  const resolvers = {
    [RootTypeEnum.Query]: {
      info() {
        return {
          id: state.serviceId,
          name: state.ws.name,
          description: 'Maana Q standalone workspace service',
          version: state.ws.version,
        }
      },
    },
    [RootTypeEnum.Mutation]: {},
  }

  state.ws.functions.reduce((acc, cur) => {
    acc[
      cur.graphqlOperationType === 'QUERY'
        ? RootTypeEnum.Query
        : RootTypeEnum.Mutation
    ][cur.name] = buildResolver(state, cur)
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
    lambdaServiceId: `${ws.id}_lambda`,
    inputKinds: {},
    outputKinds: {},
  }

  state = compose(indexWorkspace, buildSchema, buildResolvers)(state)

  state.schema = addResolversToSchema({
    schema: state.schemaOnly,
    resolvers: state.resolvers,
  })
  return state
}

export const getSchema = (state) => state.schema
