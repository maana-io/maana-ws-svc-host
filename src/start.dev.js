import initServer from './server'

initServer({
  httpAuthMiddleware: false,
  socketAuthMiddleware: false,
})
