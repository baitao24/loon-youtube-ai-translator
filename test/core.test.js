const assert = require("node:assert/strict");
const test = require("node:test");

const Core = require("../src/yt-ai-core.js");

function sourceJson3() {
  return {
    wireMagic: "pb3",
    events: [
      {
        tStartMs: 100,
        dDurationMs: 900,
        wWinId: 1,
        segs: [{ utf8: "Hello " }, { utf8: "world" }]
      },
      { tStartMs: 1000, dDurationMs: 800, segs: [{ utf8: "How are you?" }] },
      { tStartMs: 1800, dDurationMs: 200, segs: [{ utf8: "\u200b" }] }
    ]
  };
}

function translatedJson3() {
  return {
    events: [
      { tStartMs: 102, dDurationMs: 900, segs: [{ utf8: "你好世界" }] },
      { tStartMs: 1003, dDurationMs: 800, segs: [{ utf8: "你好吗？" }] }
    ]
  };
}

test("normalizes DualSubs AI settings and keeps secrets opaque", () => {
  const config = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    api_key: "secret-value",
    model: "deepseek-chat",
    auto_translate: "false",
    Position: "Forward",
    ai_enabled: "true",
    concurrency: "20"
  });
  assert.equal(Core.VERSION, "0.6.0");
  assert.equal(config.provider, "OpenAI-Compatible");
  assert.equal(config.apiKey, "secret-value");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.autoTranslate, false);
  assert.equal(config.position, "SourceFirst");
  assert.equal(config.aiEnabled, true);
  assert.equal(config.concurrency, 12);
  assert.equal(config.maxWaitMs, 6200);
  assert.equal(config.originalFetchTimeoutMs, 1400);
});

test("rewrites timedtext to the source track and never keeps tlang", () => {
  const config = Core.normalizeConfig({ api_key: "k", model: "m", target_language: "zh-Hans" });
  const explicit = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3",
    config
  );
  const url = new URL(explicit.url);
  assert.equal(explicit.changed, true);
  assert.equal(url.searchParams.has("tlang"), false);
  assert.equal(url.searchParams.get("dsai"), "1");
  assert.equal(url.searchParams.get("dsai_target"), "zh-Hant");
  assert.equal(url.searchParams.get("format"), "srv3");
  assert.deepEqual(Core.responseLanguages(explicit.url, config), { source: "en", target: "zh-Hant" });

  const manual = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3",
    Core.normalizeConfig({ api_key: "k", model: "m", auto_translate: false })
  );
  assert.equal(manual.changed, false);
  assert.equal(manual.reason, "manual-only");

  const unconfigured = Core.rewriteTimedTextRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans",
    Core.normalizeConfig({ api_key: "" })
  );
  assert.equal(new URL(unconfigured.url).searchParams.has("tlang"), false);
  assert.equal(unconfigured.reason, "missing-config");
});

test("extracts timed JSON3 cues and chunks deterministically", () => {
  const cues = Core.extractCues(sourceJson3());
  assert.deepEqual(cues, [
    {
      id: 0,
      eventIndex: 0,
      startMs: 100,
      durationMs: 900,
      text: "Hello world"
    },
    {
      id: 1,
      eventIndex: 1,
      startMs: 1000,
      durationMs: 800,
      text: "How are you?"
    }
  ]);
  assert.deepEqual(
    Core.chunkCues(cues, 1, 999).map((chunk) => chunk.map((cue) => cue.id)),
    [[0], [1]]
  );
});

test("default batching uses small batches so the first wave returns within the subtitle deadline", () => {
  // 真机：30 条一批约 2.5～3 秒，Loon 同时约 8 个请求在途；YouTube 等字幕约 7 秒。
  const cues = Array.from({ length: 962 }, (_, id) => ({
    id,
    eventIndex: id,
    startMs: id * 1000,
    durationMs: 900,
    text: `Subtitle row ${id}`
  }));
  const config = Core.normalizeConfig({});
  const chunks = Core.chunkCues(cues, config.maxBatchItems, config.maxBatchChars);
  assert.equal(config.maxBatchItems, 30);
  assert.equal(config.concurrency, 8);
  assert.equal(chunks.length, 33);
  assert.ok(chunks.every((chunk) => chunk.length <= 30));
  assert.deepEqual(chunks[0].map((cue) => cue.id).slice(0, 3), [0, 1, 2], "按时间顺序，开头先翻");
  assert.equal(chunks.flat().length, 962);
});

test("salvages usable rows from a batch that drops or duplicates a line", () => {
  const batch = [0, 1, 2, 3].map((id) => ({ id, text: `line ${id}` }));
  const rows = Core.salvageTranslations(
    { translations: [{ id: 0, text: "零" }, { id: 1, text: "一" }, { id: 1, text: "壹" }, { id: 3, text: "三" }] },
    batch
  );
  assert.deepEqual(rows.map((row) => [row.id, row.text]), [[0, "零"], [3, "三"]]);
  assert.throws(() => Core.salvageTranslations({ translations: [] }, batch), /no usable rows/);
  const merged = Core.mergeTranslationRows(
    [{ id: 0, text: "官0" }, { id: 1, text: "官1" }, { id: 2, text: "官2" }],
    rows
  );
  assert.deepEqual(merged.map((row) => row.text), ["零", "官1", "官2", "三"]);
});

test("builds OpenAI-compatible request with JSON mode and header-only key", () => {
  const config = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    api_key: "openai-secret",
    model: "model-a",
    base_url: "https://example.com/v1"
  });
  const request = Core.createOpenAIRequest(
    config,
    [{ id: 0, text: "Hello" }],
    { source: "en", target: "zh-Hans" },
    true
  );
  const body = JSON.parse(request.body);
  assert.equal(request.url, "https://example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer openai-secret");
  assert.equal(request.body.includes("openai-secret"), false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /untrusted data/);
  assert.throws(
    () =>
      Core.createOpenAIRequest(
        { ...config, baseUrl: "http://insecure.example/v1" },
        [{ id: 0, text: "Hello" }],
        { source: "en", target: "zh-Hans" },
        true
      ),
    /must use HTTPS/
  );
});

test("builds current Gemini generateContent request with structured output", () => {
  assert.equal(Core.normalizeConfig({}).model, "gemini-3.5-flash-lite");
  const config = Core.normalizeConfig({
    provider: "Gemini",
    api_key: "gemini-secret",
    model: "gemini-3.6-flash"
  });
  const request = Core.createGeminiRequest(
    config,
    [{ id: 7, text: "Hello" }],
    { source: "en", target: "zh-Hans" },
    true
  );
  const body = JSON.parse(request.body);
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
  );
  assert.equal(request.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(request.body.includes("gemini-secret"), false);
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseSchema.required, ["translations"]);
});

test("parses thought-aware model responses and rejects misaligned output", () => {
  const batch = [
    { id: 0, text: "Hello" },
    { id: 1, text: "World" }
  ];
  const payload = {
    translations: [
      { id: 0, text: "你好" },
      { id: 1, text: "世界" }
    ]
  };
  const gemini = Core.parseGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "not JSON" },
            { text: JSON.stringify(payload) }
          ]
        }
      }
    ]
  });
  assert.deepEqual(Core.validateTranslations(gemini, batch), payload.translations);
  assert.throws(
    () =>
      Core.validateTranslations(
        { translations: [{ id: 1, text: "错位" }] },
        [batch[0]]
      ),
    /Missing translation id/
  );
});

test("renders AI bilingual JSON3 without changing source timing", () => {
  const source = Core.parseSubtitleDocument(
    JSON.stringify(sourceJson3()),
    "application/json"
  );
  const rendered = JSON.parse(
    Core.renderSubtitleDocument(
      source,
      [
        { id: 0, text: "你好世界" },
        { id: 1, text: "你好吗？" }
      ],
      Core.normalizeConfig({ Position: "Reverse" })
    )
  );
  assert.equal(rendered.events[0].segs[0].utf8, "你好世界\nHello world");
  assert.equal(rendered.events[1].segs[0].utf8, "你好吗？\nHow are you?");
  assert.equal(rendered.events[0].tStartMs, 100);
  assert.equal(rendered.events[0].dDurationMs, 900);
  assert.equal(rendered.events[0].wWinId, undefined);
});

test("response cache identity changes with official content or AI settings", () => {
  const url =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans&subtype=Official";
  const first = Core.makeResponseCacheKey(
    url,
    "official-a",
    Core.normalizeConfig({ model: "a" })
  );
  const second = Core.makeResponseCacheKey(
    url,
    "official-b",
    Core.normalizeConfig({ model: "a" })
  );
  const third = Core.makeResponseCacheKey(
    url,
    "official-a",
    Core.normalizeConfig({ model: "b" })
  );
  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test("each language is rendered on exactly one line", () => {
  const forward = { position: "SourceFirst", showOnly: false };
  assert.equal(
    Core.combineText(
      "only 10-15% of the total cost of\nownership of a data center is energy.",
      "数据中心总拥有成本中，\n只有10%到15%是能源开销。",
      forward
    ),
    "only 10-15% of the total cost of ownership of a data center is energy.\n数据中心总拥有成本中，只有10%到15%是能源开销。"
  );
  assert.equal(
    Core.combineText("a\nb", "甲\n乙", { position: "TranslationFirst", showOnly: false }),
    "甲乙\na b"
  );
  assert.equal(Core.combineText("a\nb", "Hola\nmundo", { showOnly: true }), "Hola mundo");
  assert.match(Core.buildPrompts([{ id: 0, text: "x" }], "en", "zh-Hans", "").system, /single line/);
});

test("plugin dropdown labels map to config values", () => {
  const config = Core.normalizeConfig({ target_language: "繁體中文", Position: "原文在上" });
  assert.equal(config.targetLanguage, "zh-Hant");
  assert.equal(config.position, "SourceFirst");
  assert.equal(Core.normalizeConfig({ Position: "译文在上" }).position, "TranslationFirst");
  assert.equal(Core.normalizeConfig({ target_language: "日本語" }).targetLanguage, "ja");
  assert.equal(Core.normalizeConfig({ target_language: "es" }).targetLanguage, "es");
  assert.equal(Core.normalizeConfig({}).provider, "Gemini");
});

test("Gemini request carries context rows and can omit thinkingLevel", () => {
  const batch = [{ id: 5, text: "does, we need to go back" }];
  batch.context = ["For the past 2 months", "To understand what it"];
  const base = Core.normalizeConfig({ api_key: "k", model: "gemini-test" });
  const withThinking = JSON.parse(
    Core.createGeminiRequest(base, batch, { source: "en", target: "zh-Hans" }, true).body
  );
  const user = JSON.parse(withThinking.contents[0].parts[0].text);
  assert.deepEqual(user.context_before, batch.context);
  assert.deepEqual(user.subtitles, [{ id: 5, text: "does, we need to go back" }]);
  assert.match(withThinking.systemInstruction.parts[0].text, /never translate or return it/);
  assert.equal(withThinking.generationConfig.thinkingConfig.thinkingLevel, "minimal");

  const off = JSON.parse(
    Core.createGeminiRequest({ ...base, thinkingLevel: "off" }, [{ id: 0, text: "x" }], { source: "en", target: "zh-Hans" }, true).body
  );
  assert.equal(off.generationConfig.thinkingConfig, undefined);
  assert.equal(JSON.parse(off.contents[0].parts[0].text).context_before, undefined);
});

test("provider and API key follow the selected model", () => {
  const keys = { api_key: "g", deepseek_api_key: "d", openai_api_key: "o", claude_api_key: "c" };
  const cases = [
    ["gemini-3.8-flash", "Gemini", "g"],
    ["deepseek-flash", "DeepSeek", "d"],
    ["gpt-5.4-mini", "OpenAI", "o"],
    ["claude-haiku-4-5", "Claude", "c"]
  ];
  for (const [model, provider, key] of cases) {
    const config = Core.normalizeConfig({ ...keys, model });
    assert.equal(config.provider, provider, model);
    assert.equal(config.apiKey, key, model);
  }
  assert.equal(Core.normalizeConfig({ model: "deepseek-flash" }).baseUrl, "https://api.deepseek.com");
  assert.equal(Core.normalizeConfig({ model: "gpt-5.4-nano" }).baseUrl, "https://api.openai.com/v1");
  // 只填了 Gemini Key 却选了 DeepSeek：视为未配置，不会把 Gemini Key 发给别家
  const mismatched = Core.normalizeConfig({ api_key: "g", model: "deepseek-flash" });
  assert.equal(mismatched.apiKey, "");
  assert.equal(Core.isConfigured(mismatched), false);
});

test("batch size starts by model speed class and adapts unless fixed", () => {
  assert.equal(Core.initialBatchSize("gemini-3.5-flash-lite"), 30);
  assert.equal(Core.initialBatchSize("gpt-5.4-nano"), 30);
  assert.equal(Core.initialBatchSize("claude-haiku-4-5"), 30);
  assert.equal(Core.initialBatchSize("deepseek-flash"), 30);
  assert.equal(Core.initialBatchSize("gemini-3.8-flash"), 15);
  assert.equal(Core.initialBatchSize("deepseek-v4-pro"), 15);
  const adaptive = Core.normalizeConfig({ model: "gemini-3.8-flash" });
  assert.equal(adaptive.adaptiveBatch, true);
  assert.equal(adaptive.maxBatchItems, 15);
  const fixed = Core.normalizeConfig({ model: "gemini-3.8-flash", batch_size: "20" });
  assert.equal(fixed.adaptiveBatch, false);
  assert.equal(fixed.maxBatchItems, 20);
});

test("OpenAI and DeepSeek requests disable reasoning the way each provider expects", () => {
  const batch = [{ id: 0, text: "hello" }];
  const languages = { source: "en", target: "zh-Hans" };
  const openai = Core.createOpenAIRequest(
    Core.normalizeConfig({ model: "gpt-5.4-mini", openai_api_key: "o" }), batch, languages, true
  );
  const openaiBody = JSON.parse(openai.body);
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer o");
  assert.equal(openaiBody.reasoning_effort, "none");
  assert.equal(openaiBody.temperature, undefined, "GPT-5.x 不接受自定义 temperature");
  assert.deepEqual(openaiBody.response_format, { type: "json_object" });

  const deepseek = Core.createOpenAIRequest(
    Core.normalizeConfig({ model: "deepseek-flash", deepseek_api_key: "d" }), batch, languages, true
  );
  const deepseekBody = JSON.parse(deepseek.body);
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(deepseekBody.thinking, { type: "disabled" });
  assert.equal(deepseekBody.reasoning_effort, undefined);
  assert.match(deepseekBody.messages[0].content, /JSON/, "DeepSeek JSON 模式要求提示词里出现 json");
});

test("Claude request uses the Messages API with structured output", () => {
  const batch = [{ id: 3, text: "hello" }];
  batch.context = ["before"];
  const languages = { source: "en", target: "zh-Hans" };
  const haiku = Core.createClaudeRequest(
    Core.normalizeConfig({ model: "claude-haiku-4-5", claude_api_key: "c" }), batch, languages, true
  );
  const body = JSON.parse(haiku.body);
  assert.equal(haiku.url, "https://api.anthropic.com/v1/messages");
  assert.equal(haiku.headers["x-api-key"], "c");
  assert.equal(haiku.headers["anthropic-version"], "2023-06-01");
  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(JSON.parse(body.messages[0].content).context_before, ["before"]);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.output_config.format.schema.properties.translations.items.additionalProperties, false);
  assert.equal(body.output_config.effort, undefined, "Haiku 4.5 不接受 effort");
  assert.equal(body.thinking, undefined);

  const sonnet = JSON.parse(
    Core.createClaudeRequest(Core.normalizeConfig({ model: "claude-sonnet-5-5", claude_api_key: "c" }), batch, languages, false).body
  );
  assert.equal(sonnet.output_config.effort, "low");
  assert.equal(sonnet.output_config.format, undefined);

  const parsed = Core.parseClaudeResponse(
    JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ translations: [{ id: 3, text: "你好" }] }) }]
    })
  );
  assert.deepEqual(parsed.translations, [{ id: 3, text: "你好" }]);
  assert.throws(
    () => Core.parseClaudeResponse(JSON.stringify({ stop_reason: "refusal", content: [] })),
    /declined/
  );
});
