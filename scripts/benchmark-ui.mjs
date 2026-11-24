import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { build } from "vite";

const fixture = "tests/ui-benchmark.html";
const sampleCount = 3;

async function findBrowser() {
  const override = process.env.OMPD_BENCH_BROWSER;
  if (override) return Bun.which(override) ?? resolve(override);
  for (const cmd of ["google-chrome", "chromium", "chromium-browser", "msedge", "chrome"]) {
    const path = Bun.which(cmd);
    if (path) return path;
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"].flatMap((file) => roots.map((root) => join(root, file))),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  throw new Error("Chromium browser not found; set OMPD_BENCH_BROWSER to its executable path");
}

async function waitFor(description, lookup) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const result = await lookup();
    if (result) return result;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener("message", ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    const request = pending.get(id);
    if (request) {
      if (error) request.reject(new Error(error.message));
      else request.resolve(result);
    }
  });
  ws.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("CDP socket closed"));
  });
  try {
    await waitFor("CDP connection", () => {
      if (ws.readyState === WebSocket.CLOSED) throw new Error("Could not connect to CDP");
      return ws.readyState === WebSocket.OPEN;
    });
  } catch (error) {
    ws.close();
    throw error;
  }
  return {
    close: () => ws.close(),
    async call(method, params = {}, timeout = 30_000) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error(`${method}: CDP socket closed`);
      const id = ++nextId;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), timeout);
          ws.send(JSON.stringify({ id, method, params }));
        });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
  };
}

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function metrics(page) {
  const { metrics } = await page.call("Performance.getMetrics");
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function percentile(values, fraction) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Missing or invalid frame intervals");
  }
  const ordered = values.toSorted((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
}

async function measure(page, url, sample) {
  const query = `?sample=${sample}`;
  const navigation = await page.call("Page.navigate", { url: url + query });
  if (navigation.errorText) throw new Error(navigation.errorText);
  await waitFor("benchmark fixture", async () => {
    try {
      return await evaluate(page, `location.search === ${JSON.stringify(query)} && !!globalThis.uiBenchmark`);
    } catch (error) {
      // A navigation can invalidate the previous document's execution context.
      if (!/context.*destroyed|cannot find context|navigated/i.test(error.message)) throw error;
      return false;
    }
  });
  await evaluate(page, "uiBenchmark.prepare()");
  await page.call("HeapProfiler.collectGarbage");
  const before = await metrics(page);
  const { stream, scroll } = await evaluate(page, "uiBenchmark.run()");
  const after = await metrics(page);
  if (stream.length !== 144 || scroll.length !== 48) throw new Error("Fixture returned an incomplete workload");
  await page.call("HeapProfiler.collectGarbage");
  const retained = await metrics(page);
  const { nodes } = await page.call("Memory.getDOMCounters");
  const values = {
    renderer_task_ms: (after.TaskDuration - before.TaskDuration) * 1000,
    stream_frame_p95_ms: percentile(stream, 0.95),
    scroll_frame_p95_ms: percentile(scroll, 0.95),
    retained_js_heap_mib: retained.JSHeapUsedSize / (1024 * 1024),
    dom_nodes: nodes,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid metric ${name}: ${value}`);
  }
  return values;
}

async function benchmark() {
  const executable = await findBrowser();
  const temp = await mkdtemp(join(tmpdir(), "ompd-ui-bench-"));
  const dist = join(temp, "dist");
  const profile = join(temp, "profile");
  let server, browser, browserCdp, page;
  try {
    await build({ logLevel: "error", build: {
      outDir: dist,
      rolldownOptions: { input: resolve(fixture) },
      reportCompressedSize: false,
    } });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = resolve(dist, `.${new URL(request.url).pathname}`);
        if (!path.startsWith(dist + sep)) return new Response(null, { status: 404 });
        const file = Bun.file(path);
        if (!await file.exists()) return new Response(null, { status: 404 });
        return new Response(file, { headers: {
          "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:",
        } });
      },
    });
    browser = Bun.spawn([
      executable, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const base = await waitFor("Chromium DevTools port", async () => {
      if (browser.exitCode !== null) throw new Error(`Chromium exited during startup (${browser.exitCode})`);
      let contents;
      try {
        contents = await readFile(join(profile, "DevToolsActivePort"), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      const [port, endpoint] = contents.trim().split(/\r?\n/);
      return /^\d+$/.test(port) && endpoint?.startsWith("/devtools/browser/") && `http://127.0.0.1:${port}`;
    });
    const json = async (path) => {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Chromium ${path}: HTTP ${response.status}`);
      return response.json();
    };
    const version = await json("/json/version");
    browserCdp = await connect(version.webSocketDebuggerUrl);
    const target = (await json("/json/list")).find(({ type, url }) => type === "page" && url === "about:blank");
    if (!target) throw new Error("Chromium did not open the benchmark tab");
    page = await connect(target.webSocketDebuggerUrl);
    await page.call("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await page.call("Performance.enable");
    const samples = [];
    console.error(`${version.Browser}: ${sampleCount} warmed samples (160 history turns, 72 stream updates, 48 scroll steps each)`);
    for (let i = 0; i < sampleCount; i++) {
      samples.push(await measure(page, new URL(fixture, server.url).href, i + 1));
    }
    return Object.fromEntries(Object.keys(samples[0]).map((name) => [name, percentile(samples.map((sample) => sample[name]), 0.5)]));
  } finally {
    page?.close();
    if (browser && browser.exitCode === null) {
      try { await browserCdp?.call("Browser.close", {}, 2000); } catch { /* Shutdown can close CDP before replying. */ }
      await Promise.race([browser.exited, Bun.sleep(2000)]);
      if (browser.exitCode === null) browser.kill();
      await browser.exited;
    }
    browserCdp?.close();
    await server?.stop(true);
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const result = await benchmark();
for (const [name, value] of Object.entries(result)) console.log(`METRIC ${name}=${value.toFixed(3)}`);
