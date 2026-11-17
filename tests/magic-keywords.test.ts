import { describe, expect, test } from "bun:test";
import { magicKeywordRanges } from "../src/lib/omp/magic-keywords";

const words = (text: string) => magicKeywordRanges(text).map((range) => text.slice(range.from, range.to));

describe("magic prompt keywords", () => {
  test("matches lowercase prose with punctuation and preserves UTF-16 offsets", () => {
    expect(words("😀 请 ultrathink, (chillax) orchestrate! workflowz; jevify."))
      .toEqual(["ultrathink", "chillax", "orchestrate", "workflowz", "jevify"]);
    expect(words("ultrathink ultrathink")).toEqual(["ultrathink", "ultrathink"]);
  });

  test("does not decorate identifiers, paths, calls or uppercase words", () => {
    expect(words("Ultrathink ULTRATHINK my_ultrathink ultrathink2 超ultrathink foo::ultrathink ./ultrathink ultrathink.ts ultrathink() ultrathink/path x-ultrathink"))
      .toEqual([]);
  });

  test("excludes multiline code, exact-length inline spans, and markup contents", () => {
    const text = [
      "`ultrathink` ``a ` chillax`` orchestrate",
      "```ts", "ultrathink", "```",
      "~~~", "chillax", "~~~",
      '<note title="a > b">ultrathink <note>jevify</note> chillax</note>',
      "<!-- workflowz --> <self keyword='ultrathink' />",
      "workflowz",
    ].join("\n");
    expect(words(text)).toEqual(["orchestrate", "workflowz"]);
  });

  test("handles incomplete input without swallowing subsequent prose", () => {
    expect(words("`ultrathink")).toEqual(["ultrathink"]);
    expect(words("<note>ultrathink")).toEqual(["ultrathink"]);
    expect(words("ultrathink\n```\nchillax")).toEqual(["ultrathink"]);
    expect(words("<!-- ultrathink")).toEqual([]);
  });
});
