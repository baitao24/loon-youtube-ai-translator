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
      setTimeout(() => reject(new Error("$done timeout")), 2500)
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

function officialJson3() {
  return JSON.stringify({
    events: [
      { tStartMs: 10, dDurationMs: 20, segs: [{ utf8: "官方你好" }] },
      { tStartMs: 30, dDurationMs: 40, segs: [{ utf8: "官方世界" }] }
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

function officialSrv3() {
  return (
    '<?xml version="1.0"?><timedtext format="3"><body>' +
    '<p t="10" d="20"><s>官方你好</s></p><p t="30" d="40"><s>官方世界</s></p>' +
    "</body></timedtext>"
  );
}

function officialUrl(format = "json3", video = "abc") {
  return (
    `https://www.youtube.com/api/timedtext?v=${video}&lang=en&tlang=zh-Hans` +
    `&fmt=${format}&subtype=Official&dsai=1`
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

test("request keeps tlang and srv3 while adding the Official baseline", async () => {
  const input =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&format=srv3";
  const result = await runLoon({
    argument: config(),
    request: { url: input, method: "GET", headers: { Accept: "*/*" } }
  });
  const url = new URL(result.doneValue.url);
  assert.equal(url.searchParams.get("tlang"), "zh-Hant");
  assert.equal(url.searchParams.get("subtype"), "Official");
  assert.equal(url.searchParams.get("dsai"), "1");
  assert.equal(url.searchParams.get("format"), "srv3");
  assert.equal(url.searchParams.has("fmt"), false);
});

test("Gemini success replaces official translation with AI bilingual JSON3", async () => {
  let getRequest;
  let apiRequest;
  const result = await runLoon({
    argument: config(),
    request: { url: officialUrl(), method: "GET", headers: { Cookie: "session" } },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": "123" },
      body: officialJson3()
    },
    httpClient: {
      get(request, callback) {
        getRequest = request;
        callback(
          null,
          { status: 200, headers: { "Content-Type": "application/json" } },
          sourceJson3()
        );
      },
      post(request, callback) {
        apiRequest = request;
        successfulGemini(callback);
      }
    }
  });
  assert.equal(new URL(getRequest.url).searchParams.has("tlang"), false);
  assert.equal(getRequest.headers.Cookie, "session");
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-secret");
  assert.equal(apiRequest.body.includes("test-secret"), false);
  const output = JSON.parse(result.doneValue.body);
  assert.equal(output.events[0].segs[0].utf8, "AI你好\nHello");
  assert.equal(output.events[1].segs[0].utf8, "AI世界\nWorld");
  assert.equal(result.doneValue.headers["Content-Length"], undefined);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "ai");
});

test("Gemini success preserves srv3 and paragraph timing", async () => {
  const result = await runLoon({
    argument: config(),
    request: { url: officialUrl("srv3"), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "content-type": "text/xml", "content-encoding": "gzip" },
      body: officialSrv3()
    },
    httpClient: {
      get(_request, callback) {
        callback(
          null,
          { status: 200, headers: { "content-type": "text/xml" } },
          sourceSrv3()
        );
      },
      post(_request, callback) {
        successfulGemini(callback);
      }
    }
  });
  assert.match(result.doneValue.body, /<p t="10" d="20"><s>AI你好&#10;Hello<\/s><\/p>/);
  assert.match(result.doneValue.body, /<p t="30" d="40"><s>AI世界&#10;World<\/s><\/p>/);
  assert.equal(
    result.doneValue.headers["content-type"],
    "application/xml; charset=utf-8"
  );
  assert.equal(result.doneValue.headers["content-encoding"], "identity");
});

test("missing API configuration still returns official bilingual subtitles", async () => {
  let postCalls = 0;
  const result = await runLoon({
    argument: { ...config(), api_key: "" },
    request: { url: officialUrl(), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: officialJson3()
    },
    httpClient: {
      get(_request, callback) {
        callback(
          null,
          { status: 200, headers: { "Content-Type": "application/json" } },
          sourceJson3()
        );
      },
      post() {
        postCalls += 1;
      }
    }
  });
  const output = JSON.parse(result.doneValue.body);
  assert.equal(postCalls, 0);
  assert.equal(output.events[0].segs[0].utf8, "官方你好\nHello");
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "official");
});

test("AI failure falls back to official bilingual subtitles, never blank", async () => {
  let notificationCount = 0;
  const result = await runLoon({
    argument: config(),
    request: { url: officialUrl(), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: "official" },
      body: officialJson3()
    },
    httpClient: {
      get(_request, callback) {
        callback(
          null,
          { status: 200, headers: { "Content-Type": "application/json" } },
          sourceJson3()
        );
      },
      post(_request, callback) {
        callback(null, { status: 500 }, "{\"error\":\"bad\"}");
      }
    },
    notification: {
      post() {
        notificationCount += 1;
      }
    }
  });
  const output = JSON.parse(result.doneValue.body);
  assert.equal(output.events[0].segs[0].utf8, "官方你好\nHello");
  assert.equal(output.events[1].segs[0].utf8, "官方世界\nWorld");
  assert.equal(result.doneValue.headers.ETag, "official");
  assert.equal(
    result.doneValue.headers["x-dualsubs-ai-result"],
    "official-fallback"
  );
  assert.match(
    decodeURIComponent(result.doneValue.headers["x-dualsubs-ai-error"]),
    /AI HTTP 500/
  );
  assert.equal(notificationCount, 1);
});

test("original subtitle failure preserves YouTube official translated response", async () => {
  const originalOfficial = officialJson3();
  const result = await runLoon({
    argument: config(),
    request: { url: officialUrl(), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: originalOfficial
    },
    httpClient: {
      get(_request, callback) {
        callback(null, { status: 503 }, "");
      },
      post() {
        assert.fail("AI must not run without source subtitles");
      }
    }
  });
  assert.equal(result.doneValue.body, originalOfficial);
  assert.equal(result.doneValue.headers["x-dualsubs-ai-result"], "official-only");
});

test("OpenAI-compatible adapter retries once without JSON mode", async () => {
  const bodies = [];
  const result = await runLoon({
    argument: {
      ...config("OpenAI-Compatible"),
      base_url: "https://example.com/v1"
    },
    request: { url: officialUrl(), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: officialJson3()
    },
    httpClient: {
      get(_request, callback) {
        callback(
          null,
          { status: 200, headers: { "Content-Type": "application/json" } },
          sourceJson3()
        );
      },
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
  assert.equal(
    JSON.parse(result.doneValue.body).events[0].segs[0].utf8,
    "AI你好\nHello"
  );
});

test("second identical response uses final cache without network calls", async () => {
  const store = new Map();
  let getCalls = 0;
  let postCalls = 0;
  const shared = {
    argument: config(),
    request: { url: officialUrl("json3", "cache"), method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: officialJson3()
    },
    store,
    httpClient: {
      get(_request, callback) {
        getCalls += 1;
        callback(
          null,
          { status: 200, headers: { "Content-Type": "application/json" } },
          sourceJson3()
        );
      },
      post(_request, callback) {
        postCalls += 1;
        successfulGemini(callback);
      }
    }
  };
  await runLoon(shared);
  const second = await runLoon(shared);
  assert.equal(getCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(
    JSON.parse(second.doneValue.body).events[1].segs[0].utf8,
    "AI世界\nWorld"
  );
  assert.equal(second.doneValue.headers["x-dualsubs-ai-result"], "cache-ai");
});
