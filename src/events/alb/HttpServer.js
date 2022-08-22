import { exit } from 'node:process'
import { Buffer } from 'buffer'
import { Server } from '@hapi/hapi'
import { log } from '@serverless/utils/log.js'
import { detectEncoding, generateAlbHapiPath } from '../../utils/index.js'
import LambdaAlbRequestEvent from './lambda-events/LambdaAlbRequestEvent.js'
import logRoutes from '../../utils/logRoutes.js'

const { stringify } = JSON

export default class HttpServer {
  #lambda = null

  #options = null

  #serverless = null

  #server = null

  #lastRequestOptions = null

  #terminalInfo = []

  constructor(serverless, options, lambda) {
    this.#serverless = serverless
    this.#options = options
    this.#lambda = lambda

    const { host, albPort } = options

    const serverOptions = {
      host,
      port: albPort,
      router: {
        // allows for paths with trailing slashes to be the same as without
        // e.g. : /my-path is the same as /my-path/
        stripTrailingSlash: true,
      },
    }

    this.#server = new Server(serverOptions)
  }

  async start() {
    const { host, httpsProtocol, albPort } = this.#options

    try {
      await this.#server.start()
    } catch (err) {
      log.error(
        `Unexpected error while starting serverless-offline alb server on port ${albPort}:`,
        err,
      )
      exit(1)
    }

    log.notice(
      `Offline [http for alb] listening on http${
        httpsProtocol ? 's' : ''
      }://${host}:${albPort}`,
    )
  }

  stop(timeout) {
    return this.#server.stop({
      timeout,
    })
  }

  get server() {
    return this.#server.listener
  }

  createRoutes(functionKey, albEvent) {
    const method = albEvent.conditions.method[0].toUpperCase()
    const path = albEvent.conditions.path[0]
    const hapiPath = generateAlbHapiPath(path, this.#options, this.#serverless)

    const stage = this.#options.stage || this.#serverless.service.provider.stage
    const { host, albPort, httpsProtocol } = this.#options
    const server = `${httpsProtocol ? 'https' : 'http'}://${host}:${albPort}`

    this.#terminalInfo.push({
      invokePath: `/2015-03-31/functions/${functionKey}/invocations`,
      method,
      path: hapiPath,
      server,
      stage: this.#options.noPrependStageInUrl ? null : stage,
    })

    const hapiMethod = method === 'ANY' ? '*' : method
    const hapiOptions = {}

    // skip HEAD routes as hapi will fail with 'Method name not allowed: HEAD ...'
    // for more details, check https://github.com/dherault/serverless-offline/issues/204
    if (hapiMethod === 'HEAD') {
      log.notice(
        'HEAD method event detected. Skipping HAPI server route mapping',
      )

      return
    }

    if (hapiMethod !== 'HEAD' && hapiMethod !== 'GET') {
      // maxBytes: Increase request size from 1MB default limit to 10MB.
      // Cf AWS API GW payload limits.
      hapiOptions.payload = {
        maxBytes: 1024 * 1024 * 10,
        parse: false,
      }
    }

    const hapiHandler = async (request, h) => {
      this.#lastRequestOptions = {
        headers: request.headers,
        method: request.method,
        payload: request.payload,
        url: request.url.href,
      }

      const requestPath = this.#options.noPrependStageInUrl
        ? request.path
        : request.path.substr(`/${stage}`.length)

      // Payload processing
      const encoding = detectEncoding(request)

      request.payload = request.payload && request.payload.toString(encoding)
      request.rawPayload = request.payload

      // Incoming request message
      log.notice()

      log.notice()
      log.notice(`${method} ${request.path} (λ: ${functionKey})`)

      const response = h.response()

      const event = new LambdaAlbRequestEvent(
        request,
        stage,
        requestPath,
      ).create()

      const lambdaFunction = this.#lambda.get(functionKey)

      lambdaFunction.setEvent(event)

      let result
      let err

      try {
        result = await lambdaFunction.runHandler()
      } catch (_err) {
        err = _err
      }

      log.debug('_____ HANDLER RESOLVED _____')

      // Failure handling
      let errorStatusCode = '502'
      if (err) {
        // Since the --useChildProcesses option loads the handler in
        // a separate process and serverless-offline communicates with it
        // over IPC, we are unable to catch JavaScript unhandledException errors
        // when the handler code contains bad JavaScript. Instead, we "catch"
        // it here and reply in the same way that we would have above when
        // we lazy-load the non-IPC handler function.
        if (this.#options.useChildProcesses && err.ipcException) {
          return this.#reply502(
            response,
            `Error while loading ${functionKey}`,
            err,
          )
        }

        const errorMessage = (err.message || err).toString()

        const re = /\[(\d{3})]/
        const found = errorMessage.match(re)

        if (found && found.length > 1) {
          ;[, errorStatusCode] = found
        } else {
          errorStatusCode = '502'
        }

        // Mocks Lambda errors
        result = {
          errorMessage,
          errorType: err.constructor.name,
          stackTrace: this.#getArrayStackTrace(err.stack),
        }

        log.notice(`Failure: ${errorMessage}`)

        if (!this.#options.hideStackTraces) {
          log.error(err.stack)
        }
      }

      let statusCode = 200
      if (err) {
        statusCode = errorStatusCode
      }
      response.statusCode = statusCode

      if (typeof result === 'string') {
        response.source = stringify(result)
      } else if (result && typeof result.body !== 'undefined') {
        if (result.isBase64Encoded) {
          response.encoding = 'binary'
          response.source = Buffer.from(result.body, 'base64')
          response.variety = 'buffer'
        } else {
          if (result && result.body && typeof result.body !== 'string') {
            return this.#reply502(
              response,
              'According to the API Gateway specs, the body content must be stringified. Check your Lambda response and make sure you are invoking JSON.stringify(YOUR_CONTENT) on your body object',
              {},
            )
          }
          response.source = result.body
        }
      }

      // Log response
      let whatToLog = result

      try {
        whatToLog = stringify(result)
      } catch {
        // nothing
      } finally {
        if (this.#options.printOutput) {
          log.notice(
            err ? `Replying ${statusCode}` : `[${statusCode}] ${whatToLog}`,
          )
        }
      }

      return response
    }

    this.#server.route({
      handler: hapiHandler,
      method: hapiMethod,
      options: hapiOptions,
      path: hapiPath,
    })
  }

  writeRoutesTerminal() {
    logRoutes(this.#terminalInfo)
  }

  #getArrayStackTrace(stack) {
    if (!stack) return null

    const splittedStack = stack.split('\n')

    return splittedStack
      .slice(
        0,
        splittedStack.findIndex((item) =>
          item.match(/server.route.handler.LambdaContext/),
        ),
      )
      .map((line) => line.trim())
  }

  #replyError(statusCode, response, message, error) {
    log.notice(message)

    log.error(error)

    response.header('Content-Type', 'application/json')

    response.statusCode = statusCode
    response.source = {
      errorMessage: message,
      errorType: error.constructor.name,
      offlineInfo:
        'If you believe this is an issue with serverless-offline please submit it, thanks. https://github.com/dherault/serverless-offline/issues',
      stackTrace: this.#getArrayStackTrace(error.stack),
    }

    return response
  }

  #reply502(response, message, error) {
    // APIG replies 502 by default on failures;
    return this.#replyError(502, response, message, error)
  }
}
