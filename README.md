# DualSubs AI 双语字幕（Loon）

这是一个基于 DualSubs 稳定 YouTube 适配层的 AI 增强插件。

它不会把 AI 当成字幕显示的唯一条件：

1. DualSubs 先解锁 YouTube 字幕轨和自动翻译语言。
2. YouTube 返回官方译文，作为始终可用的安全底座。
3. 插件获取同一视频的原文字幕，并尝试 Gemini 或 OpenAI-Compatible 翻译。
4. AI 按时完成时显示“原文 + AI 译文”。
5. AI 超时、限流、输出错位或配置缺失时显示“原文 + YouTube 官方译文”。
6. 原文获取也失败时至少保留 YouTube 官方译文，不返回空白字幕。

## 支持范围

- YouTube iOS/iPadOS/macOS 客户端中已有的人工字幕或自动字幕
- JSON3 与 srv3/XML 字幕格式
- Gemini 原生 `generateContent`
- OpenAI-Compatible `chat/completions`
- 自定义 API Key、Base URL、模型、目标语言、提示词
- AI/官方译文在上或原文在上
- 成功结果缓存，以及 AI 失败后的短时官方兜底缓存

暂不包含：

- 无字幕视频的语音识别
- YouTube Music 歌词 AI 翻译
- tvOS YouTube App
- 向 YouTube App 内注入模型选择按钮

模型和密钥均在 Loon 插件设置中填写。

## 与旧版的关键差异

旧版直接拦截原字幕并等待 AI。AI 未在 YouTube 的短等待窗口内完成时，只能返回原文，甚至可能让客户端显示字幕加载失败。

`0.3.1` 改为 DualSubs Official 基线：

- 不删除 `tlang`
- 不强制把 srv3 改成 JSON3
- 不等待 AI 才决定是否有字幕
- AI 失败时仍然得到官方双语字幕
- 复用 DualSubs v1.5.11 的播放器 JSON/Protobuf 适配

## 安装产物

### 在线安装

- [一键导入 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fbaitao24%2Floon-youtube-ai-translator%2Fmain%2Fdist%2FYouTube.AI.Translate.remote.plugin)
- [远程插件订阅地址](https://raw.githubusercontent.com/baitao24/loon-youtube-ai-translator/main/dist/YouTube.AI.Translate.remote.plugin)

`0.2.x` 使用的订阅文件名和脚本文件名继续保留，因此已有用户刷新原资源即可升级；无需删除后重新导入，也更有机会保留 Loon 已保存的参数。API Key 不会包含在订阅中。

### 本地构建

```bash
npm run verify
```

生成：

- `dist/dualsubs-ai.bundle.js`
- `dist/DualSubs.AI.YouTube.local.plugin`
- `dist/DualSubs.AI.YouTube.remote.plugin`
- `dist/manifest.json`

同时生成旧版兼容路径：

- `dist/yt-ai.bundle.js`
- `dist/YouTube.AI.Translate.local.plugin`
- `dist/YouTube.AI.Translate.remote.plugin`

如需让远程插件改用其他脚本地址：

```bash
npm run build -- --script-url "https://example.com/dualsubs-ai.bundle.js"
```

不要同时启用官方 DualSubs YouTube 插件或旧的 YouTube AI 插件，因为它们会重复处理同一条 `timedtext` 请求。YouTube 去广告插件可以保留，但应关闭其中的字幕翻译功能，并按 DualSubs 文档把去广告插件置于本插件上方。

## Loon 设置

主要选项：

- `启用 AI 增强`：关闭后仍然使用 DualSubs 官方双语字幕。
- `AI 服务商`：Gemini 或 OpenAI-Compatible。
- `API Key`：只保存在 Loon 本机参数中。
- `模型名称`：默认 `gemini-3.6-flash`；更重视速度可选择 `gemini-3.5-flash-lite`。
- `默认目标语言`：默认 `zh-Hans`，YouTube 自动翻译菜单所选语言优先。
- `字幕顺序`：`Reverse` 为译文在上，`Forward` 为原文在上。
- `每批字幕条数`：默认 250，配合四路并发，让约千条字幕尽量在一轮请求内完成。
- `字幕最大等待`：默认 6200 毫秒；达到期限立即使用官方双语字幕。

Gemini 3.x 默认使用 `minimal` 思考等级，并采用 `responseMimeType` + `responseSchema`。请求不携带已弃用的 `temperature`、`top_p`、`top_k`。

OpenAI-Compatible 默认使用 JSON Mode；服务商返回 400、404 或 422 时，会在剩余时限内去掉 `response_format` 重试一次。

## 结果判断

Loon 请求记录中的响应头会标明路径：

- `x-dualsubs-ai-result: ai`：AI 双语字幕
- `x-dualsubs-ai-result: cache-ai`：AI 缓存
- `x-dualsubs-ai-result: official`：AI 未启用或配置缺失，使用官方双语
- `x-dualsubs-ai-result: official-fallback`：AI 失败或超时，使用官方双语
- `x-dualsubs-ai-result: official-only`：原字幕获取失败，仅保留官方译文

错误头会脱敏，不包含 API Key 或字幕正文。

## 缓存与隐私

字幕正文会直接发送到你选择的模型服务商。本项目没有中转服务器、账号系统或遥测。

最终字幕缓存保存在 Loon `$persistentStore`，缓存身份包含视频、语言、模型、提示词、字幕顺序及官方响应摘要，但不包含 API Key。AI 成功结果默认缓存一天；AI 失败的官方兜底只缓存 30 秒，避免持续超时又不会永久阻止后续 AI 重试。

Loon 插件的 `input` 不是系统钥匙串。建议使用带额度和来源限制、可随时撤销的 API Key。

## 开发验证

```bash
npm run verify
```

验证覆盖：

- DualSubs Official 请求准备及格式保持
- JSON3 与 srv3 原文/官方译文对齐
- Gemini 与 OpenAI-Compatible 请求和结构化响应
- AI 成功、配置缺失、API 失败、原文获取失败
- 官方双语兜底永不为空
- 最终字幕缓存
- 962 条字幕的一轮四请求分批策略
- 构建产物哈希、上游版本固定和敏感值扫描

自动测试不能替代 iPhone 真机验收。发布前必须在真实 YouTube 视频上确认请求头、字幕画面、耗时、缓存和超时回退。

## 上游与许可证

- [DualSubs/YouTube](https://github.com/DualSubs/YouTube)，固定 `v1.5.11`
- [DualSubs/Universal](https://github.com/DualSubs/Universal)，对齐和双语合成参考 `v1.7.5`

DualSubs 采用 Apache License 2.0。本项目保留上游归属和许可证说明，详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
