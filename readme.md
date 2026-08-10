# koishi-plugin-chatluna-mega-knowledge

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-mega-knowledge?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-mega-knowledge)

为 ChatLuna 设计的海量知识库插件。核心能力是把用户配置的**完整知识文档 + 固定检索提示词**以**粘性会话**方式喂给 LLM 并向其提问，得到特定知识领域的回复。模型在需要领域知识时自行调用本插件注册的工具。

## 特性

- **注册为 chatluna 工具**：模型按需调用 `mega_knowledge`（工具名可配置），而非每轮硬注入。
- **元数据过滤**：每条知识条目可绑定 `preset / bot / platform / guild / channel / user` 选择器，留空=通配。当前会话环境命中「最具体」的条目生效。
- **粘性会话 + 缓存命中**：每条命中条目按会话冻结一个稳定的系统前缀（渲染后的固定提示词 + 完整文档），并在后续轮次中复用同一前缀、追加式积累历史，使 DeepSeek 的上下文缓存（prompt cache）命中前缀。
- **可配置检索提示词**：提供全局默认提示词模板与每条目模板，支持多种变量。
- **推荐模型**：默认使用 `deepseek/deepseek-v4-flash`。

## 安装与依赖

需要先安装并配置 ChatLuna 及一个模型适配器（推荐 `chatluna-deepseek-adapter`，并配置好 API Key）。本插件依赖 `chatluna` 服务。

## 配置说明

| 配置项 | 说明 |
| --- | --- |
| `enableTool` | 是否注册知识库工具供模型调用 |
| `toolName` | 注册的工具名称，默认 `mega_knowledge` |
| `knowledgeModel` | 知识问答模型，格式 `平台/模型名`，默认 `deepseek/deepseek-v4-flash` |
| `defaultRetrievalPrompt` | 全局默认检索提示词模板（条目未单独配置时使用） |
| `entries` | 知识条目表（见下） |
| `maxSessionTurns` | 粘性会话保留最大轮次（0=不限） |
| `sessionTTL` | 粘性会话空闲存活秒数 |
| `persistSessions` | 是否持久化会话到磁盘 |

### 知识条目（entries）

每条字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 唯一标识 |
| `document` | 完整文档正文，或文件路径（相对 `baseDir` 或绝对路径，支持 `.txt/.md/.json/.yaml/.csv` 等） |
| `retrievalPrompt` | 该条目专属提示词模板，留空用全局默认 |
| `preset` / `bot` / `platform` / `guildId` / `channelId` / `userId` | 元数据选择器，留空=通配，非空必须精确匹配 |
| `enabled` | 是否启用 |

## 检索提示词变量

模板使用单花括号语法 `{var}`，由 ChatLuna 提示词渲染器渲染：

| 变量 | 含义 |
| --- | --- |
| `{question}` | 模型本轮提问 |
| `{document}` | 完整知识文档全文 |
| `{knowledge_name}` | 命中的条目名 |
| `{user}` / `{bot}` / `{platform}` | 用户 ID / Bot 自身 ID / 适配器平台 |
| `{guild}` / `{channel}` / `{preset}` | 群组 / 频道 / 预设关键词 |
| `{conversation_id}` | 会话 ID |
| `{date}` / `{weekday}` / `{time_UTC(offset)}` | 内置时间函数 |

默认模板：

```
你是知识库问答助手。请严格依据下方知识文档回答用户问题；若文档未覆盖相关内容，请如实说明无法回答，禁止编造。

# 知识文档
{document}

# 用户问题
{question}
```

## 工作原理

1. 模型在回答需要领域知识时调用 `mega_knowledge` 工具，传入 `question`（可选 `knowledgeName`）。
2. 插件从工具运行上下文读取 `conversationId / preset / session.{platform,selfId,guildId,channelId,userId}`，按元数据选择器过滤出最具体的生效条目。
3. 读取/渲染文档与提示词，组装 `[SystemMessage(稳定前缀), ...历史轮次, HumanMessage(question)]`。
4. 调用 `knowledgeModel`（默认 `deepseek/deepseek-v4-flash`），把答案返回给模型，并把本轮 Q&A 追加到粘性会话。
5. 稳定前缀与历史轮次字节不变 → DeepSeek 上下文缓存命中。

## 许可证

MIT
