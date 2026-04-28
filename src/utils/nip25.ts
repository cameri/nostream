import { Event, ReactionEntry } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'

export const isReactionEvent = (event: Event): boolean => event.kind === EventKinds.REACTION

export const isExternalContentReactionEvent = (event: Event): boolean =>
    event.kind === EventKinds.EXTERNAL_CONTENT_REACTION

export const isLikeReaction = (event: Event): boolean =>
    isReactionEvent(event) && (event.content === '+' || event.content === '')

export const isDislikeReaction = (event: Event): boolean =>
    isReactionEvent(event) && event.content === '-'

export const parseReaction = (event: Event): ReactionEntry => {
    const eTags = event.tags.filter((tag) => tag[0] === EventTags.Event)
    const pTags = event.tags.filter((tag) => tag[0] === EventTags.Pubkey)
    const aTags = event.tags.filter((tag) => tag[0] === EventTags.Address)
    const kTag = event.tags.find((tag) => tag[0] === EventTags.Kind)

    return {
        targetEventId: eTags.length > 0 ? eTags[eTags.length - 1][1] : undefined,
        targetPubkey: pTags.length > 0 ? pTags[pTags.length - 1][1] : undefined,
        targetAddress: aTags.length > 0 ? aTags[aTags.length - 1][1] : undefined,
        targetKind: kTag ? Number(kTag[1]) : undefined,
        content: event.content,
    }
}