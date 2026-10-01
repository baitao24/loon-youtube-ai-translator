// YouTube 字幕诊断脚本（Loon）
// 1. 按设定秒数延迟 timedtext / player 响应，测 YouTube App 的等待上限
// 2. 记录字幕请求的格式、条数和距打开视频的间隔
// 3. 在 https://www.youtube.com/__ytdiag/ 提供报告页和 Gemini 速度测试
// 只读、不改写任何响应内容；API Key 只从 Loon 参数读取，不写入日志或页面。
(function runYouTubeDiag() {
  "use strict";

  const EVENTS_KEY = "@YTDiag.Events.v1";
  const SAMPLE_KEY = "@YTDiag.Sample.v1";
  const PLAYER_AT_KEY = "@YTDiag.LastPlayerAt.v1";
  const ARG_NAMES = ["timedtext_delay", "player_delay", "api_key", "model"];
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
  const startedAt = Date.now();

  const SAMPLE_LINES = [
    "so today we're going to look at how this thing actually works",
    "and honestly I didn't expect it to be this fast",
    "the first thing you want to do is open the settings panel",
    "then scroll all the way down until you see the advanced section",
    "a lot of people skip this step and that's where things go wrong",
    "okay let me show you what happens if we change this value",
    "you can see the numbers jump right away",
    "now that's interesting because the documentation says otherwise",
    "I reached out to the team and they confirmed it's a known issue",
    "anyway let's move on to the second part of the video",
    "this is the part most of you asked about in the comments",
    "we're going to compare three different approaches side by side",
    "the cheapest one costs about twenty dollars a month",
    "but the performance difference is honestly not that big",
    "if you're just starting out I'd go with the simple option",
    "you can always upgrade later once you know what you need",
    "one thing I really like here is the battery life",
    "I've been using it every day for about three weeks now",
    "and it still lasts me a full day without charging",
    "the camera on the other hand is a bit of a mixed bag",
    "in good lighting the photos look great",
    "but at night there's quite a lot of noise",
    "let me know in the comments if you've noticed the same thing",
    "alright that's pretty much everything I wanted to cover",
    "if this video helped you consider subscribing",
    "it really helps the channel and I read every comment",
    "next week we'll be testing the new update",
    "so make sure you don't miss that one",
    "thanks for watching and I'll see you in the next video",
    "take care everyone bye"
  ];

  // ---------- 工具 ----------
  function parseArgs(raw) {
    if (Array.isArray(raw)) {
      const result = {};
      ARG_NAMES.forEach((name, index) => {
        if (raw[index] !== undefined) result[name] = raw[index];
      });
      return result;
    }
    if (raw && typeof raw === "object") return raw;
    const text = String(raw || "").trim();
    if (!text) return {};
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch (_) {
        return {};
      }
    }
    const result = {};
    text.split("&").forEach((pair) => {
      const at = pair.indexOf("=");
      if (at < 0) return;
      result[decodeURIComponent(pair.slice(0, at))] = decodeURIComponent(
        pair.slice(at + 1).replace(/\+/g, " ")
      );
    });
    return result;
  }

  const args = parseArgs(typeof $argument === "undefined" ? "" : $argument);
  const config = {
    timedtextDelay: clampNumber(args.timedtext_delay, 0, 0, 60),
    playerDelay: clampNumber(args.player_delay, 0, 0, 60),
    apiKey: String(args.api_key || "").trim(),
    model: String(args.model || "").trim()
  };

  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function log(message) {
    console.log(`[YTDiag] ${message}`);
  }

  function storeRead(key) {
    try {
      return typeof $persistentStore === "undefined" ? null : $persistentStore.read(key);
    } catch (_) {
      return null;
    }
  }

  function storeWrite(value, key) {
    try {
      if (typeof $persistentStore !== "undefined") $persistentStore.write(value, key);
    } catch (_) {
      // 诊断记录失败不能影响 YouTube 请求
    }
  }

  function readEvents() {
    try {
      const parsed = JSON.parse(storeRead(EVENTS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function addEvent(type, info) {
    const events = readEvents();
    events.unshift({ at: Date.now(), type, info });
    storeWrite(JSON.stringify(events.slice(0, 40)), EVENTS_KEY);
  }

  function notify(title, body) {
    try {
      if (typeof $notification !== "undefined") $notification.post("YouTube 诊断", title, body);
    } catch (_) {
      // 通知只是辅助
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function queryParams(url) {
    const result = {};
    const at = url.indexOf("?");
    if (at < 0) return result;
    url
      .slice(at + 1)
      .split("&")
      .forEach((pair) => {
        const eq = pair.indexOf("=");
        const key = eq < 0 ? pair : pair.slice(0, eq);
        const value = eq < 0 ? "" : pair.slice(eq + 1);
        try {
          result[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
        } catch (_) {
          result[key] = value;
        }
      });
    return result;
  }

  function bodyToText(body, limit) {
    if (body === undefined || body === null) return "";
    if (typeof body === "string") return body.slice(0, limit);
    // binary-body-mode 下 body 是 Uint8Array
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    let text = "";
    const end = Math.min(bytes.length, limit);
    for (let index = 0; index < end; index += 1) {
      const code = bytes[index];
      text += code >= 32 && code < 127 ? String.fromCharCode(code) : " ";
    }
    return text;
  }

  function bodyLength(body) {
    if (body === undefined || body === null) return 0;
    if (typeof body === "string") return body.length;
    return body.byteLength || body.length || 0;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function redact(text) {
    let result = String(text || "");
    if (config.apiKey) result = result.split(config.apiKey).join("[KEY]");
    return result.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[KEY]");
  }

  function formatTime(ms) {
    const date = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  // ---------- 字幕响应 ----------
  function describeSubtitle(body) {
    const text = typeof body === "string" ? body : bodyToText(body, 2000000);
    const head = text.trimStart().slice(0, 200);
    if (head.startsWith("{")) {
      let cues = 0;
      try {
        const parsed = JSON.parse(text);
        cues = (parsed.events || []).filter((event) => Array.isArray(event.segs)).length;
      } catch (_) {
        cues = (text.match(/"segs"/g) || []).length;
      }
      return { format: "json3", cues };
    }
    if (head.startsWith("<")) {
      const pCount = (text.match(/<p\s/g) || []).length;
      const textCount = (text.match(/<text\s/g) || []).length;
      const words = (text.match(/<s[\s>]/g) || []).length;
      return {
        format: pCount ? "srv3" : textCount ? "srv1/xml" : "xml",
        cues: pCount || textCount,
        wordTags: words
      };
    }
    if (head.startsWith("WEBVTT")) {
      return { format: "vtt", cues: (text.match(/-->/g) || []).length };
    }
    return { format: head ? "unknown" : "empty", cues: 0 };
  }

  async function handleTimedtext() {
    const params = queryParams($request.url);
    const description = describeSubtitle($response.body);
    const lastPlayerAt = Number(storeRead(PLAYER_AT_KEY) || 0);
    const sincePlayer = lastPlayerAt ? (startedAt - lastPlayerAt) / 1000 : null;
    const info = {
      v: params.v || "",
      lang: params.lang || "",
      kind: params.kind || "",
      fmt: params.fmt || params.format || "",
      tlang: params.tlang || "",
      bytes: bodyLength($response.body),
      format: description.format,
      cues: description.cues,
      wordTags: description.wordTags || 0,
      sincePlayer: sincePlayer === null ? null : Number(sincePlayer.toFixed(1)),
      delay: config.timedtextDelay
    };
    storeWrite(
      JSON.stringify({
        at: startedAt,
        url: $request.url.replace(/([?&](?:key|token|pot|signature|sig)=)[^&]+/gi, "$1…"),
        info,
        head: bodyToText($response.body, 6000)
      }),
      SAMPLE_KEY
    );
    if (config.timedtextDelay > 0) {
      addEvent("timedtext", Object.assign({ state: "holding" }, info));
      log(`timedtext ${info.v} held for ${config.timedtextDelay}s`);
      await sleep(config.timedtextDelay * 1000);
      notify(`字幕已在 ${config.timedtextDelay} 秒后放行`, `视频 ${info.v || "?"}，请看字幕是否出现`);
    }
    addEvent("timedtext", Object.assign({ state: "released", heldMs: Date.now() - startedAt }, info));
    log(`timedtext ${info.v} ${info.format} ${info.cues} cues released`);
    $done({});
  }

  // ---------- 播放器响应 ----------
  async function handlePlayer() {
    storeWrite(String(startedAt), PLAYER_AT_KEY);
    const text = bodyToText($response.body, 3000000);
    const info = {
      host: $request.url.split("/")[2] || "",
      bytes: bodyLength($response.body),
      captionUrls: (text.match(/api\/timedtext/g) || []).length,
      delay: config.playerDelay
    };
    if (config.playerDelay > 0) {
      addEvent("player", Object.assign({ state: "holding" }, info));
      await sleep(config.playerDelay * 1000);
      notify(`播放器已在 ${config.playerDelay} 秒后放行`, "请看视频是否正常打开");
    }
    addEvent("player", Object.assign({ state: "released", heldMs: Date.now() - startedAt }, info));
    $done({});
  }

  // ---------- Gemini 速度测试 ----------
  function httpRequest(method, request, timeoutMs) {
    return new Promise((resolve) => {
      const begin = Date.now();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Object.assign({ ms: Date.now() - begin }, result));
      };
      const timer = setTimeout(() => finish({ status: 0, error: `超时 ${timeoutMs}ms` }), timeoutMs);
      try {
        $httpClient[method](Object.assign({ timeout: timeoutMs }, request), (error, response, body) => {
          if (error) return finish({ status: 0, error: redact(error) });
          finish({ status: Number(response?.status || response?.statusCode || 0), body: String(body || "") });
        });
      } catch (error) {
        finish({ status: 0, error: redact(error?.message || error) });
      }
    });
  }

  function modelVersion(name) {
    const match = name.match(/gemini-(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) : 0;
  }

  function pickModel(models) {
    const usable = models.filter(
      (name) => /flash/.test(name) && !/image|tts|audio|live|embedding|vision|exp-/.test(name)
    );
    usable.sort((a, b) => {
      const lite = Number(/lite/.test(b)) - Number(/lite/.test(a));
      if (lite) return lite;
      const version = modelVersion(b) - modelVersion(a);
      if (version) return version;
      return Number(/preview/.test(a)) - Number(/preview/.test(b));
    });
    return usable[0] || "";
  }

  async function listModels() {
    const result = await httpRequest(
      "get",
      { url: `${GEMINI_BASE}/models?pageSize=200`, headers: { "x-goog-api-key": config.apiKey } },
      15000
    );
    if (result.status !== 200) return { error: result.error || `HTTP ${result.status}`, body: result.body, models: [] };
    try {
      const parsed = JSON.parse(result.body);
      const models = (parsed.models || [])
        .filter((model) => (model.supportedGenerationMethods || []).includes("generateContent"))
        .map((model) => String(model.name || "").replace(/^models\//, ""));
      return { models };
    } catch (error) {
      return { error: "模型列表解析失败", models: [] };
    }
  }

  function batchLines(size, offset) {
    return Array.from({ length: size }, (_, index) => SAMPLE_LINES[(offset + index) % SAMPLE_LINES.length]);
  }

  function geminiBody(lines, thinking) {
    const generationConfig = {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { t: { type: "ARRAY", items: { type: "STRING" } } },
        required: ["t"]
      },
      temperature: 0
    };
    if (thinking && thinking !== "off") generationConfig.thinkingConfig = { thinkingLevel: thinking };
    return JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text:
              "You translate YouTube subtitle lines into natural Simplified Chinese. " +
              "Return JSON {\"t\": [...]} with exactly one translation per input line, in the same order."
          }
        ]
      },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(lines) }] }],
      generationConfig
    });
  }

  async function translateOnce(model, lines, thinking) {
    let usedThinking = thinking;
    let result = await httpRequest(
      "post",
      {
        url: `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
        body: geminiBody(lines, usedThinking)
      },
      30000
    );
    let note = "";
    if (result.status === 400 && usedThinking !== "off" && /thinking/i.test(result.body || "")) {
      usedThinking = "off";
      note = "模型不接受 thinkingLevel，已去掉后重试";
      const retry = await httpRequest(
        "post",
        {
          url: `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
          headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
          body: geminiBody(lines, "off")
        },
        30000
      );
      retry.ms += result.ms;
      result = retry;
    }
    const outcome = { ms: result.ms, status: result.status, note, thinking: usedThinking };
    if (result.status !== 200) {
      outcome.error = result.error || redact((result.body || "").slice(0, 300));
      return outcome;
    }
    try {
      const parsed = JSON.parse(result.body);
      const usage = parsed.usageMetadata || {};
      outcome.outTokens = usage.candidatesTokenCount || 0;
      outcome.thoughtTokens = usage.thoughtsTokenCount || 0;
      const text = (parsed.candidates?.[0]?.content?.parts || [])
        .filter((part) => part.thought !== true)
        .map((part) => part.text || "")
        .join("");
      const translations = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")).t || [];
      outcome.count = translations.length;
      outcome.ok = translations.length === lines.length;
      outcome.preview = translations.slice(0, 3);
    } catch (error) {
      outcome.error = "响应解析失败";
    }
    return outcome;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  async function runBenchmark(params) {
    const size = clampNumber(params.n, 30, 5, 200);
    const concurrency = clampNumber(params.c, 8, 1, 30);
    const thinking = ["minimal", "low", "medium", "high", "off"].includes(params.thinking)
      ? params.thinking
      : "minimal";
    const report = { size, concurrency, thinking };

    const listed = await listModels();
    report.models = listed.models;
    report.listError = listed.error ? redact(`${listed.error} ${(listed.body || "").slice(0, 200)}`) : "";
    report.model = params.model || config.model || pickModel(listed.models);
    if (!report.model) return report;

    report.single = await translateOnce(report.model, batchLines(size, 0), thinking);
    if (report.single.status !== 200) return report;

    const parallelStart = Date.now();
    report.parallel = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        translateOnce(report.model, batchLines(size, index * 7), thinking)
      )
    );
    report.parallelWallMs = Date.now() - parallelStart;
    const okLatencies = report.parallel.filter((item) => item.ok).map((item) => item.ms);
    report.medianMs = median(okLatencies);
    report.estimates = [300, 1200].map((cues) => {
      const rounds = Math.ceil(cues / size / concurrency);
      return { cues, rounds, seconds: Number(((rounds * report.parallelWallMs) / 1000).toFixed(1)) };
    });
    addEvent("gemini", {
      model: report.model,
      size,
      concurrency,
      singleMs: report.single.ms,
      wallMs: report.parallelWallMs,
      failed: report.parallel.filter((item) => !item.ok).length
    });
    return report;
  }

  // ---------- 报告页 ----------
  const PAGE_STYLE = `
    :root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--ok:#1a7f37;--bad:#c0362c;--accent:#0a66c2}
    @media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f2;--muted:#a1a1a6;--line:#38383a;--ok:#4cc26a;--bad:#ff6b5e;--accent:#5aa9ff}}
    body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
    h1{font-size:22px;margin:4px 0 12px}h2{font-size:17px;margin:24px 0 8px}
    p,li{color:var(--fg)}.muted{color:var(--muted);font-size:13px}
    table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
    th{color:var(--muted);font-weight:500}.ok{color:var(--ok)}.bad{color:var(--bad)}
    a{color:var(--accent)}pre{white-space:pre-wrap;word-break:break-all;font-size:12px;border:1px solid var(--line);padding:8px;border-radius:6px}
    .wrap{overflow-x:auto}`;

  function page(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
      title
    )}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
  }

  function nav() {
    return `<p class="muted"><a href="/__ytdiag/">记录</a> · <a href="/__ytdiag/gemini">Gemini 速度测试</a> · <a href="/__ytdiag/sample">字幕样本</a> · <a href="/__ytdiag/clear">清空记录</a></p>`;
  }

  function eventRow(event) {
    const info = event.info || {};
    let detail = "";
    if (event.type === "timedtext") {
      detail = `${escapeHtml(info.state)} · ${escapeHtml(info.format)} ${info.cues} 条${
        info.wordTags ? `（逐词 ${info.wordTags}）` : ""
      } · lang=${escapeHtml(info.lang)}${info.kind ? ` kind=${escapeHtml(info.kind)}` : ""}${
        info.tlang ? ` tlang=${escapeHtml(info.tlang)}` : ""
      } · 视频 ${escapeHtml(info.v)}${info.sincePlayer !== null && info.sincePlayer !== undefined ? ` · 距打开 ${info.sincePlayer}s` : ""}${
        info.heldMs !== undefined ? ` · 共耗 ${(info.heldMs / 1000).toFixed(1)}s` : ""
      }`;
    } else if (event.type === "player") {
      detail = `${escapeHtml(info.state)} · ${escapeHtml(info.host)} · ${info.bytes} 字节 · 含字幕地址 ${info.captionUrls} 处${
        info.heldMs !== undefined ? ` · 共耗 ${(info.heldMs / 1000).toFixed(1)}s` : ""
      }`;
    } else if (event.type === "gemini") {
      detail = `${escapeHtml(info.model)} · 每批 ${info.size} 条 · 单批 ${(info.singleMs / 1000).toFixed(1)}s · ${
        info.concurrency
      } 并发总耗 ${(info.wallMs / 1000).toFixed(1)}s · 失败 ${info.failed}`;
    }
    return `<tr><td>${formatTime(event.at)}</td><td>${escapeHtml(event.type)}</td><td>${detail}</td></tr>`;
  }

  function indexPage() {
    const events = readEvents();
    const rows = events.length
      ? events.map(eventRow).join("")
      : `<tr><td colspan="3" class="muted">还没有记录。打开一个有字幕的视频并开启字幕后刷新本页。</td></tr>`;
    return page(
      "YouTube 诊断",
      `<h1>YouTube 诊断记录</h1>${nav()}
      <p class="muted">当前设置：字幕延迟 ${config.timedtextDelay}s，播放器延迟 ${config.playerDelay}s，API Key ${
        config.apiKey ? "已填写" : "未填写"
      }。最新在上。</p>
      <div class="wrap"><table><tr><th>时间</th><th>类型</th><th>详情</th></tr>${rows}</table></div>`
    );
  }

  function samplePage() {
    let sample = null;
    try {
      sample = JSON.parse(storeRead(SAMPLE_KEY) || "null");
    } catch (_) {
      sample = null;
    }
    if (!sample) return page("字幕样本", `<h1>字幕样本</h1>${nav()}<p class="muted">还没有抓到字幕请求。</p>`);
    return page(
      "字幕样本",
      `<h1>最近一次字幕</h1>${nav()}<p class="muted">${formatTime(sample.at)}</p>
      <h2>请求地址</h2><pre>${escapeHtml(sample.url)}</pre>
      <h2>解析结果</h2><pre>${escapeHtml(JSON.stringify(sample.info, null, 2))}</pre>
      <h2>响应开头</h2><pre>${escapeHtml(sample.head)}</pre>`
    );
  }

  function benchmarkPage(report) {
    const parts = [`<h1>Gemini 速度测试</h1>`, nav()];
    if (!config.apiKey) {
      parts.push(`<p class="bad">没有 API Key。请在 Loon 插件参数里填写 Gemini API Key 后再打开本页。</p>`);
      return page("Gemini 速度测试", parts.join(""));
    }
    parts.push(
      `<p class="muted">模型 ${escapeHtml(report.model || "未选出")} · 每批 ${report.size} 条 · 并发 ${report.concurrency} · thinking=${escapeHtml(
        report.thinking
      )}。可在网址后加 ?model=xxx&amp;n=30&amp;c=8&amp;thinking=minimal 调整。</p>`
    );
    if (report.listError) parts.push(`<p class="bad">获取模型列表失败：${escapeHtml(report.listError)}</p>`);
    if (!report.model) {
      parts.push(`<p class="bad">没有可用的 Flash 模型，请在网址里用 ?model= 指定。</p>`);
      return page("Gemini 速度测试", parts.join(""));
    }
    const single = report.single;
    parts.push(`<h2>单批</h2>`);
    if (single.status !== 200) {
      parts.push(
        `<p class="bad">失败：HTTP ${single.status} · ${escapeHtml(single.error || "")}</p>${
          single.status === 429 ? `<p>429 表示被限流，通常是免费层额度太低。</p>` : ""
        }`
      );
    } else {
      parts.push(
        `<p class="${single.ok ? "ok" : "bad"}">${(single.ms / 1000).toFixed(2)} 秒 · 返回 ${single.count}/${report.size} 条 · 输出 ${
          single.outTokens
        } tokens · 思考 ${single.thoughtTokens} tokens</p>${single.note ? `<p class="muted">${escapeHtml(single.note)}</p>` : ""}
        <p class="muted">译文示例：${escapeHtml((single.preview || []).join(" / "))}</p>`
      );
    }
    if (report.parallel) {
      const failed = report.parallel.filter((item) => !item.ok);
      const rows = report.parallel
        .map(
          (item, index) =>
            `<tr><td>${index + 1}</td><td>${(item.ms / 1000).toFixed(2)}s</td><td class="${item.ok ? "ok" : "bad"}">${
              item.ok ? `${item.count} 条` : `HTTP ${item.status} ${escapeHtml((item.error || "").slice(0, 80))}`
            }</td></tr>`
        )
        .join("");
      parts.push(
        `<h2>${report.concurrency} 批同时发</h2>
        <p>总耗时 <strong>${(report.parallelWallMs / 1000).toFixed(2)} 秒</strong>，中位数 ${(report.medianMs / 1000).toFixed(
          2
        )} 秒，失败 <span class="${failed.length ? "bad" : "ok"}">${failed.length}</span> 批。</p>
        <div class="wrap"><table><tr><th>#</th><th>耗时</th><th>结果</th></tr>${rows}</table></div>
        <h2>按此速度估算</h2><ul>${report.estimates
          .map((item) => `<li>${item.cues} 条字幕（约 ${item.cues === 300 ? "10–15 分钟" : "1 小时"}视频）：${item.rounds} 轮，约 ${item.seconds} 秒</li>`)
          .join("")}</ul>`
      );
    }
    if (report.models && report.models.length) {
      parts.push(
        `<h2>这个 Key 能用的模型</h2><p class="muted">${report.models
          .map((name) => `<a href="/__ytdiag/gemini?model=${encodeURIComponent(name)}">${escapeHtml(name)}</a>`)
          .join(" · ")}</p>`
      );
    }
    return page("Gemini 速度测试", parts.join(""));
  }

  function respondHtml(html) {
    $done({
      response: {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        body: html
      }
    });
  }

  async function handleDiagPage() {
    const url = $request.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const params = queryParams(url);
    if (path.startsWith("/__ytdiag/gemini")) {
      if (!config.apiKey) return respondHtml(benchmarkPage({}));
      return respondHtml(benchmarkPage(await runBenchmark(params)));
    }
    if (path.startsWith("/__ytdiag/sample")) return respondHtml(samplePage());
    if (path.startsWith("/__ytdiag/clear")) {
      storeWrite("[]", EVENTS_KEY);
      storeWrite("", SAMPLE_KEY);
      return respondHtml(page("已清空", `<h1>已清空</h1>${nav()}`));
    }
    return respondHtml(indexPage());
  }

  // ---------- 入口 ----------
  const url = String((typeof $request === "undefined" ? null : $request)?.url || "");
  let task;
  if (/\/__ytdiag(\/|\?|$)/.test(url)) task = handleDiagPage();
  else if (typeof $response === "undefined") task = Promise.resolve($done({}));
  else if (/\/api\/timedtext/.test(url)) task = handleTimedtext();
  else if (/\/youtubei\/v1\/player/.test(url)) task = handlePlayer();
  else task = Promise.resolve($done({}));

  task.catch((error) => {
    log(`error: ${redact(error?.message || error)}`);
    if (/\/__ytdiag/.test(url)) respondHtml(page("出错", `<h1>出错</h1><pre>${escapeHtml(redact(error?.message || error))}</pre>`));
    else $done({});
  });
})();
