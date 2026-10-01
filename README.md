# YouTube AI 双语字幕（Loon 插件）

在 iPhone / iPad 的 YouTube App 里，用 Gemini 把字幕翻成双语：一行原文，一行译文。

- 打开字幕后约 6 秒内尽量多翻，十几分钟以内的视频通常一次翻完
- 长视频第一次只能翻开头一部分，没翻到的行先显示原文；关掉再打开字幕，会接着翻剩下的部分
- 翻好的结果会缓存，同一个视频再看不用重新翻
- 只需要自己的 Gemini API Key，不需要部署任何服务

## 安装

1. [一键导入 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fbaitao24%2Floon-youtube-ai-translator%2Fmain%2Fdist%2FYouTube.AI.Translate.remote.plugin)，或手动添加订阅地址：
   `https://raw.githubusercontent.com/baitao24/loon-youtube-ai-translator/main/dist/YouTube.AI.Translate.remote.plugin`
2. 确认 Loon 已开启 MITM 并信任证书。
3. 在插件设置里填写 Gemini API Key（在 [Google AI Studio](https://aistudio.google.com/apikey) 创建）。
4. 关闭其他会处理 YouTube 字幕的插件（官方 DualSubs、旧版翻译插件等），否则会重复处理同一条字幕请求。去广告插件可以保留。

## 设置项

| 设置 | 说明 |
| --- | --- |
| AI 翻译 | 总开关。关闭后只显示 YouTube 原文字幕 |
| Gemini API Key | 只保存在本机 Loon 里。建议在 Google 后台设置用量上限 |
| 模型 | 默认 `gemini-3.5-flash-lite`，真机实测最快。不带 lite 的模型更细致但更慢，长视频第一次能翻到的比例会变少 |
| 翻译成 | 简体中文、繁體中文、日本語、한국어、English。在 YouTube 字幕菜单里选了「自动翻译」成某种语言时，以菜单为准 |
| 字幕顺序 | 原文在上 / 译文在上 |
| 只显示译文 | 开启后不显示原文 |
| 自动打开字幕 | 打开视频时自动开启字幕 |
| 额外翻译要求 | 例如“人名保留英文”“科技术语按业内习惯翻译” |
| 日志等级 | 排查问题时用；日志不记录 API Key 和字幕全文 |

## 工作原理

YouTube App 开字幕时会一次性请求整份字幕（`/api/timedtext`）。插件在 Loon 里拦截这份字幕，交给 Gemini 翻译，再改写成双语返回给 App。

几个关键限制，都是真机实测得到的（2026-10）：

| 实测项 | 结果 | 插件的做法 |
| --- | --- | --- |
| YouTube App 等字幕的上限 | 7 秒能显示，8 秒报错 | 最多用 6.2 秒，到点就带着已翻好的部分返回 |
| Gemini 3.5 Flash-Lite 速度 | 30 条一批约 2.5～3 秒 | 每批 30 条，按时间顺序翻，开头最先翻好 |
| Loon 同时在途的请求数 | 约 8 个，再多会排队 | 并发 8 |
| 模型偶尔少返回一行 | 约每 20 批 1 次 | 按行校验，缺的行显示原文，其余照用 |
| YouTube 官方机翻（`tlang` 参数） | 一律返回 429 拦截页 | 不再请求官方机翻，并去掉 App 自带的 `tlang` |

按这个速度，一次开字幕大约能翻 400～500 条，相当于视频开头 15～20 分钟。

每批还会附带前两行原文作为上下文，避免一句话被切在两批之间时译得生硬。

播放器层（解锁字幕轨、自动打开字幕）直接加载 [DualSubs/YouTube](https://github.com/DualSubs/YouTube) v1.5.11 的官方发布脚本。

## 常见问题

**怎么确认是 AI 翻的？**
插件不再使用任何机器翻译。屏幕上出现的译文都来自 Gemini；没翻到的行只显示原文。

**长视频后半段只有英文？**
第一次开字幕的时间只够翻开头一部分。关掉字幕再打开，插件会只翻剩下的行，通常两三次就能翻完，之后直接用缓存。

**字幕显示 error loading？**
先确认 MITM 证书已信任、没有其他字幕插件同时启用。然后在 Loon 的脚本日志里找「AI 字幕响应」，把日志截图用于排查。

**日志怎么看？**
「AI 字幕响应」的日志里有一行类似：

```
AI rows 448/1422 (31%), new 448, failed batches 0, 5711ms
```

依次是已翻行数 / 总行数、本次新翻的行数、失败的批次数、耗时。有失败批次时，行尾会附上第一个失败原因。

响应头 `x-dualsubs-ai-result` 标明结果：

| 值 | 含义 |
| --- | --- |
| `ai` | 全部由 AI 翻译 |
| `ai-partial` | 部分由 AI 翻译，其余显示原文 |
| `cache-ai` | 命中缓存 |
| `source-only` | AI 未启用、未配置或失败，只显示原文 |
| `upstream-error` | YouTube 本身返回了错误，原样放行 |
| `skipped` | 不是插件处理的请求 |

## 隐私

字幕文本会直接发给 Google Gemini 翻译。本项目没有中转服务器、账号系统或遥测。

翻译结果缓存在 Loon 本机（`$persistentStore`），缓存里不包含 API Key。Loon 插件的输入框不是系统钥匙串，建议使用设了用量上限、可随时撤销的 API Key。

## 诊断工具

[`diag` 分支](https://github.com/baitao24/loon-youtube-ai-translator/tree/diag/diag)里有一个临时诊断插件，可以测 YouTube 等待字幕的上限和 Gemini 从手机调用的速度。上面的实测数据就是用它测的。它会故意延迟字幕，测完要关闭。

## 开发

```bash
npm run verify
```

会构建 `dist/`、做语法检查并运行全部测试。自动测试不能替代真机验收，改动发布前要在 iPhone 上用真实视频确认字幕画面和 Loon 日志。

构建测试分支时，让远程插件指向该分支的脚本：

```bash
npm run build -- --script-url "https://raw.githubusercontent.com/baitao24/loon-youtube-ai-translator/<分支>/dist/dualsubs-ai.bundle.js"
```

## 许可证

本项目采用 MIT License。播放器适配加载的 DualSubs 脚本采用 Apache License 2.0，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
