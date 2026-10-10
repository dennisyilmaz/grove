import { execa } from "execa";

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/** Run a project check command via sh -c in the given worktree, capturing interleaved output. */
export async function runCheckCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void,
): Promise<CommandResult> {
  try {
    const result = await execa("sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
      all: true,
      reject: false,
    });
    const output = result.all ?? "";
    if (onOutput && output) onOutput(output);
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode ?? -1,
      output,
      timedOut: result.timedOut ?? false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (onOutput) onOutput(message);
    return { ok: false, exitCode: -1, output: message, timedOut: false };
  }
}
