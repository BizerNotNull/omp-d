// /wt can rewrite the source checkout while the agent is still using it.
if (process.argv[2] === "dev") {
  process.env.OMPD_DEV_NO_WATCH = "1";
  if (!process.argv.slice(3).includes("--no-watch")) process.argv.splice(3, 0, "--no-watch");
}

await import("@tauri-apps/cli/tauri.js");
