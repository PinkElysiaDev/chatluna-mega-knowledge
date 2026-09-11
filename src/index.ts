import { Schema } from 'koishi'
import type { Context } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { CacheKeepAlive } from './keepalive'
import { SessionManager } from './session-manager'
import { registerKnowledgeTool } from './tool'
import { registerKnowledgeVariable } from './variable'
import type { KnowledgeEntry } from './types'

export * from './types'

export interface Config {
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
    /** Max Q&A turns kept per sticky session (sliding window; 0 = unlimited). */
    maxSessionTurns: number
    /** Idle TTL in seconds; sessions older than this are evicted. */
    sessionTTL: number
    /** Persist sessions to disk so they survive restarts. */
    persistSessions: boolean
    /** Register the `{mega_knowledge}` preset variable. */
    enableVariable: boolean
    /** Entry names for which the prompt-cache keep-alive probes run. */
    cacheKeepAliveEntries: string[]
    /** Keep-alive probe interval in minutes. */
    cacheKeepAliveInterval: number
}

export const DEFAULT_RETRIEVAL_PROMPT = `你是知识库问答助手。请严格依据下方知识文档回答用户问题；若文档未覆盖相关内容，请如实说明无法回答，禁止编造。

# 知识文档
{document}`

const selectorRuleSchema = Schema.object({
    type: Schema.union([
        Schema.const('preset').description('预设名称'),
        Schema.const('bot').description('Bot 自身 ID'),
        Schema.const('platform').description('适配器平台'),
        Schema.const('guildId').description('群组 ID'),
        Schema.const('channelId').description('频道 ID'),
        Schema.const('userId').description('用户 ID')
    ])
        .default('guildId')
        .description('选择器类型'),
    value: Schema.string().required().description('匹配值（精确匹配）')
})

const entrySchema = Schema.object({
    name: Schema.string().required().description('知识条目名称（唯一标识）'),
    document: Schema.string()
        .role('textarea')
        .required()
        .description(
            '完整知识文档正文。可填入纯文本、指向文件的路径（相对 baseDir 或绝对路径，支持 .txt/.md/.json/.yaml/.csv 等文本文件），或以 http(s):// 开头的远程 URL'
        ),
    retrievalPrompt: Schema.string()
        .role('textarea')
        .default('')
        .description(
            '该条目专属检索提示词模板，留空则使用全局默认。支持变量：{question} {document} {knowledge_name} {user} {bot} {platform} {guild} {channel} {preset} {conversation_id}，以及内置 {date} {weekday} 等'
        ),
    selectors: Schema.array(selectorRuleSchema)
        .role('table')
        .default([])
        .description(
            '选择器规则表，每行一条规则。同一类型多行=任一匹配（如两个群共享此知识库，加两行群组 ID 即可）；不同类型之间须同时满足；留空=对所有环境生效'
        ),
    enabled: Schema.boolean().default(true).description('是否启用该条目')
}).collapse()

export const Config: Schema<Config> = Schema.intersect([
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
                '用于知识库问答的模型，格式为 平台/模型名（取自 chatluna 已配置的平台适配器）'
            ),
        defaultRetrievalPrompt: Schema.string()
            .role('textarea')
            .default(DEFAULT_RETRIEVAL_PROMPT)
            .description(
                '全局默认检索提示词模板。当条目未单独配置检索提示词时使用。支持变量：{question} {document} {knowledge_name} {user} {bot} {platform} {guild} {channel} {preset} {conversation_id}，以及内置 {date} {weekday} 等'
            ),
        entries: Schema.array(entrySchema)
            .default([])
            .description('知识条目列表')
    }),
    Schema.object({
        maxSessionTurns: Schema.number()
            .min(0)
            .step(1)
            .default(0)
            .description(
                '粘性会话保留的最大 Q&A 轮次（0=不限，默认不限；设置后超出按滑窗保留最近 N 轮，系统前缀保持稳定以保证缓存命中）'
            ),
        sessionTTL: Schema.number()
            .min(60)
            .max(2592000)
            .step(60)
            .default(604800)
            .description('粘性会话空闲存活秒数（默认 7 天）'),
        persistSessions: Schema.boolean()
            .default(true)
            .description('是否将粘性会话持久化到磁盘（跨重启保留）')
    }),
    Schema.object({
        enableVariable: Schema.boolean()
            .default(true)
            .description(
                '是否注册 {mega_knowledge} 预设变量。在预设中写 {mega_knowledge}，每次请求会先自动检索知识库并把结论填入变量再继续（注意是单花括号，{{ }} 是字面量转义）'
            ),
        cacheKeepAliveEntries: Schema.array(Schema.string())
            .role('table')
            .default([])
            .description(
                '启用缓存保活的知识库名称列表（每行填一个知识条目名称）。到期间隔后自动向知识模型发送最小化探测请求（要求只回复 OK）以维持上游提示缓存'
            ),
        cacheKeepAliveInterval: Schema.number()
            .min(5)
            .step(1)
            .default(30)
            .description('缓存保活探测间隔（分钟）')
    })
]).i18n({
    'zh-CN': require('./locales/zh-CN.schema.yml'),
    'en-US': require('./locales/en-US.schema.yml')
}) as unknown as Schema<Config>

export const name = 'chatluna-mega-knowledge'

export const inject = ['chatluna']

export function apply(ctx: Context, config: Config) {
    const logger = createLogger(ctx, 'chatluna-mega-knowledge')

    // The plugin is not a model platform: the wrapper is only used for
    // registerTool, and its request-related config fields are never read
    // (createConfigPool = false).
    const plugin = new ChatLunaPlugin(
        ctx,
        config as unknown as ChatLunaPlugin.Config,
        'mega-knowledge',
        false
    )

    const sessions = new SessionManager(ctx, {
        maxTurns: config.maxSessionTurns,
        ttlSeconds: config.sessionTTL,
        persist: config.persistSessions
    })

    if (config.enableVariable) {
        registerKnowledgeVariable(ctx, config, sessions)
    }

    ctx.on('ready', () => {
        registerKnowledgeTool(ctx, config, plugin, sessions)

        if (config.cacheKeepAliveEntries.length > 0) {
            new CacheKeepAlive(ctx, config, sessions).start()
        }

        logger.success(
            'mega-knowledge ready, entries=%d, model=%s, keepAlive=%d',
            config.entries.length,
            config.knowledgeModel,
            config.cacheKeepAliveEntries.length
        )
    })
}
