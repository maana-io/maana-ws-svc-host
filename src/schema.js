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
const { toposort } = require('./toposort.js')

let count = 0

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

const kinds = {}
const outputKinds = {}
const inputKinds = {}

const kindToGraphQLObject = (kind, isInput) => {
  const cache = isInput ? inputKinds : outputKinds
  const make = () => {
    const body = {
      name: `${kind.name}${isInput ? 'AsInput' : ''}`,
      description: kind.description,
      fields: () =>
        kind.schema.reduce((acc, cur) => {
          acc[cur.name] = {
            type: kindToGraphQLType(
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

const kindToGraphQLType = (type, kindId, modifiers, isInput) => {
  let base
  if (type !== 'KIND') {
    base = scalars[type]
    if (!base) throw new Error(`Unknown scalar: ${type}`)
  } else if (kindId) {
    const kind = kinds[kindId]
    base = kindToGraphQLObject(kind, isInput)
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

const fnToGraphQLField = (fn) => {
  const field = {
    type: kindToGraphQLType(fn.outputType, fn.outputKindId, fn.outputModifiers),
    description: fn.description,
    args: fn.arguments.reduce((acc, cur) => {
      acc[cur.name] = {
        type: kindToGraphQLType(cur.type, cur.typeKindId, cur.modifiers, true),
      }
      return acc
    }, {}),
  }
  return field
}

const createSchema = (ws) => {
  // index the kinds for later lookup
  ws.kinds.forEach((k) => (kinds[k.id] = k))

  const queries = {
    count: {
      type: GraphQLInt,
      resolve: () => count,
    },
  }
  const mutations = {
    updateCount: {
      type: GraphQLInt,
      description: 'update the count',
      resolve: () => {
        count += 1
        return count
      },
    },
  }

  ws.functions.forEach((fn) => {
    if (fn.functionType === 'CKG') {
      if (fn.graphqlOperationType === 'QUERY') {
        queries[fn.name] = fnToGraphQLField(fn)
      } else if (fn.graphqlOperationType === 'MUTATION') {
        mutations[fn.name] = fnToGraphQLField(fn)
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
  return new GraphQLSchema({
    query,
    mutation,
  })
}

module.exports = { createSchema }
