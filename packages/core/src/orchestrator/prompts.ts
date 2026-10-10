import type { Plan, PlanWorker, Project, Task } from "@grove/shared";
import { PLAN_FILENAME } from "@grove/shared";

/** The "## Where you are" block every worktree-bound session starts with. */
function whereYouAre(worktreeRoot: string, mainRepoPath: string): string[] {
  return [
    `## Where you are`,
    `Your current working directory is an ISOLATED GIT WORKTREE at \`${worktreeRoot}\`. Treat it as the repository root; do all reading and writing here, with relative paths.`,
    `The primary checkout of this repository lives at \`${mainRepoPath}\`. You may see that path in git metadata or file contents — it is OFF-LIMITS. Never read from it (it may be on a different revision) and never write to it (writes there are denied and waste a turn).`,
  ];
}

export function plannerPrompt(
  task: Task,
  project: Project,
  worktreeRoot: string,
  rejectionNote?: string,
): string {
  return [
    `You are the planning session for a coding task in the repository at your working directory.`,
    ``,
    ...whereYouAre(worktreeRoot, project.repoPath),
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `${task.description}`,
    ``,
    `## Your job`,
    `Explore the repository (read-only) and produce a work plan as a JSON file at exactly \`${PLAN_FILENAME}\` in the repo root — i.e. \`${worktreeRoot}/${PLAN_FILENAME}\`. That file is the ONLY thing you may write.`,
    ``,
    // A design the human already approved is settled, so the planner's job on it
    // is narrower: plan how to BUILD it. It is not asked to restate the artifact
    // — the daemon stamps the approved one into the plan itself.
    task.design
      ? [
          `## The design is already decided — plan how to build THIS`,
          `A human has approved the interface below and the daemon has bound it to this task. It is not a suggestion and not a starting point: it is what ships.`,
          `- Do NOT emit an "artifact" field. The daemon puts this exact design into the plan; anything you drew would be discarded.`,
          `- Plan the implementation OF it: which real components, tokens and files have to change to make the repository look and behave like this, and how that splits into workers.`,
          `- If it cannot be built as drawn (it needs a token that does not exist, a component that cannot flex that way), say so in "outOfScope" rather than quietly planning something else.`,
          task.design.notes ? `\nDesigner's notes: ${task.design.notes}` : ``,
          `\nTitle: ${task.design.title}`,
          `\`\`\`jsx\n${task.design.content.slice(0, 16_000)}\n\`\`\``,
          ``,
        ]
          .filter((line) => line !== ``)
          .join("\n")
      : ``,
    `Every plan uses the SAME structured shape so it reads identically each time. Keep every field CONCISE — short phrases and small bullet lists, never a long run-on paragraph.`,
    ``,
    `The JSON shape:`,
    `{`,
    `  "approach": "<ONE or TWO sentences summarizing the overall approach. A summary only — the detail goes in steps.>",`,
    `  "surface": "<'logical' | 'visual' | 'mixed' — declare 'visual' or 'mixed' whenever write scopes touch UI components, CSS, views, or layout templates>",`,
    `  "steps": [`,
    `    { "title": "<short step heading, e.g. 'Backend feed' or 'Header UI'>", "detail": "<a markdown STRING (not a JSON array) — 1–3 sentences or a short newline-separated '- ' bullet list. NOT a wall of text.>" }`,
    `  ],`,
    `  "workers": [`,
    `    { "id": "w1", "title": "<slice name>", "scope": ["<glob>", ...], "complexity": "low|medium|high", "notes": "<a markdown STRING (not a JSON array) — concise slice guidance, a few newline-separated '- ' bullets, not a paragraph>" }`,
    `  ],`,
    `  "mergeOrder": ["w1", ...],`,
    `  "outOfScope": "<what deliberately isn't being done — concise>",`,
    `  "diagram": "<optional: mermaid source (e.g. flowchart TD, sequenceDiagram) visualizing logical flows or interactions. Omit for visual/UI tasks where mermaid carries no signal>",`,
    `  "artifact": {`,
    `    "title": "<what this shows, e.g. 'Composer — empty, typing, sending'>",`,
    `    "type": "react",`,
    `    "content": "<a COMPLETE self-contained JSX module, default-exporting one component that renders the proposed interface. See the artifact rules below.>",`,
    `    "notes": "<optional: the design decisions a reviewer should push back on>"`,
    `  }`,
    `}`,
    ``,
    `Rules:`,
    `- Always fill "steps": 2–6 short, titled steps that together describe the whole change. This is the body of the plan.`,
    `- Scope globs are relative to the repo root and define each worker's WRITE boundary; everything else is read-only to that worker.`,
    `- Declare "surface" as "visual" or "mixed" if any worker scope touches UI files (*.tsx, *.css, components/**, etc.).`,
    task.design
      ? `- "artifact" is already settled for this task (see the approved design above) — omit the field entirely.`
      : `- For visual or mixed surfaces "artifact" is REQUIRED, and it is the most important field in the plan: a human is going to look at the running interface and approve or reject THAT, not your prose. A plan on a rendered surface with no artifact is rejected and sent back to you. Do NOT emit a mermaid diagram for a purely visual change; a flowchart cannot show whether a control is right on hover.`,
    task.design
      ? ``
      : `- The artifact renders in a sandboxed frame with React 18, Tailwind (utility classes), lucide-react icons, Recharts and Framer Motion already available as globals — write JSX as if they were imported, do NOT emit import statements, and default-export the root component. Nothing else is installable, and the frame cannot reach the network or the repository.`,
    task.design
      ? ``
      : `- Because it cannot import from the repository, the artifact must RESTATE the relevant styling rather than reference it: read the real components and design tokens, then reproduce their look with concrete Tailwind classes. It is a faithful drawing of the change, not the change itself.`,
    task.design
      ? ``
      : `- Show the states that decide the design in ONE artifact — a rest row above a hovered row above the narrow variant, labelled — rather than describing them. Interactivity is welcome where it is the point (a control that opens, a field that fills).`,
    `- Scopes must be disjoint: no file may match two workers' scopes, including files a worker might create.`,
    `- Prefer ONE worker. Split into parallel workers (max ${3}) only when slices are genuinely independent.`,
    `- Scope dependency manifests (package.json, lockfiles) to a single worker if they must change.`,
    `- Rate each worker's "complexity" honestly — it selects the implementation model. "low" means a mechanical, well-specified edit a careful junior would get right first try (a rename, a copy change, a config value, adding a case to an existing switch). "medium" is ordinary feature work inside one module. "high" is anything needing design judgment, cross-module reasoning, tricky concurrency or state, or where you are unsure. When torn, choose the higher one: an over-rated slice costs a little money, an under-rated one costs a wrong implementation and another round.`,
    `- Do not implement anything; only plan.`,
    rejectionNote
      ? `\n## Reviewer feedback on your previous plan (address it)\n${rejectionNote}`
      : ``,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

/**
 * The design round: one scoped session that turns a visual plan into an artifact
 * a human can look at, before the fleet spends anything implementing it.
 *
 * Its write scope is computed by the daemon (`deriveDesignWorkerScope`), not by
 * this prompt — the prompt asks, the daemon disposes.
 */
export function designPrompt(
  task: Task,
  plan: Plan,
  loc: { worktreeRoot: string; mainRepoPath: string },
  opts: {
    scope: readonly string[];
    artifactFile: string;
    metaFile: string;
    trailer?: string;
    rejectionNote?: string;
    /** Why the previous attempt's artifact was unusable. */
    artifactError?: string;
  },
): string {
  return [
    `You are the DESIGN session for a task whose plan changes a rendered interface. You are in an isolated git worktree on the task's design branch; the daemon handles all git integration — do NOT merge, open pull requests, or switch branches.`,
    ``,
    ...whereYouAre(loc.worktreeRoot, loc.mainRepoPath),
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `${task.description}`,
    ``,
    `## Approved plan (approach)`,
    plan.approach,
    plan.outOfScope ? `\nOut of scope: ${plan.outOfScope}` : ``,
    ``,
    `## Why this round exists`,
    `A description of an interface is not a faithful proxy for it: "a compact header row with a + action" describes the version you want and the version you'd reject equally well. So before the implementation fleet runs, you produce the interface as something a human can LOOK AT, and they approve or reject that. If they approve, YOUR COMMIT BECOMES THE BASE the implementation workers build on — nobody re-derives this design from prose later.`,
    ``,
    `## What to produce`,
    `1. **The artifact** — write \`${opts.artifactFile}\`: a complete, self-contained JSX module that renders the proposed interface.`,
    `2. **Its metadata** — write \`${opts.metaFile}\`: \`{ "title": "...", "type": "react", "notes": "..." }\`. \`notes\` is where you say which design decisions a reviewer should push back on.`,
    `3. **The real code, where it is cheap and certain.** Anything inside your write scope that the design obviously implies — a token, a class, a component's markup — belongs in this commit too, because approval binds it as the base. Do not attempt the whole feature; the fleet does that.`,
    ``,
    `## The artifact's runtime (read this before writing it)`,
    `It renders in a sandboxed frame, not in your repository. Available as globals: React 18 (all hooks), Tailwind utility classes, lucide-react icons, Recharts, Framer Motion. Nothing else, no network, no filesystem, and NO imports from the repo.`,
    `- Emit NO import statements. Write JSX as if React, the icons and the chart components were already in scope.`,
    `- Default-export exactly one root component: \`export default function Something() { … }\`.`,
    `- Because it cannot import the real components, RESTATE their look: read the actual components and design tokens in the repo, then reproduce them with concrete Tailwind classes and hex/oklch values. A faithful drawing beats an approximation that invents its own visual language.`,
    `- Put the states that decide the design in the ONE artifact, labelled: rest above hover above focus above the narrow variant. A single rest-state mock-up hides exactly the defects this review exists to catch. Make it interactive where interactivity is the point.`,
    `- It must render standalone: no props, no external data. Hard-code representative content.`,
    ``,
    plan.artifact
      ? `## The plan already carries an artifact — improve it, don't restart\nTitle: ${plan.artifact.title}\n\`\`\`jsx\n${plan.artifact.content.slice(0, 12_000)}\n\`\`\``
      : ``,
    `## Definition of done`,
    `- \`${opts.artifactFile}\` exists, is valid JSX, and renders the proposed interface standalone.`,
    `- \`${opts.metaFile}\` exists with at least a title.`,
    `- Commit your work with clear messages (the daemon also checkpoints uncommitted changes).`,
    opts.trailer
      ? `- Commit authorship: never add a Claude or Anthropic co-author trailer. If you include a co-author trailer, it must be exactly: ${opts.trailer}`
      : ``,
    `- Your final message says what you built and which decisions a human might disagree with — that is what they are about to approve or reject.`,
    ``,
    `## Output contract (mandatory)`,
    `End your final message with a fenced json block, exactly this shape:`,
    "```json",
    `{"status": "changed|blocked", "summary": "..."}`,
    "```",
    `There is no "no_changes_needed" here: this round exists to produce an artifact, so a tree that already satisfies the plan still needs one written.`,
    opts.artifactError
      ? `\n## Your previous attempt's artifact could not be used (fix this)\n${opts.artifactError}`
      : ``,
    opts.rejectionNote
      ? `\n## A human reviewed the previous design and rejected it, saying (address it)\n${opts.rejectionNote}`
      : ``,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

export function workerPrompt(
  task: Task,
  plan: Plan,
  worker: PlanWorker,
  loc: { worktreeRoot: string; mainRepoPath: string },
  opts: { trailer?: string; retryNote?: string } = {},
): string {
  const { trailer, retryNote } = opts;
  return [
    `You are an implementation worker on a coding task. You are in an isolated git worktree on your own branch; the daemon handles all git integration — do NOT merge into the base branch, open pull requests, or switch branches.`,
    `You may read from the remote freely: \`git fetch\`, \`git log origin/<branch>\`, and \`gh pr view\` / \`gh pr diff\` all work, which is how you inspect base or another branch's work.`,
    `To publish your own branch, run \`grove-push\` — no arguments, and it pushes THIS branch only. \`git push\` is denied precisely so nothing can push anywhere else. It publishes commits, so commit first if you want your latest work on the remote.`,
    ``,
    ...whereYouAre(loc.worktreeRoot, loc.mainRepoPath),
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `${task.description}`,
    ``,
    `## Approved plan (approach)`,
    plan.approach,
    plan.outOfScope ? `\nOut of scope: ${plan.outOfScope}` : ``,
    ``,
    // The artifact is what the human actually approved — for a UI slice it is
    // more specific than any sentence in the plan, and shipping something that
    // does not match it is the drift the design gate exists to prevent.
    plan.artifact
      ? [
          `## The approved design (this is what the human signed off)`,
          `A human looked at the rendered artifact below and approved THAT. Your implementation must match it: the same layout, spacing, states and affordances. Where it and the prose disagree, the artifact wins. Where it is silent, follow the repository's existing components and tokens.`,
          // A design the human drew and bound to the task is the tightest contract
          // in the pipeline: they are not asking for something in this spirit,
          // they are asking for this. Say so, or "map it to the repo's tokens"
          // reads as licence to redesign it.
          plan.artifact.source === "human"
            ? `THIS ONE THE HUMAN DREW THEMSELVES and attached to the task. Treat every visible decision in it as specified: proportions, radii, spacing, sizes, states, wording, and which controls exist. Do not add controls it does not have, remove ones it does, or "improve" its layout. Colour is the one place to reconcile with the repository — use the existing design tokens for the same ROLES the drawing uses (surface, border, accent, muted text) rather than its literal hex values, and keep everything else exactly as drawn. If a decision in it genuinely cannot be expressed with this repository's components, do not silently substitute one: implement everything else and say what you could not match in your final message.`
            : ``,
          plan.artifact.notes ? `\nDesigner's notes: ${plan.artifact.notes}` : ``,
          `\n\`\`\`jsx\n${plan.artifact.content.slice(0, 20_000)}\n\`\`\``,
          `\nIt is a self-contained drawing built to render standalone, so do NOT copy it in verbatim: reproduce its result using the real components, tokens and utilities of this repository.`,
          ``,
        ]
          .filter((line) => line !== ``)
          .join("\n")
      : ``,
    `## Your slice: ${worker.title}`,
    worker.notes ? `${worker.notes}\n` : ``,
    `Your write scope (enforced): ${worker.scope.join(", ")}`,
    `Files outside your scope are read-only context. If your slice seems to require writing outside it, stop and explain why in your final message instead of working around the boundary.`,
    ``,
    `## Definition of done`,
    `- The slice is implemented and complete.`,
    `- Commit your work with clear messages (the daemon also checkpoints uncommitted changes).`,
    trailer
      ? `- Commit authorship: never add a Claude or Anthropic co-author trailer. If you include a co-author trailer, it must be exactly: ${trailer}`
      : ``,
    `- Your final message states plainly what you changed and anything a reviewer should know.`,
    ``,
    `## Output contract (mandatory)`,
    `End your final message with a fenced json block, exactly this shape:`,
    "```json",
    `{"status": "changed|no_changes_needed|blocked", "summary": "..."}`,
    "```",
    `- "changed": you edited files. The normal case.`,
    `- "no_changes_needed": you verified the tree ALREADY satisfies this slice, so no edit is warranted. Only legitimate with evidence — put it in "summary" (the command you ran and its result, or what you read). This is a real completed outcome, not a failure.`,
    `- "blocked": you could not complete the slice. Say why in "summary". Never dress a blocker up as "no_changes_needed".`,
    retryNote
      ? `\n## The human operator retried this slice and said (address it)\n${retryNote}`
      : ``,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

export function reviewerPrompt(
  task: Task,
  sliceTitle: string,
  changedFiles: string[],
  diffText: string,
): string {
  return [
    `You are a fresh-eyes code reviewer. You did not write this change. Review the diff below for correctness: bugs, broken behavior, requirement gaps against the task. Ignore style preferences.`,
    ``,
    `## Task being implemented`,
    `Title: ${task.title}`,
    `${task.description}`,
    ``,
    `## Slice under review: ${sliceTitle}`,
    `Changed files: ${changedFiles.join(", ") || "(none)"}`,
    ``,
    `You may read any file in the worktree for context. The authoritative diff:`,
    ``,
    "```diff",
    diffText,
    "```",
    ``,
    `## Output contract (mandatory)`,
    `End your final message with a fenced json block, exactly this shape:`,
    "```json",
    `{"findings": [{"severity": "error|warning|info", "action": "fix|escalate|note", "title": "...", "body": "...", "file": "path-or-null", "line": null}]}`,
    "```",
    `- "fix": a defect the implementer can and should fix now (use with severity "error").`,
    `- "escalate": needs a human judgment call.`,
    `- "note": informational; does not block.`,
    `An empty findings array means the diff is clean. Report real defects only — do not pad.`,
  ].join("\n");
}

/** Wrapper for guidance pushed into a LIVE session's input stream. */
export function liveGuidance(body: string): string {
  return [
    `[Message from the human operator — read now and incorporate into your current work]`,
    body,
  ].join("\n");
}

/** Prompt section for guidance that arrived while no session was active. */
export function guidanceBlock(bodies: string[]): string {
  return [
    `## Guidance from the human operator (arrived before this session started — honor it)`,
    ...bodies.map((b) => `- ${b}`),
  ].join("\n");
}

/**
 * Conflict resolution is an editing job, not a git job: the session edits the
 * conflicted files in place and the daemon stages and commits the merge. Git
 * stays entirely in the daemon's hands, and the resolution is verified by
 * scanning for leftover markers rather than by believing the session.
 */
export function mergeConflictPrompt(ref: string, files: string[], operatorNote?: string): string {
  return [
    `A merge of \`${ref}\` into this branch stopped with conflicts. Your job is to resolve them.`,
    ``,
    `## Conflicted files`,
    ...files.map((f) => `- ${f}`),
    ``,
    `## How to resolve`,
    `- Edit each file to its correct final state and delete every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).`,
    `- KEEP BOTH SIDES' INTENT. Each side is someone's completed, reviewed work. If one side moved code the other side changed, apply that change to its new home rather than discarding it. Dropping a side to make the file compile is the one failure mode that matters here.`,
    `- Read the surrounding file for context before deciding; a conflict hunk rarely carries enough on its own.`,
    `- Do NOT run any git command. The daemon owns git: it stages and commits the merge once you are done. Deleting a file is a valid resolution where that is genuinely correct.`,
    `- Do not fix unrelated problems you notice. Resolve the conflicts, nothing else.`,
    ``,
    `## When you are done`,
    `State per file which side you kept and why — that is what a reviewer checks.`,
    operatorNote ? `\n## The human operator said (address it)\n${operatorNote}` : ``,
  ]
    .filter((line) => line !== ``)
    .join("\n");
}

export function fixPrompt(findingSummaries: string[]): string {
  return [
    `A reviewer examined your changes and found issues that must be fixed. Address each one, commit the fixes, and summarize what you changed.`,
    ``,
    `## Findings`,
    ...findingSummaries.map((f, i) => `${i + 1}. ${f}`),
  ].join("\n");
}
