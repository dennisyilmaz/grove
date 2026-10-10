/**
 * The model string as the Claude Agent SDK wants it, or `undefined` to let the
 * install's own default stand.
 *
 * grove drives the user's authenticated Claude Code install, so the value is
 * either a Claude alias (`opus`, `sonnet`, `haiku`) or a pinned Claude model id
 * — there is no vendor translation layer here, and inventing one would mean the
 * UI naming a model grove cannot actually run. The only thing worth normalising
 * is the absence of a choice: blank, whitespace, or the literal "default" all
 * mean "no override", and handing any of those to the SDK is an error rather
 * than a default.
 *
 * Applied at every boundary where a stored or user-supplied string reaches the
 * SDK (the fleet driver and the orchestrator turn), so neither has to trust the
 * other to have cleaned it.
 */
export function normalizeModelForSdk(model: string | undefined | null): string | undefined {
  const m = model?.trim();
  if (!m || m.toLowerCase() === "default") return undefined;
  return m;
}
