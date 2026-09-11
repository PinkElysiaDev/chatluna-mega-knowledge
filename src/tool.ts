import { tool } from '@langchain/core/tools'
import type { Context, Session } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import type { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import z from 'zod'
import type { Config } from './index'
import { buildCallContext, queryKnowledge } from './knowledge'
import type { SessionManager } from './session-manager'

const KNOWLEDGE_TOOL_DESCRIPTION = `Query a domain-specific knowledge base backed by a full document.
- Use this tool when the user asks about a specific domain that requires authoritative/reference knowledge
- Takes a natural-language question and returns an answer grounded in the configured knowledge document
- An optional knowledgeName can pin a specific knowledge entry; otherwise the entry matching the current chat environment is used
- Available in both the chatluna main plugin and the character roleplay plugin
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

/**
 * Register the knowledge tool (`mega_knowledge` by default) on chatluna's
 * shared platform registry — the single registry consumed by both the chatluna
 * main plugin and the character plugin.
 */
export function registerKnowledgeTool(
    ctx: Context,
    config: Config,
    plugin: ChatLunaPlugin,
    sessions: SessionManager
): void {
    if (!config.enableTool || config.entries.length === 0) {
        return
    }

    const toolName = config.toolName

    const knowledgeTool = tool(
        async (
            input: z.infer<typeof knowledgeSchema>,
            runConfig: ChatLunaToolRunnable
        ) => {
            const result = await queryKnowledge(
                ctx,
                config,
                sessions,
                buildCallContext(runConfig?.configurable),
                input.question,
                {
                    preferredName: input.knowledgeName,
                    session: runConfig?.configurable
                        ?.session as Session | undefined
                }
            )
            return result.text
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
