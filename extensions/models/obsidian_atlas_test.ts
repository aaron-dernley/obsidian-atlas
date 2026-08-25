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
  formatProgress,
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
