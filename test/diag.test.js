const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.resolve(__dirname, "../diag/yt-diag.js");
const KEY = "AIzaTESTKEY_0123456789abcdefghijkl";

async function runDiag({ url, response, argument, httpClient, store = new Map() }) {
  const source = await readFile(scriptPath, "utf8");
  const logs = [];
  const notifications = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const sandbox = {
    Date,
    Promise,
    JSON,
    Uint8Array,
    Number,
    setTimeout,
    clearTimeout,
    console: { log: (line) => logs.push(line) },
    $argument: argument || {},
    $request: { url, headers: {} },
    $httpClient: httpClient,
    $notification: { post: (...parts) => notifications.push(parts.join(" | ")) },
    $persistentStore: {
      read: (key) => (store.has(key) ? store.get(key) : null),
      write: (value, key) => {
        store.set(key, value);
        return true;
      }
    },
    $done: (value) => resolveDone(value)
  };
  if (response !== undefined) sandbox.$response = response;
  vm.runInNewContext(source, sandbox, { filename: "yt-diag.js" });
  const value = await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("$done timeout")), 4000))
  ]);
  return { value, logs, notifications, store };
}

function events(store) {
  return JSON.parse(store.get("@YTDiag.Events.v1") || "[]");
}

const SRV3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
<p t="0" d="2000"><s>hello</s><s t="400"> world</s></p>
<p t="2000" d="1500"><s>second</s><s t="300"> line</s></p>
</body></timedtext>`;

test("字幕响应按设定延迟后原样放行并记录格式", async () => {
  const begin = Date.now();
  const { value, notifications, store } = await runDiag({
    url: "https://www.youtube.com/api/timedtext?v=abc123&lang=en&kind=asr&fmt=srv3",
    response: { status: 200, headers: {}, body: SRV3 },
    argument: { timedtext_delay: "0.2" }
  });
  assert.equal(JSON.stringify(value), "{}");
  assert.ok(Date.now() - begin >= 190, "应至少延迟 200ms");
  const [released, holding] = events(store);
  assert.equal(holding.info.state, "holding");
  assert.equal(released.info.state, "released");
  assert.equal(released.info.format, "srv3");
  assert.equal(released.info.cues, 2);
  assert.equal(released.info.wordTags, 4);
  assert.equal(released.info.kind, "asr");
  assert.equal(notifications.length, 1);
  assert.match(JSON.parse(store.get("@YTDiag.Sample.v1")).head, /timedtext/);
});

test("json3 字幕不延迟时立即放行", async () => {
  const body = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "hi" }] }, { tStartMs: 10 }, { segs: [{ utf8: "yo" }] }] });
  const { value, notifications, store } = await runDiag({
    url: "https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3",
    response: { status: 200, headers: {}, body },
    argument: { timedtext_delay: "0" }
  });
  assert.equal(JSON.stringify(value), "{}");
  assert.equal(notifications.length, 0);
  const [released] = events(store);
  assert.equal(released.info.format, "json3");
  assert.equal(released.info.cues, 2);
});

test("App 播放器二进制响应：记录字幕地址数量，之后的字幕请求能算出间隔", async () => {
  const store = new Map();
  const bytes = new Uint8Array(Buffer.from("\x08\x01junk https://www.youtube.com/api/timedtext?v=abc more\x00"));
  const player = await runDiag({
    url: "https://youtubei.googleapis.com/youtubei/v1/player?key=x",
    response: { status: 200, headers: {}, body: bytes },
    argument: ["0", "0", "", ""],
    store
  });
  assert.equal(JSON.stringify(player.value), "{}");
  assert.equal(events(store)[0].info.captionUrls, 1);
  await runDiag({
    url: "https://www.youtube.com/api/timedtext?v=abc&lang=en",
    response: { status: 200, headers: {}, body: SRV3 },
    store
  });
  const latest = events(store)[0];
  assert.equal(latest.type, "timedtext");
  assert.ok(latest.info.sincePlayer >= 0 && latest.info.sincePlayer < 5);
});

test("报告页返回 HTML 并列出记录", async () => {
  const store = new Map();
  await runDiag({
    url: "https://www.youtube.com/api/timedtext?v=vid9&lang=en",
    response: { status: 200, headers: {}, body: SRV3 },
    store
  });
  const { value } = await runDiag({ url: "https://www.youtube.com/__ytdiag/", store });
  assert.equal(value.response.status, 200);
  assert.match(value.response.headers["Content-Type"], /text\/html/);
  assert.match(value.response.body, /vid9/);
  assert.match(value.response.body, /srv3 2 条/);
});

function geminiClient({ models, posts }) {
  const calls = [];
  return {
    calls,
    client: {
      get(request, callback) {
        calls.push({ method: "get", request });
        setTimeout(() => callback(null, { status: 200 }, JSON.stringify({ models })), 5);
      },
      post(request, callback) {
        calls.push({ method: "post", request });
        const next = posts.length > 1 ? posts.shift() : posts[0];
        setTimeout(() => {
          const result = next(JSON.parse(request.body));
          callback(null, { status: result.status }, result.body);
        }, 5);
      }
    }
  };
}

function okTranslation(body) {
  const lines = JSON.parse(body.contents[0].parts[0].text);
  return {
    status: 200,
    body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ t: lines.map((_, i) => `译文${i}`) }) }] } }],
      usageMetadata: { candidatesTokenCount: 321, thoughtsTokenCount: 0 }
    })
  };
}

test("Gemini 测速：自动挑 Flash-Lite，thinking 被拒时去掉重试，页面不泄露 Key", async () => {
  const { client, calls } = geminiClient({
    models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-image", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-9", supportedGenerationMethods: ["embedContent"] }
    ],
    posts: [
      (body) => {
        assert.ok(body.generationConfig.thinkingConfig);
        return { status: 400, body: JSON.stringify({ error: { message: "thinking_level is not supported" } }) };
      },
      (body) => {
        assert.equal(body.generationConfig.thinkingConfig, undefined);
        return okTranslation(body);
      },
      okTranslation
    ]
  });
  const { value, logs, store } = await runDiag({
    url: "https://www.youtube.com/__ytdiag/gemini?n=10&c=3",
    argument: { api_key: KEY },
    httpClient: client
  });
  const html = value.response.body;
  assert.match(html, /gemini-3\.5-flash-lite/);
  assert.match(html, /返回 10\/10 条/);
  assert.match(html, /3 批同时发/);
  assert.match(html, /失败 <span class="ok">0<\/span>/);
  assert.match(html, /模型不接受 thinkingLevel/);
  assert.ok(calls.every((call) => !call.request.url.includes(KEY)), "Key 不能出现在网址里");
  assert.ok(calls.filter((c) => c.method === "post").every((c) => c.request.headers["x-goog-api-key"] === KEY));
  assert.ok(!html.includes(KEY) && !logs.join("\n").includes(KEY) && ![...store.values()].join("").includes(KEY));
  assert.equal(events(store)[0].type, "gemini");
});

test("Gemini 测速：429 限流时报告原因并停止并发测试", async () => {
  const { client, calls } = geminiClient({
    models: [{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] }],
    posts: [() => ({ status: 429, body: JSON.stringify({ error: { message: `quota exceeded for ${KEY}` } }) })]
  });
  const { value } = await runDiag({
    url: "https://www.youtube.com/__ytdiag/gemini",
    argument: { api_key: KEY },
    httpClient: client
  });
  const html = value.response.body;
  assert.match(html, /HTTP 429/);
  assert.match(html, /限流/);
  assert.ok(!html.includes(KEY));
  assert.equal(calls.filter((c) => c.method === "post").length, 1);
});

test("没填 Key 时提示，不发任何请求", async () => {
  const { value } = await runDiag({
    url: "https://m.youtube.com/__ytdiag/gemini",
    argument: "timedtext_delay=0&api_key=",
    httpClient: { get: () => assert.fail("不应请求"), post: () => assert.fail("不应请求") }
  });
  assert.match(value.response.body, /没有 API Key/);
});
