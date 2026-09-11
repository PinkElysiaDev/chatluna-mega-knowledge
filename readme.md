# koishi-plugin-chatluna-mega-knowledge

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-mega-knowledge?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-mega-knowledge)

为 ChatLuna 设计的海量知识库插件。核心能力是把用户配置的**完整知识文档 + 固定检索提示词**以**粘性会话**方式喂给 LLM 并向其提问，得到特定知识领域的回复。模型在需要领域知识时自行调用本插件注册的工具。

## 特性

- **注册为 chatluna 工具**：模型按需调用 `mega_knowledge`（工具名可配置），而非每轮硬注入；主插件与伪装插件（chatluna-character）均可用。
- **预设变量注入**：预设中写 `{mega_knowledge}`，每次请求先自动检索知识并把结论填入变量再继续（详见下文）。
- **直接使用 chatluna 平台适配器模型**：本插件不自建任何模型请求通道，所有请求（鉴权、重试、超时、代理等）均由所选平台适配器负责，插件仅通过 `ctx.chatluna.createChatModel()` 获取模型。
- **选择器规则表**：每条知识条目内建规则表，每行=类型（下拉单选）+ 匹配值；同一类型多行任一匹配（如两个群共享一份知识库），不同类型须同时满足，留空=通配。当前会话环境命中「最具体」的条目生效。
- **粘性会话 + 缓存命中**：每条命中条目按会话冻结一个稳定的系统前缀（渲染后的固定提示词 + 完整文档），并在后续轮次中复用同一前缀、追加式积累历史，使 DeepSeek 等模型的上下文缓存（prompt cache）命中前缀。
- **可配置检索提示词**：提供全局默认提示词模板与每条目模板，支持多种变量。
- **文档来源灵活**：支持纯文本内联、本地文件路径、远程 `http(s)://` URL（带短 TTL 内存缓存）。
- **缓存保活**：可按条目定时发送「只回复 OK」的最小化探测请求，以最小 token 消耗维持上游提示缓存（详见下文）。

## 安装与依赖

需要先安装并配置 ChatLuna 及一个模型适配器（如 `chatluna-deepseek-adapter`，并配置好 API Key）。本插件依赖 `chatluna` 服务。

## 配置说明

| 配置项 | 说明 |
| --- | --- |
| `enableTool` | 是否注册知识库工具供模型调用 |
| `toolName` | 注册的工具名称，默认 `mega_knowledge` |
| `knowledgeModel` | 知识问答模型，格式 `平台/模型名`（取自 chatluna 已配置的平台适配器），默认 `deepseek/deepseek-v4-flash` |
| `defaultRetrievalPrompt` | 全局默认检索提示词模板（条目未单独配置检索提示词时使用） |
| `entries` | 知识条目列表，每条为可折叠展开的对象（见下） |
| `maxSessionTurns` | 粘性会话保留最大轮次，默认 `0`=不限 |
| `sessionTTL` | 粘性会话空闲存活秒数，默认 `604800`（7 天），上限 30 天 |
| `persistSessions` | 是否持久化会话到磁盘，默认开启（`data/chatluna/mega-knowledge/sessions.json`） |
| `enableVariable` | 是否注册 `{mega_knowledge}` 预设变量，默认开启（见下） |
| `cacheKeepAliveEntries` | 启用缓存保活的知识库名称列表（table 外观，每行一个名称，见下） |
| `cacheKeepAliveInterval` | 缓存保活探测间隔（分钟），默认 30 |

### 知识条目（entries）

每条字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 唯一标识 |
| `document` | 完整文档正文，或文件路径（相对 `baseDir` 或绝对路径，支持 `.txt/.md/.json/.yaml/.csv` 等），或 `http(s)://` 远程 URL |
| `retrievalPrompt` | 该条目专属提示词模板，留空用全局默认 |
| `selectors` | 选择器规则表（见下） |
| `enabled` | 是否启用 |

### 选择器规则（selectors）

表格中每一行代表一种选择器（一条规则）：**类型**列是下拉单选（预设名称 / Bot 自身 ID / 适配器平台 / 群组 ID / 频道 ID / 用户 ID），**值**列填精确匹配值。快捷新增行即新增规则。

匹配语义：

- **同一类型多行 = 任一匹配**。例如想让某两个群共享同一份知识库，加两行 `类型=群组 ID`，分别填两个群号即可。
- **不同类型之间 = 须同时满足**（AND）。例如 `群组 ID=A` + `用户 ID=U` 表示只在群 A 中的用户 U 生效。
- **规则留空 = 对所有环境生效**（通配）。
- 命中多个条目时，被约束类型数最多（最具体）的条目优先；会话键按「会话 ID + 条目名」隔离，两个共享知识库的群各自保有独立的粘性会话。

远程 URL 文档在首次使用时拉取并缓存 5 分钟；拉取失败时会回退到过期缓存（如有）。

## 检索提示词变量

模板使用单花括号语法 `{var}`，由 ChatLuna 提示词渲染器渲染：

| 变量 | 含义 |
| --- | --- |
| `{question}` | 模型本轮提问（注意：默认模板不再使用它，问题始终作为末尾用户消息发送） |
| `{document}` | 完整知识文档全文 |
| `{knowledge_name}` | 命中的条目名 |
| `{user}` / `{bot}` / `{platform}` | 用户 ID / Bot 自身 ID / 适配器平台 |
| `{guild}` / `{channel}` / `{preset}` | 群组 / 频道 / 预设名称 |
| `{conversation_id}` | 会话 ID |
| `{date}` / `{weekday}` / `{time_UTC(offset)}` | 内置时间函数 |

默认模板：

```
你是知识库问答助手。请严格依据下方知识文档回答用户问题；若文档未覆盖相关内容，请如实说明无法回答，禁止编造。

# 知识文档
{document}
```

## 预设变量 {mega_knowledge}

除了工具调用方式，还可以把知识检索直接注入预设（prompt）：在预设模板里写 **`{mega_knowledge}`**（注意是**单花括号**——chatluna 渲染器中 `{{ }}` 是字面量转义，双写不会生效）。

- 每次主模型请求前，渲染器会 **await** 本插件完成检索：按当前会话环境匹配知识条目 → 用粘性会话查询知识模型 → 把结论填入变量，然后请求才继续。
- 检索问题默认取本轮用户输入；也可显式指定：`{mega_knowledge(关于退款政策的问题)}`。
- 无匹配条目或无可用问题时变量渲染为空字符串，不阻塞对话。
- 同一请求内（会话+问题相同）60 秒去重，避免同模板多次渲染导致双重检索；检索失败有 30 秒负缓存，知识模型故障不会拖慢每条消息。
- 与工具路径共享同一粘性会话（键=会话+条目名），缓存命中互相受益。
- 主插件与伪装插件（chatluna-character）的预设都经由 chatluna 共享渲染器渲染，变量在两边均可用；工具 likewise 同时注册给两边。
- **伪装插件注意**：请把 `{mega_knowledge}` 写在预设的 **input 模板**里——伪装插件渲染 system 模板时不携带本轮用户输入（变量会渲染为空），input 模板才有（`prompt` = 触发消息原文）。主插件任意消息位均可。另：伪装插件里工具路径与变量路径的粘性会话键不同（前缀字节相同、缓存不受影响，但轮次历史不互通）。

## 缓存保活（keep-alive）

上游模型（如 DeepSeek）的提示缓存在空闲一段时间后可能失效。在 `cacheKeepAliveEntries`（table 外观数组）中填入知识条目名称后，本插件按 `cacheKeepAliveInterval`（分钟，默认 30）定期发送**最小化探测请求**维持缓存：

- 对条目**基础前缀**（系统提示词+完整文档）发一次探测——惠及将来新建的会话；
- 对该条目**每个粘性会话**重放其精确字节前缀+已积累轮次——保证长会话缓存不冷；
- 探测问题为「请只回复：OK」并限制 `maxTokens=16`，回复直接丢弃：**不写入会话历史、不刷新会话 TTL**，对会话完全透明；
- 输入侧命中缓存按缓存价计费，输出仅数个 token，成本最小化；
- 跳过探测间隔内有真实访问的会话（缓存仍是热的）。

## 工作原理

1. 模型在回答需要领域知识时调用 `mega_knowledge` 工具，传入 `question`（可选 `knowledgeName`）。
2. 插件从工具运行上下文读取 `agentContext.conversationId / preset / session.{platform,selfId,guildId,channelId,userId}`，按元数据选择器过滤出最具体的生效条目。
3. 读取（本地文件或远程 URL）/渲染文档与提示词，组装 `[SystemMessage(稳定前缀), ...历史轮次, HumanMessage(question)]`。
4. 调用 `knowledgeModel`（默认 `deepseek/deepseek-v4-flash`），把答案返回给模型，并把本轮 Q&A 追加到粘性会话。
5. 稳定前缀与历史轮次字节不变 → 上游模型上下文缓存命中。

## 许可证

MIT
