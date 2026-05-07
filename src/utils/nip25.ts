import { Event, ReactionEntry } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'

export const isReactionEvent = (event: { kind?: number }): boolean => event.kind === EventKinds.REACTION

export const isExternalContentReactionEvent = (event: { kind?: number }): boolean =>
    event.kind === EventKinds.EXTERNAL_CONTENT_REACTION

export const isLikeReaction = (event: { kind?: number; content?: string }): boolean =>
    isReactionEvent(event) && (event.content === '+' || event.content === '')

export const isDislikeReaction = (event: { kind?: number; content?: string }): boolean =>
    isReactionEvent(event) && event.content === '-'

export const parseReaction = (event: Event): ReactionEntry => {
    let lastETag: string[] | undefined
    let lastPTag: string[] | undefined
    let lastATag: string[] | undefined
    let firstKTag: string[] | undefined

    for (const tag of event.tags) {
        switch (tag[0]) {
            case EventTags.Event: lastETag = tag; break
            case EventTags.Pubkey: lastPTag = tag; break
            case EventTags.Address: lastATag = tag; break
            case EventTags.Kind: if (!firstKTag) { firstKTag = tag } break
        }
    }

    const kTagValue = firstKTag && firstKTag.length > 1 ? firstKTag[1] : undefined
    const parsedKind = kTagValue !== undefined ? Number(kTagValue) : undefined
    return {
        targetEventId: lastETag?.[1],
        targetPubkey: lastPTag?.[1],
        targetAddress: lastATag?.[1],
        targetKind: parsedKind !== undefined && Number.isFinite(parsedKind) ? parsedKind : undefined,
        content: event.content,
    }
}