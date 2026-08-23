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
  assertSafeSegment,
  countMermaid,
  extractCliText,
  extractJsonObject,
  normalizeRepoUrl,
  projectNameFromUrl,
  renderNote,
  slugify,
  surveyTree,
  yamlString,
} from "./obsidian_atlas.ts";

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
