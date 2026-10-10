// The node ids and the name splitter, alone: the prompt path reads them and must not
// pay for the parser tier they used to live beside.
export const fileNode = (path: string): string => `f:${path}`;
export const symbolNode = (path: string, name: string): string => `s:${path}#${name}`;

export type Def = { path: string; name: string };

/** `s:<path>#<name>` → the two halves; a name may hold a dot, a path may hold a hash. */
export const splitSymbol = (id: string): Def | null => {
  const at = id.lastIndexOf("#");
  return id.startsWith("s:") && at > 2 ? { path: id.slice(2, at), name: id.slice(at + 1) } : null;
};

/** The file a node id is about: its own path for a file, the defining file for a symbol. */
export const pathOf = (id: string): string | null =>
  id.startsWith("f:") ? id.slice(2) : (splitSymbol(id)?.path ?? null);

/** `renewLease` → ["renew", "lease"]; `HTTPServer` → ["http", "server"]. */
export function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => w.toLowerCase());
}

/** FTS5 knows the repository since migration 14; a query says which one before its terms. */
export const scoped = (repo: string, query: string): string => `repo:"${repo}" AND (${query})`;

/** The same, over a repository and the branch slice laid over it. */
export const scopedAll = (repos: string[], query: string): string =>
  `(${repos.map((r) => `repo:"${r}"`).join(" OR ")}) AND (${query})`;
