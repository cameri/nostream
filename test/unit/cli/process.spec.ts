import chai from 'chai'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { spawnWorkerProcess } from '../../../src/cli/utils/process'

// `import * as childProcess` goes through TS's __importStar interop helper,
// which wraps built-in CJS modules in a frozen getter-only object sinon can't
// stub. `import ... = require(...)` gives the raw module object instead —
// the same one process.ts's own `require('child_process')` call resolves to.
import childProcess = require('child_process')

chai.use(sinonChai)

const { expect } = chai

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write: Sinon.SinonStub }
  kill: Sinon.SinonStub
}

const createFakeChild = (): FakeChildProcess =>
  Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: Sinon.stub() },
    kill: Sinon.stub(),
  })

describe('spawnWorkerProcess', () => {
  let sandbox: Sinon.SinonSandbox
  let spawnStub: Sinon.SinonStub
  let fakeChild: FakeChildProcess

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    fakeChild = createFakeChild()
    spawnStub = sandbox.stub(childProcess, 'spawn').returns(fakeChild as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('spawns the command with piped stdio and no shell', () => {
    spawnWorkerProcess('python3', ['worker.py'])

    expect(spawnStub).to.have.been.calledWith('python3', ['worker.py'], Sinon.match({ stdio: 'pipe', shell: false }))
  })

  it('writes sent messages to stdin as a newline-terminated JSON line', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])

    handle.send({ id: 'abc', kind: 5000 })

    expect(fakeChild.stdin.write).to.have.been.calledWith('{"id":"abc","kind":5000}\n')
  })

  it('parses newline-delimited JSON from stdout and dispatches each line to message handlers', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])
    const received: unknown[] = []
    handle.onMessage((message) => received.push(message))

    fakeChild.stdout.emit('data', Buffer.from('{"id":"a"}\n{"id":"b"}\n'))

    expect(received).to.deep.equal([{ id: 'a' }, { id: 'b' }])
  })

  it('buffers a line split across multiple stdout chunks', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])
    const received: unknown[] = []
    handle.onMessage((message) => received.push(message))

    fakeChild.stdout.emit('data', Buffer.from('{"id":"a"'))
    fakeChild.stdout.emit('data', Buffer.from('}\n'))

    expect(received).to.deep.equal([{ id: 'a' }])
  })

  it('drops malformed JSON lines without throwing', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])
    const received: unknown[] = []
    handle.onMessage((message) => received.push(message))

    expect(() => fakeChild.stdout.emit('data', Buffer.from('not json\n{"id":"a"}\n'))).to.not.throw()
    expect(received).to.deep.equal([{ id: 'a' }])
  })

  it('classifies ENOENT spawn errors as not-found', () => {
    const handle = spawnWorkerProcess('nope', [])
    const reasons: string[] = []
    handle.onSpawnError((reason) => reasons.push(reason))

    const error = Object.assign(new Error('not found'), { code: 'ENOENT' })
    fakeChild.emit('error', error)

    expect(reasons).to.deep.equal(['not-found'])
  })

  it('classifies EACCES spawn errors as permission-denied', () => {
    const handle = spawnWorkerProcess('nope', [])
    const reasons: string[] = []
    handle.onSpawnError((reason) => reasons.push(reason))

    const error = Object.assign(new Error('denied'), { code: 'EACCES' })
    fakeChild.emit('error', error)

    expect(reasons).to.deep.equal(['permission-denied'])
  })

  it('classifies other spawn errors as spawn-error', () => {
    const handle = spawnWorkerProcess('nope', [])
    const reasons: string[] = []
    handle.onSpawnError((reason) => reasons.push(reason))

    fakeChild.emit('error', new Error('boom'))

    expect(reasons).to.deep.equal(['spawn-error'])
  })

  it('notifies exit handlers with the exit code and signal', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])
    const exits: Array<[number | null, NodeJS.Signals | null]> = []
    handle.onExit((code, signal) => exits.push([code, signal]))

    fakeChild.emit('exit', 1, null)

    expect(exits).to.deep.equal([[1, null]])
  })

  it('kills the underlying child process with SIGTERM', () => {
    const handle = spawnWorkerProcess('python3', ['worker.py'])

    handle.kill()

    expect(fakeChild.kill).to.have.been.calledWith('SIGTERM')
  })
})
