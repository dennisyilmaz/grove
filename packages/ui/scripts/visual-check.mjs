#!/usr/bin/env node
/**
 * The rendered gate: boot the app's own build, load the probe page in a
 * headless browser, and fail on what came out.
 *
 * This is the answer to a gate that went green while the composer had two focus
 * outlines drawn around it. `tsc`, `biome` and the unit tests are all
 * structurally incapable of seeing that — the collision happens in the CSS
 * cascade at run time, between an unlayered global rule and a layered utility.
 * The only instrument that can answer it is a browser.
 *
 * Deliberately dependency-free beyond what the UI already installs: vite is the
 * project's own dev server, and the browser is the headless Chrome shell that
 * is already on the machine (Playwright's cache, or the system install). No new
 * package, no driver protocol — the page computes its own verdict and the
 * document is dumped once.
 *
 * Exit code 0 = every invariant held. 1 = violations (printed). 2 = the check
 * could not run, which is not the same as passing and must never be reported as
 * green.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");

const VERDICT_ID = "grove-visual-verdict";
const SHOT_DIR = process.env.GROVE_VISUAL_SHOTS ?? path.join(uiRoot, ".visual");

/** Every place a headless Chrome may already exist, cheapest first. */
function findBrowser() {
  if (process.env.GROVE_CHROME) return process.env.GROVE_CHROME;

  const roots = [
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    path.join(os.homedir(), ".cache/ms-playwright"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium"))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const rel of [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-headless-shell-linux/chrome-headless-shell",
        "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chrome-linux/chrome",
      ]) {
        const candidate = path.join(root, dir, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const system of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (fs.existsSync(system)) return system;
  }
  return null;
}

function fail(message) {
  console.error(`visual gate could not run: ${message}`);
  console.error("set GROVE_CHROME to a Chrome/Chromium binary, or install one.");
  process.exit(2);
}

const browser = findBrowser();
if (!browser) fail("no headless Chrome found");

const { createServer } = await import("vite");
const server = await createServer({
  root: uiRoot,
  configFile: path.join(uiRoot, "vite.config.ts"),
  logLevel: "error",
  server: { port: 0, strictPort: false },
});
await server.listen();

const address = server.httpServer?.address();
if (!address || typeof address === "string") {
  await server.close();
  fail("vite did not report a port");
}
// `localhost`, not a literal address: vite binds the IPv6 loopback by default,
// and a hardcoded 127.0.0.1 is refused there. The name resolves to whichever
// family is actually listening.
const url = `http://localhost:${address.port}/visual-probe.html`;

const chromeArgs = (extra) => [
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--virtual-time-budget=8000",
  "--window-size=1200,900",
  ...extra,
  url,
];

try {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // One run produces the screenshot a human can look at; the second dumps the
  // DOM the page wrote its verdict into. Separate runs because the shell does
  // not do both in one invocation.
  await execFileAsync(browser, chromeArgs([`--screenshot=${path.join(SHOT_DIR, "probe.png")}`]), {
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  }).catch(() => {
    // A screenshot is a courtesy; the verdict below is the gate.
  });

  const { stdout } = await execFileAsync(browser, chromeArgs(["--dump-dom"]), {
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const marker = `id="${VERDICT_ID}">`;
  const start = stdout.indexOf(marker);
  if (start === -1) {
    console.error(stdout.slice(0, 2000));
    fail("the probe page never published a verdict (it failed to render)");
  }
  const end = stdout.indexOf("</script>", start);
  const verdict = JSON.parse(stdout.slice(start + marker.length, end));

  if (verdict.ok) {
    console.log(`visual gate: green — every rendered invariant held (${url})`);
    console.log(`screenshot: ${path.join(SHOT_DIR, "probe.png")}`);
    await server.close();
    process.exit(0);
  }

  console.error(`visual gate: RED — ${verdict.violations.length} violation(s)\n`);
  for (const v of verdict.violations) {
    console.error(`  [${v.scene}] ${v.invariant}`);
    console.error(`    element: ${v.element}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(`screenshot: ${path.join(SHOT_DIR, "probe.png")}`);
  await server.close();
  process.exit(1);
} catch (err) {
  await server.close();
  fail(String(err));
}
