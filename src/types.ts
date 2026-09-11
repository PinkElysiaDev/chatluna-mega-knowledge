/** Selector dimensions a rule can constrain. */
export type KnowledgeSelectorType =
    | 'preset'
    | 'bot'
    | 'platform'
    | 'guildId'
    | 'channelId'
    | 'userId'

/**
 * A single selector rule: constrain one dimension to one exact value.
 *
 * Rules of the same type are OR'd (any match suffices, e.g. two guilds
 * sharing one knowledge base); different types are AND'd (all constrained
 * dimensions must match).
 */
export interface KnowledgeSelectorRule {
    /** Selector dimension this rule constrains. */
    type: KnowledgeSelectorType
    /** Exact-match value; blank rules are ignored at match time. */
    value: string
}

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
    /** Full document text, a local file path, or a remote http(s):// URL. */
    document: string
    /** Per-entry retrieval prompt template; empty falls back to the global default. */
    retrievalPrompt: string
    /**
     * Selector rules (table rows). Same-type rules are OR'd, different types
     * are AND'd. Empty list = the entry applies to every environment.
     */
    selectors: KnowledgeSelectorRule[]
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
    preset?: string
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
    bot?: string
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
    platform?: string
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
    guildId?: string
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
    channelId?: string
    /** @deprecated legacy flat selector, read as a fallback for pre-rule configs. */
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
