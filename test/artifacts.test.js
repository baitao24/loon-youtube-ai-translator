const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("generated bundle hash matches manifest and contains both runtimes", async () => {
  const [bundle, manifestText] = await Promise.all([
    readFile(path.join(projectRoot, "dist/yt-ai.bundle.js"), "utf8"),
    readFile(path.join(projectRoot, "dist/manifest.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256").update(bundle).digest("hex");
  assert.equal(digest, manifest.sha256);
  assert.match(bundle, /function createYouTubeAICore/);
  assert.match(bundle, /function runYouTubeAITranslator/);
  assert.doesNotMatch(bundle, /test-secret|openai-secret|gemini-secret/);
});

test("local Loon plugin has complete arguments, safe defaults, and no template markers", async () => {
  const plugin = await readFile(
    path.join(projectRoot, "dist/YouTube.AI.Translate.local.plugin"),
    "utf8"
  );
  const definitionNames = [...plugin.matchAll(/^([a-z_]+)\s*=\s*(?:input|select|switch),/gm)]
    .map((match) => match[1]);
  const argumentLine = plugin
    .split("\n")
    .find((line) => line.includes("tag=YouTube AI 字幕请求"));
  const referencedNames = [...argumentLine.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);

  assert.deepEqual(referencedNames, definitionNames);
  assert.doesNotMatch(plugin, /\{\{SCRIPT_URL\}\}/);
  assert.match(plugin, /script-path=yt-ai\.bundle\.js/);
  assert.match(plugin, /provider = select,"Gemini","OpenAI-Compatible"/);
  assert.match(plugin, /model = input,"gemini-3\.6-flash"/);
  assert.match(plugin, /concurrency = select,"2","1","3","4"/);
  assert.match(plugin, /retries = select,"2","0","1","3"/);
  assert.match(plugin, /cache_entries = select,"6","0","3","10","20"/);
  assert.match(plugin, /timeout=300/);
  assert.match(plugin, /\[MITM\][\s\S]*www\.youtube\.com, m\.youtube\.com/);
});
