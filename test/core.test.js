const assert = require("node:assert/strict");
const test = require("node:test");

const Core = require("../src/yt-ai-core.js");

function sampleBody() {
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

test("normalizes Loon arguments without exposing or changing the key", () => {
  const config = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    api_key: "secret-value",
    model: "deepseek-chat",
    auto_translate: "false",
    position: "SourceFirst",
    concurrency: "9"
  });
  assert.equal(config.provider, "OpenAI-Compatible");
  assert.equal(config.apiKey, "secret-value");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.autoTranslate, false);
  assert.equal(config.position, "SourceFirst");
  assert.equal(config.concurrency, 4);
  assert.equal(config.maxWaitMs, 6500);
  assert.equal(config.thinkingLevel, "minimal");
});

test("migrates only the old Gemini timeout default to six seconds", () => {
  const gemini = Core.normalizeConfig({ provider: "Gemini", timeout_ms: "5000" });
  const openai = Core.normalizeConfig({
    provider: "OpenAI-Compatible",
    timeout_ms: "5000"
  });
  const customGemini = Core.normalizeConfig({ provider: "Gemini", timeout_ms: "4000" });
  assert.equal(gemini.timeoutMs, 6000);
  assert.equal(openai.timeoutMs, 5000);
  assert.equal(customGemini.timeoutMs, 4000);
});

test("rewrites YouTube auto-translation without changing the requested subtitle format", () => {
  const config = Core.normalizeConfig({
    provider: "Gemini",
    api_key: "key",
    model: "gemini-test",
    target_language: "zh-Hans"
  });
  const input =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&fmt=srv3";
  const result = Core.rewriteTimedTextRequest(input, config);
  const url = new URL(result.url);
  assert.equal(result.changed, true);
  assert.equal(url.searchParams.has("tlang"), false);
  assert.equal(url.searchParams.get("fmt"), "srv3");
  assert.equal(url.searchParams.get("ytai"), "1");
  assert.equal(url.searchParams.get("ytai_tlang"), "zh-Hant");
});

test("manual-only mode leaves a plain source request untouched", () => {
  const config = Core.normalizeConfig({
    provider: "Gemini",
    api_key: "key",
    model: "gemini-test",
    auto_translate: false
  });
  const input = "https://www.youtube.com/api/timedtext?v=abc&lang=en";
  const result = Core.rewriteTimedTextRequest(input, config);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "manual-only");
  assert.equal(result.url, input);
});

test("missing API configuration never removes YouTube's own tlang fallback", () => {
  const config = Core.normalizeConfig({ provider: "Gemini", api_key: "", model: "x" });
  const input = "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans";
  const result = Core.rewriteTimedTextRequest(input, config);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "missing-config");
  assert.equal(new URL(result.url).searchParams.get("tlang"), "zh-Hans");
});

test("extracts complete JSON3 cue text and chunks deterministically", () => {
  const cues = Core.extractCues(sampleBody());
  assert.deepEqual(cues, [
    { id: 0, eventIndex: 0, text: "Hello world" },
    { id: 1, eventIndex: 1, text: "How are you?" }
  ]);
  assert.deepEqual(
    Core.chunkCues(cues, 1, 999).map((chunk) => chunk.map((cue) => cue.id)),
    [[0], [1]]
  );
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

test("builds native Gemini generateContent request with response schema", () => {
  assert.equal(Core.normalizeConfig({}).model, "gemini-3.6-flash");
  const config = Core.normalizeConfig({
    provider: "Gemini",
    api_key: "gemini-secret",
    model: "gemini-model"
  });
  const request = Core.createGeminiRequest(
    config,
    [{ id: 7, text: "Hello" }],
    { source: "en", target: "zh-Hans" },
    false
  );
  const body = JSON.parse(request.body);
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-model:generateContent"
  );
  assert.equal(request.headers["x-goog-api-key"], "gemini-secret");
  assert.equal(request.body.includes("gemini-secret"), false);
  assert.equal(body.generationConfig.temperature, undefined);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(body.generationConfig.responseFormat.text.mimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ["translations"]);
  const legacyBody = JSON.parse(
    Core.createGeminiRequest(
      config,
      [{ id: 7, text: "Hello" }],
      { source: "en", target: "zh-Hans" },
      true
    ).body
  );
  assert.equal(legacyBody.generationConfig.responseMimeType, "application/json");
  assert.equal(legacyBody.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.deepEqual(legacyBody.generationConfig.responseSchema.required, ["translations"]);
  assert.throws(
    () =>
      Core.createGeminiRequest(
        { ...config, geminiBaseUrl: "http://insecure.example/v1beta" },
        [{ id: 7, text: "Hello" }],
        { source: "en", target: "zh-Hans" },
        false
      ),
    /must use HTTPS/
  );
});

test("parses and validates OpenAI and Gemini structured responses", () => {
  const batch = [
    { id: 0, text: "Hello" },
    { id: 1, text: "World" }
  ];
  const payload = { translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }] };
  const openAI = Core.parseOpenAIResponse({
    choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } }]
  });
  const gemini = Core.parseGeminiResponse({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: "internal reasoning that is not JSON" },
          { text: JSON.stringify(payload) }
        ]
      }
    }]
  });
  assert.deepEqual(Core.validateTranslations(openAI, batch), payload.translations);
  assert.deepEqual(Core.validateTranslations(gemini, batch), payload.translations);
  assert.deepEqual(
    Core.validateTranslations(
      { translations: [payload.translations[1], payload.translations[0]] },
      batch
    ),
    payload.translations
  );
  assert.throws(
    () => Core.validateTranslations({ translations: [{ id: 1, text: "错位" }] }, [batch[0]]),
    /Missing translation id/
  );
  assert.throws(
    () =>
      Core.validateTranslations(
        { translations: [{ id: 0, text: "很".repeat(241) }] },
        [batch[0]]
      ),
    /unexpectedly long/
  );
});

test("merges bilingual text without changing timing or unrelated fields", () => {
  const body = sampleBody();
  const beforeTimes = body.events.map((event) => [event.tStartMs, event.dDurationMs]);
  const cues = Core.extractCues(body);
  Core.mergeTranslations(
    body,
    cues,
    [{ id: 0, text: "你好世界" }, { id: 1, text: "你好吗？" }],
    Core.normalizeConfig({ position: "TranslationFirst" })
  );
  assert.deepEqual(
    body.events.map((event) => [event.tStartMs, event.dDurationMs]),
    beforeTimes
  );
  assert.equal(body.events[0].segs[0].utf8, "你好世界\nHello world");
  assert.equal(body.events[0].wWinId, undefined);
  assert.equal(body.wireMagic, "pb3");
});

test("extracts and merges srv3 XML while preserving paragraph timing", () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><pen id="0"/></head>' +
    '<body><p t="10" d="20"><s>Hello &amp; </s><s>world</s></p>' +
    '<p t="30" d="40">How are you?</p><p t="70" d="10">&#8203;</p></body></timedtext>';
  const cues = Core.extractSrv3Cues(xml);
  assert.deepEqual(cues, [
    { id: 0, paragraphIndex: 0, text: "Hello & world" },
    { id: 1, paragraphIndex: 1, text: "How are you?" }
  ]);
  const merged = Core.mergeSrv3Translations(
    xml,
    cues,
    [{ id: 0, text: "你好，世界" }, { id: 1, text: "你好吗？" }],
    Core.normalizeConfig({ position: "TranslationFirst" })
  );
  assert.match(merged, /<p t="10" d="20"><s>你好，世界&#10;Hello &amp; world<\/s><\/p>/);
  assert.match(merged, /<p t="30" d="40"><s>你好吗？&#10;How are you\?<\/s><\/p>/);
  assert.match(merged, /<p t="70" d="10">&#8203;<\/p>/);
  assert.equal((merged.match(/<p\b/g) || []).length, 3);
});

test("cache key changes with model, target, prompt, or subtitle text", () => {
  const url = "https://www.youtube.com/api/timedtext?v=abc&lang=en&ytai=1";
  const cues = [{ id: 0, eventIndex: 0, text: "Hello" }];
  const languages = { source: "en", target: "zh-Hans" };
  const first = Core.makeCacheKey(
    url,
    Core.normalizeConfig({ model: "a" }),
    cues,
    languages
  );
  const second = Core.makeCacheKey(
    url,
    Core.normalizeConfig({ model: "b" }),
    cues,
    languages
  );
  assert.notEqual(first, second);
});
