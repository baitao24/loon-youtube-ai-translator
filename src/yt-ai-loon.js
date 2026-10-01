(function runDualSubsAITranslator() {
  "use strict";

  const Core = globalThis.YTAI;
  const CACHE_KEY = "@DualSubs-AI.Cache.v1";
  const NOTICE_KEY = "@DualSubs-AI.LastNotice.v1";
  // 按视频保存已翻好的 AI 行；没翻完的视频下次请求字幕时只翻剩下的行。
  const ROWS_KEY = "@DualSubs-AI.Rows.v1";
  const ROWS_MAX_CHARS = 400000;
  // 剩余时间不够一批正常耗时（真机 2～3 秒）就不再发新批次。
  const MIN_LAUNCH_MS = 2000;
  const RENDER_RESERVE_MS = 150;
  const LOG_LEVELS = { OFF: 99, ERROR: 40, WARN: 30, INFO: 20, DEBUG: 10 };
  const CLIENT_SAFE_MAX_WAIT_MS = 6200;
  const config = Core.normalizeConfig(
    typeof $argument === "undefined" ? {} : $argument
  );
  const executionDeadline =
    Date.now() + Math.min(config.maxWaitMs, CLIENT_SAFE_MAX_WAIT_MS);

  function log(level, message) {
    if ((LOG_LEVELS[level] || 20) < (LOG_LEVELS[config.logLevel] || 20)) return;
    console.log(`[DualSubs-AI][${level}] ${message}`);
  }

  function safeError(error) {
    return String(error?.message || error || "unknown error")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 220);
  }

  function notifyFallback(message, subtitle) {
    if (typeof $notification === "undefined" || typeof $notification.post !== "function") {
      return;
    }
    const now = Date.now();
    let previous = 0;
    try {
      previous = Number($persistentStore?.read(NOTICE_KEY) || 0);
    } catch (_) {
      previous = 0;
    }
    if (now - previous < 300000) return;
    try {
      $persistentStore?.write(String(now), NOTICE_KEY);
      $notification.post(
        "DualSubs AI 字幕",
        subtitle || "AI 未及时完成，已保留官方双语字幕",
        message
      );
    } catch (_) {
      // Notifications are best-effort and must never block subtitles.
    }
  }

  function sanitizedHeaders(contentType, result, error) {
    const headers = Object.assign({}, $response?.headers || {});
    Object.keys(headers).forEach((key) => {
      if (/^(content-length|transfer-encoding|content-encoding)$/i.test(key)) {
        delete headers[key];
      }
      if (/^content-type$/i.test(key)) delete headers[key];
    });
    if (contentType) headers["content-type"] = contentType;
    headers["content-encoding"] = "identity";
    headers["x-dualsubs-ai-result"] = result;
    if (error) {
      headers["x-dualsubs-ai-error"] = encodeURIComponent(safeError(error)).slice(
        0,
        220
      );
    }
    return headers;
  }

  function doneRequest(url) {
    if (url === $request.url) return $done({});
    return $done({ url });
  }

  function doneBody(body, contentType, result, error) {
    return $done(
      Object.assign({}, $response, {
        headers: sanitizedHeaders(contentType, result, error),
        body
      })
    );
  }

  function donePassthrough(result, error) {
    return $done(
      Object.assign({}, $response, {
        headers: sanitizedHeaders(
          $response?.headers?.["Content-Type"] ||
            $response?.headers?.["content-type"],
          result,
          error
        )
      })
    );
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function remainingTime() {
    return executionDeadline - Date.now();
  }

  function httpGet(request, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof $httpClient === "undefined" || typeof $httpClient.get !== "function") {
        reject(new Error("Loon $httpClient.get is unavailable"));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Original subtitle timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      $httpClient.get(request, (error, response, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error(String(error)));
          return;
        }
        const status = Number(response?.status || response?.statusCode || 0);
        if (status < 200 || status >= 300) {
          reject(new Error(`Original subtitle HTTP ${status || "unknown"}`));
          return;
        }
        resolve({
          body: String(body || ""),
          headers: response?.headers || {}
        });
      });
    });
  }

  function httpPost(request) {
    return new Promise((resolve, reject) => {
      if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function") {
        reject(new Error("Loon $httpClient.post is unavailable"));
        return;
      }
      let settled = false;
      const timeoutMs = Math.min(request.timeout, Math.max(500, remainingTime() - 350));
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`AI timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      $httpClient.post(request, (error, response, body) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error(String(error)));
          return;
        }
        const status = Number(response?.status || response?.statusCode || 0);
        if (status < 200 || status >= 300) {
          const failure = new Error(`AI HTTP ${status || "unknown"}`);
          failure.status = status;
          reject(failure);
          return;
        }
        resolve(String(body || ""));
      });
    });
  }

  function requestConfigWithinDeadline() {
    const remaining = remainingTime();
    if (remaining <= 700) {
      throw new Error("AI translation exceeded the subtitle deadline");
    }
    return Object.assign({}, config, {
      timeoutMs: Math.min(config.timeoutMs, Math.max(500, remaining - 350))
    });
  }

  async function translateBatch(batch, languages) {
    let lastError;
    for (let attempt = 0; attempt <= config.retries; attempt += 1) {
      try {
        const requestConfig = requestConfigWithinDeadline();
        if (config.provider === "Gemini") {
          const request = Core.createGeminiRequest(
            requestConfig,
            batch,
            languages,
            true
          );
          const raw = await httpPost(request);
          return Core.salvageTranslations(Core.parseGeminiResponse(raw), batch);
        }

        try {
          const request = Core.createOpenAIRequest(
            requestConfig,
            batch,
            languages,
            true
          );
          const raw = await httpPost(request);
          return Core.salvageTranslations(Core.parseOpenAIResponse(raw), batch);
        } catch (error) {
          if (![400, 404, 422].includes(error?.status)) throw error;
          log("DEBUG", "JSON mode rejected; retrying without response_format");
          const request = Core.createOpenAIRequest(
            requestConfigWithinDeadline(),
            batch,
            languages,
            false
          );
          const raw = await httpPost(request);
          return Core.salvageTranslations(Core.parseOpenAIResponse(raw), batch);
        }
      } catch (error) {
        lastError = error;
        if (attempt < config.retries) await delay(160 * 2 ** attempt);
      }
    }
    throw lastError || new Error("AI translation failed");
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function runWorker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }
    const workerCount = Math.min(
      Math.max(1, limit),
      Math.max(1, items.length)
    );
    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker())
    );
    return results;
  }

  // 在截止时间前尽量多翻：按时间顺序派发批次，到点就带着已完成的行返回，
  // 不等仍在途的请求。单批失败不影响其他批次。
  async function translateWithinDeadline(batches, languages) {
    const rows = [];
    const failures = [];
    let nextIndex = 0;
    let finished = false;
    async function runWorker() {
      while (!finished && nextIndex < batches.length) {
        if (remainingTime() < MIN_LAUNCH_MS) return;
        const batch = batches[nextIndex];
        nextIndex += 1;
        try {
          const translated = await translateBatch(batch, languages);
          if (!finished) rows.push(...translated);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    const workerCount = Math.min(config.concurrency, Math.max(1, batches.length));
    const workers = Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    let timer;
    await Promise.race([
      workers,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, remainingTime() - RENDER_RESERVE_MS));
      })
    ]);
    clearTimeout(timer);
    finished = true;
    return { rows: rows.slice(), failures, launched: nextIndex };
  }

  function loadRowStore() {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return [];
    try {
      const parsed = JSON.parse($persistentStore.read(ROWS_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function readRows(key) {
    const entry = loadRowStore().find((item) => item?.key === key);
    return new Map(Object.entries(entry?.rows || {}));
  }

  function writeRows(key, rows) {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return;
    try {
      const entries = loadRowStore().filter((item) => item?.key !== key);
      entries.unshift({ key, updatedAt: Date.now(), rows: Object.fromEntries(rows) });
      while (entries.length > config.cacheEntries) entries.pop();
      let payload = JSON.stringify(entries);
      while (payload.length > ROWS_MAX_CHARS && entries.length > 1) {
        entries.pop();
        payload = JSON.stringify(entries);
      }
      if (payload.length <= ROWS_MAX_CHARS) $persistentStore.write(payload, ROWS_KEY);
    } catch (error) {
      log("WARN", `Row cache write skipped: ${safeError(error)}`);
    }
  }

  function loadCache() {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") {
      return { entries: [] };
    }
    try {
      const parsed = JSON.parse(
        $persistentStore.read(CACHE_KEY) || "{\"entries\":[]}"
      );
      return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch (_) {
      return { entries: [] };
    }
  }

  function readCache(key) {
    const now = Date.now();
    const cache = loadCache();
    const entry = cache.entries.find(
      (item) =>
        item?.key === key &&
        typeof item?.body === "string" &&
        (!item.expiresAt || item.expiresAt > now)
    );
    return entry || null;
  }

  function writeCache(key, value, ttlMs) {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return;
    try {
      const cache = loadCache();
      const entries = cache.entries.filter((item) => item?.key !== key);
      entries.unshift(
        Object.assign(
          {
            key,
            createdAt: Date.now(),
            expiresAt: ttlMs ? Date.now() + ttlMs : 0
          },
          value
        )
      );
      while (entries.length > config.cacheEntries) entries.pop();
      let payload = JSON.stringify({ entries });
      while (payload.length > config.cacheMaxChars && entries.length > 1) {
        entries.pop();
        payload = JSON.stringify({ entries });
      }
      if (payload.length <= config.cacheMaxChars) {
        $persistentStore.write(payload, CACHE_KEY);
      }
    } catch (error) {
      log("WARN", `Cache write skipped: ${safeError(error)}`);
    }
  }

  function requestHeadersForOriginal() {
    const headers = Object.assign({}, $request.headers || {});
    Object.keys(headers).forEach((key) => {
      if (/^(content-length|accept-encoding|host)$/i.test(key)) delete headers[key];
    });
    return headers;
  }

  async function handleRequest() {
    const prepared = Core.prepareDualSubsRequest($request.url, config);
    if (prepared.changed) {
      log(
        "INFO",
        `Official bilingual baseline prepared (${prepared.sourceLanguage} -> ${prepared.targetLanguage})`
      );
    }
    doneRequest(prepared.url);
  }

  async function handleResponse() {
    if (!Core.isDualSubsResponse($request.url)) {
      donePassthrough("skipped");
      return;
    }

    const translatedBody = String($response.body || "");
    const translatedContentType =
      $response.headers?.["Content-Type"] ||
      $response.headers?.["content-type"] ||
      "";
    const responseCacheKey = Core.makeResponseCacheKey(
      $request.url,
      translatedBody,
      config
    );
    const cached = readCache(responseCacheKey);
    if (cached) {
      log("INFO", `Final subtitle cache hit (${cached.result})`);
      doneBody(cached.body, cached.contentType, `cache-${cached.result}`);
      return;
    }

    const originalUrl = Core.originalSubtitleUrl($request.url);
    const originalTimeout = Math.min(
      config.originalFetchTimeoutMs,
      Math.max(500, remainingTime() - 900)
    );
    let original;
    try {
      original = await httpGet(
        { url: originalUrl, headers: requestHeadersForOriginal() },
        originalTimeout
      );
    } catch (error) {
      log("ERROR", safeError(error));
      donePassthrough("official-only", error);
      return;
    }

    const originalContentType =
      original.headers?.["Content-Type"] ||
      original.headers?.["content-type"] ||
      translatedContentType;
    let official;
    try {
      official = Core.composeOfficialSubtitles(
        original.body,
        originalContentType,
        translatedBody,
        translatedContentType,
        config
      );
      log(
        "INFO",
        `Official bilingual baseline ready (${official.matchedCues}/${official.sourceCues.length})`
      );
    } catch (error) {
      log("ERROR", safeError(error));
      donePassthrough("official-only", error);
      return;
    }

    if (!config.aiEnabled || !Core.isConfigured(config)) {
      const reason = config.aiEnabled ? "AI configuration is incomplete" : "AI disabled";
      log("INFO", `${reason}; using official bilingual subtitles`);
      writeCache(
        responseCacheKey,
        {
          body: official.body,
          contentType: official.contentType,
          result: "official"
        },
        3600000
      );
      doneBody(official.body, official.contentType, "official");
      return;
    }

    try {
      const sourceDocument = official.sourceDocument;
      const languages = Core.responseLanguages($request.url, config);
      const rowsKey = Core.makeCacheKey($request.url, config, sourceDocument.cues, languages);
      const known = readRows(rowsKey);
      const pending = sourceDocument.cues.filter((cue) => !known.has(String(cue.id)));
      const batches = Core.chunkCues(pending, config.maxBatchItems, config.maxBatchChars);
      log(
        "INFO",
        `AI translating ${pending.length}/${sourceDocument.cues.length} cues in ${batches.length} batch(es) via ${config.provider}`
      );
      const outcome = batches.length
        ? await translateWithinDeadline(batches, languages)
        : { rows: [], failures: [], launched: 0 };
      outcome.rows.forEach((row) => known.set(String(row.id), row.text));
      if (outcome.rows.length) writeRows(rowsKey, known);

      const aiRows = sourceDocument.cues
        .filter((cue) => known.has(String(cue.id)))
        .map((cue) => ({ id: cue.id, text: known.get(String(cue.id)) }));
      if (!aiRows.length) {
        throw outcome.failures[0] || new Error("AI produced no rows before the subtitle deadline");
      }
      const complete = aiRows.length === sourceDocument.cues.length;
      const aiBody = Core.renderSubtitleDocument(
        sourceDocument,
        Core.mergeTranslationRows(official.translations, aiRows),
        config
      );
      const percent = Math.floor((aiRows.length / sourceDocument.cues.length) * 100);
      log(
        "INFO",
        `AI rows ${aiRows.length}/${sourceDocument.cues.length} (${percent}%), ` +
          `new ${outcome.rows.length}, failed batches ${outcome.failures.length}, ` +
          `${Date.now() - (executionDeadline - Math.min(config.maxWaitMs, CLIENT_SAFE_MAX_WAIT_MS))}ms`
      );
      if (complete) {
        writeCache(
          responseCacheKey,
          {
            body: aiBody,
            contentType: official.contentType,
            result: "ai"
          },
          86400000
        );
      } else {
        notifyFallback(
          `已用 AI 翻译 ${percent}%，其余为官方译文。关闭再打开字幕会继续翻译剩下的部分。`,
          "AI 字幕部分完成"
        );
      }
      doneBody(aiBody, official.contentType, complete ? "ai" : "ai-partial");
    } catch (error) {
      const message = safeError(error);
      log("WARN", `${message}; using official bilingual subtitles`);
      notifyFallback(message);
      writeCache(
        responseCacheKey,
        {
          body: official.body,
          contentType: official.contentType,
          result: "official-fallback"
        },
        30000
      );
      doneBody(
        official.body,
        official.contentType,
        "official-fallback",
        message
      );
    }
  }

  Promise.resolve()
    .then(() =>
      typeof $response === "undefined" ? handleRequest() : handleResponse()
    )
    .catch((error) => {
      const message = safeError(error);
      log("ERROR", message);
      if (typeof $response === "undefined") doneRequest($request.url);
      else donePassthrough("official-only", message);
    });
})();
