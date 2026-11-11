import { expect, test } from "bun:test";
import { projectMessageBranches } from "../src/lib/omp/branches";
import type { AgentMessage, SessionTree, SessionTreeNode, UserMessage } from "../src/lib/omp/types";

function user(text: string, timestamp: number, extra: Partial<UserMessage> = {}): UserMessage {
  return { role: "user", content: text, timestamp, ...extra };
}

function node(
  id: string,
  timestamp: number,
  message?: AgentMessage,
  children: SessionTreeNode[] = [],
): SessionTreeNode {
  for (const child of children) child.entry.parentId = id;
  return {
    entry: { id, parentId: null, type: message ? "message" : "model_change", timestamp: new Date(timestamp).toISOString(), ...(message ? { message } : {}) },
    children,
  };
}

function assistant(timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp };
}

test("duplicate prompt text maps by timestamp and content, not text alone", () => {
  const first = user("repeat", 1);
  const second = user("repeat", 3);
  const image = user("", 5, { content: [{ type: "image", mimeType: "image/png", data: "original" }] });
  const tree: SessionTree = {
    tree: [node("first", 1, first, [node("answer", 2, assistant(2), [
      node("second", 3, second, [node("answer-2", 4, assistant(4), [node("image", 5, image)])]),
    ])])],
    leafId: "image",
  };
  const transcript: AgentMessage[] = [
    first, assistant(2), second,
    user("", 5, { content: [{ type: "image", mimeType: "image/png", data: "different" }] }),
    user("", 5, { content: [{ data: "original", mimeType: "image/png", type: "image" }] }),
  ];
  const projected = projectMessageBranches(tree, transcript);
  expect(projected.map((branch) => branch?.entryId)).toEqual(["first", undefined, "second", undefined, "image"]);
  expect(projected[0]?.alternatives).toEqual([{ entryId: "first", leafId: "image" }]);
  expect(projected[2]?.alternatives).toEqual([{ entryId: "second", leafId: "image" }]);
});

test("metadata-separated alternatives retain chronological order and restore newest complete tails", () => {
  const original = user("original", 3);
  const edited = user("edited", 7);
  const olderTail = node("old-tail", 5, assistant(5));
  const latestTail = node("newest-tail", 20, assistant(20));
  const activeTail = node("active-tail", 8, assistant(8));
  const newerInactiveTail = node("inactive-tail", 30, assistant(30));
  const root = node("answer", 1, assistant(1), [
    // Deliberately out of timestamp order: alternatives must still be chronological.
    node("thinking", 6, undefined, [node("edited", 7, edited, [activeTail, newerInactiveTail])]),
    node("model", 2, undefined, [node("custom", 2, undefined, [node("original", 3, original, [olderTail, latestTail])])]),
  ]);
  const projected = projectMessageBranches({ tree: [root], leafId: "active-tail" }, [edited, assistant(8)]);
  expect(projected).toEqual([
    {
      entryId: "edited", index: 1,
      alternatives: [{ entryId: "original", leafId: "newest-tail" }, { entryId: "edited", leafId: "active-tail" }],
    },
    undefined,
  ]);
});

test("nested forks and sequential prompts do not become outer alternatives", () => {
  const first = user("first", 1);
  const outerEdit = user("outer edit", 2);
  const next = user("next", 4);
  const innerEdit = user("inner edit", 6);
  const sequential = user("sequential", 8);
  const roots = [
    node("first", 1, first, [node("reply", 3, assistant(3), [
      node("next", 4, next, [node("next-reply", 5, assistant(5))]),
      node("inner-meta", 5, undefined, [node("inner", 6, innerEdit, [
        node("inner-reply", 7, assistant(7), [node("sequential", 8, sequential)]),
      ])]),
    ])]),
    node("outer", 2, outerEdit),
  ];
  const projected = projectMessageBranches({ tree: roots, leafId: "sequential" }, [first, innerEdit, sequential]);
  expect(projected[0]).toEqual({
    entryId: "first", index: 0,
    alternatives: [{ entryId: "first", leafId: "sequential" }, { entryId: "outer", leafId: "outer" }],
  });
  expect(projected[1]).toEqual({
    entryId: "inner", index: 1,
    alternatives: [{ entryId: "next", leafId: "next-reply" }, { entryId: "inner", leafId: "sequential" }],
  });
  expect(projected[2]?.alternatives).toEqual([{ entryId: "sequential", leafId: "sequential" }]);
});

test("compacted transcripts match ordered surviving identities and ignore unpersisted users", () => {
  const first = user("repeat", 1);
  const middle = user("repeat", 3);
  const last = user("repeat", 5);
  const root = node("first", 1, first, [node("reply", 2, assistant(2), [
    node("middle", 3, middle, [node("reply-2", 4, assistant(4), [node("last", 5, last)])]),
  ])]);
  const transcript: AgentMessage[] = [
    { role: "compactionSummary", content: "summary", timestamp: 6 },
    user("unpersisted", 0), middle, assistant(4), last,
  ];
  expect(projectMessageBranches({ tree: [root], leafId: "last" }, transcript).map((branch) => branch?.entryId))
    .toEqual([undefined, undefined, "middle", undefined, "last"]);
});

test("synthetic, developer, and agent-attributed messages are never editable", () => {
  const ordinary = user("prompt", 1);
  const synthetic = user("injected", 2, { synthetic: true });
  const agent = user("agent", 3, { attribution: "agent" });
  const developer: AgentMessage = { role: "developer", content: "rules", timestamp: 4 };
  const root = node("ordinary", 1, ordinary, [node("synthetic", 2, synthetic, [
    node("agent", 3, agent, [node("developer", 4, developer)]),
  ])]);
  const projected = projectMessageBranches({ tree: [root], leafId: "developer" }, [ordinary, synthetic, agent, developer]);
  expect(projected.map((branch) => branch?.entryId)).toEqual(["ordinary", undefined, undefined, undefined]);
});

test("fully identical repeated identities consume distinct entries in transcript order", () => {
  const repeated = user("identical", 1);
  const root = node("first", 1, repeated, [node("second", 2, { ...repeated })]);
  const projected = projectMessageBranches({ tree: [root], leafId: "second" }, [repeated, { ...repeated }]);
  expect(projected.map((branch) => branch?.entryId)).toEqual(["first", "second"]);
  expect(projected.map((branch) => branch?.alternatives.length)).toEqual([1, 1]);
});

test("deep histories project iteratively without overflowing the call stack", () => {
  const prompt = user("deep", 1);
  const root = node("root", 1, prompt);
  let tail = root;
  for (let index = 0; index < 25_000; index++) {
    const child = node(`metadata-${index}`, index + 2);
    child.entry.parentId = tail.entry.id;
    tail.children.push(child);
    tail = child;
  }
  const projected = projectMessageBranches({ tree: [root], leafId: tail.entry.id }, [prompt]);
  expect(projected[0]).toEqual({
    entryId: "root", index: 0,
    alternatives: [{ entryId: "root", leafId: tail.entry.id }],
  });
});

test("an empty or unselected tree never attributes transcript messages to inactive entries", () => {
  const prompt = user("prompt", 1);
  expect(projectMessageBranches({ tree: [], leafId: null }, [prompt])).toEqual([undefined]);
  expect(projectMessageBranches({ tree: [node("prompt", 1, prompt)], leafId: null }, [prompt])).toEqual([undefined]);
});
