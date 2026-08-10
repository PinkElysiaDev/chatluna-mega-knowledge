import type { KnowledgeCallContext, KnowledgeEntry, MatchResult } from './types'

/**
 * Match a single knowledge entry against a call context.
 *
 * A selector field that is empty/blank acts as a wildcard. Every non-wildcard
 * selector must match the corresponding context field exactly for the entry to
 * be considered active. `specificity` counts the non-wildcard fields so the
 * most specific active entry wins.
 */
export function matchEntry(
    entry: KnowledgeEntry,
    ctx: KnowledgeCallContext
): MatchResult {
    if (!entry.enabled) {
        return { matched: false, specificity: 0 }
    }

    const checks: Array<[string | undefined, string | undefined]> = [
        [entry.preset, ctx.preset],
        [entry.bot, ctx.botId],
        [entry.platform, ctx.platform],
        [entry.guildId, ctx.guildId],
        [entry.channelId, ctx.channelId],
        [entry.userId, ctx.userId]
    ]

    let specificity = 0
    for (const [selector, actual] of checks) {
        if (selector == null || selector.trim() === '') {
            // wildcard — does not constrain matching
            continue
        }
        specificity++
        if (actual !== selector) {
            return { matched: false, specificity: 0 }
        }
    }
    return { matched: true, specificity }
}

/**
 * Select the most specific active entry for a call context.
 * Ties are broken by array order (first wins). Returns `null` if none match.
 */
export function selectEntry(
    entries: KnowledgeEntry[],
    ctx: KnowledgeCallContext,
    preferredName?: string
): KnowledgeEntry | null {
    if (preferredName && preferredName.trim() !== '') {
        const exact = entries.find(
            (e) => e.enabled && e.name === preferredName
        )
        if (exact) {
            // still verify selectors match
            if (matchEntry(exact, ctx).matched) return exact
        }
    }

    let best: KnowledgeEntry | null = null
    let bestSpec = -1
    for (const entry of entries) {
        const result = matchEntry(entry, ctx)
        if (!result.matched) continue
        if (result.specificity > bestSpec) {
            best = entry
            bestSpec = result.specificity
        }
    }
    return best
}

/**
 * Build a stable conversation key for session storage. Prefers conversationId,
 * falling back to platform/selfId/guild-or-channel/user.
 */
export function buildConversationKey(ctx: KnowledgeCallContext): string {
    if (ctx.conversationId && ctx.conversationId !== '') {
        return `conv:${ctx.conversationId}`
    }
    const guild = ctx.guildId || ctx.channelId || 'global'
    return `bind:${ctx.platform || 'unknown'}:${ctx.botId || 'self'}:${guild}:${ctx.userId || 'anon'}`
}
