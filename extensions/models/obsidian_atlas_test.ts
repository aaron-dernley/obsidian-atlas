/**
 * Unit tests for the pure helpers in the Obsidian Atlas model.
 *
 * @module
 */
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  type AgentProgress,
  applyStreamEvent,
  assertSafeSegment,
  countMermaid,
  extractCliText,
  extractJsonObject,
  findOrphans,
  formatProgress,
  model,
  normalizeRepoUrl,
  projectNameFromUrl,
  renderNote,
  slugify,
  surveyTree,
  yamlString,
} from "./obsidian_atlas.ts";

/** Fresh zeroed counters for progress tests. */
function emptyProgress(): AgentProgress {
  return {
    elapsedSeconds: 0,
    turns: 0,
    filesRead: 0,
    searches: 0,
    costUsd: null,
  };
}

Deno.test("slugify normalises titles", () => {
  assertEquals(slugify("Data Flow & Storage"), "data-flow-storage");
  assertEquals(slugify("  Café Résumé  "), "cafe-resume");
  assertEquals(slugify("!!!"), "untitled");
  assertEquals(slugify("Already-Slugged"), "already-slugged");
});

Deno.test("assertSafeSegment rejects traversal", () => {
  assertSafeSegment("overview.md");
  for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
    assertThrows(() => assertSafeSegment(bad), Error, "Unsafe path segment");
  }
});

Deno.test("normalizeRepoUrl expands shorthand and strips .git", () => {
  assertEquals(
    normalizeRepoUrl("aaron-dernley/obsidian-atlas"),
    "https://github.com/aaron-dernley/obsidian-atlas",
  );
  assertEquals(
    normalizeRepoUrl("https://github.com/org/thing.git"),
    "https://github.com/org/thing",
  );
  assertEquals(
    normalizeRepoUrl("github.com/org/thing"),
    "https://github.com/org/thing",
  );
  assertEquals(
    normalizeRepoUrl("git@github.com:org/thing.git"),
    "git@github.com:org/thing",
  );
});

Deno.test("projectNameFromUrl takes the final segment", () => {
  assertEquals(
    projectNameFromUrl("https://github.com/org/My_Thing.git"),
    "my-thing",
  );
  assertEquals(projectNameFromUrl("https://example.com/a/b/c/"), "c");
});

Deno.test("extractCliText unwraps the result envelope", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"title":"x"}',
  });
  assertEquals(extractCliText(envelope), '{"title":"x"}');
});

Deno.test("extractCliText unwraps a content-block envelope", () => {
  const envelope = JSON.stringify({
    content: [{ type: "text", text: '{"title":' }, {
      type: "text",
      text: '"x"}',
    }],
  });
  assertEquals(extractCliText(envelope), '{"title":"x"}');
});

Deno.test("extractCliText passes through bare text", () => {
  assertEquals(extractCliText("  hello  "), "hello");
});

Deno.test("extractCliText surfaces CLI errors", () => {
  const envelope = JSON.stringify({ is_error: true, result: "rate limited" });
  assertThrows(() => extractCliText(envelope), Error, "rate limited");
});

Deno.test("extractCliText rejects empty output", () => {
  assertThrows(() => extractCliText("   "), Error, "no output");
});

Deno.test("extractJsonObject handles fences, prose and nesting", () => {
  assertEquals(extractJsonObject('{"a":1}'), { a: 1 });
  assertEquals(
    extractJsonObject('```json\n{"a":1}\n```'),
    { a: 1 },
  );
  assertEquals(
    extractJsonObject('Here you go:\n{"a":{"b":[1,2]}}\nHope that helps!'),
    { a: { b: [1, 2] } },
  );
});

Deno.test("extractJsonObject ignores braces inside strings", () => {
  assertEquals(
    extractJsonObject('prefix {"body":"a } b \\" c"} suffix'),
    { body: 'a } b " c' },
  );
});

Deno.test("extractJsonObject does not truncate at a fence nested inside a note body", () => {
  // The real failure: the response is wrapped in one outer ```json fence, but
  // a note body embeds its own ```mermaid fence (an *expected* part of the
  // contract). A nearest-closing-fence match would stop at the nested one and
  // hand back a truncated, unbalanced candidate.
  const raw = "```json\n" +
    '{"title":"T","summary":"s","tags":[],"notes":[{"slug":"a","title":"A",' +
    '"kind":"overview","body":"See:\\n\\n```mermaid\\nflowchart TD\\n A-->B\\n```' +
    '\\n\\nmore text","links":[]}]}\n' +
    "```";
  const result = extractJsonObject(raw) as { notes: Array<{ body: string }> };
  assertStringIncludes(result.notes[0].body, "```mermaid");
  assertStringIncludes(result.notes[0].body, "more text");
});

Deno.test("extractJsonObject throws when there is no object", () => {
  assertThrows(
    () => extractJsonObject("no json here"),
    Error,
    "No JSON object",
  );
});

Deno.test("extractJsonObject repairs raw control characters in strings", () => {
  // The exact failure seen charting chalk/chalk: a literal newline inside a
  // markdown body, which is invalid JSON but a complete, usable answer.
  const raw = '{"title":"Chalk","body":"line one\nline two\ttabbed"}';
  assertThrows(() => JSON.parse(raw));
  assertEquals(extractJsonObject(raw), {
    title: "Chalk",
    body: "line one\nline two\ttabbed",
  });

  // An already-escaped body must survive untouched, including literal
  // backslash-n sequences that are not newlines at all.
  assertEquals(
    extractJsonObject('{"body":"escaped \\n stays \\\\n literal"}'),
    { body: "escaped \n stays \\n literal" },
  );

  // Control characters with no short escape fall back to \\uXXXX.
  assertEquals(extractJsonObject('{"body":"bell\x07here"}'), {
    body: "bell\x07here",
  });
});

Deno.test("countMermaid counts fences", () => {
  assertEquals(countMermaid("a\n```mermaid\nflowchart\n```\nb"), 1);
  assertEquals(countMermaid("```mermaid\nx\n```\n```mermaid\ny\n```"), 2);
  assertEquals(countMermaid("no diagrams"), 0);
});

Deno.test("yamlString escapes quotes and backslashes", () => {
  assertEquals(yamlString('a "b" c'), '"a \\"b\\" c"');
  assertEquals(yamlString("a\\b"), '"a\\\\b"');
});

Deno.test("renderNote emits frontmatter, body and resolved wikilinks", () => {
  const md = renderNote(
    {
      slug: "overview",
      title: "Overview",
      kind: "overview",
      body: "It does things.\n\n```mermaid\nflowchart TD\n A-->B\n```",
      links: ["data-flow", "does-not-exist"],
    },
    {
      source: "https://github.com/org/thing",
      sourceKind: "repo",
      project: "thing",
      generatedAt: "2026-08-21T12:00:00.000Z",
      tags: ["Backend"],
      titleBySlug: new Map([["data-flow", "Data Flow"]]),
    },
  );

  assertStringIncludes(md, 'title: "Overview"');
  assertStringIncludes(md, 'atlas-kind: "overview"');
  assertStringIncludes(md, 'atlas-source: "https://github.com/org/thing"');
  assertStringIncludes(md, "  - atlas\n");
  assertStringIncludes(md, "  - atlas-overview\n");
  assertStringIncludes(md, "  - backend\n");
  assertStringIncludes(md, "# Overview");
  assertStringIncludes(md, "```mermaid");
  // Resolvable link is rendered; dangling one is dropped.
  assertStringIncludes(md, "- [[data-flow|Data Flow]]");
  assertEquals(md.includes("does-not-exist"), false);
});

Deno.test("renderNote omits the Related section when nothing resolves", () => {
  const md = renderNote(
    { slug: "a", title: "A", kind: "component", body: "body", links: [] },
    {
      source: "s",
      sourceKind: "repo",
      project: "p",
      generatedAt: "2026-08-21T12:00:00.000Z",
      tags: [],
      titleBySlug: new Map(),
    },
  );
  assertEquals(md.includes("## Related"), false);
});

Deno.test("formatProgress renders measured counters, never a percentage", () => {
  assertEquals(
    formatProgress({
      elapsedSeconds: 151,
      turns: 14,
      filesRead: 47,
      searches: 0,
      costUsd: 2.1,
    }),
    "2m31s · 14 turns · 47 files read · $2.10",
  );
  // Zero-padded seconds, singulars, searches included, cost still unknown.
  assertEquals(
    formatProgress({
      elapsedSeconds: 65,
      turns: 1,
      filesRead: 1,
      searches: 3,
      costUsd: null,
    }),
    "1m05s · 1 turn · 1 file read · 3 searches",
  );
  assertEquals(
    formatProgress(emptyProgress()),
    "0m00s · 0 turns · 0 files read",
  );
});

Deno.test("applyStreamEvent counts turns and tool use", () => {
  const p = emptyProgress();
  applyStreamEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_use", name: "Grep", input: {} },
        { type: "tool_use", name: "Read", input: {} },
      ],
    },
  }, p);

  assertEquals(p.turns, 1);
  assertEquals(p.filesRead, 2);
  assertEquals(p.searches, 1);
});

Deno.test("applyStreamEvent picks up cost from the result event", () => {
  const p = emptyProgress();
  applyStreamEvent({ type: "result", total_cost_usd: 2.27 }, p);
  assertEquals(p.costUsd, 2.27);
});

Deno.test("applyStreamEvent keeps the turn count monotonic", () => {
  const p = emptyProgress();
  const assistant = { type: "assistant", message: { content: [] } };
  for (let i = 0; i < 20; i++) applyStreamEvent(assistant, p);

  // The CLI's own num_turns counts turns differently and is typically lower
  // than the assistant messages seen; taking it would make the final progress
  // line report fewer turns than the line before it.
  applyStreamEvent({ type: "result", total_cost_usd: 0.87, num_turns: 16 }, p);
  assertEquals(p.turns, 20);
  assertEquals(p.costUsd, 0.87);
});

Deno.test("applyStreamEvent ignores junk without throwing", () => {
  const p = emptyProgress();
  for (
    const junk of [null, undefined, 42, "text", [], {}, { type: "system" }]
  ) {
    applyStreamEvent(junk, p);
  }
  // Non-assistant, non-result events must not move any counter.
  assertEquals(p, emptyProgress());
});

Deno.test("applyStreamEvent tolerates a malformed assistant message", () => {
  const p = emptyProgress();
  applyStreamEvent({ type: "assistant" }, p);
  applyStreamEvent(
    { type: "assistant", message: { content: "not-an-array" } },
    p,
  );
  applyStreamEvent({ type: "assistant", message: { content: [null, 7] } }, p);
  // Turns still counted; no tool counters corrupted.
  assertEquals(p.turns, 3);
  assertEquals(p.filesRead, 0);
  assertEquals(p.searches, 0);
});

Deno.test("surveyTree summarises a tree and skips ignored dirs", async () => {
  const root = await Deno.makeTempDir({ prefix: "atlas-test-" });
  try {
    await Deno.writeTextFile(`${root}/package.json`, '{"name":"x"}');
    await Deno.writeTextFile(`${root}/index.ts`, "export const a = 1;\n");
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(`${root}/src/app.ts`, "export const b = 2;\n");
    await Deno.mkdir(`${root}/node_modules/junk`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/node_modules/junk/huge.ts`,
      "x".repeat(500),
    );

    const s = await surveyTree(root);

    assertEquals(s.fileCount, 3, "node_modules must not be counted");
    assertEquals(s.truncated, false);
    assertEquals(
      s.languages.find((l) => l.language === "TypeScript")?.files,
      2,
    );
    assertEquals(s.signalFiles.includes("package.json"), true);
    assertEquals(s.signalFiles.includes("index.ts"), true);
    assertEquals(s.topLevel.includes("src/"), true);
    assertEquals(
      s.topLevel.includes("node_modules/"),
      false,
      "ignored dirs must not appear in topLevel",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Method-level tests
//
// These exercise the real methods end to end without network access or spend:
// the repository is a local git repo, and the Claude CLI is a shell script that
// prints a canned NDJSON stream. That covers the streaming, parsing, rendering
// and failure paths that the pure-helper tests cannot reach.
// ---------------------------------------------------------------------------

/** Global arguments with every default resolved, as the engine would pass them. */
function testGlobals(
  vaultRoot: string,
  claudeBin: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    vaultRoot,
    folder: "Atlas",
    claudeBin,
    permissionMode: "dontAsk",
    timeoutSeconds: 900,
    ...extra,
  };
}

/** Create a small git repository on disk and return its path. */
async function makeGitRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "atlas-src-" });
  await Deno.writeTextFile(`${root}/package.json`, '{"name":"fixture"}');
  await Deno.writeTextFile(`${root}/index.ts`, "export const a = 1;\n");
  const git = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!success) throw new Error(new TextDecoder().decode(stderr));
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("add", "-A");
  await git("commit", "-q", "-m", "fixture");
  return root;
}

/**
 * Write an executable stand-in for the Claude CLI that prints `lines`.
 *
 * @param lines NDJSON event lines the fake CLI should emit on stdout.
 * @param exitCode Exit status for the fake process.
 * @returns Path to the executable.
 */
async function makeFakeClaude(
  lines: string[],
  exitCode = 0,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "atlas-bin-" });
  const path = `${dir}/claude`;
  const payload = lines.join("\n");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\ncat <<'STREAM_EOF'\n${payload}\nSTREAM_EOF\nexit ${exitCode}\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

/**
 * A minimal valid atlas document as the agent would return it.
 *
 * @param body Markdown body for the first note.
 * @param secondSlug Slug of the second note, varied to simulate the agent
 *   rewording a title between runs and so orphaning the old file.
 */
function atlasDocument(body: string, secondSlug = "details"): string {
  return JSON.stringify({
    title: "Fixture",
    summary: "A fixture project.",
    tags: ["Fixture"],
    notes: [
      {
        slug: "overview",
        title: "Overview",
        kind: "overview",
        body,
        links: [secondSlug],
      },
      {
        slug: secondSlug,
        title: "Details",
        kind: "component",
        body: "Details body.",
        links: ["overview", "missing"],
      },
    ],
  });
}

/** Build a fake event stream whose result event carries `resultText`. */
function stream(resultText: string, costUsd = 0.42): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Grep", input: {} },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: resultText,
      total_cost_usd: costUsd,
      num_turns: 1,
    }),
  ];
}

/** Captured writes and logs from a stubbed method context. */
interface Captured {
  // deno-lint-ignore no-explicit-any
  context: any;
  resources: Array<{ specName: string; name: string; data: Record<string, unknown> }>;
  files: Array<{ specName: string; name: string; content: string }>;
  logs: string[];
  deleted: string[];
}

/**
 * Build a method context that records what the method writes and logs.
 *
 * @param globalArgs Resolved global arguments for the run.
 * @returns The context plus the arrays it appends to.
 */
function captureContext(
  globalArgs: Record<string, unknown>,
  stored: Record<string, Record<string, unknown>> = {},
): Captured {
  const resources: Captured["resources"] = [];
  const files: Captured["files"] = [];
  const logs: string[] = [];
  const deleted: string[] = [];
  const render = (msg: string, props?: Record<string, unknown>) =>
    msg.replace(/\{(\w+)\}/g, (_, k) => String(props?.[k] ?? `{${k}}`));

  return {
    resources,
    files,
    logs,
    deleted,
    context: {
      globalArgs,
      logger: {
        info: (m: string, p?: Record<string, unknown>) => logs.push(render(m, p)),
        warning: (m: string, p?: Record<string, unknown>) =>
          logs.push(render(m, p)),
      },
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        resources.push({ specName, name, data });
        return Promise.resolve({ name });
      },
      readResource: (name: string) => Promise.resolve(stored[name] ?? null),
      deleteResource: (name: string) => {
        deleted.push(name);
        return Promise.resolve();
      },
      createFileWriter: (specName: string, name: string) => ({
        writeText: (content: string) => {
          files.push({ specName, name, content });
          return Promise.resolve({ name });
        },
      }),
    },
  };
}

Deno.test("vault-exists check passes for a directory and fails otherwise", async () => {
  const dir = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const file = `${dir}/not-a-dir`;
  await Deno.writeTextFile(file, "x");
  try {
    const check = model.checks["vault-exists"];
    assertEquals(check.labels, ["policy"]);

    assertEquals(
      (await check.execute({ globalArgs: { vaultRoot: dir } as never })).pass,
      true,
    );

    const onFile = await check.execute({
      globalArgs: { vaultRoot: file } as never,
    });
    assertEquals(onFile.pass, false);
    assertStringIncludes(onFile.errors?.[0] ?? "", "not a directory");

    const missing = await check.execute({
      globalArgs: { vaultRoot: `${dir}/nope` } as never,
    });
    assertEquals(missing.pass, false);
    assertStringIncludes(missing.errors?.[0] ?? "", "does not exist");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("survey clones a repo, writes a conforming resource, and cleans up", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const before = await countTempDirs();
  try {
    const cap = captureContext(testGlobals(vault, "claude"));
    await model.methods.survey.execute(
      { repo, keepClone: false },
      cap.context,
    );

    assertEquals(cap.resources.length, 1);
    const [written] = cap.resources;
    assertEquals(written.specName, "survey");
    assertEquals(written.name, "survey-" + slugify(repo.split("/").pop()!));

    // Every field the survey spec declares must be populated.
    for (
      const field of [
        "source",
        "sourceKind",
        "ref",
        "commit",
        "project",
        "fileCount",
        "totalBytes",
        "truncated",
        "languages",
        "signalFiles",
        "topLevel",
        "surveyedAt",
      ]
    ) {
      assertEquals(
        field in written.data,
        true,
        `survey resource is missing ${field}`,
      );
    }
    assertEquals(written.data.fileCount, 2);
    assertEquals(written.data.truncated, false);
    assertEquals(written.data.sourceKind, "repo");
    assertEquals(written.data.ref, "default");
    assertEquals((written.data.commit as string).length, 40);

    // The clone and the temp directory holding it are both gone.
    assertEquals(await countTempDirs(), before);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
  }
});

/** Count leftover atlas-* clone directories in the system temp directory. */
async function countTempDirs(): Promise<number> {
  const tmp = await Deno.makeTempDir({ prefix: "atlas-probe-" });
  const parent = tmp.slice(0, tmp.lastIndexOf("/"));
  await Deno.remove(tmp);
  let n = 0;
  for await (const e of Deno.readDir(parent)) {
    if (e.isDirectory && e.name.startsWith("atlas-") && !e.name.startsWith("atlas-src-") &&
      !e.name.startsWith("atlas-bin-") && !e.name.startsWith("atlas-vault-") &&
      !e.name.startsWith("atlas-test-") && !e.name.startsWith("atlas-probe-")) n++;
  }
  return n;
}

Deno.test("chart renders notes into the vault and records every artifact", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const bin = await makeFakeClaude(
    stream(atlasDocument("Overview body.\n\n```mermaid\nflowchart TD\n A-->B\n```")),
  );
  try {
    const cap = captureContext(testGlobals(vault, bin));
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      cap.context,
    );

    const specs = cap.resources.map((r) => r.specName);
    assertEquals(specs, ["survey", "atlas", "note", "note"]);
    assertEquals(cap.files.length, 1);
    assertEquals(cap.files[0].specName, "transcript");

    const atlas = cap.resources[1].data;
    assertEquals(atlas.project, "fixture");
    assertEquals(atlas.folder, "Atlas/fixture");
    assertEquals(atlas.noteCount, 2);
    assertEquals(atlas.diagramCount, 1);

    // Notes actually exist on disk with frontmatter and resolved wikilinks.
    const overview = await Deno.readTextFile(
      `${vault}/Atlas/fixture/overview.md`,
    );
    assertStringIncludes(overview, 'atlas-project: "fixture"');
    assertStringIncludes(overview, "```mermaid");
    assertStringIncludes(overview, "[[details|Details]]");
    await Deno.stat(`${vault}/Atlas/fixture/details.md`);

    // The dangling link the agent invented is dropped, not rendered.
    const details = await Deno.readTextFile(
      `${vault}/Atlas/fixture/details.md`,
    );
    assertEquals(details.includes("missing"), false);
    assertEquals(cap.resources[3].data.links, ["overview"]);

    // Progress was reported, ending with the cost the CLI declared.
    const progress = cap.logs.filter((l) => l.includes("turn"));
    assertEquals(progress.length > 0, true, "expected a progress line");
    assertStringIncludes(progress[progress.length - 1], "$0.42");
    assertStringIncludes(progress[progress.length - 1], "1 file read");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chart recovers when the agent emits a raw control character", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  // A literal newline inside the JSON string — invalid JSON, complete answer.
  // This is the failure that killed a real run after several minutes.
  const bin = await makeFakeClaude(stream(atlasDocument("line one\nline two")));
  try {
    const cap = captureContext(testGlobals(vault, bin));
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      cap.context,
    );

    const body = await Deno.readTextFile(`${vault}/Atlas/fixture/overview.md`);
    assertStringIncludes(body, "line one\nline two");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chart keeps the transcript when the agent output is unusable", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const bin = await makeFakeClaude(stream("I could not work out what this is."));
  try {
    const cap = captureContext(testGlobals(vault, bin));
    const err = await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      cap.context,
    ).then(() => null, (e: unknown) => e);

    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "could not be parsed as JSON");

    // The spend is not thrown away: the transcript survives the failure.
    assertEquals(cap.files.length, 1);
    assertEquals(cap.files[0].specName, "transcript");
    assertStringIncludes(cap.files[0].content, "total_cost_usd");
    assertEquals(
      cap.logs.some((l) => l.includes("transcript kept")),
      true,
    );

    // No atlas or note resources were written from a failed run.
    assertEquals(
      cap.resources.filter((r) => r.specName !== "survey").length,
      0,
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chart reports an exhausted budget as its own failure", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const bin = await makeFakeClaude([
    JSON.stringify({
      type: "result",
      is_error: true,
      total_cost_usd: 1.51,
      terminal_reason: "budget_exhausted",
    }),
  ], 1);
  try {
    const cap = captureContext(testGlobals(vault, bin, { maxBudgetUsd: 1.5 }));
    const err = await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      cap.context,
    ).then(() => null, (e: unknown) => e);

    const message = (err as Error).message;
    assertStringIncludes(message, "maxBudgetUsd cap of $1.5");
    assertStringIncludes(message, "$1.51");
    // Still debuggable.
    assertEquals(cap.files.length, 1);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chartDiagram rejects a missing or unsupported image", async () => {
  const dir = await Deno.makeTempDir({ prefix: "atlas-img-" });
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  try {
    const cap = captureContext(testGlobals(vault, "claude"));

    const missing = await model.methods.chartDiagram.execute(
      { image: `${dir}/nope.png`, prune: false },
      cap.context,
    ).then(() => null, (e: unknown) => e);
    assertStringIncludes((missing as Error).message, "Diagram image not found");

    const bad = `${dir}/notes.txt`;
    await Deno.writeTextFile(bad, "x");
    const unsupported = await model.methods.chartDiagram.execute(
      { image: bad, prune: false },
      cap.context,
    ).then(() => null, (e: unknown) => e);
    assertStringIncludes(
      (unsupported as Error).message,
      "Unsupported image type",
    );

    // Nothing was written for either rejection.
    assertEquals(cap.resources.length, 0);
    assertEquals(cap.files.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(vault, { recursive: true });
  }
});

Deno.test("chart skips the spend when the commit is already charted", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  // A CLI that must never run: if the skip fails, the test fails loudly.
  const bin = await makeFakeClaude(["this would be a protocol violation"], 1);
  try {
    // First chart the project for real, using a working fake CLI.
    const good = await makeFakeClaude(stream(atlasDocument("Body.")));
    const first = captureContext(testGlobals(vault, good));
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      first.context,
    );
    const charted = first.resources.find((r) => r.specName === "atlas")!.data;
    assertEquals(typeof charted.commit, "string");

    // Now re-chart with the previous atlas recorded and the same HEAD.
    const second = captureContext(testGlobals(vault, bin), {
      "atlas-fixture": charted,
    });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      second.context,
    );

    // Only the survey is rewritten; no agent was invoked, nothing was spent.
    assertEquals(second.resources.map((r) => r.specName), ["survey"]);
    assertEquals(second.files.length, 0);
    assertEquals(
      second.logs.some((l) => l.includes("Already charted at commit")),
      true,
    );

    await Deno.remove(good.slice(0, good.lastIndexOf("/")), {
      recursive: true,
    });
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chart re-charts on force, a new commit, or missing notes", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const bin = await makeFakeClaude(stream(atlasDocument("Body.")));
  try {
    const globals = testGlobals(vault, bin);
    const baseline = captureContext(globals);
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      baseline.context,
    );
    const charted = baseline.resources.find((r) =>
      r.specName === "atlas"
    )!.data;

    // force overrides a matching commit.
    const forced = captureContext(globals, { "atlas-fixture": charted });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: true, prune: false },
      forced.context,
    );
    assertEquals(forced.resources.some((r) => r.specName === "atlas"), true);

    // A different recorded commit means the repo moved on.
    const moved = captureContext(globals, {
      "atlas-fixture": { ...charted, commit: "0".repeat(40) },
    });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      moved.context,
    );
    assertEquals(moved.resources.some((r) => r.specName === "atlas"), true);

    // Matching data but the notes are gone from the vault: charting again is
    // the only way the caller ends up with notes.
    await Deno.remove(`${vault}/Atlas/fixture`, { recursive: true });
    const emptied = captureContext(globals, { "atlas-fixture": charted });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      emptied.context,
    );
    assertEquals(emptied.resources.some((r) => r.specName === "atlas"), true);
    await Deno.stat(`${vault}/Atlas/fixture/overview.md`);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("notes record the commit they describe", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const bin = await makeFakeClaude(stream(atlasDocument("Body.")));
  try {
    const cap = captureContext(testGlobals(vault, bin));
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: false, prune: false },
      cap.context,
    );

    const commit =
      cap.resources.find((r) => r.specName === "atlas")!.data.commit as string;
    const note = await Deno.readTextFile(`${vault}/Atlas/fixture/overview.md`);
    assertStringIncludes(note, `atlas-commit: "${commit}"`);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
  }
});

Deno.test("chartDiagram exposes only the image, not its folder", async () => {
  const desktop = await Deno.makeTempDir({ prefix: "atlas-img-" });
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  // A secret sitting beside the diagram, as things do on a real desktop.
  await Deno.writeTextFile(`${desktop}/tax-return.txt`, "private");
  await Deno.writeTextFile(`${desktop}/arch.png`, "not-really-a-png");

  // The fake CLI reports the directory it was granted, so the test can assert
  // on what the agent could actually have read.
  const binDir = await Deno.makeTempDir({ prefix: "atlas-bin-" });
  const bin = `${binDir}/claude`;
  const seen = `${binDir}/granted.txt`;
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--add-dir" ]; then shift; ls "$1" > ${seen}; fi\n  shift\ndone\ncat <<'STREAM_EOF'\n${
      stream(atlasDocument("Body.")).join("\n")
    }\nSTREAM_EOF\n`,
  );
  await Deno.chmod(bin, 0o755);

  try {
    const cap = captureContext(testGlobals(vault, bin));
    await model.methods.chartDiagram.execute(
      { image: `${desktop}/arch.png`, project: "diagram", prune: false },
      cap.context,
    );

    const granted = await Deno.readTextFile(seen);
    assertStringIncludes(granted, "arch.png");
    assertEquals(
      granted.includes("tax-return"),
      false,
      "the agent must not be able to see files beside the diagram",
    );

    // Provenance still points at the real file, not the staged copy.
    const atlas = cap.resources.find((r) => r.specName === "atlas")!.data;
    assertEquals(atlas.source, `${desktop}/arch.png`);
  } finally {
    await Deno.remove(desktop, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("findOrphans claims only notes this model wrote", async () => {
  const dir = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const note = (project: string) =>
    `---\ntitle: "T"\natlas-project: ${JSON.stringify(project)}\n---\n\n# T\n`;
  try {
    await Deno.writeTextFile(`${dir}/kept.md`, note("fixture"));
    await Deno.writeTextFile(`${dir}/orphan.md`, note("fixture"));
    // None of the following belong to this project and must survive.
    await Deno.writeTextFile(`${dir}/my-own-notes.md`, "# Mine\n");
    await Deno.writeTextFile(`${dir}/other-project.md`, note("elsewhere"));
    await Deno.writeTextFile(`${dir}/data.json`, "{}");
    // A note that merely quotes the marker in its prose, without frontmatter.
    await Deno.writeTextFile(
      `${dir}/quoting.md`,
      `# Docs\n\nWe set atlas-project: "fixture" in frontmatter.\n`,
    );
    await Deno.mkdir(`${dir}/subfolder`);
    await Deno.writeTextFile(`${dir}/subfolder/nested.md`, note("fixture"));

    const orphans = await findOrphans(
      dir,
      "fixture",
      new Set([`${dir}/kept.md`]),
    );
    assertEquals(orphans, [{ slug: "orphan", path: `${dir}/orphan.md` }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findOrphans returns nothing for a folder that is not there", async () => {
  assertEquals(await findOrphans("/nonexistent/atlas/dir", "x", new Set()), []);
});

Deno.test("chart reports orphaned notes but leaves them alone by default", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const first = await makeFakeClaude(stream(atlasDocument("Body.", "details")));
  // The agent rewords the second note, so its slug — and its filename — change.
  const second = await makeFakeClaude(
    stream(atlasDocument("Body.", "finer-details")),
  );
  try {
    const globals = testGlobals(vault, first);
    const before = captureContext(globals);
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: true, prune: false },
      before.context,
    );
    const charted = before.resources.find((r) => r.specName === "atlas")!.data;
    await Deno.stat(`${vault}/Atlas/fixture/details.md`);

    const after = captureContext(testGlobals(vault, second), {
      "atlas-fixture": charted,
    });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: true, prune: false },
      after.context,
    );

    // The orphan is still there, and the user was told about it by name.
    await Deno.stat(`${vault}/Atlas/fixture/details.md`);
    await Deno.stat(`${vault}/Atlas/fixture/finer-details.md`);
    assertEquals(after.deleted, []);
    const warned = after.logs.find((l) => l.includes("no longer produced"));
    assertEquals(typeof warned, "string");
    assertStringIncludes(warned!, "details");

    await Deno.remove(first.slice(0, first.lastIndexOf("/")), {
      recursive: true,
    });
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(second.slice(0, second.lastIndexOf("/")), {
      recursive: true,
    });
  }
});

Deno.test("chart with prune removes the orphan and its stale resource", async () => {
  const repo = await makeGitRepo();
  const vault = await Deno.makeTempDir({ prefix: "atlas-vault-" });
  const first = await makeFakeClaude(stream(atlasDocument("Body.", "details")));
  const second = await makeFakeClaude(
    stream(atlasDocument("Body.", "finer-details")),
  );
  try {
    const before = captureContext(testGlobals(vault, first));
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: true, prune: true },
      before.context,
    );
    const charted = before.resources.find((r) => r.specName === "atlas")!.data;

    // A file the model never wrote must survive the prune untouched.
    const handwritten = `${vault}/Atlas/fixture/my-own-notes.md`;
    await Deno.writeTextFile(handwritten, "mine");

    const after = captureContext(testGlobals(vault, second), {
      "atlas-fixture": charted,
    });
    await model.methods.chart.execute(
      { repo, project: "fixture", keepClone: false, force: true, prune: true },
      after.context,
    );

    // The orphan is gone, along with the resource that described it.
    assertEquals(
      await Deno.stat(`${vault}/Atlas/fixture/details.md`).then(
        () => true,
        () => false,
      ),
      false,
      "the orphaned note should have been deleted",
    );
    assertEquals(after.deleted, ["note-fixture-details"]);
    assertEquals(
      after.logs.some((l) => l.includes("Pruned 1 orphaned note")),
      true,
    );

    // Current notes and anything the user wrote themselves are untouched.
    await Deno.stat(`${vault}/Atlas/fixture/overview.md`);
    await Deno.stat(`${vault}/Atlas/fixture/finer-details.md`);
    assertEquals(await Deno.readTextFile(handwritten), "mine");

    await Deno.remove(first.slice(0, first.lastIndexOf("/")), {
      recursive: true,
    });
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(vault, { recursive: true });
    await Deno.remove(second.slice(0, second.lastIndexOf("/")), {
      recursive: true,
    });
  }
});
