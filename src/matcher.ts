import type {
    KnowledgeCallContext,
    KnowledgeEntry,
    KnowledgeSelectorRule,
    KnowledgeSelectorType,
    MatchResult
} from './types'

const SELECTOR_FIELDS: Record<KnowledgeSelectorType, keyof KnowledgeCallContext> = {
    preset: 'preset',
    bot: 'botId',
    platform: 'platform',
    guildId: 'guildId',
    channelId: 'channelId',
    userId: 'userId'
}

/**
 * Collect the effective selector rules of an entry. Configured rules win;
 * otherwise legacy flat selector fields (pre-rule configs not yet re-saved)
 * are converted into one rule per non-empty field. An empty result means the
 * entry is a wildcard that applies to every environment.
 */
function collectRules(entry: KnowledgeEntry): KnowledgeSelectorRule[] {
    const rules = (entry.selectors ?? [])
        .filter(
            (rule) =>
                rule != null &&
                SELECTOR_FIELDS[rule.type] != null &&
                (rule.value ?? '').trim() !== ''
        )
        .map((rule) => ({ type: rule.type, value: rule.value.trim() }))
    if (rules.length > 0) return rules

    const legacy: Array<[KnowledgeSelectorType, string | undefined]> = [
        ['preset', entry.preset],
        ['bot', entry.bot],
        ['platform', entry.platform],
        ['guildId', entry.guildId],
        ['channelId', entry.channelId],
        ['userId', entry.userId]
    ]
    return legacy
        .filter(([, value]) => value != null && value.trim() !== '')
        .map(([type, value]) => ({ type, value: value!.trim() }))
}

/**
 * Match a single knowledge entry against a call context.
 *
 * Rules are grouped by selector type: within one type, any matching rule
 * suffices (e.g. two guild rows share the entry); every type that has rules
 * must be satisfied (AND across types). `specificity` counts the constrained
 * types so the most specific active entry wins; a wildcard entry matches
 * everything with specificity 0.
 */
export function matchEntry(
    entry: KnowledgeEntry,
    ctx: KnowledgeCallContext
): MatchResult {
    if (!entry.enabled) {
        return { matched: false, specificity: 0 }
    }

    const rules = collectRules(entry)
    if (rules.length === 0) {
        return { matched: true, specificity: 0 }
    }

    const byType = new Map<KnowledgeSelectorType, Set<string>>()
    for (const rule of rules) {
        let values = byType.get(rule.type)
        if (!values) {
            values = new Set<string>()
            byType.set(rule.type, values)
        }
        values.add(rule.value)
    }

    let specificity = 0
    for (const [type, values] of byType) {
        const actual = ctx[SELECTOR_FIELDS[type]]
        if (actual == null || !values.has(actual)) {
            return { matched: false, specificity: 0 }
        }
        specificity++
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
