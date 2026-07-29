(function runDualSubsAITranslator() {
  "use strict";

  const Core = globalThis.YTAI;
  const CACHE_KEY = "@DualSubs-AI.Cache.v1";
  const NOTICE_KEY = "@DualSubs-AI.LastNotice.v1";
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

  function notifyFallback(message) {
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
        "AI 未及时完成，已保留官方双语字幕",
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
          return Core.validateTranslations(Core.parseGeminiResponse(raw), batch);
        }

        try {
          const request = Core.createOpenAIRequest(
            requestConfig,
            batch,
            languages,
            true
          );
          const raw = await httpPost(request);
          return Core.validateTranslations(Core.parseOpenAIResponse(raw), batch);
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
          return Core.validateTranslations(Core.parseOpenAIResponse(raw), batch);
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
      const sourceDocument = Core.parseSubtitleDocument(
        original.body,
        originalContentType
      );
      const languages = Core.responseLanguages($request.url, config);
      const batches = Core.chunkCues(
        sourceDocument.cues,
        config.maxBatchItems,
        config.maxBatchChars
      );
      log(
        "INFO",
        `AI translating ${sourceDocument.cues.length} cues in ${batches.length} batch(es) via ${config.provider}`
      );
      const translatedBatches = await mapLimit(
        batches,
        config.concurrency,
        (batch) => translateBatch(batch, languages)
      );
      const translations = Core.validateTranslations(
        { translations: translatedBatches.flat() },
        sourceDocument.cues
      );
      const aiBody = Core.renderSubtitleDocument(
        sourceDocument,
        translations,
        config
      );
      writeCache(
        responseCacheKey,
        {
          body: aiBody,
          contentType: official.contentType,
          result: "ai"
        },
        86400000
      );
      doneBody(aiBody, official.contentType, "ai");
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
