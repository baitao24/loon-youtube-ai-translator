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
  vm.runInNewContext(bundle, sandbox, { filename: "yt-ai.bundle.js" });
  await Promise.race([
    donePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("$done timeout")), 2000))
  ]);
  return { doneValue, store };
}

function config(provider) {
  return {
    provider,
    api_key: "test-secret",
    model: provider === "Gemini" ? "gemini-test" : "openai-test",
    target_language: "zh-Hans",
    retries: "0",
    concurrency: "1",
    timeout_ms: "12000",
    max_wait_ms: "15000",
    thinking_level: "minimal",
    cache_entries: "3",
    log_level: "OFF"
  };
}

function timedTextBody() {
  return JSON.stringify({
    events: [
      { tStartMs: 10, dDurationMs: 20, segs: [{ utf8: "Hello" }] },
      { tStartMs: 30, dDurationMs: 40, segs: [{ utf8: "World" }] }
    ]
  });
}

function srv3Body() {
  return (
    '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><pen id="0"/></head>' +
    '<body><p t="10" d="20"><s>Hello</s></p><p t="30" d="40"><s>World</s></p></body></timedtext>'
  );
}

test("Loon request context strips tlang without changing YouTube's srv3 format", async () => {
  const input =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-Hant&fmt=srv3";
  const result = await runLoon({
    argument: config("Gemini"),
    request: { url: input, method: "GET", headers: { Accept: "*/*" } }
  });
  const url = new URL(result.doneValue.url);
  assert.equal(url.searchParams.has("tlang"), false);
  assert.equal(url.searchParams.get("fmt"), "srv3");
  assert.equal(url.searchParams.get("ytai_tlang"), "zh-Hant");
  assert.equal(Object.keys(result.doneValue).join(","), "url");
});

test("Loon response context calls Gemini and returns bilingual JSON3", async () => {
  let apiRequest;
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  const result = await runLoon({
    argument: config("Gemini"),
    request: { url: requestUrl, method: "GET", headers: {} },
    response: {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": "123" },
      body: timedTextBody()
    },
    httpClient: {
      post(request, callback) {
        apiRequest = request;
        const payload = {
          translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }]
        };
        callback(null, { status: 200 }, JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
        }));
      }
    }
  });
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-secret");
  assert.ok(apiRequest.timeout >= 5000 && apiRequest.timeout <= 6000);
  assert.equal(apiRequest.body.includes("test-secret"), false);
  assert.equal(
    JSON.parse(apiRequest.body).generationConfig.responseFormat.text.mimeType,
    "application/json"
  );
  const output = JSON.parse(result.doneValue.body);
  assert.equal(output.events[0].segs[0].utf8, "你好\nHello");
  assert.equal(output.events[1].segs[0].utf8, "世界\nWorld");
  assert.equal(output.events[0].tStartMs, 10);
  assert.equal(result.doneValue.headers["Content-Length"], undefined);
  assert.equal(result.doneValue.headers["x-ytai-result"], "translated");
});

test("Loon response context keeps srv3 XML and returns bilingual paragraphs", async () => {
  let apiRequest;
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&format=srv3&ytai=1&ytai_tlang=zh-Hans";
  const result = await runLoon({
    argument: config("Gemini"),
    request: { url: requestUrl, method: "GET", headers: {} },
    response: {
      status: 200,
      headers: {
        "content-type": "text/xml",
        "content-encoding": "gzip",
        "content-length": "123"
      },
      body: srv3Body()
    },
    httpClient: {
      post(request, callback) {
        apiRequest = request;
        const payload = {
          translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }]
        };
        callback(null, { status: 200 }, JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
        }));
      }
    }
  });
  assert.ok(apiRequest.timeout <= 6000);
  assert.match(result.doneValue.body, /<p t="10" d="20"><s>你好&#10;Hello<\/s><\/p>/);
  assert.match(result.doneValue.body, /<p t="30" d="40"><s>世界&#10;World<\/s><\/p>/);
  assert.equal(result.doneValue.headers["content-type"], "application/xml; charset=utf-8");
  assert.equal(result.doneValue.headers["content-encoding"], "identity");
  assert.equal(result.doneValue.headers["content-length"], undefined);
});

test("Gemini retries with legacy responseSchema when responseFormat is rejected", async () => {
  const bodies = [];
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=gemini-legacy&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  const result = await runLoon({
    argument: config("Gemini"),
    request: { url: requestUrl, method: "GET", headers: {} },
    response: { status: 200, headers: {}, body: timedTextBody() },
    httpClient: {
      post(request, callback) {
        bodies.push(JSON.parse(request.body));
        if (bodies.length === 1) {
          callback(null, { status: 400 }, "{\"error\":\"unknown responseFormat\"}");
          return;
        }
        const payload = {
          translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }]
        };
        callback(null, { status: 200 }, JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
        }));
      }
    }
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].generationConfig.responseSchema, undefined);
  assert.deepEqual(
    bodies[1].generationConfig.responseSchema.required,
    ["translations"]
  );
  assert.equal(JSON.parse(result.doneValue.body).events[0].segs[0].utf8, "你好\nHello");
});

test("OpenAI adapter retries without response_format when provider rejects JSON mode", async () => {
  const bodies = [];
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  const result = await runLoon({
    argument: { ...config("OpenAI-Compatible"), base_url: "https://example.com/v1" },
    request: { url: requestUrl, method: "GET", headers: {} },
    response: { status: 200, headers: {}, body: timedTextBody() },
    httpClient: {
      post(request, callback) {
        bodies.push(JSON.parse(request.body));
        if (bodies.length === 1) {
          callback(null, { status: 400 }, "{\"error\":\"unsupported\"}");
          return;
        }
        const content = JSON.stringify({
          translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }]
        });
        callback(
          null,
          { status: 200 },
          JSON.stringify({ choices: [{ message: { content } }] })
        );
      }
    }
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(JSON.parse(result.doneValue.body).events[0].segs[0].utf8, "你好\nHello");
});

test("API failure returns the untouched original response", async () => {
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  const original = timedTextBody();
  let notificationCount = 0;
  const result = await runLoon({
    argument: config("Gemini"),
    request: { url: requestUrl, method: "GET", headers: {} },
    response: { status: 200, headers: { ETag: "abc" }, body: original },
    httpClient: {
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
  assert.equal(result.doneValue.headers.ETag, "abc");
  assert.equal(result.doneValue.headers["x-ytai-result"], "fallback");
  assert.match(decodeURIComponent(result.doneValue.headers["x-ytai-error"]), /API HTTP 500/);
  assert.equal(notificationCount, 1);
});

test("stops starting API requests before the subtitle display deadline", async () => {
  let now = 1000;
  let calls = 0;
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=deadline&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  const result = await runLoon({
    argument: { ...config("Gemini"), retries: "1" },
    request: { url: requestUrl, method: "GET", headers: {} },
    response: { status: 200, headers: {}, body: timedTextBody() },
    Date: { now: () => now },
    httpClient: {
      post(_request, callback) {
        calls += 1;
        now += 14500;
        callback(null, { status: 500 }, "{\"error\":\"slow failure\"}");
      }
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.doneValue.headers["x-ytai-result"], "fallback");
});

test("a second identical response uses persistent cache without another API call", async () => {
  const store = new Map();
  const requestUrl =
    "https://www.youtube.com/api/timedtext?v=cache&lang=en&fmt=json3&ytai=1&ytai_tlang=zh-Hans";
  let calls = 0;
  const httpClient = {
    post(_request, callback) {
      calls += 1;
      const payload = {
        translations: [{ id: 0, text: "你好" }, { id: 1, text: "世界" }]
      };
      callback(null, { status: 200 }, JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }]
      }));
    }
  };
  const shared = {
    argument: config("Gemini"),
    request: { url: requestUrl, method: "GET", headers: {} },
    response: { status: 200, headers: {}, body: timedTextBody() },
    httpClient,
    store
  };
  await runLoon(shared);
  const second = await runLoon(shared);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(second.doneValue.body).events[1].segs[0].utf8, "世界\nWorld");
});
