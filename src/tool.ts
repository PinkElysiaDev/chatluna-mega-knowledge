import { tool } from '@langchain/core/tools'
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { ComputedRef } from '@vue/reactivity'
import type { Context } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import z from 'zod'
import type { Config } from './index'
import { buildConversationKey, selectEntry } from './matcher'
import type { SessionManager } from './session-manager'
import { buildVariables, loadDocument, renderPromptTemplate } from './utils'
import type { KnowledgeCallContext } from './types'

const KNOWLEDGE_TOOL_DESCRIPTION = `Query a domain-specific knowledge base backed by a full document.
- Use this tool when the user asks about a specific domain that requires authoritative/reference knowledge
- Takes a natural-language question and returns an answer grounded in the configured knowledge document
- An optional knowledgeName can pin a specific knowledge entry; otherwise the entry matching the current chat environment is used
- This tool is read-only and does not modify any state`

const knowledgeSchema = z.object({
    question: z
        .string()
        .describe(
            'The natural-language question to answer from the knowledge document'
        ),
    knowledgeName: z
        .string()
        .optional()
        .describe(
            'Optional name of a specific knowledge entry to use; omit to auto-select by environment'
        )
})

// Cache created model refs by model name so we don't rebuild them per call.
const modelCache = new Map<string, ComputedRef<ChatLunaChatModel | undefined>>()

async function getModel(
    ctx: Context,
    name: string
): Promise<ChatLunaChatModel | undefined> {
    const key = name || 'deepseek/deepseek-v4-flash'
    let ref = modelCache.get(key)
    if (!ref) {
        ref = await ctx.chatluna.createChatModel(key)
        modelCache.set(key, ref)
    }
    return ref?.value
}

function extractCallContext(
    runConfig: ChatLunaToolRunnable
): KnowledgeCallContext {
    const session = runConfig.configurable.session
    return {
        conversationId: runConfig.configurable.conversationId,
        preset: runConfig.configurable.preset,
        userId: runConfig.configurable.userId ?? session?.userId,
        platform: session?.platform,
        botId: session?.selfId,
        guildId: session?.guildId ?? session?.channelId,
        channelId: session?.channelId
    }
}

function buildMessages(
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

export function registerKnowledgeTool(
    ctx: Context,
    config: Config,
    plugin: ChatLunaPlugin,
    sessions: SessionManager
): void {
    if (!config.enableTool || (config.entries?.length ?? 0) === 0) {
        return
    }

    const toolName = config.toolName || 'mega_knowledge'

    const knowledgeTool = tool(
        async (
            input: z.infer<typeof knowledgeSchema>,
            runConfig: ChatLunaToolRunnable
        ) => {
            const ctxMeta = extractCallContext(runConfig)
            const session = runConfig?.configurable?.session

            const entry = selectEntry(
                config.entries,
                ctxMeta,
                input.knowledgeName
            )
            if (!entry) {
                return 'No matching knowledge entry is configured for the current environment. Configure one or adjust the metadata selectors.'
            }

            const documentText = loadDocument(ctx, entry.document)
            if (!documentText.trim()) {
                return `Knowledge entry "${entry.name}" has an empty document.`
            }

            const template =
                entry.retrievalPrompt && entry.retrievalPrompt.trim() !== ''
                    ? entry.retrievalPrompt
                    : config.defaultRetrievalPrompt

            const variables = buildVariables(
                input.question,
                documentText,
                entry.name,
                ctxMeta
            )

            const promptText = await renderPromptTemplate(
                ctx,
                template,
                variables,
                session,
                ctxMeta.conversationId
            )

            // Guarantee the full document lives in the frozen, byte-stable prefix
            // so the upstream prompt cache always sees it. If the template already
            // embeds {document}, don't append it twice.
            let stablePrefix = promptText
            if (template && template.includes('{document}')) {
                stablePrefix = promptText
            } else {
                stablePrefix =
                    (promptText ? promptText + '\n\n' : '') +
                    `# 知识文档\n\n${documentText}`
            }

            const convKey = buildConversationKey(ctxMeta)
            const sessionKey = `${convKey}:${entry.name}`
            const ks = sessions.getOrCreate(
                sessionKey,
                entry.name,
                entry.name,
                stablePrefix
            )

            const messages = buildMessages(ks.stablePrefix, ks.turns, input.question)

            const model = await getModel(ctx, config.knowledgeModel)
            if (!model) {
                return `Knowledge model "${config.knowledgeModel}" is not available. Check that the corresponding adapter is configured.`
            }

            try {
                const result = await model.invoke(messages)
                const answer = getMessageContent(result.content)
                sessions.appendTurn(ks, input.question, answer)
                return answer
            } catch (err) {
                ctx.logger.warn(
                    'mega-knowledge: knowledge LLM call failed:',
                    err
                )
                return `Knowledge query failed: ${
                    err instanceof Error ? err.message : String(err)
                }`
            }
        },
        {
            name: toolName,
            description: KNOWLEDGE_TOOL_DESCRIPTION,
            schema: knowledgeSchema
        }
    )

    plugin.registerTool(toolName, {
        description: KNOWLEDGE_TOOL_DESCRIPTION,
        selector: () => true,
        meta: {
            source: 'extension',
            group: 'mega-knowledge',
            tags: ['mega-knowledge', 'knowledge', 'rag'],
            defaultAvailability: {
                enabled: true,
                main: true,
                chatluna: true,
                characterScope: 'all'
            }
        },
        createTool: () => knowledgeTool
    })
}
