#!/usr/bin/env node
/**
 * Copy the artifact runtime's libraries out of node_modules into
 * `public/vendor/`, so the sandboxed preview frame loads them from grove's own
 * origin instead of a CDN.
 *
 * Why a copy and not a bundle: every one of these ships a prebuilt UMD/IIFE
 * file that attaches itself to a global, which is exactly the shape the frame
 * needs — it evaluates JSX at runtime against globals, it does not import
 * anything. Bundling them would mean reproducing that global-attaching wrapper
 * ourselves for no gain.
 *
 * Why React 18 and not the 19 the app itself runs: React 19 ships no UMD build.
 * Pinning the frame to 18 keeps a prebuilt file available and keeps Recharts 2
 * and framer-motion 10 on the versions they were written against — the frame is
 * an opaque origin with its own globals, so its React has nothing to do with
 * the app's. `react18`/`react-dom18` are aliased installs for this file alone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");
const modules = path.join(uiRoot, "node_modules");
const outDir = path.join(uiRoot, "public", "vendor");

/**
 * Production builds, deliberately. The CDN version of this shell loaded
 * `react.development.js` — 10× the bytes, dev-only warnings in a frame nobody
 * can open a console on.
 */
const FILES = [
  ["react18/umd/react.production.min.js", "react.js"],
  ["react-dom18/umd/react-dom.production.min.js", "react-dom.js"],
  ["prop-types/prop-types.min.js", "prop-types.js"],
  ["@babel/standalone/babel.min.js", "babel.js"],
  ["lucide-react/dist/umd/lucide-react.min.js", "lucide-react.js"],
  ["recharts/umd/Recharts.js", "recharts.js"],
  ["framer-motion/dist/framer-motion.js", "framer-motion.js"],
  ["@tailwindcss/browser/dist/index.global.js", "tailwind.js"],
];

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
const missing = [];
for (const [from, to] of FILES) {
  const src = path.join(modules, from);
  if (!fs.existsSync(src)) {
    missing.push(from);
    continue;
  }
  fs.copyFileSync(src, path.join(outDir, to));
  copied++;
}

if (missing.length > 0) {
  // Fail the build. A silently missing bundle would ship a preview that stubs
  // half its libraries and blames the network for it.
  console.error(
    `vendor-runtime: missing ${missing.length} file(s) in node_modules:\n  ${missing.join("\n  ")}\n` +
      "Run `pnpm install` in packages/ui.",
  );
  process.exit(1);
}

console.log(`vendor-runtime: ${copied} files → public/vendor/`);
