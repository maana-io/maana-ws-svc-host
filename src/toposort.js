const createTopology = (ws) => {
  const fnIdx = ws.functions.reduce((idx, fn) => {
    idx[fn.id] = fn
    console.log(
      `${fn.name}:`,
      fn.graph.nodes?.map((x) => x.operationId).filter((x) => !!x)
    )
    return idx
  }, {})
  return fnIdx
}

const sort = (topology) => {
  return topology
}

const toposort = (ws) => {
  const t = createTopology(ws)
  const s = sort(t)
}
//

module.exports = { toposort }
