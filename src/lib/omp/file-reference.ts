export function formatPathReferences(paths: string[]): string {
  return paths.map((path) => {
    let fenceLength = 1;
    for (const [run] of path.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run.length + 1);
    const fence = "`".repeat(fenceLength);
    const padding = path.startsWith("`") || path.endsWith("`") ? " " : "";
    return `${fence}${padding}${path}${padding}${fence}`;
  }).join(" ");
}
