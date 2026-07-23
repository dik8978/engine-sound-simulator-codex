import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { minify } from "terser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "public");
const outputDir = path.join(root, "docs");

const jsOptions = {
  compress: {
    passes: 2,
    pure_getters: true,
  },
  mangle: true,
  format: {
    comments: false,
  },
};

const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: true,
  rotateStringArray: true,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 9,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.45,
  transformObjectKeys: false,
};

function contentHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>+~])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

async function protectJs(source, name) {
  const minified = await minify(source, jsOptions);
  if (!minified.code) {
    throw new Error(`Failed to minify ${name}`);
  }
  return JavaScriptObfuscator.obfuscate(
    minified.code,
    obfuscatorOptions,
  ).getObfuscatedCode();
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(path.join(sourceDir, "fonts"), path.join(outputDir, "fonts"), {
  recursive: true,
});

const workletSource = await readFile(path.join(sourceDir, "engine-worklet.js"), "utf8");
const protectedWorklet = await protectJs(workletSource, "engine-worklet.js");
const workletFile = `engine-worklet.${contentHash(protectedWorklet)}.js`;
await writeFile(path.join(outputDir, workletFile), protectedWorklet);

const referenceAnalyzerSource = await readFile(path.join(sourceDir, "reference-analyzer.js"), "utf8");
const mainSource = await readFile(path.join(sourceDir, "main.js"), "utf8");
const protectedMainSource = `${referenceAnalyzerSource}\n${mainSource}`.replace(
  /audioCtx\.audioWorklet\.addModule\(['"]engine-worklet\.js['"]\)/,
  `audioCtx.audioWorklet.addModule('${workletFile}')`,
);
const protectedMain = await protectJs(protectedMainSource, "main.js");
const mainFile = `app.${contentHash(protectedMain)}.js`;
await writeFile(path.join(outputDir, mainFile), protectedMain);

const cssSource = await readFile(path.join(sourceDir, "style.css"), "utf8");
const protectedCss = minifyCss(cssSource);
const cssFile = `style.${contentHash(protectedCss)}.css`;
await writeFile(path.join(outputDir, cssFile), protectedCss);

const htmlSource = await readFile(path.join(sourceDir, "index.html"), "utf8");
const protectedHtml = minifyHtml(
  htmlSource
    .replace(
      "<title>Engine Sound Simulator</title>",
      '<title>Engine Sound Simulator</title><meta name="robots" content="noindex,nofollow">',
    )
    .replace('href="style.css"', `href="${cssFile}"`)
    .replace('<script src="reference-analyzer.js"></script>', '')
    .replace('src="main.js"', `src="${mainFile}"`),
);
await writeFile(path.join(outputDir, "index.html"), protectedHtml);

await writeFile(path.join(outputDir, ".nojekyll"), "");
await writeFile(
  path.join(outputDir, "robots.txt"),
  "User-agent: *\nDisallow: /\n",
);

console.log("Protected GitHub Pages assets written to docs/");
