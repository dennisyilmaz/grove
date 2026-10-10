import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Symbol as Definition, SymbolTier } from "./structure.ts";

const MAX_SIGNATURE = 120;

type Node = {
  kind: number;
  pos: number;
  end: number;
  parent?: Node;
  modifiers?: Node[];
  name?: Node & { text?: string; escapedText?: string };
  body?: Node;
  members?: Node[];
  declarationList?: { declarations: Node[] };
  initializer?: Node;
  exportClause?: { elements?: { name: { text: string } }[] };
  moduleSpecifier?: Node;
  expression?: Node & { text?: string };
  getStart(sf: SourceFile): number;
  getText(sf: SourceFile): string;
};
type SourceFile = Node & {
  statements: Node[];
  text: string;
  getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
};
type TS = {
  createSourceFile(
    name: string,
    text: string,
    target: number,
    parents: boolean,
    kind?: number,
  ): SourceFile;
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number; TSX: number; JS: number; JSX: number };
  SyntaxKind: Record<string, number>;
  forEachChild(node: Node, cb: (n: Node) => void): void;
};

/**
 * The repository's own compiler, never one grove ships: the hook must stay dependency-
 * free, and a repo with no `typescript` gets the regex tier. Only ingest may call this.
 */
export function loadTypescript(root: string): TS | null {
  try {
    return createRequire(join(root, "package.json"))("typescript") as TS;
  } catch {
    return null;
  }
}

const collapse = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/,?\s+\)/g, ")")
    .trim();

/** Same body under another name hashes the same, which is what lets an anchor follow a rename. */
export function fingerprintOf(text: string, name: string): string {
  const masked = collapse(text).split(name).join("_");
  return createHash("sha1").update(masked).digest("hex").slice(0, 16);
}

export function tsTier(ts: TS): SymbolTier {
  const k = (name: string): number => ts.SyntaxKind[name] ?? -1;
  const K = {
    ExportDeclaration: k("ExportDeclaration"),
    ExportAssignment: k("ExportAssignment"),
    Identifier: k("Identifier"),
    ArrowFunction: k("ArrowFunction"),
    FunctionExpression: k("FunctionExpression"),
    PrivateKeyword: k("PrivateKeyword"),
    ExportKeyword: k("ExportKeyword"),
    MethodDeclaration: k("MethodDeclaration"),
    GetAccessor: k("GetAccessor"),
    SetAccessor: k("SetAccessor"),
    PropertyDeclaration: k("PropertyDeclaration"),
    FunctionDeclaration: k("FunctionDeclaration"),
    ClassDeclaration: k("ClassDeclaration"),
    InterfaceDeclaration: k("InterfaceDeclaration"),
    TypeAliasDeclaration: k("TypeAliasDeclaration"),
    EnumDeclaration: k("EnumDeclaration"),
    ModuleDeclaration: k("ModuleDeclaration"),
    VariableStatement: k("VariableStatement"),
  };
  const kindOf = (path: string): number => {
    if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  };
  const has = (node: Node, kind: number): boolean =>
    (node.modifiers ?? []).some((m) => m.kind === kind);

  return (path, text) => {
    if (!/\.[cm]?[jt]sx?$/.test(path)) return null;
    let sf: SourceFile;
    try {
      sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kindOf(path));
    } catch {
      return null;
    }
    const lineAt = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const signatureOf = (node: Node, kind: string, name: string): string => {
      const start = node.getStart(sf);
      const stop = node.body ? node.body.getStart(sf) : node.end;
      let sig = collapse(text.slice(start, stop))
        .replace(/^export\s+(default\s+)?/, "")
        .replace(/^declare\s+/, "")
        .replace(/\s*[{=]$/, "");
      if (kind === "const" && node.initializer) {
        const init = node.initializer;
        const arrow = init.kind === K.ArrowFunction || init.kind === K.FunctionExpression;
        const head =
          arrow && init.body ? text.slice(init.getStart(sf), init.body.getStart(sf)) : "";
        sig = collapse(`${name}${head ? ` = ${head}` : ""}`).replace(/\s*[{=]$/, "");
      }
      return sig.length > MAX_SIGNATURE ? `${sig.slice(0, MAX_SIGNATURE - 1)}…` : sig;
    };

    const out: Definition[] = [];
    const exportedLater = new Set<string>();
    for (const st of sf.statements) {
      if (st.kind === K.ExportDeclaration && !st.moduleSpecifier) {
        for (const e of st.exportClause?.elements ?? []) exportedLater.add(e.name.text);
      }
      if (st.kind === K.ExportAssignment && st.expression?.kind === K.Identifier) {
        exportedLater.add(st.expression?.text ?? "");
      }
    }

    const push = (
      node: Node,
      kind: string,
      name: string,
      exported: boolean,
      prefix: string,
    ): void => {
      const full = prefix ? `${prefix}.${name}` : name;
      out.push({
        name: full,
        kind,
        line: lineAt(node.getStart(sf)),
        endLine: lineAt(node.end),
        exported,
        signature: signatureOf(node, kind, name),
        fingerprint: fingerprintOf(node.getText(sf), name),
      });
    };

    const members = (owner: Node, prefix: string, exported: boolean): void => {
      for (const m of owner.members ?? []) {
        const name = m.name?.text ?? m.name?.escapedText;
        if (!name || has(m, K.PrivateKeyword)) continue;
        if (
          m.kind === K.MethodDeclaration ||
          m.kind === K.GetAccessor ||
          m.kind === K.SetAccessor
        ) {
          push(m, "method", name, exported, prefix);
        } else if (m.kind === K.PropertyDeclaration && m.initializer?.kind === K.ArrowFunction) {
          push(m, "method", name, exported, prefix);
        }
      }
    };

    const visit = (st: Node, prefix: string, parentExported: boolean): void => {
      const name = st.name?.text ?? st.name?.escapedText;
      const exported =
        parentExported || has(st, K.ExportKeyword) || (name ? exportedLater.has(name) : false);
      if (st.kind === K.FunctionDeclaration && name) push(st, "function", name, exported, prefix);
      else if (st.kind === K.ClassDeclaration && name) {
        push(st, "class", name, exported, prefix);
        members(st, prefix ? `${prefix}.${name}` : name, exported);
      } else if (st.kind === K.InterfaceDeclaration && name)
        push(st, "interface", name, exported, prefix);
      else if (st.kind === K.TypeAliasDeclaration && name) push(st, "type", name, exported, prefix);
      else if (st.kind === K.EnumDeclaration && name) push(st, "enum", name, exported, prefix);
      else if (st.kind === K.ModuleDeclaration && name) {
        push(st, "mod", name, exported, prefix);
        const body = st.body as (Node & { statements?: Node[] }) | undefined;
        for (const inner of body?.statements ?? [])
          visit(inner, prefix ? `${prefix}.${name}` : name, exported);
      } else if (st.kind === K.VariableStatement) {
        for (const d of st.declarationList?.declarations ?? []) {
          const n = d.name?.text ?? d.name?.escapedText;
          if (n && d.name?.kind === K.Identifier)
            push(d, "const", n, exported || exportedLater.has(n), prefix);
        }
      }
    };
    // A synthesized node from error recovery can throw on position; that file is the
    // regex tier's, not a failed ingest.
    try {
      for (const st of sf.statements) visit(st, "", false);
    } catch {
      return null;
    }
    return out;
  };
}
