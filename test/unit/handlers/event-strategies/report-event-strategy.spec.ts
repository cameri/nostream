import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

const { expect } = chai

import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { Event } from '../../../../src/@types/event'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { MessageType } from '../../../../src/@types/messages'
import { ReportType } from '../../../../src/@types/report'
import { IEventRepository, IReportRepository } from '../../../../src/@types/repositories'
import { IWotGraphService } from '../../../../src/@types/services'
import { Settings } from '../../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'
import { ReportEventStrategy } from '../../../../src/handlers/event-strategies/report-event-strategy'

describe('ReportEventStrategy', () => {
  const reporterPubkey = '2'.repeat(64)
  const reportedPubkey = '3'.repeat(64)
  const reportedEventId = '4'.repeat(64)

  const event: Event = {
    id: 'event-id',
    pubkey: reporterPubkey,
    kind: 1984,
    tags: [['p', reportedPubkey, 'spam']],
  } as any

  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let reportRepository: IReportRepository
  let wotGraphService: IWotGraphService
  let settings: () => Settings

  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryCreateStub: Sinon.SinonStub
  let reportRepositoryCreateManyStub: Sinon.SinonStub
  let getDistanceStub: Sinon.SinonStub

  let strategy: IEventStrategy<Event, Promise<void>>

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any

    eventRepositoryCreateStub = sandbox.stub()
    eventRepository = {
      create: eventRepositoryCreateStub,
    } as any

    reportRepositoryCreateManyStub = sandbox.stub()
    reportRepository = {
      createMany: reportRepositoryCreateManyStub,
    } as any

    getDistanceStub = sandbox.stub()
    wotGraphService = {
      getDistance: getDistanceStub,
    } as any

    settings = () => ({ nip56: { enabled: true, trustedModerators: [] } }) as any

    strategy = new ReportEventStrategy(webSocket, eventRepository, reportRepository, wotGraphService, settings)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('creates the event', async () => {
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])
      getDistanceStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
    })

    it('broadcasts the event when newly created', async () => {
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])
      getDistanceStub.resolves(1)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('does not broadcast or record a report when the event is a duplicate', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        'duplicate:',
      ])
      expect(reportRepositoryCreateManyStub).not.to.have.been.called
    })

    it('records a report with full weight for a direct follow (distance 1)', async () => {
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])
      getDistanceStub.resolves(1)

      await strategy.execute(event)

      expect(reportRepositoryCreateManyStub).to.have.been.calledOnceWithExactly([
        {
          eventId: 'event-id',
          reporterPubkey,
          reportedPubkey,
          reportedEventId: null,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: false,
        },
      ])
    })

    it('records a report with zero weight for a reporter outside the trust graph', async () => {
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])
      getDistanceStub.resolves(undefined)

      await strategy.execute(event)

      expect(reportRepositoryCreateManyStub).to.have.been.calledOnceWithExactly([
        {
          eventId: 'event-id',
          reporterPubkey,
          reportedPubkey,
          reportedEventId: null,
          reportType: ReportType.SPAM,
          weight: 0,
          actionable: false,
        },
      ])
    })

    it('records an actionable, max-weight report from a trusted moderator regardless of distance', async () => {
      settings = () => ({ nip56: { enabled: true, trustedModerators: [reporterPubkey] } }) as any
      strategy = new ReportEventStrategy(webSocket, eventRepository, reportRepository, wotGraphService, settings)
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])

      await strategy.execute(event)

      expect(reportRepositoryCreateManyStub).to.have.been.calledOnceWithExactly([
        {
          eventId: 'event-id',
          reporterPubkey,
          reportedPubkey,
          reportedEventId: null,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: true,
        },
      ])
    })

    it('does not consult the WoT graph for a trusted moderator', async () => {
      settings = () => ({ nip56: { enabled: true, trustedModerators: [reporterPubkey] } }) as any
      strategy = new ReportEventStrategy(webSocket, eventRepository, reportRepository, wotGraphService, settings)
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}])

      await strategy.execute(event)

      expect(getDistanceStub).not.to.have.been.called
    })

    it('does not record any report when the event has no valid target', async () => {
      const noTargetEvent: Event = { ...event, tags: [] } as any
      eventRepositoryCreateStub.resolves(1)
      getDistanceStub.resolves(1)

      await strategy.execute(noTargetEvent)

      expect(reportRepositoryCreateManyStub).not.to.have.been.called
    })

    it('does not record any report for a moderator event with no valid target', async () => {
      const noTargetEvent: Event = { ...event, tags: [] } as any
      settings = () => ({ nip56: { enabled: true, trustedModerators: [reporterPubkey] } }) as any
      strategy = new ReportEventStrategy(webSocket, eventRepository, reportRepository, wotGraphService, settings)
      eventRepositoryCreateStub.resolves(1)

      await strategy.execute(noTargetEvent)

      expect(reportRepositoryCreateManyStub).not.to.have.been.called
    })

    it('records one row per target, in a single batch, when p and e tags carry different report types', async () => {
      const mixedEvent: Event = {
        ...event,
        tags: [
          ['p', reportedPubkey, 'impersonation'],
          ['e', reportedEventId, 'nudity'],
        ],
      } as any
      eventRepositoryCreateStub.resolves(1)
      reportRepositoryCreateManyStub.resolves([{}, {}])
      getDistanceStub.resolves(1)

      await strategy.execute(mixedEvent)

      expect(reportRepositoryCreateManyStub).to.have.been.calledOnceWithExactly([
        {
          eventId: 'event-id',
          reporterPubkey,
          reportedPubkey: null,
          reportedEventId,
          reportType: ReportType.NUDITY,
          weight: 1,
          actionable: false,
        },
        {
          eventId: 'event-id',
          reporterPubkey,
          reportedPubkey,
          reportedEventId: null,
          reportType: ReportType.IMPERSONATION,
          weight: 1,
          actionable: false,
        },
      ])
    })

    it('stores the event but does not record a report when nip56 is disabled', async () => {
      settings = () => ({ nip56: { enabled: false, trustedModerators: [] } }) as any
      strategy = new ReportEventStrategy(webSocket, eventRepository, reportRepository, wotGraphService, settings)
      eventRepositoryCreateStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
      expect(reportRepositoryCreateManyStub).not.to.have.been.called
      expect(getDistanceStub).not.to.have.been.called
    })

    it('does not reject the event when report recording fails', async () => {
      eventRepositoryCreateStub.resolves(1)
      getDistanceStub.resolves(1)
      reportRepositoryCreateManyStub.rejects(new Error('db unavailable'))

      await expect(strategy.execute(event)).to.eventually.be.fulfilled

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
    })

    it('rejects if unable to create the event', async () => {
      const error = new Error('event creation failed')
      eventRepositoryCreateStub.rejects(error)

      await expect(strategy.execute(event)).to.eventually.be.rejectedWith(error)

      expect(reportRepositoryCreateManyStub).not.to.have.been.called
    })
  })
})
