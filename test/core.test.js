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
    concurrency: "9"
  });
  assert.equal(Core.VERSION, "0.3.0");
  assert.equal(config.provider, "OpenAI-Compatible");
  assert.equal(config.apiKey, "secret-value");
  assert.equal(config.model, "deepseek-chat");
  assert.equal(config.autoTranslate, false);
  assert.equal(config.position, "SourceFirst");
  assert.equal(config.aiEnabled, true);
  assert.equal(config.concurrency, 4);
  assert.equal(config.maxWaitMs, 6200);
  assert.equal(config.originalFetchTimeoutMs, 1400);
});

test("prepares an Official DualSubs baseline without changing subtitle format", () => {
  const config = Core.normalizeConfig({
    api_key: "",
    target_language: "zh-Hans"
  });
  const input =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3";
  const prepared = Core.prepareDualSubsRequest(input, config);
  const url = new URL(prepared.url);
  assert.equal(prepared.changed, true);
  assert.equal(prepared.reason, "official-baseline");
  assert.equal(url.searchParams.get("tlang"), "zh-Hant");
  assert.equal(url.searchParams.get("subtype"), "Official");
  assert.equal(url.searchParams.get("dsai"), "1");
  assert.equal(url.searchParams.get("format"), "srv3");
  assert.equal(url.searchParams.has("fmt"), false);
});

test("automatically adds the configured target but respects manual-only mode", () => {
  const automatic = Core.prepareDualSubsRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3",
    Core.normalizeConfig({ target_language: "zh-Hans" })
  );
  assert.equal(new URL(automatic.url).searchParams.get("tlang"), "zh-Hans");

  const manual = Core.prepareDualSubsRequest(
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3",
    Core.normalizeConfig({ auto_translate: false })
  );
  assert.equal(manual.changed, false);
  assert.equal(manual.reason, "manual-only");
});

test("builds the original subtitle URL without recursive interception markers", () => {
  const prepared =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans&fmt=json3&subtype=Official&dsai=1";
  const original = new URL(Core.originalSubtitleUrl(prepared));
  assert.equal(original.searchParams.get("lang"), "en");
  assert.equal(original.searchParams.get("fmt"), "json3");
  assert.equal(original.searchParams.has("tlang"), false);
  assert.equal(original.searchParams.has("subtype"), false);
  assert.equal(original.searchParams.has("dsai"), false);
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

test("default batching keeps a 962-cue video within one four-request wave", () => {
  const cues = Array.from({ length: 962 }, (_, id) => ({
    id,
    eventIndex: id,
    startMs: id * 1000,
    durationMs: 900,
    text: `Subtitle row ${id}`
  }));
  const config = Core.normalizeConfig({});
  const chunks = Core.chunkCues(
    cues,
    config.maxBatchItems,
    config.maxBatchChars
  );
  assert.equal(chunks.length, 4);
  assert.equal(config.concurrency, 4);
  assert.equal(chunks.flat().length, 962);
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
  assert.equal(Core.normalizeConfig({}).model, "gemini-3.6-flash");
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

test("composes official JSON3 fallback by timestamp like DualSubs", () => {
  const composed = Core.composeOfficialSubtitles(
    JSON.stringify(sourceJson3()),
    "application/json",
    JSON.stringify(translatedJson3()),
    "application/json",
    Core.normalizeConfig({ Position: "Reverse", alignment_tolerance_ms: 10 })
  );
  const body = JSON.parse(composed.body);
  assert.equal(composed.matchedCues, 2);
  assert.equal(composed.matchRate, 1);
  assert.equal(body.events[0].segs[0].utf8, "你好世界\nHello world");
  assert.equal(body.events[1].segs[0].utf8, "你好吗？\nHow are you?");
});

test("composes official srv3 fallback and preserves paragraph timing", () => {
  const source =
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="10" d="20"><s>Hello</s></p><p t="30" d="40"><s>World</s></p>' +
    "</body></timedtext>";
  const translated =
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="10" d="20"><s>你好</s></p><p t="30" d="40"><s>世界</s></p>' +
    "</body></timedtext>";
  const composed = Core.composeOfficialSubtitles(
    source,
    "text/xml",
    translated,
    "text/xml",
    Core.normalizeConfig({ Position: "Reverse" })
  );
  assert.match(composed.body, /<p t="10" d="20"><s>你好&#10;Hello<\/s><\/p>/);
  assert.match(composed.body, /<p t="30" d="40"><s>世界&#10;World<\/s><\/p>/);
  assert.equal(composed.contentType, "application/xml; charset=utf-8");
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
