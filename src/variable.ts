import type { Context, Session } from 'koishi'
import type { Config } from './index'
import {
    buildCallContext,
    queryKnowledge,
    type KnowledgeQueryResult
} from './knowledge'
import { buildConversationKey } from './matcher'
import type { SessionManager } from './session-manager'

export const MEGA_KNOWLEDGE_VARIABLE = 'mega_knowledge'

// Identical retrievals within this window reuse the previous answer: a single
// request may render the same template multiple times, and we don't want to
// query the knowledge model twice for the same question.
const DEDUP_TTL = 60_000
// Failed retrievals are remembered for a shorter window so a broken knowledge
// model doesn't stall every single request with a fresh failed call.
const FAILURE_TTL = 30_000
const DEDUP_MAX_ENTRIES = 64

interface CachedRetrieval {
    ok: boolean
    text: string
    at: number
}

const dedupCache = new Map<string, CachedRetrieval>()

// Re-entrancy guard: if a retrieval template itself references
// `{mega_knowledge}`, the nested render must not trigger another retrieval —
// that would recurse indefinitely (renderer→provider→retrieval→renderer…).
let inRetrieval = false

function lookupCachedResult(key: string): CachedRetrieval | undefined {
    const cached = dedupCache.get(key)
    if (!cached) return undefined
    const ttl = cached.ok ? DEDUP_TTL : FAILURE_TTL
    return Date.now() - cached.at < ttl ? cached : undefined
}

function rememberResult(key: string, ok: boolean, text: string): void {
    if (dedupCache.size >= DEDUP_MAX_ENTRIES) {
        pruneDedupCache()
    }
    dedupCache.set(key, { ok, text, at: Date.now() })
}

function pruneDedupCache(): void {
    const now = Date.now()
    for (const [key, value] of dedupCache) {
        if (now - value.at >= DEDUP_TTL) {
            dedupCache.delete(key)
        }
    }
    // still full — drop the oldest entries
    while (dedupCache.size >= DEDUP_MAX_ENTRIES) {
        const oldest = [...dedupCache.entries()].sort(
            (a, b) => a[1].at - b[1].at
        )[0]
        if (!oldest) break
        dedupCache.delete(oldest[0])
    }
}

/**
 * Resolve the retrieval question: an explicit argument wins
 * (`{mega_knowledge(自定义问题)}`), then the current user input
 * (`variables.prompt`); `undefined` when neither is usable.
 */
function resolveRetrievalQuestion(
    args: string[],
    variables: Record<string, unknown>
): string | undefined {
    const explicit =
        args[0] != null && String(args[0]).trim() !== ''
            ? String(args[0])
            : undefined
    const prompt =
        typeof variables?.prompt === 'string' && variables.prompt.trim() !== ''
            ? variables.prompt
            : undefined
    return explicit ?? prompt
}

/**
 * Register the `{mega_knowledge}` prompt function provider on chatluna's
 * shared prompt renderer.
 *
 * The renderer awaits async providers before the preset is assembled into the
 * model request, so every request that uses `{mega_knowledge}` first runs the
 * knowledge retrieval (entry matched by the current chat environment) and
 * fills the answer into the variable. Works in both the chatluna main plugin
 * and the character plugin — both render presets through the same service.
 *
 * Question priority: an explicit argument (`{mega_knowledge(自定义问题)}`),
 * then the current user input (`variables.prompt`). Without a usable
 * question or matching entry the variable renders as an empty string.
 *
 * Note for the character plugin: only the INPUT template receives the current
 * user input (`prompt: session.content`); its system template does not, so
 * put the variable in the input template there. The chatluna main plugin
 * exposes `variables.prompt` to every preset message slot.
 */
export function registerKnowledgeVariable(
    ctx: Context,
    config: Config,
    sessions: SessionManager
): void {
    ctx.effect(() =>
        ctx.chatluna.promptRenderer.registerFunctionProvider(
            MEGA_KNOWLEDGE_VARIABLE,
            async (args, variables, configurable) => {
                if (inRetrieval || config.entries.length === 0) return ''

                const question = resolveRetrievalQuestion(args, variables)
                if (!question) return ''

                const callContext = buildCallContext(configurable)
                const cacheKey = `${buildConversationKey(callContext)}:${question}`

                const cached = lookupCachedResult(cacheKey)
                if (cached) return cached.text

                inRetrieval = true
                let result: KnowledgeQueryResult
                try {
                    result = await queryKnowledge(
                        ctx,
                        config,
                        sessions,
                        callContext,
                        question,
                        {
                            session: configurable?.session as Session | undefined
                        }
                    )
                } finally {
                    inRetrieval = false
                }

                if (!result.ok) {
                    ctx.logger.warn(
                        'mega-knowledge: preset variable retrieval failed:',
                        result.text
                    )
                    rememberResult(cacheKey, false, '')
                    return ''
                }

                rememberResult(cacheKey, true, result.text)
                return result.text
            }
        )
    )
}
