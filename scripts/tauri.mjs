// /wt can rewrite the source checkout. Native auto-restarts would close the
// desktop window and terminate its agent in the middle of that relocation.
if (process.argv[2] === "dev" && !process.argv.slice(3).includes("--no-watch")) {
  process.argv.splice(3, 0, "--no-watch");
}

await import("@tauri-apps/cli/tauri.js");
