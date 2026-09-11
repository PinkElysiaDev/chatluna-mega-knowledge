import type { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import type { Config } from './index'
import {
    buildCallContext,
    buildMessages,
    buildStablePrefix,
    getModel
} from './knowledge'
import type { SessionManager } from './session-manager'
import type { KnowledgeEntry } from './types'
import { loadDocument } from './utils'

const PROBE_QUESTION = '请只回复：OK'
const PROBE_MAX_TOKENS = 16
// Delay before the first probe so platform adapters have time to register
// their models after startup.
const FIRST_TICK_DELAY_MS = 60_000

/**
 * Keeps the upstream provider's prompt cache warm for configured knowledge
 * entries.
 *
 * Every interval, for each configured entry name:
 * 1. a base-prefix probe `[SystemMessage(稳定前缀), HumanMessage("请只回复：OK")]`
 *    refreshes the entry's document prefix (benefits future sessions);
 * 2. one probe per existing sticky session replays that session's exact
 *    byte prefix plus its accumulated turns.
 *
 * Probes are transparent: the reply is discarded, nothing is appended to the
 * session history, and `lastAccess` is untouched (TTL eviction and session
 * content are unaffected). Input tokens are billed at the (cheap) cache-hit
 * price and the output is a couple of tokens, so the cost per probe is
 * minimal while the prefix stays continuously cached.
 */
export class CacheKeepAlive {
    private readonly _warnedNames = new Set<string>()
    private _running = false

    constructor(
        private readonly ctx: Context,
        private readonly config: Config,
        private readonly sessions: SessionManager
    ) {}

    start(): void {
        const intervalMs = this._intervalMs()
        this.ctx.setInterval(() => void this._tick(), intervalMs)
        this.ctx.setTimeout(() => void this._tick(), FIRST_TICK_DELAY_MS)
    }

    private _intervalMs(): number {
        return this.config.cacheKeepAliveInterval * 60_000
    }

    private async _tick(): Promise<void> {
        if (this._running) {
            // previous tick still probing (e.g. the model hangs) — don't stack
            this.ctx.logger.debug(
                'mega-knowledge: keep-alive tick skipped, previous tick still running'
            )
            return
        }
        this._running = true
        try {
            await this._probeAll()
        } catch (err) {
            this.ctx.logger.debug(
                'mega-knowledge: keep-alive tick failed:',
                err
            )
        } finally {
            this._running = false
        }
    }

    private async _probeAll(): Promise<void> {
        const names = this.config.cacheKeepAliveEntries
        if (names.length === 0) return

        const entriesByName = new Map<string, KnowledgeEntry>(
            this.config.entries
                .filter((entry) => entry != null && !!entry.name)
                .map((entry) => [entry.name, entry])
        )
        const now = Date.now()
        const intervalMs = this._intervalMs()

        const model = await getModel(this.ctx, this.config.knowledgeModel)
        if (!model) {
            this.ctx.logger.debug(
                'mega-knowledge: keep-alive skipped, knowledge model is not available'
            )
            return
        }

        for (const rawName of names) {
            const name = (rawName ?? '').trim()
            if (!name) continue

            const entry = entriesByName.get(name)
            if (!entry || !entry.enabled) {
                if (!this._warnedNames.has(name)) {
                    this._warnedNames.add(name)
                    this.ctx.logger.warn(
                        `mega-knowledge: keep-alive entry "${name}" not found or disabled`
                    )
                }
                continue
            }
            this._warnedNames.delete(name)

            await this._probeEntry(model, entry, now, intervalMs)
        }
    }

    private async _probeEntry(
        model: ChatLunaChatModel,
        entry: KnowledgeEntry,
        now: number,
        intervalMs: number
    ): Promise<void> {
        let documentText: string
        try {
            documentText = await loadDocument(this.ctx, entry.document)
        } catch (err) {
            this.ctx.logger.debug(
                `mega-knowledge: keep-alive base probe failed for "${entry.name}":`,
                err
            )
            return
        }
        if (!documentText.trim()) return

        // 1. base prefix probe — keeps the entry's shared document prefix warm
        try {
            const prefix = await buildStablePrefix(
                this.ctx,
                this.config,
                entry,
                documentText,
                buildCallContext(undefined)
            )
            const messages = buildMessages(prefix, [], PROBE_QUESTION)
            await model.invoke(messages, { maxTokens: PROBE_MAX_TOKENS })
        } catch (err) {
            this.ctx.logger.debug(
                `mega-knowledge: keep-alive base probe failed for "${entry.name}":`,
                err
            )
        }

        // 2. per-session probes — replay each session's exact byte prefix
        for (const session of this.sessions.listByEntry(entry.name)) {
            if (now - session.lastAccess < intervalMs) {
                // recently served by real traffic, the cache is still warm
                continue
            }
            try {
                const messages = buildMessages(
                    session.stablePrefix,
                    session.turns,
                    PROBE_QUESTION
                )
                await model.invoke(messages, { maxTokens: PROBE_MAX_TOKENS })
            } catch (err) {
                this.ctx.logger.debug(
                    `mega-knowledge: keep-alive session probe failed for "${entry.name}" (${session.key}):`,
                    err
                )
            }
        }
    }
}
