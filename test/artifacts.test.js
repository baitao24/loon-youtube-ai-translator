const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("generated bundle hash matches manifest and contains both runtimes", async () => {
  const [bundle, legacyBundle, manifestText] = await Promise.all([
    readFile(path.join(projectRoot, "dist/dualsubs-ai.bundle.js"), "utf8"),
    readFile(path.join(projectRoot, "dist/yt-ai.bundle.js"), "utf8"),
    readFile(path.join(projectRoot, "dist/manifest.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256").update(bundle).digest("hex");
  assert.equal(digest, manifest.sha256);
  assert.equal(manifest.upstream.youtube, "v1.5.11");
  assert.equal(manifest.upstream.universalReference, "v1.7.5");
  assert.equal(legacyBundle, bundle);
  assert.equal(manifest.compatibility.bundle, "yt-ai.bundle.js");
  assert.match(bundle, /function createYouTubeAICore/);
  assert.match(bundle, /function runDualSubsAITranslator/);
  assert.doesNotMatch(bundle, /test-secret|openai-secret|gemini-secret/);
});

test("existing public subscription filenames remain valid and use the new runtime", async () => {
  const [remotePlugin, legacyRemotePlugin, localPlugin, legacyLocalPlugin] =
    await Promise.all([
      readFile(
        path.join(projectRoot, "dist/DualSubs.AI.YouTube.remote.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/YouTube.AI.Translate.remote.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/DualSubs.AI.YouTube.local.plugin"),
        "utf8"
      ),
      readFile(
        path.join(projectRoot, "dist/YouTube.AI.Translate.local.plugin"),
        "utf8"
      )
    ]);

  assert.equal(legacyRemotePlugin, remotePlugin);
  assert.equal(legacyLocalPlugin, localPlugin);
  assert.match(remotePlugin, /^#!version = 0\.9\.0$/m);
  // 远程插件必须指向构建时记录的脚本地址（main 或测试分支）
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "dist/manifest.json"), "utf8")
  );
  assert.match(
    manifest.scriptUrl,
    /^https:\/\/raw\.githubusercontent\.com\/baitao24\/loon-youtube-ai-translator\/(main|v0\.4)\/dist\/dualsubs-ai\.bundle\.js$/
  );
  assert.ok(remotePlugin.includes(`script-path=${manifest.scriptUrl},`));
  const responseRule = remotePlugin
    .split("\n")
    .find(
      (line) =>
        line.startsWith("http-response ") &&
        line.includes("\\/api\\/timedtext")
    );
  assert.ok(responseRule);
  assert.doesNotMatch(responseRule, /subtype=Official/);
  assert.match(responseRule, /timedtext\(\\\?\.\+\)\?\$/);
});

test("local plugin pins DualSubs, exposes AI settings, and has no template markers", async () => {
  const plugin = await readFile(
    path.join(projectRoot, "dist/DualSubs.AI.YouTube.local.plugin"),
    "utf8"
  );
  const definitions = new Set(
    [...plugin.matchAll(/^([A-Za-z_]+)\s*=\s*(?:input|select|switch),/gm)].map(
      (match) => match[1]
    )
  );
  const scriptLines = plugin
    .split("\n")
    .filter((line) => line.startsWith("http-"));
  for (const line of scriptLines) {
    for (const match of line.matchAll(/\{([A-Za-z_]+)\}/g)) {
      assert.equal(definitions.has(match[1]), true, `missing argument ${match[1]}`);
    }
  }

  assert.doesNotMatch(plugin, /\{\{SCRIPT_URL\}\}/);
  assert.match(plugin, /script-path=dualsubs-ai\.bundle\.js/);
  // 0.5.1：只拦截字幕接口，不和 YouTube 去广告插件抢 player / get_watch 等接口
  assert.doesNotMatch(plugin, /youtubei|DualSubs\/YouTube\/releases/);
  assert.deepEqual(
    scriptLines.map((line) => line.split(" ")[1]),
    [
      "^https?:\\/\\/(www|m)\\.youtube\\.com\\/api\\/timedtext(\\?.+)?$",
      "^https?:\\/\\/(www|m)\\.youtube\\.com\\/api\\/timedtext(\\?.+)?$",
      "^https?:\\/\\/s\\.youtube\\.com\\/api\\/stats\\/(watchtime|qoe|playback)(\\?.*)?$"
    ]
  );
  assert.match(plugin, /^hostname = www\.youtube\.com, m\.youtube\.com, s\.youtube\.com$/m);
  // 后台续翻只借观看统计请求，不能碰去广告插件拦截的 stats/ads
  const statsRule = new RegExp(scriptLines[2].split(" ")[1]);
  assert.ok(statsRule.test("https://s.youtube.com/api/stats/watchtime?docid=abc&cpn=x"));
  assert.ok(!statsRule.test("https://s.youtube.com/api/stats/ads?ver=2"));
  // 0.5：只保留真正有用的设置项，模型和语言都是下拉选择
  assert.deepEqual([...definitions].sort(), [
    "LogLevel",
    "Position",
    "ShowOnly",
    "ai_enabled",
    "api_key",
    "background_translate",
    "claude_api_key",
    "custom_prompt",
    "deepseek_api_key",
    "model",
    "openai_api_key",
    "sentence_split",
    "target_language"
  ]);
  assert.match(plugin, /^model = select,"gemini-3\.5-flash-lite",/m);
  // 每家至少一个模型，且模型名都能推断出服务商
  const models = plugin.match(/^model = select,(.*?),tag=/m)[1].split(",").map((item) => item.replace(/"/g, ""));
  for (const prefix of ["gemini-", "deepseek-", "gpt-", "claude-"]) {
    assert.ok(models.some((name) => name.startsWith(prefix)), `missing ${prefix} models`);
  }
  assert.match(plugin, /^target_language = select,"简体中文",/m);
  assert.match(plugin, /^Position = select,"原文在上","译文在上"/m);
  assert.doesNotMatch(plugin, /subtype=Official|tlang=|googlevideo/);
  const timedTextResponseRule = plugin
    .split("\n")
    .find(
      (line) =>
        line.startsWith("http-response ") &&
        line.includes("\\/api\\/timedtext")
    );
  assert.ok(timedTextResponseRule);
});
