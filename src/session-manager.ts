import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'koishi'
import type { KnowledgeSession, KnowledgeSessionTurn } from './types'

export interface SessionManagerOptions {
    /** Max Q&A turns kept per session (sliding window; 0 = unlimited). */
    maxTurns: number
    /** Idle TTL in seconds; sessions older than this are evicted. */
    ttlSeconds: number
    /** Persist sessions to disk so they survive restarts. */
    persist: boolean
}

const PERSIST_DIR = 'data/chatluna/mega-knowledge'
const PERSIST_FILE = 'sessions.json'

/**
 * Manages sticky knowledge sessions.
 *
 * A session is keyed by `${conversationKey}:${entryName}`. Its `stablePrefix`
 * (rendered retrieval prompt + full document) is frozen at creation time and
 * reused verbatim on every subsequent call, so the leading `SystemMessage` and
 * already-accumulated turns form a byte-stable prefix that hits the upstream
 * provider's prompt cache. New turns are appended (with a sliding window so the
 * prefix stays stable in the long run).
 */
export class SessionManager {
    private readonly _sessions = new Map<string, KnowledgeSession>()
    private readonly _ctx: Context
    private readonly _options: SessionManagerOptions
    private readonly _persistPath: string
    private _dirty = false

    constructor(ctx: Context, options: SessionManagerOptions) {
        this._ctx = ctx
        this._options = options
        this._persistPath = join(ctx.baseDir, PERSIST_DIR, PERSIST_FILE)

        this._load()

        // Sweep cadence scales with the TTL, clamped between once a minute and
        // once every 10 minutes.
        const sweepIntervalMs =
            Math.max(60, Math.min(options.ttlSeconds, 600)) * 1000
        ctx.setInterval(() => {
            this._sweep()
            this._maybeFlush()
        }, sweepIntervalMs)
        ctx.effect(() => () => this._maybeFlush(true))
    }

    /**
     * Get an existing session or create one with the given frozen prefix.
     * The prefix is only stored when the session is first created — callers
     * must compute the same prefix for a given entry, but it is never
     * overwritten afterwards.
     */
    getOrCreate(
        key: string,
        entryName: string,
        stablePrefix: string
    ): KnowledgeSession {
        const existing = this._sessions.get(key)
        if (existing) {
            existing.lastAccess = Date.now()
            return existing
        }

        const session: KnowledgeSession = {
            key,
            entryName,
            stablePrefix,
            turns: [],
            lastAccess: Date.now()
        }
        this._sessions.set(key, session)
        this._markDirty()
        return session
    }

    /** Append a Q&A turn, applying the sliding window. */
    appendTurn(
        session: KnowledgeSession,
        question: string,
        answer: string
    ): void {
        const turn: KnowledgeSessionTurn = { question, answer }
        session.turns.push(turn)
        const max = this._options.maxTurns
        if (max > 0 && session.turns.length > max) {
            session.turns.splice(0, session.turns.length - max)
        }
        session.lastAccess = Date.now()
        this._markDirty()
    }

    /**
     * Read-only list of the sticky sessions bound to an entry name.
     * Used by the cache keep-alive to probe each session's frozen prefix.
     */
    listByEntry(entryName: string): KnowledgeSession[] {
        const result: KnowledgeSession[] = []
        for (const session of this._sessions.values()) {
            if (session.entryName === entryName) {
                result.push(session)
            }
        }
        return result
    }

    private _sweep(): void {
        const now = Date.now()
        const ttlMs = this._options.ttlSeconds * 1000
        let changed = false
        for (const [key, session] of this._sessions) {
            if (now - session.lastAccess > ttlMs) {
                this._sessions.delete(key)
                changed = true
            }
        }
        if (changed) this._markDirty()
    }

    private _markDirty(): void {
        this._dirty = true
    }

    private _maybeFlush(force = false): void {
        if (!this._options.persist) return
        if (!force && !this._dirty) return
        this._dirty = false
        try {
            mkdirSync(join(this._ctx.baseDir, PERSIST_DIR), { recursive: true })
            const payload = JSON.stringify(Array.from(this._sessions.values()))
            writeFileSync(this._persistPath, payload, 'utf-8')
        } catch (err) {
            this._ctx.logger.warn(
                'mega-knowledge: failed to persist sessions:',
                err
            )
        }
    }

    private _load(): void {
        if (!this._options.persist) return
        try {
            if (!existsSync(this._persistPath)) return
            const raw = readFileSync(this._persistPath, 'utf-8')
            const arr = JSON.parse(raw) as KnowledgeSession[]
            if (!Array.isArray(arr)) return
            const now = Date.now()
            const ttlMs = this._options.ttlSeconds * 1000
            for (const s of arr) {
                if (!s || !s.key) continue
                if (now - (s.lastAccess ?? 0) > ttlMs) continue
                this._sessions.set(s.key, s)
            }
        } catch (err) {
            this._ctx.logger.warn(
                'mega-knowledge: failed to load persisted sessions:',
                err
            )
        }
    }
}
