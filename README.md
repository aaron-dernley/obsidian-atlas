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

# Interpret an architecture diagram instead of a repository.
swamp model method run atlas chartDiagram \
  --input image=/Users/you/Desktop/architecture.png \
  --input note="Payments platform, drawn by the infra team"
```

Output lands at `<vaultRoot>/<folder>/<project>/`:

```text
MyVault/Atlas/deno/
  overview.md        ← kind: overview, links out to the rest
  architecture.md    ← ```mermaid flowchart
  data-flow.md       ← ```mermaid sequenceDiagram
  components.md
  glossary.md
```

Every note carries queryable frontmatter, so Dataview can pick it up:

```yaml
---
title: "Overview"
atlas-project: "deno"
atlas-source: "https://github.com/denoland/deno"
atlas-source-kind: "repo"
atlas-kind: "overview"
atlas-generated: "2026-08-21T12:00:00.000Z"
tags:
  - atlas
  - atlas-overview
---
```

## Methods

| Method         | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `survey`       | Clone a repo and record its structure. Deterministic, no LLM, no cost.    |
| `chart`        | Clone, have Claude explain it, render the atlas into the vault.           |
| `chartDiagram` | Interpret a diagram image and write the explanation into the vault.       |

## Global arguments

| Argument         | Default    | Purpose                                          |
| ---------------- | ---------- | ------------------------------------------------ |
| `vaultRoot`      | _required_ | Absolute path to the Obsidian vault              |
| `folder`         | `Atlas`    | Folder inside the vault for generated atlases    |
| `claudeBin`      | `claude`   | Claude CLI executable                            |
| `model`          | _unset_    | Optional model override for the CLI              |
| `workDir`        | temp dir   | Where repositories are cloned                    |
| `permissionMode` | `dontAsk`  | Permission mode passed to the CLI                |
| `timeoutSeconds` | `900`      | Per-invocation wall-clock limit                  |

## How it works

`chart` runs three stages. First it shallow-clones the repository and walks the
tree to build a deterministic survey — file counts, a language histogram, and
the build/entry-point files that reveal how the project is assembled. That
survey is written as its own resource, so it is queryable even if the LLM stage
later fails.

Second, the survey is embedded in a prompt and handed to the Claude CLI with
`--allowedTools Read Grep Glob` and `--add-dir` scoped to the clone. The agent
explores the code itself rather than having every file stuffed into one prompt,
which is what lets this work on repositories far larger than a context window.
It returns a single JSON document validated against a Zod schema.

Third, this model renders that document. Slugs are de-duplicated, dangling
wikilinks are dropped, path segments are checked for traversal, and each note is
written with frontmatter. Raw CLI output is retained for seven days as a
`transcript` file artifact for debugging.

### Prerequisites

- `git` on `PATH`
- The [`claude` CLI](https://claude.com/claude-code) on `PATH`, authenticated.
  No API key is required — it uses your existing Claude Code credentials.
- An existing Obsidian vault directory. A pre-flight check fails the run if
  `vaultRoot` does not exist, so a typo surfaces before anything is cloned.

### Costs and caveats

`chart` spends tokens against your Claude account — roughly proportional to how
much of the repository the agent reads. Run `survey` first to see what it is
about to take on. The model does not currently do incremental updates: charting
the same project again overwrites the previous notes in that folder.

## License

MIT — see LICENSE for details.
