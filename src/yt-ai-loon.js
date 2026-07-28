(function runYouTubeAITranslator() {
  "use strict";

  const Core = globalThis.YTAI;
  const CACHE_KEY = "@YT-AI-Translator.Cache.v1";
  const NOTICE_KEY = "@YT-AI-Translator.LastNotice.v1";
  const LOG_LEVELS = { OFF: 99, ERROR: 40, WARN: 30, INFO: 20, DEBUG: 10 };
  const config = Core.normalizeConfig(typeof $argument === "undefined" ? {} : $argument);
  const executionDeadline = Date.now() + config.maxWaitMs;

  function log(level, message) {
    if ((LOG_LEVELS[level] || 20) < (LOG_LEVELS[config.logLevel] || 20)) return;
    console.log(`[YT-AI][${level}] ${message}`);
  }

  function safeError(error) {
    const message = String(error?.message || error || "unknown error");
    return message
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 240);
  }

  function notifyFallback(message) {
    if (typeof $notification === "undefined" || typeof $notification.post !== "function") return;
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
      $notification.post("YouTube AI 字幕", "已安全回退原字幕", message);
    } catch (_) {
      // Notification failures must never break subtitle playback.
    }
  }

  function doneRequest(url) {
    if (url === $request.url) return $done({});
    return $done({ url });
  }

  function doneResponse(body) {
    if (body === undefined) return $done({});
    const headers = Object.assign({}, $response.headers || {});
    delete headers["Content-Length"];
    delete headers["content-length"];
    delete headers["Transfer-Encoding"];
    delete headers["transfer-encoding"];
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Encoding"] = "identity";
    return $done(Object.assign({}, $response, { headers, body }));
  }

  function httpPost(request) {
    return new Promise((resolve, reject) => {
      if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function") {
        reject(new Error("Loon $httpClient.post is unavailable"));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`API timeout after ${request.timeout}ms`));
      }, request.timeout + 250);
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
          const failure = new Error(`API HTTP ${status || "unknown"}`);
          failure.status = status;
          reject(failure);
          return;
        }
        resolve(String(body || ""));
      });
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function requestConfigWithinDeadline() {
    const remaining = executionDeadline - Date.now();
    if (remaining <= 1000) {
      throw new Error("Translation exceeded the subtitle display deadline");
    }
    return Object.assign({}, config, {
      timeoutMs: Math.min(config.timeoutMs, Math.max(1000, remaining - 500))
    });
  }

  async function translateBatch(batch, languages) {
    let lastError;
    for (let attempt = 0; attempt <= config.retries; attempt += 1) {
      try {
        const requestConfig = requestConfigWithinDeadline();
        if (config.provider === "Gemini") {
          try {
            const request = Core.createGeminiRequest(requestConfig, batch, languages, false);
            const raw = await httpPost(request);
            return Core.validateTranslations(Core.parseGeminiResponse(raw), batch);
          } catch (error) {
            if (![400, 422].includes(error?.status)) throw error;
            log("DEBUG", "Gemini rejected responseFormat; retrying with legacy responseSchema");
            const request = Core.createGeminiRequest(
              requestConfigWithinDeadline(),
              batch,
              languages,
              true
            );
            const raw = await httpPost(request);
            return Core.validateTranslations(Core.parseGeminiResponse(raw), batch);
          }
        }

        try {
          const request = Core.createOpenAIRequest(requestConfig, batch, languages, true);
          const raw = await httpPost(request);
          return Core.validateTranslations(Core.parseOpenAIResponse(raw), batch);
        } catch (error) {
          if (![400, 404, 422].includes(error?.status)) throw error;
          log("DEBUG", "Provider rejected JSON mode; retrying this batch without response_format");
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
        if (attempt < config.retries) await delay(250 * 2 ** attempt);
      }
    }
    throw lastError || new Error("translation failed");
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
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
      () => runWorker()
    );
    await Promise.all(workers);
    return results;
  }

  function loadCache() {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") {
      return { entries: [] };
    }
    try {
      const parsed = JSON.parse($persistentStore.read(CACHE_KEY) || "{\"entries\":[]}");
      return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch (_) {
      return { entries: [] };
    }
  }

  function readCache(key) {
    const cache = loadCache();
    const entry = cache.entries.find((item) => item?.key === key);
    return Array.isArray(entry?.translations) ? entry.translations : null;
  }

  function writeCache(key, translations) {
    if (config.cacheEntries <= 0 || typeof $persistentStore === "undefined") return;
    try {
      const cache = loadCache();
      const entries = cache.entries.filter((item) => item?.key !== key);
      entries.unshift({ key, createdAt: Date.now(), translations });
      while (entries.length > config.cacheEntries) entries.pop();
      let payload = JSON.stringify({ entries });
      while (payload.length > config.cacheMaxChars && entries.length > 1) {
        entries.pop();
        payload = JSON.stringify({ entries });
      }
      if (payload.length <= config.cacheMaxChars) $persistentStore.write(payload, CACHE_KEY);
    } catch (error) {
      log("WARN", `Cache write skipped: ${safeError(error)}`);
    }
  }

  async function handleRequest() {
    const rewritten = Core.rewriteTimedTextRequest($request.url, config);
    if (rewritten.changed) {
      log(
        "INFO",
        `Subtitle request prepared (${rewritten.sourceLanguage} -> ${rewritten.targetLanguage})`
      );
    } else if (rewritten.reason === "missing-config") {
      log("WARN", "API Key or model is empty; keeping YouTube's original request");
    }
    doneRequest(rewritten.url);
  }

  async function handleResponse() {
    if (!Core.shouldProcessResponse($request.url)) {
      doneResponse();
      return;
    }
    if (!Core.isConfigured(config)) {
      log("WARN", "Configuration is incomplete; returning original subtitles");
      doneResponse();
      return;
    }

    let body;
    try {
      body = JSON.parse($response.body || "{}");
    } catch (error) {
      throw new Error(`YouTube JSON3 parse failed: ${safeError(error)}`);
    }
    const cues = Core.extractCues(body);
    if (!cues.length) {
      log("INFO", "No translatable subtitle cues found");
      doneResponse();
      return;
    }

    const languages = Core.responseLanguages($request.url, config);
    const cacheKey = Core.makeCacheKey($request.url, config, cues, languages);
    let translations = readCache(cacheKey);
    if (translations) {
      try {
        translations = Core.validateTranslations({ translations }, cues);
        log("INFO", `Cache hit (${cues.length} cues)`);
      } catch (_) {
        translations = null;
      }
    }

    if (!translations) {
      const batches = Core.chunkCues(cues, config.maxBatchItems, config.maxBatchChars);
      log(
        "INFO",
        `Translating ${cues.length} cues in ${batches.length} batch(es) via ${config.provider}`
      );
      const translatedBatches = await mapLimit(
        batches,
        config.concurrency,
        (batch) => translateBatch(batch, languages)
      );
      translations = translatedBatches.flat();
      translations = Core.validateTranslations({ translations }, cues);
      writeCache(cacheKey, translations);
    }

    const merged = Core.mergeTranslations(body, cues, translations, config);
    doneResponse(JSON.stringify(merged));
  }

  Promise.resolve()
    .then(() => (typeof $response === "undefined" ? handleRequest() : handleResponse()))
    .catch((error) => {
      const message = safeError(error);
      log("ERROR", message);
      notifyFallback(message);
      if (typeof $response === "undefined") doneRequest($request.url);
      else doneResponse();
    });
})();
