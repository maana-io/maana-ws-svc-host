// --- External imports
const { log } = require('io.maana.shared')

// --- Internal imports
const pkg = require('../package')

// --- Environment variables

const SELF = `${pkg.name}:${pkg.version}`

// --- Functions

// --- Exports

module.exports = {
  SELF,
  log: log(SELF),
}
