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
  assert.match(remotePlugin, /^#!version = 0\.3\.1$/m);
  assert.match(
    remotePlugin,
    /script-path=https:\/\/raw\.githubusercontent\.com\/baitao24\/loon-youtube-ai-translator\/main\/dist\/dualsubs-ai\.bundle\.js/
  );
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
  assert.match(
    plugin,
    /DualSubs\/YouTube\/releases\/download\/v1\.5\.11\/request\.bundle\.js/
  );
  assert.match(plugin, /Type = select,"Official"/);
  assert.match(plugin, /ai_enabled = switch,true/);
  assert.match(plugin, /provider = select,"Gemini","OpenAI-Compatible"/);
  assert.match(plugin, /model = input,"gemini-3\.6-flash"/);
  assert.match(plugin, /Position = select,"Reverse","Forward"/);
  assert.match(plugin, /max_batch_items = select,"250","120","180","300"/);
  assert.match(plugin, /concurrency = select,"4","1","2","3"/);
  assert.match(plugin, /timeout_ms = select,"5200","4000","6000"/);
  assert.match(plugin, /max_wait_ms = select,"6200","5000","5800","6500"/);
  assert.match(plugin, /subtype=Official/);
  const timedTextResponseRule = plugin
    .split("\n")
    .find(
      (line) =>
        line.startsWith("http-response ") &&
        line.includes("\\/api\\/timedtext")
    );
  assert.ok(timedTextResponseRule);
  assert.doesNotMatch(timedTextResponseRule, /subtype=Official/);
  assert.match(plugin, /\[MITM\][\s\S]*youtubei\.googleapis\.com/);
});
