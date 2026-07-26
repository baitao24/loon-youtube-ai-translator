import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const scriptUrlIndex = args.indexOf("--script-url");
const remoteScriptUrl = scriptUrlIndex >= 0 ? args[scriptUrlIndex + 1] : "";

if (scriptUrlIndex >= 0 && !remoteScriptUrl) {
  throw new Error("--script-url requires an HTTPS URL");
}
if (remoteScriptUrl && !/^https:\/\//i.test(remoteScriptUrl)) {
  throw new Error("--script-url must use HTTPS");
}

const pkg = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const core = await readFile(resolve(projectRoot, "src/yt-ai-core.js"), "utf8");
const loon = await readFile(resolve(projectRoot, "src/yt-ai-loon.js"), "utf8");
const pluginTemplate = await readFile(
  resolve(projectRoot, "template/YouTube.AI.Translate.plugin"),
  "utf8"
);

const banner = [
  `// YouTube AI bilingual subtitles for Loon v${pkg.version}`,
  "// OpenAI-Compatible + Gemini native API",
  "// Never logs API keys or full subtitle payloads.",
  ""
].join("\n");
const bundle = `${banner}${core.trim()}\n\n${loon.trim()}\n`;
const sha256 = createHash("sha256").update(bundle).digest("hex");
const distDir = resolve(projectRoot, "dist");
await mkdir(distDir, { recursive: true });
await writeFile(resolve(distDir, "yt-ai.bundle.js"), bundle);

const localPlugin = pluginTemplate
  .replaceAll("{{SCRIPT_URL}}", "yt-ai.bundle.js")
  .replace(/^#!version\s*=.*$/m, `#!version = ${pkg.version}`);
await writeFile(resolve(distDir, "YouTube.AI.Translate.local.plugin"), localPlugin);

if (remoteScriptUrl) {
  const remotePlugin = pluginTemplate
    .replaceAll("{{SCRIPT_URL}}", remoteScriptUrl)
    .replace(/^#!version\s*=.*$/m, `#!version = ${pkg.version}`);
  await writeFile(resolve(distDir, "YouTube.AI.Translate.remote.plugin"), remotePlugin);
} else {
  await rm(resolve(distDir, "YouTube.AI.Translate.remote.plugin"), { force: true });
}

await writeFile(
  resolve(distDir, "manifest.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      bundle: "yt-ai.bundle.js",
      sha256,
      localPlugin: "YouTube.AI.Translate.local.plugin",
      remotePlugin: remoteScriptUrl ? "YouTube.AI.Translate.remote.plugin" : null,
      scriptUrl: remoteScriptUrl || null
    },
    null,
    2
  )}\n`
);

console.log(`Built ${pkg.name} v${pkg.version}`);
console.log(`Bundle SHA-256: ${sha256}`);
