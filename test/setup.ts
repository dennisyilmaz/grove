import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A test that logs to the real ~/.grove/cli.log poisons the file the gate is read from.
process.env.GROVE_CLI_LOG ??= "off";

// One test run used to leave dozens of ctx cache files under the real ~/.grove.
const home = mkdtempSync(join(tmpdir(), "grove-test-home-"));
mkdirSync(join(home, ".claude", "projects"), { recursive: true });
process.env.HOME = home;
process.env.GROVE_KNOWLEDGE_DB ??= join(home, ".grove", "knowledge.db");
