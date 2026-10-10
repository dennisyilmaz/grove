import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

/**
 * Installing grove as a background service.
 *
 * Until now the only ways to run the daemon were `pnpm dev` and a hand-typed
 * `node packages/core/dist/index.js` — which means it did not survive a logout,
 * and nothing restarted it after a crash. Both platforms get the same contract:
 * start at login, restart on failure, log to grove's own data directory.
 *
 * The unit files are generated from the *current* interpreter and script paths
 * rather than a template with placeholders, because the thing that breaks a
 * hand-written launchd job is always a stale absolute path to a node that a
 * version manager has since moved.
 */

export const SERVICE_LABEL = "com.grove.daemon";
export const SERVICE_NAME = "grove";

export interface ServicePaths {
  /** Absolute path to the node binary the service should run. */
  node: string;
  /** Absolute path to the built daemon entry point. */
  entry: string;
  /** grove's data directory — logs live beside the database. */
  dataDir: string;
}

export function launchAgentPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(home = os.homedir()): string {
  return path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * A launchd agent, not a daemon: grove runs as the logged-in user, drives that
 * user's authenticated Claude Code install, and serves a loopback UI. There is
 * nothing about it that belongs to root.
 */
export function launchAgentPlist(p: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(p.node)}</string>
    <string>--enable-source-maps</string>
    <string>${xmlEscape(p.entry)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart on crash, with launchd's own backoff. A daemon that supervises a
       fleet is worth restarting; a crash loop is visible in the log below. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(p.dataDir)}</string>
  <!-- launchd's stdout would otherwise go nowhere. grove also writes its own
       rotating grove.log; these two catch what starts before the logger does. -->
  <key>StandardOutPath</key><string>${xmlEscape(path.join(p.dataDir, "service.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(p.dataDir, "service.err.log"))}</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GROVE_DATA_DIR</key><string>${xmlEscape(p.dataDir)}</string>
    <!-- The service captures stdout itself; the rotating file stays on because
         it is the one a human is told to read. -->
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin")}</string>
  </dict>
</dict>
</plist>
`;
}

export function systemdUnit(p: ServicePaths): string {
  return `[Unit]
Description=grove — local agent fleet daemon
After=network.target

[Service]
Type=simple
ExecStart=${p.node} --enable-source-maps ${p.entry}
WorkingDirectory=${p.dataDir}
Environment=GROVE_DATA_DIR=${p.dataDir}
Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin"}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface ServiceResult {
  path: string;
  platform: "darwin" | "linux";
  loaded: boolean;
  /** What to run if the load step could not be done for us. */
  hint?: string;
}

/** Write the unit file and ask the OS to load it. */
export async function installService(p: ServicePaths): Promise<ServiceResult> {
  if (process.platform === "darwin") {
    const dest = launchAgentPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.writeFileSync(dest, launchAgentPlist(p));
    // `bootout` first so re-installing picks up a changed plist instead of
    // silently keeping the previously loaded one.
    const domain = `gui/${process.getuid?.() ?? ""}`;
    await execa("launchctl", ["bootout", domain, dest], { reject: false });
    const boot = await execa("launchctl", ["bootstrap", domain, dest], { reject: false });
    return {
      path: dest,
      platform: "darwin",
      loaded: boot.exitCode === 0,
      ...(boot.exitCode === 0 ? {} : { hint: `launchctl bootstrap ${domain} ${dest}` }),
    };
  }
  if (process.platform === "linux") {
    const dest = systemdUnitPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.writeFileSync(dest, systemdUnit(p));
    await execa("systemctl", ["--user", "daemon-reload"], { reject: false });
    const enable = await execa("systemctl", ["--user", "enable", "--now", SERVICE_NAME], {
      reject: false,
    });
    return {
      path: dest,
      platform: "linux",
      loaded: enable.exitCode === 0,
      ...(enable.exitCode === 0 ? {} : { hint: `systemctl --user enable --now ${SERVICE_NAME}` }),
    };
  }
  throw new Error(`no service integration for ${process.platform}`);
}

export async function uninstallService(): Promise<{ path: string; removed: boolean }> {
  if (process.platform === "darwin") {
    const dest = launchAgentPath();
    const domain = `gui/${process.getuid?.() ?? ""}`;
    await execa("launchctl", ["bootout", domain, dest], { reject: false });
    const existed = fs.existsSync(dest);
    fs.rmSync(dest, { force: true });
    return { path: dest, removed: existed };
  }
  if (process.platform === "linux") {
    const dest = systemdUnitPath();
    await execa("systemctl", ["--user", "disable", "--now", SERVICE_NAME], { reject: false });
    const existed = fs.existsSync(dest);
    fs.rmSync(dest, { force: true });
    await execa("systemctl", ["--user", "daemon-reload"], { reject: false });
    return { path: dest, removed: existed };
  }
  throw new Error(`no service integration for ${process.platform}`);
}
