---
description: Bank this session's working state so /clear costs nothing
allowed-tools: Bash(grove handoff:*), Bash(git rev-parse:*), Bash(git status:*), Write
---

Write the handoff notes for this session, so it can be cleared without losing
anything that matters.

## What this is for

Almost everything in this conversation is **derivation** — reading, tool output,
dead ends. That value is already spent; carrying it forward costs a multiple per
turn and buys nothing. A handful of **conclusions** sit on top of it, and those
are the only things a `/clear` actually destroys.

`grove handoff` already recovers the mechanical layer on its own — session title,
prompts, files touched, git state, resume command. **Do not repeat any of it.**
You are writing only what parsing cannot recover.

## Steps

1. Get the target path — do not guess it. It is keyed to this *terminal*, so it
   is the same file across every `/clear` this window does, and it may already
   hold notes worth carrying forward:

   ```bash
   grove handoff --path
   ```

   If that command is not found, stop and say so rather than writing to a guessed
   path: run `node packages/cli/scripts/install.mjs` from the grove checkout.
   Notes written to the wrong path are silently lost, which is worse than an
   error.

2. Get the current commit for the stamp:

   ```bash
   git rev-parse --short HEAD
   ```

3. Write that file with this exact shape. Omit any section that would be empty —
   an empty heading reads as "nothing to worry about here", which is a lie if you
   simply didn't check.

   ```markdown
   ---
   thread: <the filename stem from step 1 — this terminal, not one session>
   head: <short sha from step 2>
   written: <ISO 8601 UTC, e.g. 2026-07-29T21:30:00Z>
   ---

   GOAL
     One or two lines. What we are mid-way through, and what "done" looks like.

   DECIDED
     - <choice> over <alternative>, because <reason>

   REJECTED
     - Tried <X>; failed because <Y>. Do not retry it.

   VERIFIED
     - <what was actually run, and that it passed>
   UNVERIFIED
     - <written but never exercised — say so plainly>

   NEXT
   - [ ] <the concrete next action, specific enough to start cold>
   - [x] <carry forward anything already finished, ticked>

   GOTCHAS
     - <the thing that cost an hour to discover>
   ```

   `NEXT` must use markdown checkboxes. They are the ledger: every future session
   in this terminal is shown the open count, and finishing one is
   `grove handoff --done <n>` rather than a rewrite of the whole file.

## Rules

- **Conclusions, not derivation.** "Cache reads are 0.1x weight" is a conclusion.
  The investigation that established it is not.
- **Never duplicate git or CLAUDE.md.** A copy goes stale and then lies to a
  future session with total confidence. Anything re-derivable stays a pointer.
- **VERIFIED means a check was run and passed.** Compiling is not verifying. If
  something was only written, it belongs under UNVERIFIED.
- **Target 40 lines.** Past that you are summarising the transcript instead of
  capturing conclusions, and the next session will be paying to re-read your
  notes about reading.
- Write only from what is already in context. Do not re-read the repo to pad this
  out — this turn runs at peak context and is the most expensive one available.

When the file is written, confirm in one line: the path, and that `/clear` is now
safe because the full session remains at `claude --resume <id>`.
