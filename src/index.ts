import { Context, Logger, Schema } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { SessionManager } from './session-manager'
import { registerKnowledgeTool } from './tool'
import type { KnowledgeEntry } from './types'

export * from './types'

export let logger: Logger

export interface Config extends ChatLunaPlugin.Config {
    /** Whether the knowledge tool should be registered. */
    enableTool: boolean
    /** Registered tool name. */
    toolName: string
    /** Model used for knowledge Q&A, `platform/model` form. */
    knowledgeModel: string
    /** Global default retrieval-prompt template used when an entry has none. */
    defaultRetrievalPrompt: string
    /** Knowledge entries (full document + fixed prompt + metadata selectors). */
    entries: KnowledgeEntry[]
    /** Max Q&A turns kept per sticky session (sliding window). */
    maxSessionTurns: number
    /** Idle TTL for sticky sessions, in seconds. */
    sessionTTL: number
    /** Persist sticky sessions to disk across restarts. */
    persistSessions: boolean
}

export const DEFAULT_RETRIEVAL_PROMPT = `你是知识库问答助手。请严格依据下方知识文档回答用户问题；若文档未覆盖相关内容，请如实说明无法回答，禁止编造。

# 知识文档
{document}

# 用户问题
{question}`

const entrySchema = Schema.object({
    name: Schema.string().required().description('知识条目名称（唯一标识）'),
    document: Schema.string()
        .role('textarea')
        .required()
        .description(
            '完整知识文档正文。可填入纯文本，或指向文件的路径（相对 baseDir 或绝对路径，支持 .txt/.md/.json/.yaml/.csv 等文本文件）'
        ),
    retrievalPrompt: Schema.string()
        .role('textarea')
        .default('')
        .description(
            '该条目专属检索提示词模板，留空则使用全局默认。支持变量：{question} {document} {knowledge_name} {user} {bot} {platform} {guild} {channel} {preset} {conversation_id}，以及内置 {date} {weekday} 等'
        ),
    preset: Schema.string()
        .default('')
        .description('选择器：预设关键词。留空=通配'),
    bot: Schema.string()
        .default('')
        .description('选择器：Bot 自身 ID（session.selfId）。留空=通配'),
    platform: Schema.string()
        .default('')
        .description('选择器：适配器平台（如 qq、onebot）。留空=通配'),
    guildId: Schema.string()
        .default('')
        .description('选择器：群组 ID。留空=通配'),
    channelId: Schema.string()
        .default('')
        .description('选择器：频道 ID。留空=通配'),
    userId: Schema.string()
        .default('')
        .description('选择器：用户 ID。留空=通配'),
    enabled: Schema.boolean().default(true).description('是否启用该条目')
})

export const Config: Schema<Config> = Schema.intersect([
    ChatLunaPlugin.Config,
    Schema.object({
        enableTool: Schema.boolean()
            .default(true)
            .description('是否注册知识库工具供模型调用'),
        toolName: Schema.string()
            .default('mega_knowledge')
            .description('注册的工具名称'),
        knowledgeModel: Schema.dynamic('model')
            .default('deepseek/deepseek-v4-flash')
            .description(
                '用于知识库问答的模型，强烈建议 deepseek/deepseek-v4-flash'
            ),
        defaultRetrievalPrompt: Schema.string()
            .role('textarea')
            .default(DEFAULT_RETRIEVAL_PROMPT)
            .description(
                '全局默认检索提示词模板。当条目未单独配置时使用。支持变量：{question} {document} {knowledge_name} {user} {bot} {platform} {guild} {channel} {preset} {conversation_id}，以及内置 {date} {weekday} 等'
            ),
        entries: Schema.array(entrySchema)
            .role('table')
            .default([])
            .description('知识条目列表')
    }),
    Schema.object({
        maxSessionTurns: Schema.number()
            .min(0)
            .max(100)
            .step(1)
            .default(20)
            .description(
                '粘性会话保留的最大 Q&A 轮次（0=不限；超出按滑窗保留最近 N 轮，系统前缀保持稳定以保证缓存命中）'
            ),
        sessionTTL: Schema.number()
            .min(60)
            .max(86400)
            .step(60)
            .default(1800)
            .description('粘性会话空闲存活秒数'),
        persistSessions: Schema.boolean()
            .default(false)
            .description('是否将粘性会话持久化到磁盘（跨重启保留）')
    })
]).i18n({
    'zh-CN': require('./locales/zh-CN.schema.yml'),
    'en-US': require('./locales/en-US.schema.yml')
}) as unknown as Schema<Config>

export const name = 'chatluna-mega-knowledge'

export const inject = ['chatluna']

export function apply(ctx: Context, config: Config) {
    logger = createLogger(ctx, 'chatluna-mega-knowledge')

    const plugin = new ChatLunaPlugin(ctx, config, 'mega-knowledge', false)

    const sessions = new SessionManager(ctx, {
        maxTurns: config.maxSessionTurns,
        ttlSeconds: config.sessionTTL,
        persist: config.persistSessions
    })

    ctx.on('ready', async () => {
        registerKnowledgeTool(ctx, config, plugin, sessions)
        logger.success(
            'mega-knowledge ready, entries=%d, model=%s',
            config.entries?.length ?? 0,
            config.knowledgeModel
        )
    })
}
