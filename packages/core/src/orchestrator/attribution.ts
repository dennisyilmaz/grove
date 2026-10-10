/** "claude-opus-4-8[1m]" → "Opus 4.8 1M context" — for commit trailers and logs. */
export function prettyModelLabel(model: string | null): string {
  if (!model) return "Claude";
  if (model.toLowerCase().startsWith("gemini")) {
    let label = model.replace(/^gemini-?/i, "");
    const oneM = label.includes("[1m]");
    label = label.replace("[1m]", "");
    if (!label) return "Gemini";
    const parts = label
      .split("-")
      .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ")
      .replace(/(\d) (\d)/g, "$1.$2");
    const name = `Gemini ${parts.trim()}`;
    return oneM ? `${name} 1M context` : name;
  }
  let label = model.replace(/^claude-/, "");
  const oneM = label.includes("[1m]");
  label = label.replace("[1m]", "");
  label = label
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2");
  return oneM ? `${label.trim()} 1M context` : label.trim();
}

/**
 * Commit attribution for everything grove produces. Never Claude/Anthropic
 * authorship: sessions get this via the SDK `attribution.commit` setting, and
 * daemon-made commits (checkpoints, fix rounds, gate fixes) append it directly.
 */
export function groveTrailer(model: string | null): string {
  return model ? `Co-Authored-By: grove (${prettyModelLabel(model)})` : "Co-Authored-By: grove";
}
