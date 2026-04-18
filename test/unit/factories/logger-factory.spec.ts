import { expect } from 'chai'
import Sinon from 'sinon'

import { createLogger } from '../../../src/factories/logger-factory'
import { logger as baseLogger } from '../../../src/logger'

type StubPinoLogger = {
  level: string
  debug: Sinon.SinonStub
  info: Sinon.SinonStub
  warn: Sinon.SinonStub
  error: Sinon.SinonStub
  fatal: Sinon.SinonStub
  child: Sinon.SinonStub
}

const createStubPinoLogger = (sandbox: Sinon.SinonSandbox): StubPinoLogger => ({
  level: 'info',
  debug: sandbox.stub(),
  info: sandbox.stub(),
  warn: sandbox.stub(),
  error: sandbox.stub(),
  fatal: sandbox.stub(),
  child: sandbox.stub(),
})

describe('createLogger', () => {
  let sandbox: Sinon.SinonSandbox
  let rootInstance: StubPinoLogger
  let childInstance: StubPinoLogger

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    rootInstance = createStubPinoLogger(sandbox)
    childInstance = createStubPinoLogger(sandbox)

    sandbox.stub(baseLogger, 'child').returns(rootInstance as any)
    rootInstance.child.callsFake(() => childInstance as any)
    childInstance.child.callsFake(() => childInstance as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('enables debug level when requested', () => {
    createLogger('payments', { enabled: true })

    expect(rootInstance.level).to.equal('debug')
  })

  it('logs formatted string messages', () => {
    const logger = createLogger('payments')

    logger.info('invoice %s created', 'abc123')

    Sinon.assert.calledOnceWithExactly(rootInstance.info, 'invoice abc123 created')
  })

  it('logs Error instances under err key', () => {
    const logger = createLogger('payments')
    const error = new Error('boom')

    logger.error(error)

    Sinon.assert.calledOnceWithExactly(rootInstance.error, { err: error })
  })

  it('logs mixed non-string messages safely', () => {
    const logger = createLogger('payments')

    logger.warn({ id: 42 }, 'extra')

    Sinon.assert.calledOnce(rootInstance.warn)
    expect(rootInstance.warn.firstCall.args[0]).to.contain('id: 42')
  })

  it('forwards plain objects when no extra args are provided', () => {
    const logger = createLogger('payments')
    const payload = { status: 'ok' }

    logger.fatal(payload)

    Sinon.assert.calledOnceWithExactly(rootInstance.fatal, payload)
  })

  it('supports child and extended loggers', () => {
    const logger = createLogger('payments')

    const childLogger = logger.child({ requestId: 'req-1' })
    childLogger.info('child logger message')

    const extendedLogger = logger.extend('settlements')
    extendedLogger.debug('extended logger message')

    Sinon.assert.calledWith(rootInstance.child, { requestId: 'req-1' })
    Sinon.assert.calledWith(rootInstance.child, Sinon.match.has('scope', Sinon.match.string))
    Sinon.assert.calledWithExactly(childInstance.info, 'child logger message')
    Sinon.assert.calledWithExactly(childInstance.debug, 'extended logger message')
  })
})
