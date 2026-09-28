# English Agent（本地首版）

单用户英语对话网页：多对话、逐对话难度和主动纠错、AI 回复划词释义与整句翻译、逐 AI 消息语法追问、两套独立模型设置、SQLite 本地记录与原生 Responses Compaction。

## 启动

需要 Node.js 24+ 和 npm。仓库中不含 API Key。克隆后运行：

```bash
npm ci
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。Vite 开发服务器代理 `/api` 到本地后端 `127.0.0.1:3001`。生产构建及单服务启动：

```bash
npm run build
npm start
```

打开 `http://127.0.0.1:3001`。两种服务都只监听 `127.0.0.1`。运行 `npm test` 执行使用 mock 服务的测试。可用 `PORT`、`DATA_DIR`、`COMPACT_THRESHOLD_TOKENS` 环境变量调整后端端口、数据目录和压缩阈值；示例见 `.env.example`。该项目不自动加载 `.env`，需由 shell 或进程管理器设置环境变量。

### Linux 服务器分支

在 Linux 服务器上，克隆 `linux` 分支并运行 `npm run linux`。首次运行生成网页访问密码并存入本机私有文件；后端只监听 `127.0.0.1`。要通过其他设备的域名或 IP 访问，用 Caddy 提供 HTTPS 并反向代理到后端。此入口默认把数据库和登录密码放在 `${XDG_DATA_HOME:-$HOME/.local/share}/english-agent/`；详见 [Linux 服务器部署](docs/LINUX.md)。当前临时执行环境不能提供外部可访问地址。

## 首次设置和使用

在“模型设置”分别保存主模型和辅助模型的 Base URL、Model ID、API Key。Base URL 可填服务根地址或带 `/v1` 的地址，程序拼接 `/v1/responses` 和 `/v1/responses/compact`。两套配置可指向同一服务。“测试连接”对辅助模型调用 Responses；对主模型依次调用 Responses 和原生 compact，可能产生少量服务用量。保存后只返回是否有 Key，不返回明文；留空新 Key 会保留旧 Key，也可勾选清除。

点击“新对话”，选择自由聊天、日常闲聊、咖啡馆/餐厅点餐、旅行、购物、工作交流，或输入自定义情景。每个对话的情景、难度和纠错挡位可以在顶部随时调整。按 Enter 发送，Shift+Enter 换行。回复与其下方纠错卡分开。选中 AI 回复中的词语即请求中文释义；选中完整句子即请求整句翻译，并可输入语法问题。“追问语法”发送问题时才创建对应消息的辅助线程。若主模型请求失败，用户消息保留，可点击“重试上一条”。

## 数据和实现取舍

- 数据库默认为 `./data/english-agent.db`，含完整 transcript、逐对话模型窗口、辅助线程和两套配置。`data/` 被 Git 忽略。数据库文件创建为仅当前用户可读写；请保护本机账户和备份。前端不使用浏览器持久存储保存 Key。日志不输出请求体或密钥。
- 主对话使用 `POST /v1/responses` 的无状态输入数组（`store:false`）。模型要求返回 `reply` 与 `corrections` JSON，前者显示自然回复，后者另作纠错卡；若模型不遵循格式，界面给出错误并保留待重试的用户消息。关闭纠错时服务端会清空任何意外返回的纠错项。
- 模型窗口在每次成功回复后存储本轮 input 与 Responses 的原始 `output`。达到 `COMPACT_THRESHOLD_TOKENS` 时，先调用独立的 `POST /v1/responses/compact`，原样存储其整个 `output`，再追加新用户消息用于下一次 Responses 请求；完整 transcript 不会被压缩。默认阈值 12000 是按序列化字符数 `/4` 的粗略估计，不是提供方精确 token 计数。可按所选模型上下文限制调节；压缩请求本身也必须在模型窗口范围内。模型配置变更时，机器窗口从完整本地消息重建，旧的加密压缩状态不会发给新配置。
- 压缩窗口续接遵循 [OpenAI 的 Compaction 指南](https://developers.openai.com/api/docs/guides/compaction)：返回的整个 `output` 是下一次请求的规范输入，不能只提取其中的压缩条目。
- 静态基本指令保持稳定前缀；情景、难度、纠错规则随对话设置在后面变化。辅助模型仅收到选中内容、完整句子、最多附近三条对话片段，以及同一句已发生的辅助追问，不收到完整主对话。只有提供方的 `usage.input_tokens_details.cached_tokens` 实际返回时才显示缓存 token，不估计费用。
- 设置连接测试会实际发请求。提供方若不支持 Responses 或 compact，错误会明确指出端点；不会改用 Chat Completions 或提示词摘要。鉴权、网络超时、端点和模型请求错误分别显示；出于避免泄漏的考虑，不回显提供方的原始错误响应。

## 已知兼容性限制

候选中转站 `xindu.xyz` 的 Responses 和 `/responses/compact` 兼容性尚未实测成功；先前短请求没有收到 HTTP 响应，第三方检测仅涉及 Chat Completions。此仓库的验证使用 mock，不声称该站支持这些端点。不同中转站可能缺少原生 compact、拒绝 `store:false`、不返回标准 `output` 或不遵循 JSON 指令；界面会报告对应失败。句子划选按 `. ! ?` 和换行分割，复杂标点可能需重新选择。当前纯文字、单用户、仅本机使用，不包括同步、账户和语音。
