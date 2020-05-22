// --- External imports

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
import hash from 'object-hash'
import LRU from 'lru-cache'

import { compose, log } from '../utils'
import runJavaScript from '../lambda/runJavascript'
import { indexRemoteService } from './remote'

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

const FnTypeEnum = {
  Graph: 'Graph',
  Lambda: 'Lambda',
  Service: 'Service',
}

const indexKinds = (kinds) => {
  // Index the individual sources of kinds
  const remote = indexRemoteKinds(ws)
  const local = kinds.reduce((idx, kind) => {
    idx[kind.name] = kind
    return idx
  }, {})

  // Combine into a unified index
  return [remote, local].reduce(
    (idx, cur) =>
      Object.values(cur).reduce((idx, kind) => {
        idx[kind.id] = kind
        return idx
      }, {}),
    {}
  )
}

const indexLambdas = (ws) =>
  ws.lambda.reduce((idx, lambda) => {
    const id = `${lambda.serviceId}_lambda/${lambda.name}`
    idx[id] = {
      // Common function description
      id,
      name: lambda.name,
      description: null,
      graphqlOperationType: lambda.graphqlOperationType,
      input: lambda.input,
      output: {
        kind: lambda.outputKind,
        modifiers: lambda.outputModifiers,
      },
      // Lamdba-specific
      type: FnTypeEnum.Lambda,
      runtime: lambda.runtime.id,
      code: lambda.code,
    }
    return idx
  }, {})

const indexFunctionGraphs = (ws) =>
  ws.functions.reduce((idx, fn) => {
    const id = `${ws.id}/${fn.name}`
    idx[id] = {
      // Common function description
      id,
      name: fn.name,
      description: fn.description,
      graphqlOperationType: fn.graphqlOperationType,
      input: fn.arguments.reduce((args, arg) => {
        args[arg.name] = {
          name: arg.name,
          kind: arg.type === 'KIND' ? arg.kind.name : arg.type,
          modifiers: arg.modifiers,
        }
        return args
      }, {}),
      output: {
        kind: fn.outputType === 'KIND' ? fn.kind.name : fn.outputType,
        modifiers: fn.outputModifiers,
      },
      // Graph-specific
      type: FnTypeEnum.Graph,
      ops: fn.implementation.operations.reduce((ops, op) => {
        ops[op.id] = op
        return ops
      }, {}),
    }
    return idx
  }, {})

const indexFunctions = async (ws) => {
  // Index the individual sources of functions
  const remote = indexRemoteFunctions(ws)
  const lambda = indexLambdas(ws)
  const fgs = indexFunctionGraphs(ws)

  // Combine into a unified function index
  return [fgs, lambda, remote].reduce(
    (idx, cur) =>
      Object.values(cur).reduce((idx, fn) => {
        idx[fn.id] = fn
        return idx
      }, idx),
    {}
  )
}

const indexWorkspace = async (ws) => ({
  // fetch remote services first, then index all the Kinds and functions
  serviceIdx: await indexRemoteService(ws),
  kindIdx: indexKinds(ws.kinds),
  fnIdx: indexFunctions(ws),
})

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
              {
                kind: cur.type === 'KIND' ? cur.kind.name : cur.type,
                modifiers: cur.modifiers,
              },
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

const kindToGraphQLType = (state, { kind, modifiers }, isInput) => {
  let base = ScalarToGraphQLObject[kind]
  if (!base) {
    const kindDef = state.kindIdx[kind]
    base = kindToGraphQLObject(state, kindDef, isInput)
    if (!base) throw new Error(`Unknown kind: ${kind}`)
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
    type: kindToGraphQLType(state, fn.output),
    description: fn.description,
    args: Object.values(fn.input).reduce((args, arg) => {
      args[arg.name] = {
        type: kindToGraphQLType(state, arg, true),
      }
      return args
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

  Object.values(state.fnGraphIdx).forEach((fn) => {
    if (fn.graphqlOperationType === 'QUERY') {
      queries[fn.name] = fnToGraphQLField(state, fn)
    } else if (fn.graphqlOperationType === 'MUTATION') {
      mutations[fn.name] = fnToGraphQLField(state, fn)
    } else {
      throw new Error(
        `Unknown GraphQL operation type: ${fn.graphqlOperationType}`
      )
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

const buildQuery = (fn) => {
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

  return query
}

// --- Resolvers

const runFnGraph = async (state, fn, root, args, context) => {
  console.log(
    `FG resolver for ${fn.name} called with: root = ${JSON.stringify(
      root
    )}, args = ${JSON.stringify(args)}, ctx = ${JSON.stringify(context)}`
  )
}

const runLambda = async (state, fn, lambda, _root, args, context) => {
  if (lambda.runtime.id !== SupportedLambdas.QJavaScript)
    throw new Error(`Unsupported Lambda runtime: ${lambda.runtime.id}`)

  const startTime = new Date()
  const cacheKey = hash({ id: fn.id, args })
  let result = state.resultsCache.get(cacheKey)
  if (!result) {
    result = await runJavaScript({ input: args, lambda, context })
  }
  if (fn.graphqlOperationType === 'QUERY') {
    state.resultsCache.set(cacheKey, result)
  }
  const endTime = new Date()
  const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000
  log.info(`⏱️  Lambda: ${lambda.name} took ${elapsedTime} seconds`)
  return result
}

const runRemoteFn = async (state, fn, svc, _root, args, _context) => {
  const startTime = new Date()
  const op = fn.implementation.operations[0]
  const cacheKey = hash({ id: fn.id, args })
  let result = state.resultsCache.get(cacheKey)
  if (!result) {
    fn.query = fn.query || buildQuery(fn) // compile once

    const vars = op.argumentValues.reduce((acc, cur) => {
      acc[cur.argument.name] = args[cur.argumentRef.name]
      return acc
    }, {})

    result = await request(svc.endpointUrl, fn.query, vars)
  }
  if (fn.graphqlOperationType === 'QUERY') {
    state.resultsCache.set(cacheKey, result)
  }
  const endTime = new Date()
  const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000
  log.info(
    `⏱️  Remote: ${op.function.name} @ ${svc.endpointUrl} took ${elapsedTime} seconds`
  )

  return result[op.function.name]
}

// ---

const buildCallTree = (fn, op) => {
  const deps = op.argumentValues.reduce((deps, av) => {
    if (!av.operation) {
      if (av.argumentRef) {
        deps[av.argument.name] = { fromInput: fn.argIndex[av.argumentRef.name] }
      }
    } else {
      const depOp = fn.opIndex[av.operation.id]
      deps[av.argument.name] = { fromOutput: depOp }
      if (!depOp.deps) {
        depOp.deps = buildCallTree(fn, depOp)
      }
    }
    return deps
  }, {})
  // console.log('buildCallTree', op.id, op.function.name, deps)
  return deps
}

const printCallTree = (fn, op) => {
  console.group(`${op.function.name}(`)
  if (!op.deps || !Object.keys(op.deps)) {
    console.log('No dependencies')
    // console.log(`${key} <- ${value.function.name}`)
  } else {
    Object.entries(op.deps).forEach(([key, value]) => {
      if (value.fromInput) {
        console.log(`${key} <- ${fn.name}.${value.fromInput.name}`)
      } else {
        console.log(`${key} <-`)
        printCallTree(fn, value.fromOutput)
      }
    })
  }
  console.groupEnd()
  console.log(')')
}

const buildResolver = (state, fn) => {
  // Detect the type of resolver needed: FG, lambda, or remote
  const ops = fn.implementation.operations

  // FGs have more than one op
  if (ops.length > 1) {
    log.info(`⚡ ${fn.name}: [${ops.map((x) => x.function.name)}]`)
    const entryOp = fn.opIndex[fn.implementation.entrypoint.id]

    // Prepare the call graph so that we do minimal work at runtime
    entryOp.deps = buildCallTree(fn, entryOp)
    // console.log(JSON.stringify(entryOp.deps, null, 2))
    printCallTree(fn, entryOp)
    return (root, args, context) => runFnGraph(state, fn, root, args, context)
  }

  const op = ops[0]

  // Lambdas have an associated lambda service ID
  if (op.function.service.id === state.lambdaServiceId) {
    const lambda = state.lambdaIndex[fn.name]
    return (root, args, context) =>
      runLambda(state, fn, lambda, root, args, context)
  }

  // Remotes have an associated service
  const remoteSvc = state.svcIndex[op.function.service.id]
  if (remoteSvc) {
    return (root, args, context) =>
      runRemoteFn(state, fn, remoteSvc, root, args, context)
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

  Object.values(state.fnGraphIdx).reduce((acc, fn) => {
    console.log(fn)
    acc[
      fn.graphqlOperationType === 'QUERY'
        ? RootTypeEnum.Query
        : RootTypeEnum.Mutation
    ][fn.name] = (root, args, context) =>
      runFnGraph(state, fn, root, args, context)
    return acc
  }, resolvers)

  state.resolvers = resolvers
  return state
}

// ---

export const createHost = async (ws) => {
  let state = {
    ws,
    serviceId: ws.endpointServiceId,
    lambdaServiceId: `${ws.id}_lambda`,
    inputKinds: {},
    outputKinds: {},
    resultsCache: new LRU(),
    ...(await indexWorkspace(ws)),
  }

  state = compose(buildSchema, buildResolvers)(state)

  state.schema = addResolversToSchema({
    schema: state.schemaOnly,
    resolvers: state.resolvers,
  })
  return state
}

export const getSchema = (state) => state.schema
