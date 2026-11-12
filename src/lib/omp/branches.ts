import type { AgentMessage, SessionEntries, SessionTree, SessionTreeNode } from "./types";

export interface MessageBranch {
  entryId: string;
  alternatives: Array<{ entryId: string; leafId: string }>;
  index: number;
}

/** Build the local tree without sending depth-proportional JSON through native IPC. */
export function sessionTreeFromEntries({ entries, leafId }: SessionEntries): SessionTree {
  const nodes = new Map<string, SessionTreeNode>();
  for (const entry of entries) nodes.set(entry.id, { entry, children: [] });
  const tree: SessionTreeNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent = entry.parentId === null ? undefined : nodes.get(entry.parentId);
    if (parent) parent.children.push(node);
    else tree.push(node);
  }
  return { tree, leafId };
}

function editable(message: AgentMessage): boolean {
  return message.role === "user" && message.synthetic !== true && message.attribution !== "agent";
}

function identity(message: AgentMessage): string {
  // Normalize block field order without reducing identity to the visible prompt text.
  const content = Array.isArray(message.content)
    ? message.content.map((block) => block.type === "text"
      ? [block.type, block.text]
      : block.type === "image"
        ? [block.type, block.mimeType, block.data]
        : block)
    : message.content;
  return JSON.stringify([message.role, message.timestamp, content]);
}

interface IndexedNode {
  node: SessionTreeNode;
  parent: IndexedNode | undefined;
  messageAncestor: IndexedNode | undefined;
  order: number;
  newestLeaf: IndexedNode;
  active: boolean;
}

function newer(left: IndexedNode, right: IndexedNode): IndexedNode {
  const difference = Date.parse(left.node.entry.timestamp) - Date.parse(right.node.entry.timestamp);
  return difference > 0 || (!(difference < 0) && left.order > right.order) ? left : right;
}

/** Project persisted active-path user entries onto the possibly compacted transcript. */
export function projectMessageBranches(
  tree: SessionTree,
  messages: AgentMessage[],
): Array<MessageBranch | undefined> {
  const result = new Array<MessageBranch | undefined>(messages.length).fill(undefined);
  const nodes: IndexedNode[] = [];
  const groups = new Map<IndexedNode | undefined, IndexedNode[]>();
  const pending: Array<{ node: SessionTreeNode; parent: IndexedNode | undefined }> = [];
  for (let index = tree.tree.length - 1; index >= 0; index--) {
    pending.push({ node: tree.tree[index], parent: undefined });
  }
  let activeLeaf: IndexedNode | undefined;
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    const messageAncestor = parent?.node.entry.type === "message" ? parent : parent?.messageAncestor;
    const indexed: IndexedNode = {
      node, parent, messageAncestor, order: nodes.length,
      newestLeaf: undefined!, active: node.entry.id === tree.leafId,
    };
    indexed.newestLeaf = indexed;
    nodes.push(indexed);
    if (indexed.active) activeLeaf = indexed;
    if (node.entry.type === "message" && node.entry.message && editable(node.entry.message)) {
      const alternatives = groups.get(messageAncestor);
      if (alternatives) alternatives.push(indexed);
      else groups.set(messageAncestor, [indexed]);
    }
    for (let index = node.children.length - 1; index >= 0; index--) {
      pending.push({ node: node.children[index], parent: indexed });
    }
  }
  if (!activeLeaf) return result;

  // Children precede parents in this pass, so each subtree is summarized once.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const current = nodes[index];
    const parent = current.parent;
    if (!parent) continue;
    parent.active ||= current.active;
    parent.newestLeaf = parent.newestLeaf === parent
      ? current.newestLeaf
      : newer(parent.newestLeaf, current.newestLeaf);
  }

  const path: IndexedNode[] = [];
  for (let current: IndexedNode | undefined = activeLeaf; current; current = current.parent) {
    if (current.node.entry.type === "message" && current.node.entry.message && editable(current.node.entry.message)) {
      path.push(current);
    }
  }
  path.reverse();
  const identities = new Map<string, { entries: Array<{ node: IndexedNode; index: number }>; cursor: number }>();
  for (let index = 0; index < path.length; index++) {
    const node = path[index];
    const key = identity(node.node.entry.message!);
    const matching = identities.get(key);
    if (matching) matching.entries.push({ node, index });
    else identities.set(key, { entries: [{ node, index }], cursor: 0 });
  }

  const projections = new Map<IndexedNode | undefined, MessageBranch["alternatives"]>();
  let previousIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!editable(message)) continue;
    const matching = identities.get(identity(message));
    if (!matching) continue;
    while (matching.cursor < matching.entries.length && matching.entries[matching.cursor].index <= previousIndex) {
      matching.cursor++;
    }
    const match = matching.entries[matching.cursor++];
    if (!match) continue;
    previousIndex = match.index;
    const current = match.node;
    let alternatives = projections.get(current.messageAncestor);
    if (!alternatives) {
      const siblings = groups.get(current.messageAncestor)!;
      siblings.sort((left, right) => {
        const difference = Date.parse(left.node.entry.timestamp) - Date.parse(right.node.entry.timestamp);
        return Number.isNaN(difference) || difference === 0 ? left.order - right.order : difference;
      });
      alternatives = siblings.map((sibling) => ({
        entryId: sibling.node.entry.id,
        leafId: sibling.active ? activeLeaf.node.entry.id : sibling.newestLeaf.node.entry.id,
      }));
      projections.set(current.messageAncestor, alternatives);
    }
    result[index] = {
      entryId: current.node.entry.id,
      alternatives,
      index: alternatives.findIndex((alternative) => alternative.entryId === current.node.entry.id),
    };
  }
  return result;
}
