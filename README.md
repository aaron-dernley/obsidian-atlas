# @aaronge/obsidian-atlas

Point it at a repository you have never seen and get back a set of Obsidian
notes that explain it — architecture prose, component breakdowns, and Mermaid
diagrams, cross-linked with wikilinks so the whole thing shows up as a connected
cluster in your graph view. It also reads architecture diagrams: hand it a PNG
of a system sketch and it will name the components, explain the flows, and
transcribe the picture back out as editable Mermaid.

The heavy lifting is done by the `claude` CLI already installed on your machine,
running strictly read-only. It never writes to your vault — it returns a
structured JSON document, and this model renders the notes itself. That keeps
note paths, frontmatter and links deterministic, and means a confused agent
cannot scribble into your notes.

## Installation

```sh
swamp extension pull @aaronge/obsidian-atlas
swamp model create @aaronge/obsidian-atlas atlas
```

Then set your vault path in `models/atlas.yaml`:

```yaml
globalArguments:
  vaultRoot: /Users/you/Documents/MyVault
  folder: Atlas
```

## Usage

```sh
# Structure only — clones and inspects, no LLM, no cost. Good first check.
swamp model method run atlas survey --input repo=aaron-dernley/obsidian-atlas

# The real thing: clone, explain, write notes into the vault.
swamp model method run atlas chart --input repo=denoland/deno

# A specific branch, into a named folder.
swamp model method run atlas chart \
  --input repo=https://github.com/org/thing \
  --input ref=develop \
  --input project=thing-develop

# Re-charting the same commit costs nothing. Force it when you want a redo.
swamp model method run atlas chart \
  --input repo=denoland/deno \
  --input force=true

# Interpret an architecture diagram instead of a repository. The agent is given
# the image and nothing else — not the folder it happens to live in.
swamp model method run atlas chartDiagram \
  --input image=/Users/you/Desktop/architecture.png \
  --input note="Payments platform, drawn by the infra team"
```

Output lands at `<vaultRoot>/<folder>/<project>/`:

````text
MyVault/Atlas/deno/
  overview.md        ← kind: overview, links out to the rest
  architecture.md    ← ```mermaid flowchart
  data-flow.md       ← ```mermaid sequenceDiagram
  components.md
  glossary.md
````

Every note carries queryable frontmatter, so Dataview can pick it up:

```yaml
---
title: "Overview"
atlas-project: "deno"
atlas-source: "https://github.com/denoland/deno"
atlas-source-kind: "repo"
atlas-kind: "overview"
atlas-commit: "661317e6f91fe7c90306c2c48ea9354562ee9146"
atlas-generated: "2026-08-21T12:00:00.000Z"
tags:
  - atlas
  - atlas-overview
---
```

## Methods

| Method         | What it does                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `survey`       | Clone a repo and record its structure. Deterministic, no LLM, no cost.                                              |
| `chart`        | Clone, have Claude explain it, render the atlas into the vault. Skips the agent when the commit is already charted. |
| `chartDiagram` | Interpret a diagram image and write the explanation into the vault.                                                 |

## Global arguments

| Argument         | Default    | Purpose                                       |
| ---------------- | ---------- | --------------------------------------------- |
| `vaultRoot`      | _required_ | Absolute path to the Obsidian vault           |
| `folder`         | `Atlas`    | Folder inside the vault for generated atlases |
| `claudeBin`      | `claude`   | Claude CLI executable                         |
| `model`          | _unset_    | Optional model override for the CLI           |
| `workDir`        | temp dir   | Where repositories are cloned                 |
| `permissionMode` | `dontAsk`  | Permission mode passed to the CLI             |
| `timeoutSeconds` | `900`      | Per-invocation wall-clock limit               |
| `maxBudgetUsd`   | _unset_    | Hard spend cap in USD for a single run        |

## How it works

`chart` runs three stages. First it shallow-clones the repository and walks the
tree to build a deterministic survey — file counts, a language histogram, and
the build/entry-point files that reveal how the project is assembled. That
survey is written as its own resource, so it is queryable even if the LLM stage
later fails.

Between the two stages it checks whether this project is already charted at the
cloned commit, with its notes still present, and stops there if so — the
expensive part is skipped rather than repeated.

Second, the survey is embedded in a prompt and handed to the Claude CLI with
`--allowedTools Read Grep Glob` and `--add-dir` scoped to the clone. The agent
explores the code itself rather than having every file stuffed into one prompt,
which is what lets this work on repositories far larger than a context window.
It returns a single JSON document validated against a Zod schema.

Third, this model renders that document. Slugs are de-duplicated, dangling
wikilinks are dropped, path segments are checked for traversal, and each note is
written with frontmatter. Raw CLI output is retained for seven days as a
`transcript` file artifact for debugging.

### Progress while it runs

The agent decides for itself when it has read enough, so there is no honest
completion percentage to show. Instead the model streams the CLI's event log and
reports what it can actually measure, every fifteen seconds:

```text
Exploring 29 files. Progress below is measured activity, not a completion estimate.
  0m15s · 7 turns · 5 files read
  0m30s · 15 turns · 11 files read
  0m45s · 18 turns · 11 files read
  ...
  3m20s · 19 turns · 11 files read · $0.84
```

Counters going quiet is normal and does not mean the run has stalled: the agent
stops reading once it has seen enough and then spends a while composing its
answer. The lines keep coming on a timer so you can tell the difference between
thinking and hanging. A search count appears only when the agent uses Grep or
Glob — the run above went straight to reading files.

The dollar figure is the CLI's own reported spend, which arrives with the final
event, so it appears on the last line rather than ticking up throughout. Set
`maxBudgetUsd` to have the CLI stop the run itself once that ceiling is hit.

### Prerequisites

- `git` on `PATH`
- The [`claude` CLI](https://claude.com/claude-code) on `PATH`, authenticated.
  No API key is required — it uses your existing Claude Code credentials.
- An existing Obsidian vault directory. A pre-flight check fails the run if
  `vaultRoot` does not exist, so a typo surfaces before anything is cloned.

### Costs and caveats

`chart` spends tokens against your Claude account — roughly proportional to how
much of the repository the agent reads. Run `survey` first to see what it is
about to take on, and set `maxBudgetUsd` if you want a hard ceiling. Charting
`chalk/chalk` — 29 files, nine notes out — cost $0.84 and took three and a half
minutes.

**Charting the same commit twice is free.** `chart` records the resolved commit
and skips the whole agent stage if you ask for a project that is already charted
at that commit — it exits in about a tenth of a second having spent nothing. It
re-charts when the commit has moved, when you pass `force=true`, or when the
notes have gone missing from the vault, so a deleted folder can never leave you
stranded with data that claims the work is done.

Beyond that there is no incremental update, and two things follow:

- A note whose title changes enough to change its slug leaves the old file
  behind. Nothing is deleted from your vault, so stale notes have to be removed
  by hand — a deliberate choice, since silently deleting files from a vault you
  own is worse than leaving an orphan. Because every note carries
  `atlas-commit`, you can find them:
  `TABLE atlas-commit FROM #atlas WHERE atlas-commit != "<current>"`.
- Notes are written before the run's data artifacts, so a failure in between can
  leave markdown on disk with no matching `note` resource. Re-running repairs
  it.

If the agent's output turns out to be unusable the run fails, but the raw event
stream is still kept as a `transcript` artifact, because by then you have
already paid for it. `swamp data get <model> transcript-<project>` shows what
came back.

## License

MIT — see LICENSE for details.
