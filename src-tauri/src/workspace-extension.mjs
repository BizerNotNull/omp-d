// Query the live session manager even before an empty session has a JSONL file.
export default function workspaceExtension(pi) {
  pi.registerCommand("ompd-workspace", {
    description: "Synchronize the desktop workspace",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("ompd:workspace", ctx.sessionManager.getCwd());
    },
  });
}
