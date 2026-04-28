import { expect } from 'chai'
import { Event } from '../../../src/@types/event'
import { EventKinds } from '../../../src/constants/base'
import {
    isDislikeReaction,
    isExternalContentReactionEvent,
    isLikeReaction,
    isReactionEvent,
    parseReaction,
} from '../../../src/utils/nip25'

const baseEvent = (): Partial<Event> => ({ tags: [], content: '+' })

describe('NIP-25', () => {
    describe('isReactionEvent', () => {
        it('returns true for kind 7', () =>
            expect(isReactionEvent({ ...baseEvent(), kind: EventKinds.REACTION } as Event)).to.equal(true))

        it('returns false for other kinds', () =>
            expect(isReactionEvent({ ...baseEvent(), kind: EventKinds.TEXT_NOTE } as Event)).to.equal(false))
    })

    describe('isExternalContentReactionEvent', () => {
        it('returns true for kind 17', () =>
            expect(
                isExternalContentReactionEvent({ ...baseEvent(), kind: EventKinds.EXTERNAL_CONTENT_REACTION } as Event),
            ).to.equal(true))

        it('returns false for kind 7', () =>
            expect(
                isExternalContentReactionEvent({ ...baseEvent(), kind: EventKinds.REACTION } as Event),
            ).to.equal(false))
    })

    describe('isLikeReaction', () => {
        it('returns true for "+"', () =>
            expect(isLikeReaction({ ...baseEvent(), kind: EventKinds.REACTION, content: '+' } as Event)).to.equal(true))

        it('returns true for empty content', () =>
            expect(isLikeReaction({ ...baseEvent(), kind: EventKinds.REACTION, content: '' } as Event)).to.equal(true))

        it('returns false for "-"', () =>
            expect(isLikeReaction({ ...baseEvent(), kind: EventKinds.REACTION, content: '-' } as Event)).to.equal(false))
    })

    describe('isDislikeReaction', () => {
        it('returns true for "-"', () =>
            expect(isDislikeReaction({ ...baseEvent(), kind: EventKinds.REACTION, content: '-' } as Event)).to.equal(true))

        it('returns false for "+"', () =>
            expect(isDislikeReaction({ ...baseEvent(), kind: EventKinds.REACTION, content: '+' } as Event)).to.equal(false))
    })

    describe('parseReaction', () => {
        it('picks the last e tag as targetEventId', () => {
            const event = {
                ...baseEvent(),
                kind: EventKinds.REACTION,
                tags: [['e', 'aaa'], ['e', 'bbb']],
            } as unknown as Event
            expect(parseReaction(event).targetEventId).to.equal('bbb')
        })

        it('picks the last p tag as targetPubkey', () => {
            const event = {
                ...baseEvent(),
                kind: EventKinds.REACTION,
                tags: [['p', 'pk1'], ['p', 'pk2']],
            } as unknown as Event
            expect(parseReaction(event).targetPubkey).to.equal('pk2')
        })

        it('parses k tag as targetKind number', () => {
            const event = {
                ...baseEvent(),
                kind: EventKinds.REACTION,
                tags: [['k', '1']],
            } as unknown as Event
            expect(parseReaction(event).targetKind).to.equal(1)
        })

        it('returns undefined fields when tags are absent', () => {
            const event = { ...baseEvent(), kind: EventKinds.REACTION, tags: [] } as unknown as Event
            const result = parseReaction(event)
            expect(result.targetEventId).to.be.undefined
            expect(result.targetPubkey).to.be.undefined
            expect(result.targetKind).to.be.undefined
        })
    })
})