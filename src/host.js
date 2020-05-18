// --- Exdternal imports
import { addResolversToSchema } from 'graphql-tools'
import {
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
} from 'graphql'
import { GraphQLDate, GraphQLDateTime, GraphQLTime } from 'graphql-iso-date'
import { GraphQLJSON } from 'graphql-type-json'
import { request } from 'graphql-request'

// --- Internal imports
import { log } from './utils.js'
import runJavaScript from './runJavascript.js'

// --- Constants

const SupportedLambdas = {
  QJavaScript: 'Q+JavaScript',
}

const RootTypeEnum = {
  Query: 'RootQuery',
  Mutation: 'RootMutation',
}

const ScalarToGraphQLObject = {
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

const ScalarToGraphQLScalar = {
  BOOLEAN: 'Boolean',
  FLOAT: 'Float',
  ID: 'ID',
  INT: 'Int',
  STRING: 'String',
  //
  JSON: 'JSON',
  //
  DATE: 'Date',
  DATETIME: 'DateTime',
  TIME: 'Time',
}

// ---

const compose = (...funcs) => (initialArg) =>
  funcs.reduce((acc, func) => func(acc), initialArg)

// ---

const indexServices = (state) => ({
  ...state,
  svcIndex: state.ws.services.reduce((svcIndex, svc) => {
    svcIndex[svc.id] = svc
    return svcIndex
  }, {}),
})

const indexKinds = (state) => ({
  ...state,
  kindIndex: state.ws.kinds.reduce((kindIndex, kind) => {
    kindIndex[kind.id] = kind
    return kindIndex
  }, {}),
})

const indexFunctions = (state) => ({
  ...state,
  fnIndex: state.ws.functions.reduce((fnIndex, fn) => {
    fn.argIndex = fn.arguments.reduce((argIndex, arg) => {
      argIndex[arg.name] = arg
      return argIndex
    }, {})
    fnIndex[fn.id] = fn
    return fnIndex
  }, {}),
  lambdaIndex: state.ws.lambda.reduce((lambdaIndex, lambda) => {
    lambdaIndex[lambda.name] = lambda
    return lambdaIndex
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
    base = ScalarToGraphQLObject[type]
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
  log.info(`🚧 Building schema for ${state.serviceId}`)

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

const runFnGraph = async (state, fn, root, args, context) => {
  console.log(
    `FG resolver for ${fn.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

const runLambda = async (state, lambda, root, args, context) => {
  if (lambda.runtime.id !== SupportedLambdas.QJavaScript)
    throw new Error(`Unsupported Lambda runtime: ${lambda.runtime.id}`)

  log.info(`⚡ Lambda: ${lambda.name}, runtime: ${lambda.runtime.id}`)
  const startTime = new Date()
  const result = await runJavaScript({ input: args, lambda, context })
  const endTime = new Date()
  const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000
  log.info(`⏲️  Lambda: ${lambda.name} took ${elapsedTime} seconds`)
  return result
}

const getArgTypeString = (arg) => {
  const base = ScalarToGraphQLScalar[arg.type]
  if (arg.modifiers.includes('LIST')) {
    if (arg.modifiers.includes('NONULL')) {
      return `[${base}!]!`
    }
    return `[${base}]`
  } else if (arg.modifiers.includes('NONULL')) {
    return `${base}!`
  }
  return base
}

const runRemoteFn = async (state, fn, endpointUrl, root, args, context) => {
  const op = fn.implementation.operations[0]

  let query = `${fn.graphqlOperationType === 'QUERY' ? 'query' : 'mutation'} ${
    op.function.name
  }(`

  const inputDefs = op.argumentValues
    .map(
      (arg) =>
        `$${arg.argument.name}: ${getArgTypeString(
          fn.argIndex[arg.argumentRef.name]
        )}`
    )
    .join(',')

  query += `${inputDefs}) { ${op.function.name}(`

  // specify the input variables
  const inputVals = op.argumentValues
    .map((arg) => `${arg.argument.name}: $${arg.argument.name}`)
    .join(',')

  query += `${inputVals}) }`

  const vars = op.argumentValues.reduce((acc, cur) => {
    acc[cur.argument.name] = args[cur.argumentRef.name]
    return acc
  }, {})

  const startTime = new Date()
  const result = await request(endpointUrl, query, vars)
  const endTime = new Date()
  const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000
  log.info(`⏲️  Remote: ${op.function.name} took ${elapsedTime} seconds`)
  return result[op.function.name]
}

// ---

const buildResolver = (state, fn) => {
  const ops = fn.implementation.operations
  if (ops.length > 1) {
    log.info(`⚡ ${fn.name}: [${ops.map((x) => x.function.name)}]`)
    return (root, args, context) => runFnGraph(state, fn, root, args, context)
  }
  const op = ops[0]
  if (op.function.service.id === state.lambdaServiceId) {
    const lambda = state.lambdaIndex[fn.name]
    return (root, args, context) =>
      runLambda(state, lambda, root, args, context)
  }
  const remoteSvc = state.svcIndex[op.function.service.id]
  if (remoteSvc) {
    log.info(
      `⚡ ${fn.name}: ${op.function.service.id}/${op.function.name} @ ${remoteSvc.endpointUrl}`
    )
    return (root, args, context) =>
      runRemoteFn(state, fn, remoteSvc.endpointUrl, root, args, context)
  }
  throw new Error(`Unknown function type: ${fn.name}`)
}

const buildResolvers = (state) => {
  log.info(`🚧 Building resolvers for ${state.serviceId}`)

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
