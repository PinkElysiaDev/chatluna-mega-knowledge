import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, extname } from 'node:path'
import type { Context, Session } from 'koishi'
import type { KnowledgeCallContext } from './types'

const TEXT_EXTENSIONS = new Set([
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.yaml',
    '.yml',
    '.csv',
    '.log',
    '.html',
    '.htm',
    '.xml',
    '.rst',
    '.org'
])

const REMOTE_URL_PATTERN = /^https?:\/\//i
const REMOTE_CACHE_TTL = 5 * 60 * 1000
const REMOTE_FETCH_TIMEOUT = 30_000

const remoteDocumentCache = new Map<
    string,
    { content: string; fetchedAt: number }
>()

// Local documents are cached with their mtime so edits are picked up without
// a plugin reload.
const documentCache = new Map<string, { content: string; mtimeMs: number }>()

/**
 * Fetch a remote knowledge document over HTTP(S). Results are cached in memory
 * for a short TTL; on fetch failure a stale cached copy is served if available.
 */
async function fetchRemoteDocument(
    ctx: Context,
    url: string
): Promise<string> {
    const cached = remoteDocumentCache.get(url)
    if (cached && Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) {
        return cached.content
    }

    try {
        const content = await ctx.http.get(url, {
            responseType: 'text',
            timeout: REMOTE_FETCH_TIMEOUT
        })
        if (typeof content !== 'string') {
            throw new Error('response is not text')
        }
        remoteDocumentCache.set(url, { content, fetchedAt: Date.now() })
        return content
    } catch (err) {
        if (cached) {
            ctx.logger.warn(
                `mega-knowledge: failed to refresh remote document ${url}, serving stale cache:`,
                err
            )
            return cached.content
        }
        throw new Error(
            `Failed to fetch knowledge document from ${url}: ${
                err instanceof Error ? err.message : String(err)
            }`
        )
    }
}

/**
 * Load a local document. A value is treated as a path only if it has a
 * recognised text-document extension and resolves to an existing file
 * (absolute, or relative to `baseDir`); any other value is inline document
 * text and returned verbatim.
 */
function loadLocalDocument(
    ctx: Context,
    value: string,
    trimmed: string
): string {
    const ext = extname(trimmed).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) {
        return value
    }

    const candidate = isAbsolute(trimmed) ? trimmed : join(ctx.baseDir, trimmed)
    if (!existsSync(candidate)) {
        return value
    }

    try {
        const mtimeMs = statSync(candidate).mtimeMs
        const cached = documentCache.get(candidate)
        if (cached !== undefined && cached.mtimeMs === mtimeMs) {
            return cached.content
        }
        const content = readFileSync(candidate, 'utf-8')
        documentCache.set(candidate, { content, mtimeMs })
        return content
    } catch {
        // the file vanished or became unreadable between the checks
        return value
    }
}

/**
 * Resolve an entry's `document` config into document text. Remote URLs
 * (`http(s)://`) are fetched (throws on failure with no cache); other values
 * go through the local path / inline-text heuristics.
 */
export async function loadDocument(
    ctx: Context,
    value: string
): Promise<string> {
    const trimmed = (value ?? '').trim()
    if (trimmed === '') return ''

    if (REMOTE_URL_PATTERN.test(trimmed)) {
        return fetchRemoteDocument(ctx, trimmed)
    }
    return loadLocalDocument(ctx, value, trimmed)
}

/**
 * Build the variable map exposed to retrieval-prompt templates (single-brace
 * `{var}` syntax, rendered by `ctx.chatluna.promptRenderer`).
 *
 * The prefix is deliberately question-independent: `{question}` renders as an
 * empty string and the live question is always sent as the trailing
 * HumanMessage instead, so the frozen prefix stays byte-stable.
 */
export function buildVariables(
    documentText: string,
    entryName: string,
    callContext: KnowledgeCallContext
): Record<string, unknown> {
    return {
        question: '',
        document: documentText,
        knowledge_name: entryName,
        user: callContext.userId ?? '',
        bot: callContext.botId ?? '',
        platform: callContext.platform ?? '',
        guild: callContext.guildId ?? '',
        channel: callContext.channelId ?? '',
        preset: callContext.preset ?? '',
        conversation_id: callContext.conversationId ?? ''
    }
}

/**
 * Render a retrieval-prompt template with the knowledge variables.
 * Reuses chatluna's prompt renderer so built-in function providers
 * (`{date}`, `{weekday}`, `{time_UTC(...)}`, …) are available.
 */
export async function renderPromptTemplate(
    ctx: Context,
    source: string,
    variables: Record<string, unknown>,
    session?: Session,
    conversationId?: string
): Promise<string> {
    if (!source || source.trim() === '') return ''

    const result = await ctx.chatluna.promptRenderer.renderTemplate(
        source,
        variables,
        {
            configurable: {
                session,
                conversationId
            }
        }
    )
    return result.text
}
