#!/usr/bin/env node
import { guard } from "./guard/run.ts";

// Its own entry, not a `grove` subcommand: this runs before every Bash call, and the
// CLI's import graph costs more than the decision it would be loading for.
try {
  guard(process.argv.slice(2));
} catch {
  process.exit(0);
}
