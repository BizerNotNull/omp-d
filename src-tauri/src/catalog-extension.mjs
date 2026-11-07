// The CLI's public JSON lists available models only. Read the full registry at
// shutdown through the extension API, after configured extensions have loaded.
export default function (omp) {
  omp.on("session_shutdown", (_event, context) => {
    const models = context.modelRegistry.getAll("all").map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      kind: model.kind ?? "chat",
      contextWindow: model.contextWindow,
      input: model.input,
      cost: model.cost && {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
      },
    }));
    process.stdout.write(`\nOMP_D_CATALOG:${JSON.stringify(models)}\n`);
  });
}
