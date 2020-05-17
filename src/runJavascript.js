// --- External imports
import { NodeVM } from 'vm2'

// --- Internal imports
import { log } from './utils.js'
import { requestCkg } from './requestCkg.js'
import { getCKGToken } from './auth'

// --- Functions
const runJavaScript = async ({ input, lambda, context }) => {
  try {
    let token
    try {
      token = await getCKGToken()
    } catch (error) {
      log.error(`Error getting token: ${error}`)
      throw error
    }

    // Patch in the CKG request function into the lambda input
    const proxyRequestCkg = async ({ svcRef, query, variables }) =>
      requestCkg({ svcRef, query, variables, token })
    const patchedInput = {
      ...input,
      __requestCkg: proxyRequestCkg,
      __lambda: lambda,
    }
    const sandbox = { input: patchedInput }

    const vm = new NodeVM({
      sandbox,
      console: 'redirect',
      require: {
        // Allow lambda code to use any installed module
        external: true,
        builtin: ['*'],
      },
      wrapper: 'none',
    })

    // Capture console.log() output from within lambda function
    const outputLog = []
    vm.on('console.log', (...args) => {
      outputLog.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
      )
    })

    const result = await vm.run(lambda.code, __filename)
    context.log = outputLog
    return result
  } catch (ex) {
    log.error(lambda, 'runJavaScript', ex)
    throw ex
  }
}

export default runJavaScript
