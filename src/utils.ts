import { existsSync, readFileSync } from 'node:fs'
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

const documentCache = new Map<string, string>()

/**
 * Heuristically detect whether `value` points to a file. A value is treated as
 * a path only if it has a recognised text-document extension and resolves to an
 * existing file (absolute, or relative to `baseDir`). Otherwise the value is
 * returned verbatim as inline document text.
 */
export function loadDocument(ctx: Context, value: string): string {
    const trimmed = (value ?? '').trim()
    if (trimmed === '') return ''

    const ext = extname(trimmed).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) {
        return value
    }

    const candidate = isAbsolute(trimmed) ? trimmed : join(ctx.baseDir, trimmed)
    if (!existsSync(candidate)) {
        // fall back: maybe it really is inline text that happens to end with an ext
        return value
    }

    const cached = documentCache.get(candidate)
    if (cached !== undefined) return cached

    try {
        const content = readFileSync(candidate, 'utf-8')
        documentCache.set(candidate, content)
        return content
    } catch {
        return value
    }
}

/**
 * Build the variable map exposed to retrieval-prompt templates (single-brace
 * `{var}` syntax, rendered by `ctx.chatluna.promptRenderer`).
 */
export function buildVariables(
    question: string,
    documentText: string,
    entryName: string,
    ctxMeta: KnowledgeCallContext
): Record<string, unknown> {
    return {
        question,
        document: documentText,
        knowledge_name: entryName,
        user: ctxMeta.userId ?? '',
        bot: ctxMeta.botId ?? '',
        platform: ctxMeta.platform ?? '',
        guild: ctxMeta.guildId ?? '',
        channel: ctxMeta.channelId ?? '',
        preset: ctxMeta.preset ?? '',
        conversation_id: ctxMeta.conversationId ?? ''
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

    const result = await ctx.chatluna.promptRenderer.renderTemplate(source, variables, {
        configurable: {
            session,
            conversationId
        }
    })
    return result.text
}
