const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

async function sourceBundle() {
  const [core, loon] = await Promise.all([
    readFile(path.join(projectRoot, "src/yt-ai-core.js"), "utf8"),
    readFile(path.join(projectRoot, "src/yt-ai-loon.js"), "utf8")
  ]);
  return `${core}\n${loon}`;
}

async function runLoon(overrides) {
  const bundle = await sourceBundle();
  let doneValue;
  let doneResolve;
  const donePromise = new Promise((resolve) => {
    doneResolve = resolve;
  });
  const store = overrides.store || new Map();
  const sandbox = {
    URL,
    Date: overrides.Date || Date,
    Promise,
    Map,
    JSON,
    console: overrides.console || { log() {} },
    setTimeout,
    clearTimeout,
    $argument: overrides.argument || {},
    $request: overrides.request,
    $response: overrides.response,
    $httpClient: overrides.httpClient,
    $notification: overrides.notification || { post() {} },
    $persistentStore: {
      read(key) {
        return store.get(key) || null;
      },
      write(value, key) {
        store.set(key, value);
        return true;
      }
    },
    $done(value) {
      doneValue = value;
      doneResolve(value);
    }
  };
  if (overrides.response === undefined) delete sandbox.$response;
  vm.runInNewContext(bundle, sandbox, { filename: "dualsubs-ai.bundle.js" });
  await Promise.race([
    donePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("$done timeout")), overrides.doneTimeoutMs || 2500)
    )
  ]);
  return { doneValue, store };
}

function config(provider = "Gemini") {
  return {
    ai_enabled: true,
    provider,
    api_key: "test-secret",
    model: provider === "Gemini" ? "gemini-test" : "openai-test",
    target_language: "zh-Hans",
    retries: "0",
    concurrency: "1",
    timeout_ms: "4000",
    max_wait_ms: "5000",
    thinking_level: "minimal",
    cache_entries: "3",
    LogLevel: "OFF",
    Position: "Reverse"
  };
}

function sourceJson3() {
  return JSON.stringify({
    events: [
      { tStartMs: 10, dDurationMs: 20, segs: [{ utf8: "Hello" }] },
      { tStartMs: 30, dDurationMs: 40, segs: [{ utf8: "World" }] }
    ]
  });
}

function sourceSrv3() {
  return (
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="10" d="20"><s>Hello</s></p><p t="30" d="40"><s>World</s></p>' +
    "</body></timedtext>"
  );
}

// 请求脚本改写后的地址：没有 tlang，带 dsai 标记和目标语言
function processedUrl(format = "json3", video = "abc") {
  return (
    `https://www.youtube.com/api/timedtext?v=${video}&lang=en` +
    `&fmt=${format}&dsai=1&dsai_target=zh-Hans`
  );
}

function successfulGemini(callback) {
  const payload = {
    translations: [
      { id: 0, text: "AI你好" },
      { id: 1, text: "AI世界" }
    ]
  };
  callback(
    null,
    { status: 200 },
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
    })
  );
}

function noGet() {
  assert.fail("0.4.1 不应再额外请求字幕");
}

test("request strips tlang because YouTube now answers it with 429", async () => {
  const withTarget = await runLoon({
    argument: config(),
    request: {
      url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3",
      method: "GET",
      headers: {}
    }
  });
  const rewritten = new URL(withTarget.doneValue.url);
  assert.equal(rewritten.searchParams.has("tlang"), false);
  assert.equal(rewritten.searchParams.get("dsai"), "1");
  assert.equal(rewritten.searchParams.get("dsai_target"), "zh-Hant");
  assert.equal(rewritten.searchParams.get("format"), "srv3");

  const automatic = await runLoon({
    argument: config(),
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3", method: "GET", headers: {} }
  });
  const automaticUrl = new URL(automatic.doneValue.url);
  assert.equal(automaticUrl.searchParams.has("tlang"), false);
  assert.equal(automaticUrl.searchParams.get("dsai_target"), "zh-Hans");

  const unconfigured = await runLoon({
    argument: { ...config(), api_key: "" },
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hans", method: "GET", headers: {} }
  });
  const plainUrl = new URL(unconfigured.doneValue.url);
  assert.equal(plainUrl.searchParams.has("tlang"), false, "没配置 AI 也要去掉 tlang");
  assert.equal(plainUrl.searchParams.has("dsai"), false);
});

test("Gemini translates the source JSON3 response directly into AI bilingual subtitles", async () => {
  let apiRequest;
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl(), method: "GET", headers: { Cookie: "session" } },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": "123" },
      body: sourceJson3()
    },
    httpClient: {
      get: noGet,
      post(request, callback) {
        apiRequest = request;
        successfulGemini(callback);
      }
    }
  });
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-secret");
  assert.equal(apiRequest.body.includes("test-secret"), false);
  assert.match(apiRequest.body, /zh-Hans/);
  const output = JSON.parse(result.doneValue.body);
  assert.equal(output.events[0].segs[0].utf8, "AI你好\nHello");
  assert.equal(output.events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(result.doneValue.headers["Content-Length"], undefined);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("Gemini success preserves srv3 and paragraph timing", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl("srv3"), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "content-type": "text/xml", "content-encoding": "gzip" },
      body: sourceSrv3()
    },
    httpClient: { get: noGet, post: (_request, callback) => successfulGemini(callback) }
  });
  assert.match(result.doneValue.body, /<p t="10" d="20"><s>AI你好&#10;Hello<\/s><\/p>/);
  assert.match(result.doneValue.body, /<p t="30" d="40"><s>AI世界&#10;World<\/s><\/p>/);
  assert.equal(result.doneValue.headers["content-type"], "application/xml; charset=utf-8");
  assert.equal(result.doneValue.headers["content-encoding"], "identity");
});

test("missing API configuration passes the source subtitles through", async () => {
  const body = sourceJson3();
  const result = await runLoon({
    argument: { ...config(), api_key: "" },
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.body, body);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
});

test("AI failure keeps the source subtitles, never an error", async () => {
  let notificationCount = 0;
  const body = sourceJson3();
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json", ETag: "src" }, body },
    httpClient: {
      get: noGet,
      post(_request, callback) {
        callback(null, { status: 500 }, "{\"error\":\"bad\"}");
      }
    },
    notification: { post: () => (notificationCount += 1) }
  });
  assert.equal(result.doneValue.body, body);
  assert.equal(result.doneValue.headers.ETag, "src");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "source-only");
  assert.match(decodeURIComponent(result.doneValue.headers["x-dualsubs-ai-error"]), /AI HTTP 500/);
  assert.equal(notificationCount, 1);
});

test("YouTube error pages pass through untouched without calling AI", async () => {
  const sorry = "<html><head><title>Sorry...</title></head><body>429</body></html>";
  const result = await runLoon({
    argument: config(),
    request: { url: processedUrl("srv3"), method: "GET", headers: {} },
    response: { status: 429, headers: { "Content-Type": "text/html" }, body: sorry },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.body, sorry, "原样放行，不改写");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "upstream-error");
});

test("responses without the dsai marker are left alone", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3", method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: { get: noGet, post: () => assert.fail("不应调用 AI") }
  });
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "skipped");
});

test("OpenAI-compatible adapter retries once without JSON mode", async () => {
  const bodies = [];
  const result = await runLoon({
    argument: { ...config("OpenAI-Compatible"), base_url: "https://example.com/v1" },
    request: { url: processedUrl(), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    httpClient: {
      get: noGet,
      post(request, callback) {
        bodies.push(JSON.parse(request.body));
        if (bodies.length === 1) {
          callback(null, { status: 400 }, "{\"error\":\"unsupported\"}");
          return;
        }
        callback(
          null,
          { status: 200 },
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    translations: [
                      { id: 0, text: "AI你好" },
                      { id: 1, text: "AI世界" }
                    ]
                  })
                }
              }
            ]
          })
        );
      }
    }
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(JSON.parse(result.doneValue.body).events[0].segs[0].utf8, "AI你好\nHello");
});

test("second identical response uses final cache without network calls", async () => {
  const store = new Map();
  let postCalls = 0;
  const shared = {
    argument: config(),
    request: { url: processedUrl("json3", "cache"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: sourceJson3() },
    store,
    httpClient: {
      get: noGet,
      post(_request, callback) {
        postCalls += 1;
        successfulGemini(callback);
      }
    }
  };
  await runLoon(shared);
  const second = await runLoon(shared);
  assert.equal(postCalls, 1);
  assert.equal(JSON.parse(second.doneValue.body).events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "cache-ai");
});

function tenCueJson3(prefix) {
  return JSON.stringify({
    events: Array.from({ length: 10 }, (_, index) => ({
      tStartMs: index * 1000 + 10,
      dDurationMs: 900,
      segs: [{ utf8: `${prefix}${index}` }]
    }))
  });
}

function geminiRows(rows) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ translations: rows }) }] } }]
  });
}

function requestedIds(request) {
  return JSON.parse(JSON.parse(request.body).contents[0].parts[0].text).subtitles.map((row) => row.id);
}

function partialRun({ store, onPost, notification }) {
  return runLoon({
    argument: {
      ...config(),
      parallel: "2",
      batch_size: "5",
      max_wait_ms: "3000",
      timeout_ms: "3000"
    },
    request: { url: processedUrl("json3", "longvid"), method: "GET", headers: {} },
    response: { status: 200, headers: { "Content-Type": "application/json" }, body: tenCueJson3("Line ") },
    httpClient: { get: noGet, post: onPost },
    notification,
    store,
    doneTimeoutMs: 4500
  });
}

test("deadline returns finished AI rows, leaves the rest as source text, then resumes", async () => {
  const store = new Map();
  let notifications = 0;
  const first = await partialRun({
    store,
    notification: { post: () => (notifications += 1) },
    onPost(request, callback) {
      const ids = requestedIds(request);
      // 第一批正常返回，第二批一直不返回（模拟慢请求）
      if (ids[0] === 0) callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  const firstEvents = JSON.parse(first.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(
    firstEvents,
    Array.from({ length: 10 }, (_, i) => (i < 5 ? `AI${i}\nLine ${i}` : `Line ${i}`))
  );
  assert.equal(first.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
  assert.equal(notifications, 1);

  const requested = [];
  const second = await partialRun({
    store,
    onPost(request, callback) {
      const ids = requestedIds(request);
      requested.push(...ids);
      callback(null, { status: 200 }, geminiRows(ids.map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  assert.deepEqual(requested, [5, 6, 7, 8, 9], "续翻时只请求剩下的行");
  const secondEvents = JSON.parse(second.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(secondEvents, Array.from({ length: 10 }, (_, i) => `AI${i}\nLine ${i}`));
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("a batch that drops one line keeps the other AI rows", async () => {
  const result = await partialRun({
    store: new Map(),
    onPost(request, callback) {
      const ids = requestedIds(request);
      callback(null, { status: 200 }, geminiRows(ids.filter((id) => id !== 3).map((id) => ({ id, text: `AI${id}` }))));
    }
  });
  const events = JSON.parse(result.doneValue.body).events.map((event) => event.segs[0].utf8);
  assert.deepEqual(events, Array.from({ length: 10 }, (_, i) => (i === 3 ? "Line 3" : `AI${i}\nLine ${i}`)));
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai-partial");
});
