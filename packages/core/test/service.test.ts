import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  launchAgentPath,
  launchAgentPlist,
  SERVICE_LABEL,
  systemdUnit,
  systemdUnitPath,
} from "../src/service.ts";

const paths = {
  node: "/opt/homebrew/Cellar/node/24.4.0/bin/node",
  entry: "/Users/x/grove/packages/core/dist/index.js",
  dataDir: "/Users/x/.grove",
};

describe("launchd agent", () => {
  const plist = launchAgentPlist(paths);

  it("runs the exact interpreter and entry point it was installed with", () => {
    // The classic failure of a hand-written plist is a stale absolute path to a
    // node that a version manager has since moved.
    expect(plist).toContain(`<string>${paths.node}</string>`);
    expect(plist).toContain(`<string>${paths.entry}</string>`);
  });

  it("starts at login and restarts after a crash, but not after a clean exit", () => {
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
  });

  it("captures the output launchd would otherwise discard", () => {
    expect(plist).toContain(path.join(paths.dataDir, "service.out.log"));
    expect(plist).toContain(path.join(paths.dataDir, "service.err.log"));
  });

  it("passes the data dir through, so the service and the CLI agree on it", () => {
    expect(plist).toContain("<key>GROVE_DATA_DIR</key>");
    expect(plist).toContain(`<string>${paths.dataDir}</string>`);
  });

  it("is a user agent, not a root daemon", () => {
    // grove drives the user's authenticated Claude Code install and serves a
    // loopback UI; nothing about it belongs to root.
    expect(launchAgentPath("/Users/x")).toBe(
      `/Users/x/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
    );
  });

  it("escapes a path that would otherwise break the XML", () => {
    const plistWithAmp = launchAgentPlist({ ...paths, dataDir: "/Users/a&b/.grove" });
    expect(plistWithAmp).toContain("/Users/a&amp;b/.grove");
    expect(plistWithAmp).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe("systemd unit", () => {
  const unit = systemdUnit(paths);

  it("restarts on failure with a delay", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5");
  });

  it("runs the same command as launchd does", () => {
    expect(unit).toContain(`ExecStart=${paths.node} --enable-source-maps ${paths.entry}`);
  });

  it("installs into the user's session, not the system's", () => {
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdUnitPath("/home/x")).toBe("/home/x/.config/systemd/user/grove.service");
  });
});
