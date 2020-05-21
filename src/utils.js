// --- External imports
import { log } from 'io.maana.shared'

// --- Internal imports
import pkg from '../package'

// --- Environment variables

const SELF = `${pkg.name}:${pkg.version}`

// --- Functions
const truncate = (input, at) =>
  input?.length > at ? `${input.substring(0, at)}...` : input

const compose = (...funcs) => (initialArg) =>
  funcs.reduce((acc, func) => func(acc), initialArg)

// --- Exports

module.exports = {
  compose,
  log: log(SELF),
  SELF,
  truncate,
}
