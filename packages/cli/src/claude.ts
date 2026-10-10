import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Claude Code keeps its own state.
 *
 * Grove reads it; grove never writes to it except under `handoff/`, which is
 * grove's own subdirectory inside the project folder. Notes live there rather
 * than in `~/.grove/` on purpose: they describe one specific transcript, and
 * keeping them beside it means a note can never outlive the session it explains
 * without that being visible.
 */
export const claudeHome = (): string => join(homedir(), ".claude");

/** Claude Code encodes a project's path by replacing every separator with a dash. */
export function projectDir(cwd: string): string {
  return join(claudeHome(), "projects", cwd.replaceAll("/", "-"));
}

export function handoffDir(cwd: string): string {
  return join(projectDir(cwd), "handoff");
}

export type TranscriptFile = { path: string; id: string; modified: Date; created: Date };

/** Every transcript in a project, newest first. */
export function transcripts(cwd: string): TranscriptFile[] {
  let names: string[];
  try {
    names = readdirSync(projectDir(cwd));
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(projectDir(cwd), name);
    try {
      const st = statSync(path);
      out.push({
        path,
        id: name.slice(0, -".jsonl".length),
        modified: st.mtime,
        // `birthtime` is real on APFS; fall back rather than report the epoch.
        created: st.birthtimeMs > 0 ? st.birthtime : st.mtime,
      });
    } catch {
      // Raced with a delete — Claude Code prunes its own transcripts.
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Relative to the repo when inside it, `~`-shortened when not. */
export function relative(path: string, cwd: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const home = homedir();
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export type AgentFile = TranscriptFile & { session: string };

/** Every subagent run from a launch directory, newest first, whichever session ran it. */
export function agentTranscripts(cwd: string): AgentFile[] {
  let names: string[];
  try {
    names = readdirSync(projectDir(cwd));
  } catch {
    return [];
  }
  const out: AgentFile[] = [];
  for (const name of names) {
    if (name.endsWith(".jsonl") || name.startsWith(".")) continue;
    for (const f of agentTranscriptsOf(cwd, name)) out.push({ ...f, session: name });
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The subagents one session ran: `<project>/<session>/subagents/agent-*.jsonl`. */
export function agentTranscriptsOf(cwd: string, sessionID: string): TranscriptFile[] {
  const dir = join(projectDir(cwd), sessionID, "subagents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    try {
      const st = statSync(join(dir, name));
      out.push({
        path: join(dir, name),
        id: name.slice("agent-".length, -".jsonl".length),
        modified: st.mtime,
        created: st.birthtimeMs > 0 ? st.birthtime : st.mtime,
      });
    } catch {
      /* pruned mid-scan */
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
