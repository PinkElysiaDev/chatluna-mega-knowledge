import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { ComputedRef } from '@vue/reactivity'
import type { Context, Session } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { Config } from './index'
import { buildConversationKey, selectEntry } from './matcher'
import type { SessionManager } from './session-manager'
import type { KnowledgeCallContext, KnowledgeEntry } from './types'
import {
    buildVariables,
    loadDocument,
    renderPromptTemplate
} from './utils'

/** Heading prepended to the document when the template has no `{document}` slot. */
const DOCUMENT_SECTION_HEADER = '# 知识文档'

export interface KnowledgeQueryResult {
    ok: boolean
    /** Answer text when ok; otherwise a human-readable reason. */
    text: string
}

export interface QueryOptions {
    /** Pin a specific entry by name instead of environment matching. */
    preferredName?: string
    /** Koishi session used for prompt rendering (when available). */
    session?: Session
    /** Append the turn to the sticky session. Default: true. */
    recordTurn?: boolean
}

// Cache created model refs by model name so we don't rebuild them per call.
const modelCache = new Map<string, ComputedRef<ChatLunaChatModel | undefined>>()

export async function getModel(
    ctx: Context,
    name: string
): Promise<ChatLunaChatModel | undefined> {
    let ref = modelCache.get(name)
    if (!ref) {
        ref = await ctx.chatluna.createChatModel(name)
        modelCache.set(name, ref)
    }
    return ref?.value
}

/**
 * The flat configurable shape set directly by older chatluna runtimes and the
 * character plugin (no `agentContext` wrapper).
 */
interface FlatRunConfigurable {
    conversationId?: string
    preset?: string
    userId?: string
    session?: Session
    agentContext?: Record<string, any>
}

/**
 * Extract a `KnowledgeCallContext` from a chatluna render/run configurable.
 *
 * Works for both consumers: the main chatluna agent runtime puts the run
 * metadata on `agentContext` (`AgentRunContext`), while the character plugin
 * only supplies `session` (plus flat `conversationId`/`userId` on some paths).
 */
export function buildCallContext(
    configurable: Record<string, unknown> | undefined
): KnowledgeCallContext {
    const cfg = configurable as FlatRunConfigurable | undefined
    const session = cfg?.session
    const agentContext = cfg?.agentContext
    return {
        conversationId: agentContext?.conversationId ?? cfg?.conversationId,
        preset: cfg?.preset,
        userId: agentContext?.userId ?? cfg?.userId ?? session?.userId,
        platform: session?.platform,
        botId: session?.selfId,
        guildId: session?.guildId ?? session?.channelId,
        channelId: session?.channelId
    }
}

export function buildMessages(
    stablePrefix: string,
    turns: { question: string; answer: string }[],
    question: string
): BaseMessage[] {
    const messages: BaseMessage[] = [new SystemMessage(stablePrefix)]
    for (const turn of turns) {
        messages.push(new HumanMessage(turn.question))
        messages.push(new AIMessage(turn.answer))
    }
    messages.push(new HumanMessage(question))
    return messages
}

function pickTemplate(config: Config, entry: KnowledgeEntry): string {
    return entry.retrievalPrompt && entry.retrievalPrompt.trim() !== ''
        ? entry.retrievalPrompt
        : config.defaultRetrievalPrompt
}

/**
 * Build the frozen, byte-stable system prefix of an entry from an already
 * loaded document: the rendered retrieval prompt plus the full document. If
 * the template already embeds `{document}`, the rendered text is used
 * verbatim; otherwise the document is appended under
 * {@link DOCUMENT_SECTION_HEADER}. The question is deliberately not part of
 * the prefix.
 */
export async function buildStablePrefix(
    ctx: Context,
    config: Config,
    entry: KnowledgeEntry,
    documentText: string,
    callContext: KnowledgeCallContext,
    session?: Session
): Promise<string> {
    const template = pickTemplate(config, entry)
    const variables = buildVariables(documentText, entry.name, callContext)
    const promptText = await renderPromptTemplate(
        ctx,
        template,
        variables,
        session,
        callContext.conversationId
    )
    if (template.includes('{document}')) {
        return promptText
    }
    return (
        (promptText ? promptText + '\n\n' : '') +
        `${DOCUMENT_SECTION_HEADER}\n\n${documentText}`
    )
}

/**
 * The shared knowledge retrieval flow used by both the chatluna tool and the
 * `{mega_knowledge}` preset variable: select the entry, load the document,
 * reuse/create the sticky session, query the knowledge model and record the
 * turn.
 */
export async function queryKnowledge(
    ctx: Context,
    config: Config,
    sessions: SessionManager,
    callContext: KnowledgeCallContext,
    question: string,
    options: QueryOptions = {}
): Promise<KnowledgeQueryResult> {
    const entry = selectEntry(
        config.entries,
        callContext,
        options.preferredName
    )
    if (!entry) {
        return {
            ok: false,
            text: 'No matching knowledge entry is configured for the current environment. Configure one or adjust the metadata selectors.'
        }
    }

    let documentText: string
    let stablePrefix: string
    try {
        documentText = await loadDocument(ctx, entry.document)
        if (!documentText.trim()) {
            return {
                ok: false,
                text: `Knowledge entry "${entry.name}" has an empty document.`
            }
        }
        stablePrefix = await buildStablePrefix(
            ctx,
            config,
            entry,
            documentText,
            callContext,
            options.session
        )
    } catch (err) {
        ctx.logger.warn(
            'mega-knowledge: failed to prepare the knowledge prompt:',
            err
        )
        return {
            ok: false,
            text: `Knowledge entry "${entry.name}" could not be prepared (document load or prompt render failed). ${
                err instanceof Error ? err.message : String(err)
            }`
        }
    }

    const conversationKey = buildConversationKey(callContext)
    const stickySession = sessions.getOrCreate(
        `${conversationKey}:${entry.name}`,
        entry.name,
        stablePrefix
    )

    const messages = buildMessages(
        stickySession.stablePrefix,
        stickySession.turns,
        question
    )

    const model = await getModel(ctx, config.knowledgeModel)
    if (!model) {
        return {
            ok: false,
            text: `Knowledge model "${config.knowledgeModel}" is not available. Check that the corresponding adapter is configured.`
        }
    }

    try {
        const result = await model.invoke(messages)
        const answer = getMessageContent(result.content)
        if (options.recordTurn !== false) {
            sessions.appendTurn(stickySession, question, answer)
        }
        return { ok: true, text: answer }
    } catch (err) {
        ctx.logger.warn('mega-knowledge: knowledge LLM call failed:', err)
        return {
            ok: false,
            text: `Knowledge query failed: ${
                err instanceof Error ? err.message : String(err)
            }`
        }
    }
}
