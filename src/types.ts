/**
 * A user-configured knowledge entry.
 *
 * Each entry bundles a complete document with a fixed retrieval prompt.
 * Metadata selectors are only used to filter which entry is active for the
 * current chat environment — they are *not* used for semantic retrieval.
 */
export interface KnowledgeEntry {
    /** Display name; also serves as the session key suffix. */
    name: string
    /** Full document text, or a path to a file (absolute, or relative to baseDir). */
    document: string
    /** Per-entry retrieval prompt template; empty falls back to the global default. */
    retrievalPrompt: string
    /** Selector: preset id. Empty = wildcard. */
    preset?: string
    /** Selector: bot self id. Empty = wildcard. */
    bot?: string
    /** Selector: adapter platform. Empty = wildcard. */
    platform?: string
    /** Selector: guild id. Empty = wildcard. */
    guildId?: string
    /** Selector: channel id. Empty = wildcard. */
    channelId?: string
    /** Selector: user id. Empty = wildcard. */
    userId?: string
    enabled: boolean
}

/**
 * A single Q&A turn inside a sticky knowledge session.
 */
export interface KnowledgeSessionTurn {
    question: string
    answer: string
}

/**
 * A sticky knowledge session.
 *
 * The `stablePrefix` is computed once when the session is created and stays
 * byte-identical for the whole lifetime of the session. It is sent as the
 * leading `SystemMessage` on every call so that the upstream provider (e.g.
 * DeepSeek) can hit its prompt cache on the stable prefix plus the already
 * accumulated turns.
 */
export interface KnowledgeSession {
    /** `${conversationKey}:${entryName}` */
    key: string
    /** The id of the knowledge entry this session is bound to. */
    entryId: string
    /** The display name of the knowledge entry. */
    entryName: string
    /** Frozen system prompt: rendered retrieval prompt + full document. */
    stablePrefix: string
    /** Accumulated Q&A turns (append-only, sliding window). */
    turns: KnowledgeSessionTurn[]
    /** Last access timestamp in ms (for TTL / LRU). */
    lastAccess: number
}

/**
 * Context extracted from a chatluna tool call (`runConfig.configurable`),
 * used both for metadata filtering and session keying.
 */
export interface KnowledgeCallContext {
    conversationId?: string
    preset?: string
    userId?: string
    platform?: string
    /** bot self id */
    botId?: string
    guildId?: string
    channelId?: string
}

/**
 * Result of matching a single entry against a call context.
 */
export interface MatchResult {
    matched: boolean
    /** Number of non-wildcard selector fields that matched (higher = more specific). */
    specificity: number
}
