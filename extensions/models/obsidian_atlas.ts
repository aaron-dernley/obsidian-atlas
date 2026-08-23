/**
 * Obsidian Atlas — turn a Git repository or an architecture diagram into an
 * illustrated, wikilinked set of Obsidian notes.
 *
 * The model runs three stages. `survey` clones a repository and builds a
 * deterministic structural picture of it with no LLM involved. `chart` feeds
 * that survey to the local Claude CLI, which explores the working tree
 * read-only and returns a structured atlas document that this model then
 * renders into the vault. `chartDiagram` does the same for a single image.
 *
 * Notes are always written by this model, never by the agent — the agent is
 * given read-only tools and returns JSON. That keeps note paths, frontmatter
 * and wikilinks deterministic and prevents stray writes into the vault.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories never descended into when surveying a working tree. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".terraform",
  "Pods",
  ".swamp",
]);

/** File extension to human language name, used for the language histogram. */
const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".php": "PHP",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".clj": "Clojure",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".sql": "SQL",
  ".tf": "Terraform",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".json": "JSON",
  ".toml": "TOML",
  ".md": "Markdown",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

/**
 * Filenames that signal how a project is built, run or deployed. Surfacing
 * these in the survey gives the agent a reliable starting point.
 */
const SIGNAL_FILES: readonly string[] = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "justfile",
  "readme.md",
  "architecture.md",
  "main.go",
  "main.py",
  "main.rs",
  "index.ts",
  "index.js",
  "mod.ts",
];

/** Image extensions accepted by `chartDiagram`. */
const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Maximum files walked during a survey, to bound work on very large repos. */
const MAX_SURVEY_FILES = 20000;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  vaultRoot: z
    .string()
    .min(1)
    .describe("Absolute path to the Obsidian vault directory."),
  folder: z
    .string()
    .default("Atlas")
    .describe("Folder inside the vault that generated atlases are written to."),
  claudeBin: z
    .string()
    .default("claude")
    .describe("Claude CLI executable, resolved on PATH unless absolute."),
  model: z
    .string()
    .optional()
    .describe("Optional model override passed to the Claude CLI."),
  workDir: z
    .string()
    .optional()
    .describe("Directory for repository clones. Defaults to a temp directory."),
  permissionMode: z
    .enum(["dontAsk", "auto", "plan", "bypassPermissions"])
    .default("dontAsk")
    .describe("Permission mode passed to the Claude CLI."),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .default(900)
    .describe("Maximum wall-clock seconds for a single Claude CLI invocation."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const LanguageStatSchema = z.object({
  language: z.string(),
  files: z.number(),
  bytes: z.number(),
});

const SurveySchema = z.object({
  source: z.string(),
  sourceKind: z.string(),
  ref: z.string(),
  commit: z.string(),
  project: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  truncated: z.boolean(),
  languages: z.array(LanguageStatSchema),
  signalFiles: z.array(z.string()),
  topLevel: z.array(z.string()),
  surveyedAt: z.string(),
});

const NoteRefSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.string(),
  path: z.string(),
});

const AtlasSchema = z.object({
  source: z.string(),
  sourceKind: z.string(),
  project: z.string(),
  title: z.string(),
  summary: z.string(),
  folder: z.string(),
  noteCount: z.number(),
  diagramCount: z.number(),
  notes: z.array(NoteRefSchema),
  generatedAt: z.string(),
});

const NoteSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: z.string(),
  path: z.string(),
  project: z.string(),
  bytes: z.number(),
  diagrams: z.number(),
  links: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Agent response contract
// ---------------------------------------------------------------------------

/** Note kinds the agent may emit. Anything else is coerced to `component`. */
const NOTE_KINDS = [
  "overview",
  "architecture",
  "component",
  "dataflow",
  "setup",
  "glossary",
  "decisions",
] as const;

const AgentNoteSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(NOTE_KINDS).catch("component"),
  body: z.string().min(1),
  links: z.array(z.string()).default([]),
});

const AgentAtlasSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
  notes: z.array(AgentNoteSchema).min(1),
});

type AgentAtlas = z.infer<typeof AgentAtlasSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Convert arbitrary text into a filesystem- and wikilink-safe slug.
 *
 * @param input Raw text such as a note title or repository name.
 * @returns A lowercase hyphenated slug, or `"untitled"` when nothing survives.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug.length > 0 ? slug.slice(0, 80) : "untitled";
}

/**
 * Reject path segments that could escape the target directory.
 *
 * @param segment A single path segment to validate.
 * @throws If the segment is empty, a dot-segment, or contains a separator.
 */
export function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(segment)}`);
  }
}

/**
 * Normalise a repository reference into a clone URL.
 *
 * Accepts full HTTPS/SSH URLs and the `owner/repo` shorthand, which is
 * expanded against GitHub.
 *
 * @param repo Repository URL or `owner/repo` shorthand.
 * @returns A URL git can clone.
 */
export function normalizeRepoUrl(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/, "");
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(trimmed)) return trimmed;
  if (/^github\.com\//.test(trimmed)) return `https://${trimmed}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  return trimmed;
}

/**
 * Derive a short project name from a repository URL.
 *
 * @param repoUrl A normalised repository URL.
 * @returns A slug suitable for use as a vault subfolder.
 */
export function projectNameFromUrl(repoUrl: string): string {
  const withoutQuery = repoUrl.split(/[?#]/)[0].replace(/\/+$/, "");
  const last = withoutQuery.split("/").pop() ?? "repository";
  return slugify(last.replace(/\.git$/, ""));
}

/**
 * Pull the assistant's text out of a Claude CLI response.
 *
 * Tolerates both the `--output-format json` envelope and bare text, so the
 * model keeps working if the envelope shape changes.
 *
 * @param stdout Raw stdout captured from the CLI.
 * @returns The assistant's text payload.
 * @throws If the envelope reports an error.
 */
export function extractCliText(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new Error("Claude CLI returned no output");

  if (trimmed.startsWith("{")) {
    try {
      const envelope = JSON.parse(trimmed) as Record<string, unknown>;
      if (envelope.is_error === true) {
        const detail = typeof envelope.result === "string"
          ? envelope.result
          : JSON.stringify(envelope).slice(0, 500);
        throw new Error(`Claude CLI reported an error: ${detail}`);
      }
      if (typeof envelope.result === "string") return envelope.result;
      // Some envelopes nest the text under a content array.
      if (Array.isArray(envelope.content)) {
        const text = envelope.content
          .map((b) =>
            typeof b === "object" && b !== null && "text" in b
              ? String((b as { text: unknown }).text)
              : ""
          )
          .join("");
        if (text.trim().length > 0) return text;
      }
    } catch (err) {
      // A JSON.parse failure means it was not an envelope after all; only
      // rethrow the explicit error we raised above.
      if (err instanceof Error && err.message.startsWith("Claude CLI")) {
        throw err;
      }
    }
  }
  return trimmed;
}

/**
 * Extract a JSON object from model text that may be fenced or prose-wrapped.
 *
 * @param text Assistant text expected to contain one JSON object.
 * @returns The parsed object.
 * @throws If no balanced JSON object can be located or parsed.
 */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to brace scanning.
  }

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new Error(
      `No JSON object found in model output (first 300 chars): ${
        candidate.slice(0, 300)
      }`,
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error("Unbalanced JSON object in model output");
}

/**
 * Count fenced Mermaid diagrams in a markdown body.
 *
 * @param body Markdown note body.
 * @returns The number of mermaid code fences found.
 */
export function countMermaid(body: string): number {
  return (body.match(/```mermaid/g) ?? []).length;
}

/**
 * Escape a string for use as a double-quoted YAML scalar.
 *
 * @param value Raw string value.
 * @returns The value wrapped in double quotes with inner quotes escaped.
 */
export function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A single note as authored by the agent, before it is rendered to disk. */
export interface AtlasNote {
  /** Filename-safe identifier, also used as the wikilink target. */
  slug: string;
  /** Human readable note title. */
  title: string;
  /** Category such as `overview`, `architecture` or `dataflow`. */
  kind: string;
  /** Markdown body, which may contain fenced Mermaid diagrams. */
  body: string;
  /** Slugs of sibling notes this one should link to. */
  links: string[];
}

/** Provenance and cross-link context needed to render a note. */
export interface RenderNoteMeta {
  /** Repository URL or image path the atlas was built from. */
  source: string;
  /** Either `repo` or `diagram`. */
  sourceKind: string;
  /** Vault subfolder the atlas is written into. */
  project: string;
  /** ISO-8601 timestamp stamped into frontmatter. */
  generatedAt: string;
  /** Atlas-wide tags applied to every note. */
  tags: readonly string[];
  /** Slug to title map used to resolve and label wikilinks. */
  titleBySlug: ReadonlyMap<string, string>;
}

/**
 * Render a note to its final Obsidian markdown, frontmatter included.
 *
 * @param note The agent-authored note.
 * @param meta Provenance and cross-link context for the note.
 * @returns Complete markdown file content.
 */
export function renderNote(note: AtlasNote, meta: RenderNoteMeta): string {
  const tags = ["atlas", `atlas/${note.kind}`, ...meta.tags]
    .map((t) => slugify(t))
    .filter((t, i, arr) => t.length > 0 && arr.indexOf(t) === i);

  const frontmatter = [
    "---",
    `title: ${yamlString(note.title)}`,
    `atlas-project: ${yamlString(meta.project)}`,
    `atlas-source: ${yamlString(meta.source)}`,
    `atlas-source-kind: ${yamlString(meta.sourceKind)}`,
    `atlas-kind: ${yamlString(note.kind)}`,
    `atlas-generated: ${yamlString(meta.generatedAt)}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
  ].join("\n");

  const related = note.links
    .map((slug) => slugify(slug))
    .filter((slug) => meta.titleBySlug.has(slug))
    .filter((slug, i, arr) => arr.indexOf(slug) === i);

  const parts = [frontmatter, "", `# ${note.title}`, "", note.body.trim()];
  if (related.length > 0) {
    parts.push(
      "",
      "## Related",
      "",
      ...related.map((slug) => `- [[${slug}|${meta.titleBySlug.get(slug)}]]`),
    );
  }
  return `${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Filesystem + process helpers
// ---------------------------------------------------------------------------

/** File and byte counts for one detected language. */
export interface LanguageStat {
  /** Human readable language name, e.g. `TypeScript`. */
  language: string;
  /** Number of files attributed to this language. */
  files: number;
  /** Total bytes across those files. */
  bytes: number;
}

/** Structural facts gathered from a working tree without any LLM involvement. */
export interface SurveyResult {
  /** Files walked, excluding ignored directories. */
  fileCount: number;
  /** Total bytes across all walked files. */
  totalBytes: number;
  /** True when the walk hit the file cap and stopped counting. */
  truncated: boolean;
  /** Language histogram, largest by bytes first. */
  languages: LanguageStat[];
  /** Build and entry-point files that reveal how the project is assembled. */
  signalFiles: string[];
  /** Entries at the root of the tree, directories suffixed with a slash. */
  topLevel: string[];
}

/**
 * Walk a working tree and summarise its structure.
 *
 * @param root Absolute path to the directory to survey.
 * @returns Counts, a language histogram, and notable entry-point files.
 */
export async function surveyTree(root: string): Promise<SurveyResult> {
  const languages = new Map<string, { files: number; bytes: number }>();
  const signalFiles: string[] = [];
  const topLevel: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;

  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory && IGNORED_DIRS.has(entry.name)) continue;
    topLevel.push(entry.isDirectory ? `${entry.name}/` : entry.name);
  }
  topLevel.sort();

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile) continue;

      if (fileCount >= MAX_SURVEY_FILES) {
        truncated = true;
        continue;
      }
      fileCount++;

      let size = 0;
      try {
        size = (await Deno.stat(full)).size;
      } catch {
        continue;
      }
      totalBytes += size;

      const dot = entry.name.lastIndexOf(".");
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : "";
      const language = LANGUAGE_BY_EXT[ext];
      if (language) {
        const cur = languages.get(language) ?? { files: 0, bytes: 0 };
        cur.files++;
        cur.bytes += size;
        languages.set(language, cur);
      }

      if (SIGNAL_FILES.includes(entry.name.toLowerCase())) {
        const rel = full.slice(root.length + 1);
        if (rel.split("/").length <= 3) signalFiles.push(rel);
      }
    }
  }

  return {
    fileCount,
    totalBytes,
    truncated,
    languages: [...languages.entries()]
      .map(([language, s]) => ({ language, files: s.files, bytes: s.bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    signalFiles: signalFiles.sort().slice(0, 40),
    topLevel: topLevel.slice(0, 60),
  };
}

/**
 * Run a subprocess and capture its output.
 *
 * @param bin Executable name or absolute path.
 * @param args Argument vector.
 * @param opts Working directory, abort signal, and timeout.
 * @returns Exit code with decoded stdout and stderr.
 */
async function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; timeoutSeconds?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timer = opts.timeoutSeconds
    ? setTimeout(() => controller.abort(), opts.timeoutSeconds * 1000)
    : undefined;
  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onParentAbort);

  try {
    const command = new Deno.Command(bin, {
      args,
      cwd: opts.cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const { code, stdout, stderr } = await command.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `${bin} timed out after ${opts.timeoutSeconds}s or was cancelled`,
      );
    }
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `Executable not found: ${bin}. Install it or set the matching globalArgument.`,
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Invoke the Claude CLI read-only and return the validated atlas document.
 *
 * @param prompt The full instruction sent to the agent.
 * @param allowDir Directory the agent is permitted to read.
 * @param globals Model global arguments.
 * @param signal Cancellation signal from the method context.
 * @returns The parsed and validated agent response plus raw stdout.
 */
async function askClaude(
  prompt: string,
  allowDir: string,
  globals: GlobalArgs,
  signal?: AbortSignal,
): Promise<{ atlas: AgentAtlas; raw: string }> {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--permission-mode",
    globals.permissionMode,
    "--add-dir",
    allowDir,
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (globals.model) args.push("--model", globals.model);
  args.push(prompt);

  const result = await run(globals.claudeBin, args, {
    cwd: allowDir,
    signal,
    timeoutSeconds: globals.timeoutSeconds,
  });

  if (result.code !== 0) {
    throw new Error(
      `Claude CLI exited ${result.code}: ${
        (result.stderr || result.stdout).slice(0, 800)
      }`,
    );
  }

  const text = extractCliText(result.stdout);
  const parsed = AgentAtlasSchema.safeParse(extractJsonObject(text));
  if (!parsed.success) {
    throw new Error(
      `Claude CLI returned a document that did not match the atlas schema: ${
        JSON.stringify(parsed.error.issues).slice(0, 800)
      }`,
    );
  }
  return { atlas: parsed.data, raw: result.stdout };
}

/** Shape of the JSON contract restated to the agent in every prompt. */
const JSON_CONTRACT = `Return ONE JSON object and nothing else. No prose before
or after, no markdown fence. Shape:

{
  "title":   "Human readable title for the whole atlas",
  "summary": "Two or three sentences on what this system is and does",
  "tags":    ["short", "topic", "tags"],
  "notes": [
    {
      "slug":  "kebab-case-filename",
      "title": "Note title",
      "kind":  "overview|architecture|component|dataflow|setup|glossary|decisions",
      "body":  "Markdown body. Use ## for sections. Embed diagrams as \\\`\\\`\\\`mermaid fences.",
      "links": ["slug-of-related-note"]
    }
  ]
}

Rules:
- Produce between 4 and 10 notes. Exactly one must have kind "overview".
- Every "links" entry must be the slug of another note in this same response.
- Include at least two \\\`\\\`\\\`mermaid diagrams across the notes. Prefer
  flowchart for structure and sequenceDiagram for request flows. Keep Mermaid
  node labels free of parentheses and quotes, which break Obsidian's renderer.
- Write for a competent engineer who has never seen this system. Explain what
  each part is for and how the parts fit together. Do not pad with generic
  advice, and do not invent behaviour you did not verify.`;

/**
 * Build the repository-analysis prompt.
 *
 * @param survey Deterministic survey facts to ground the agent.
 * @param source The repository URL being documented.
 * @param dir Absolute path to the checked-out working tree.
 * @returns The full prompt string.
 */
function repoPrompt(
  survey: z.infer<typeof SurveySchema>,
  source: string,
  dir: string,
): string {
  const langs = survey.languages
    .slice(0, 8)
    .map((l) => `${l.language} (${l.files} files)`)
    .join(", ");
  return `You are documenting a software repository so that a newcomer can
understand it. The working tree is checked out at ${dir} and you may read it
with Read, Grep and Glob. You cannot modify anything.

Repository: ${source}
Commit: ${survey.commit}
Files: ${survey.fileCount}
Languages: ${langs || "unknown"}
Top level: ${survey.topLevel.join(", ")}
Key files: ${survey.signalFiles.join(", ") || "none detected"}

Start with the key files above to learn how the project is built and run, then
read the entry points and follow the important code paths. Identify the major
components, how data and control flow between them, and any notable
architectural decisions.

${JSON_CONTRACT}`;
}

/**
 * Build the diagram-interpretation prompt.
 *
 * @param imagePath Absolute path to the image file.
 * @param note Optional caller-supplied context about the diagram.
 * @returns The full prompt string.
 */
function diagramPrompt(imagePath: string, note: string | undefined): string {
  return `You are documenting an architecture diagram so that a newcomer can
understand the system it depicts. Read the image at ${imagePath} using the Read
tool.${note ? `\n\nContext from the person who supplied it: ${note}` : ""}

Identify every component in the diagram, the relationships and data flows
between them, and any labels, protocols or annotations. Explain what the system
appears to do and how the parts interact. Where the diagram is ambiguous, say so
explicitly rather than guessing.

Reproduce the diagram itself as a Mermaid diagram in the overview note so it
becomes editable text in the vault.

${JSON_CONTRACT}`;
}

// ---------------------------------------------------------------------------
// Vault writing
// ---------------------------------------------------------------------------

/**
 * Render an agent atlas into the vault and record what was written.
 *
 * @param agent The validated agent response.
 * @param meta Provenance for frontmatter and folder placement.
 * @param globals Model global arguments.
 * @returns Per-note records describing the files written.
 */
async function writeAtlas(
  agent: AgentAtlas,
  meta: { source: string; sourceKind: string; project: string },
  globals: GlobalArgs,
): Promise<Array<z.infer<typeof NoteSchema>>> {
  const generatedAt = new Date().toISOString();

  assertSafeSegment(globals.folder);
  assertSafeSegment(meta.project);
  const dir = `${globals.vaultRoot}/${globals.folder}/${meta.project}`;
  await Deno.mkdir(dir, { recursive: true });

  // De-duplicate slugs before rendering so wikilinks resolve to real files.
  const seen = new Set<string>();
  const notes = agent.notes.map((note) => {
    let slug = slugify(note.slug || note.title);
    let n = 2;
    while (seen.has(slug)) slug = `${slugify(note.slug || note.title)}-${n++}`;
    seen.add(slug);
    return { ...note, slug };
  });

  const titleBySlug = new Map(notes.map((n) => [n.slug, n.title]));
  const written: Array<z.infer<typeof NoteSchema>> = [];

  for (const note of notes) {
    assertSafeSegment(`${note.slug}.md`);
    const content = renderNote(note, {
      source: meta.source,
      sourceKind: meta.sourceKind,
      project: meta.project,
      generatedAt,
      tags: agent.tags,
      titleBySlug,
    });
    const path = `${dir}/${note.slug}.md`;
    await Deno.writeTextFile(path, content);

    written.push({
      slug: note.slug,
      title: note.title,
      kind: note.kind,
      path,
      project: meta.project,
      bytes: new TextEncoder().encode(content).length,
      diagrams: countMermaid(note.body),
      links: note.links.map((l) => slugify(l)).filter((l) =>
        titleBySlug.has(l)
      ),
    });
  }

  return written;
}

/**
 * Clone a repository shallowly and resolve its HEAD commit.
 *
 * @param repoUrl Normalised clone URL.
 * @param ref Branch or tag to check out, if any.
 * @param globals Model global arguments.
 * @param signal Cancellation signal from the method context.
 * @returns The clone directory and resolved commit SHA.
 */
async function cloneRepo(
  repoUrl: string,
  ref: string | undefined,
  globals: GlobalArgs,
  signal?: AbortSignal,
): Promise<{ dir: string; commit: string }> {
  const base = globals.workDir ??
    (await Deno.makeTempDir({ prefix: "atlas-" }));
  await Deno.mkdir(base, { recursive: true });
  const dir = `${base}/${projectNameFromUrl(repoUrl)}-${
    crypto.randomUUID().slice(0, 8)
  }`;

  const args = ["clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(repoUrl, dir);

  const cloned = await run("git", args, { signal, timeoutSeconds: 600 });
  if (cloned.code !== 0) {
    throw new Error(
      `git clone failed for ${repoUrl}: ${cloned.stderr.slice(0, 500)}`,
    );
  }

  const head = await run("git", ["rev-parse", "HEAD"], { cwd: dir, signal });
  return { dir, commit: head.stdout.trim() || "unknown" };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Minimal shape of the method context fields these methods actually use. */
interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
  ) => { writeText: (text: string) => Promise<{ name: string }> };
}

const SurveyArgsSchema = z.object({
  repo: z.string().min(1).describe("Repository URL or owner/repo shorthand."),
  ref: z.string().optional().describe("Branch or tag to check out."),
  keepClone: z
    .boolean()
    .default(false)
    .describe("Leave the clone on disk instead of deleting it."),
});

const ChartArgsSchema = z.object({
  repo: z.string().min(1).describe("Repository URL or owner/repo shorthand."),
  ref: z.string().optional().describe("Branch or tag to check out."),
  project: z
    .string()
    .optional()
    .describe("Vault subfolder name. Defaults to the repository name."),
  keepClone: z
    .boolean()
    .default(false)
    .describe("Leave the clone on disk instead of deleting it."),
});

const DiagramArgsSchema = z.object({
  image: z.string().min(1).describe("Absolute path to a diagram image file."),
  project: z
    .string()
    .optional()
    .describe("Vault subfolder name. Defaults to the image filename."),
  note: z
    .string()
    .optional()
    .describe("Optional context about what the diagram shows."),
});

/** Model definition for building Obsidian atlases from repos and diagrams. */
export const model = {
  type: "@aaronge/obsidian-atlas",
  version: "2026.08.21.1",
  description:
    "Turn a Git repository or an architecture diagram into an illustrated, wikilinked Obsidian atlas.",
  globalArguments: GlobalArgsSchema,

  resources: {
    survey: {
      description: "Deterministic structural survey of a repository",
      schema: SurveySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    atlas: {
      description: "A generated atlas and the notes it produced",
      schema: AtlasSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    note: {
      description: "A single note written into the vault",
      schema: NoteSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },

  files: {
    transcript: {
      description: "Raw Claude CLI output, retained for debugging",
      contentType: "application/json",
      lifetime: "7d",
      garbageCollection: 5,
    },
  },

  checks: {
    "vault-exists": {
      description: "The configured Obsidian vault directory exists",
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        try {
          const stat = await Deno.stat(context.globalArgs.vaultRoot);
          if (!stat.isDirectory) {
            return {
              pass: false,
              errors: [
                `vaultRoot is not a directory: ${context.globalArgs.vaultRoot}`,
              ],
            };
          }
          return { pass: true };
        } catch {
          return {
            pass: false,
            errors: [
              `vaultRoot does not exist: ${context.globalArgs.vaultRoot}`,
            ],
          };
        }
      },
    },
  },

  methods: {
    survey: {
      description:
        "Clone a repository and record its structure. No LLM is involved.",
      arguments: SurveyArgsSchema,
      execute: async (
        args: z.infer<typeof SurveyArgsSchema>,
        context: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoUrl = normalizeRepoUrl(args.repo);
        const project = projectNameFromUrl(repoUrl);
        context.logger.info("Cloning {repo}", { repo: repoUrl });

        const { dir, commit } = await cloneRepo(
          repoUrl,
          args.ref,
          context.globalArgs,
          context.signal,
        );

        try {
          const tree = await surveyTree(dir);
          const handle = await context.writeResource(
            "survey",
            `survey-${project}`,
            {
              source: repoUrl,
              sourceKind: "repo",
              ref: args.ref ?? "default",
              commit,
              project,
              surveyedAt: new Date().toISOString(),
              ...tree,
            },
          );
          context.logger.info("Surveyed {files} files in {repo}", {
            files: tree.fileCount,
            repo: repoUrl,
          });
          return { dataHandles: [handle] };
        } finally {
          if (!args.keepClone) {
            await Deno.remove(dir, { recursive: true }).catch(() => {});
          }
        }
      },
    },

    chart: {
      description:
        "Clone a repository, have the Claude CLI explain it, and write the atlas into the vault.",
      arguments: ChartArgsSchema,
      execute: async (
        args: z.infer<typeof ChartArgsSchema>,
        context: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoUrl = normalizeRepoUrl(args.repo);
        const project = slugify(args.project ?? projectNameFromUrl(repoUrl));
        context.logger.info("Charting {repo}", { repo: repoUrl });

        const { dir, commit } = await cloneRepo(
          repoUrl,
          args.ref,
          context.globalArgs,
          context.signal,
        );

        try {
          const tree = await surveyTree(dir);
          const survey = {
            source: repoUrl,
            sourceKind: "repo",
            ref: args.ref ?? "default",
            commit,
            project,
            surveyedAt: new Date().toISOString(),
            ...tree,
          };

          const surveyHandle = await context.writeResource(
            "survey",
            `survey-${project}`,
            survey,
          );

          context.logger.info("Asking Claude to explain {files} files", {
            files: tree.fileCount,
          });
          const { atlas, raw } = await askClaude(
            repoPrompt(survey, repoUrl, dir),
            dir,
            context.globalArgs,
            context.signal,
          );

          const notes = await writeAtlas(
            atlas,
            { source: repoUrl, sourceKind: "repo", project },
            context.globalArgs,
          );

          const handles = [surveyHandle];
          handles.push(
            await context.writeResource("atlas", `atlas-${project}`, {
              source: repoUrl,
              sourceKind: "repo",
              project,
              title: atlas.title,
              summary: atlas.summary,
              folder: `${context.globalArgs.folder}/${project}`,
              noteCount: notes.length,
              diagramCount: notes.reduce((n, x) => n + x.diagrams, 0),
              notes: notes.map((n) => ({
                slug: n.slug,
                title: n.title,
                kind: n.kind,
                path: n.path,
              })),
              generatedAt: new Date().toISOString(),
            }),
          );
          for (const note of notes) {
            handles.push(
              await context.writeResource(
                "note",
                `note-${project}-${note.slug}`,
                note,
              ),
            );
          }
          handles.push(
            await context
              .createFileWriter("transcript", `transcript-${project}`)
              .writeText(raw),
          );

          context.logger.info("Wrote {count} notes to {folder}", {
            count: notes.length,
            folder: `${context.globalArgs.folder}/${project}`,
          });
          return { dataHandles: handles };
        } finally {
          if (!args.keepClone) {
            await Deno.remove(dir, { recursive: true }).catch(() => {});
          }
        }
      },
    },

    chartDiagram: {
      description:
        "Interpret an architecture diagram image and write the explanation into the vault.",
      arguments: DiagramArgsSchema,
      execute: async (
        args: z.infer<typeof DiagramArgsSchema>,
        context: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const stat = await Deno.stat(args.image).catch(() => null);
        if (!stat?.isFile) {
          throw new Error(`Diagram image not found: ${args.image}`);
        }
        const dot = args.image.lastIndexOf(".");
        const ext = dot > 0 ? args.image.slice(dot).toLowerCase() : "";
        if (!IMAGE_EXTS.has(ext)) {
          throw new Error(
            `Unsupported image type ${ext || "(none)"}. Supported: ${
              [...IMAGE_EXTS].join(", ")
            }`,
          );
        }

        const dir = args.image.slice(0, args.image.lastIndexOf("/")) || ".";
        const filename = args.image.slice(args.image.lastIndexOf("/") + 1);
        const project = slugify(
          args.project ?? filename.slice(0, filename.lastIndexOf(".")),
        );

        context.logger.info("Interpreting diagram {image}", {
          image: args.image,
        });
        const { atlas, raw } = await askClaude(
          diagramPrompt(args.image, args.note),
          dir,
          context.globalArgs,
          context.signal,
        );

        const notes = await writeAtlas(
          atlas,
          { source: args.image, sourceKind: "diagram", project },
          context.globalArgs,
        );

        const handles = [
          await context.writeResource("atlas", `atlas-${project}`, {
            source: args.image,
            sourceKind: "diagram",
            project,
            title: atlas.title,
            summary: atlas.summary,
            folder: `${context.globalArgs.folder}/${project}`,
            noteCount: notes.length,
            diagramCount: notes.reduce((n, x) => n + x.diagrams, 0),
            notes: notes.map((n) => ({
              slug: n.slug,
              title: n.title,
              kind: n.kind,
              path: n.path,
            })),
            generatedAt: new Date().toISOString(),
          }),
        ];
        for (const note of notes) {
          handles.push(
            await context.writeResource(
              "note",
              `note-${project}-${note.slug}`,
              note,
            ),
          );
        }
        handles.push(
          await context
            .createFileWriter("transcript", `transcript-${project}`)
            .writeText(raw),
        );

        context.logger.info("Wrote {count} notes to {folder}", {
          count: notes.length,
          folder: `${context.globalArgs.folder}/${project}`,
        });
        return { dataHandles: handles };
      },
    },
  },
};
