import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Sinon from 'sinon'
import { Readable } from 'stream'

import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import {
  parseCliArgs,
  runVerifyStrfryExport,
  verifyFriedExport,
  verifyFriedLine,
} from '../../../src/scripts/verify-strfry-export'
import { PackedEventView, serializePackedEvent, toPackedEventFields } from '../../../src/utils/strfry'
import { Event } from '../../../src/@types/event'

const PRIVKEY = '0000000000000000000000000000000000000000000000000000000000000003'

const createEvent = async (overrides: Partial<Record<keyof Event, unknown>> = {}): Promise<Event> => {
  const pubkey = getPublicKey(PRIVKEY)
  const unsigned = await identifyEvent({
    pubkey,
    created_at: 1700000000,
    kind: 1,
    tags: [
      ['t', 'nostr'],
      ['p', pubkey],
    ],
    content: 'hello',
    ...overrides,
  } as any)

  return signEvent(PRIVKEY)(unsigned as any)
}

// Same format as a strfry export --fried line.
const toFriedLine = (event: Event, fried: Buffer = serializePackedEvent(toPackedEventFields(event))): string => {
  const { content, created_at, id, kind, pubkey, sig, tags } = event
  const json = JSON.stringify({ content, created_at, id, kind, pubkey, sig, tags })

  return `${json.slice(0, -1)},"fried":"${fried.toString('hex')}"}`
}

describe('verify-strfry-export', () => {
  let event: Event

  before(async () => {
    event = await createEvent()
  })

  describe('parseCliArgs', () => {
    it('reads a file path and checks signatures by default', () => {
      expect(parseCliArgs(['export.jsonl'])).to.deep.equal({
        filePath: 'export.jsonl',
        checkSignatures: true,
        showHelp: false,
      })
    })

    it('accepts - for stdin and --skip-signatures', () => {
      expect(parseCliArgs(['--skip-signatures', '-'])).to.deep.equal({
        filePath: '-',
        checkSignatures: false,
        showHelp: false,
      })
    })

    it('returns help mode for --help', () => {
      expect(parseCliArgs(['--help']).showHelp).to.equal(true)
    })

    it('rejects bad arguments', () => {
      expect(() => parseCliArgs([])).to.throw('Missing path to a strfry export')
      expect(() => parseCliArgs(['--fried', 'a.jsonl'])).to.throw('Unknown option: --fried')
      expect(() => parseCliArgs(['a.jsonl', 'b.jsonl'])).to.throw('Unexpected extra argument: b.jsonl')
    })
  })

  describe('verifyFriedLine', () => {
    it('accepts a line whose packed record matches the event', async () => {
      expect(await verifyFriedLine(toFriedLine(event), true)).to.equal(undefined)
    })

    it('accepts replaceable, parameterized and ephemeral events', async () => {
      for (const kind of [0, 30023, 20001]) {
        const other = await createEvent({ kind, tags: [['d', 'slug']] })

        expect(await verifyFriedLine(toFriedLine(other), true), String(kind)).to.equal(undefined)
      }
    })

    it('reports lines that are not a fried export', async () => {
      expect(await verifyFriedLine('{', true)).to.equal('Not valid JSON')
      for (const line of ['null', '42', '"text"', '[]']) {
        expect(await verifyFriedLine(line, true), line).to.equal('Not a JSON object')
      }
      expect(await verifyFriedLine(JSON.stringify(event), true)).to.equal(
        'No "fried" field, export with strfry export --fried',
      )
      expect(await verifyFriedLine(toFriedLine(event).replace(/"fried":"[0-9a-f]/, '"fried":"Z'), true)).to.equal(
        'The "fried" field is not lowercase hex',
      )
    })

    it('reports the first byte where the packed record differs', async () => {
      const fried = serializePackedEvent(toPackedEventFields(event))
      fried[72] ^= 0xff

      expect(await verifyFriedLine(toFriedLine(event, fried), true)).to.equal(
        "Packed record differs from strfry's at byte 72",
      )
    })

    it('reports a packed record that is missing a tag', async () => {
      const fields = toPackedEventFields(event)
      const fried = serializePackedEvent({ ...fields, tags: fields.tags.slice(1) })

      expect(await verifyFriedLine(toFriedLine(event, fried), true)).to.equal(
        "Packed record differs from strfry's at byte 88",
      )
    })

    it('reports a decoder that disagrees with the record', async () => {
      const kind = Sinon.stub(PackedEventView.prototype, 'kind').get(() => 7)
      expect(await verifyFriedLine(toFriedLine(event), true)).to.equal('Decoded kind differs')
      kind.restore()

      const tags = Sinon.stub(PackedEventView.prototype, 'tags').returns([])
      expect(await verifyFriedLine(toFriedLine(event), true)).to.equal('Decoded 0 tags, expected 2')
      tags.restore()
    })

    it('reports events nostream cannot pack', async () => {
      const broken = { ...event, tags: [['e', 'not-hex']] } as Event

      expect(await verifyFriedLine(toFriedLine(broken, Buffer.alloc(88)), true)).to.equal(
        'Tag e must be 64 hex characters',
      )
    })

    it('reports an id that does not match the event', async () => {
      const edited = { ...event, content: 'edited' }

      expect(await verifyFriedLine(toFriedLine(edited), true)).to.equal('Id does not match the event hash')
    })

    it('checks signatures unless told to skip them', async () => {
      const forged = { ...event, sig: '00'.repeat(64) }

      expect(await verifyFriedLine(toFriedLine(forged), true)).to.equal('Invalid signature')
      expect(await verifyFriedLine(toFriedLine(forged), false)).to.equal(undefined)
    })
  })

  describe('verifyFriedExport', () => {
    it('checks every line, skips blank ones and reports failures by line number', async () => {
      const input = Readable.from([`${toFriedLine(event)}\n\n`, '{\n', `${toFriedLine(event)}\n`])
      const failures: [number, string][] = []

      const stats = await verifyFriedExport(input, true, (lineNumber, reason) => failures.push([lineNumber, reason]))

      expect(stats).to.deep.equal({ checked: 3, failed: 1 })
      expect(failures).to.deep.equal([[3, 'Not valid JSON']])
    })
  })

  describe('a real strfry export', () => {
    // Exported from strfry 1.1.2-148-g4cd3cf6 (strfry import, then strfry export --fried).
    it('matches every packed record strfry wrote', async () => {
      const input = fs.createReadStream(path.join(__dirname, '../data/strfry-fried.jsonl'))
      const failures: [number, string][] = []

      const stats = await verifyFriedExport(input, true, (lineNumber, reason) => failures.push([lineNumber, reason]))

      expect(failures).to.deep.equal([])
      expect(stats).to.deep.equal({ checked: 25, failed: 0 })
    })
  })

  describe('runVerifyStrfryExport', () => {
    let directory: string

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-strfry-verify-'))
      Sinon.stub(console, 'log')
      Sinon.stub(console, 'error')
    })

    afterEach(() => {
      Sinon.restore()
      fs.rmSync(directory, { recursive: true, force: true })
    })

    it('exits with 0 when every event checks out', async () => {
      const filePath = path.join(directory, 'export.jsonl')
      fs.writeFileSync(filePath, `${toFriedLine(event)}\n`)

      expect(await runVerifyStrfryExport([filePath])).to.equal(0)
    })

    it('exits with 1 when the export has no events', async () => {
      const filePath = path.join(directory, 'empty.jsonl')
      fs.writeFileSync(filePath, '\n')

      expect(await runVerifyStrfryExport([filePath])).to.equal(1)
      expect((console.error as Sinon.SinonStub).calledWith('No events found in the export.')).to.equal(true)
    })

    it('says when it lists only the first failures', async () => {
      const filePath = path.join(directory, 'export.jsonl')
      fs.writeFileSync(filePath, '{\n'.repeat(21))

      expect(await runVerifyStrfryExport([filePath])).to.equal(1)
      expect((console.error as Sinon.SinonStub).callCount).to.equal(20)
      expect(
        (console.log as Sinon.SinonStub).calledWith('Checked 21 events, 21 failed (first 20 failures listed).'),
      ).to.equal(true)
    })

    it('exits with 1 and names the failing line when one does not', async () => {
      const filePath = path.join(directory, 'export.jsonl')
      fs.writeFileSync(filePath, `${toFriedLine(event)}\n${toFriedLine({ ...event, content: 'edited' })}\n`)

      expect(await runVerifyStrfryExport([filePath])).to.equal(1)
      expect((console.error as Sinon.SinonStub).calledWith('line 2: Id does not match the event hash')).to.equal(true)
    })
  })
})
