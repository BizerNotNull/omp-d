import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PLAN_KEY = "ompd:plan";
const PROPOSE = "ompd_propose_plan";
const READ_ONLY = new Set(["read", "search", "grep", "find", "ls"]);
const MAX_PLAN_LENGTH = 32_000;
const OFF = { phase: "off", draft: "" };
const DEFAULT_TIERS = ["smol", "default", "slow"];
const EFFORT_SUFFIX = /:(off|minimal|low|medium|high|xhigh|xxhigh|max|auto|inherit)$/i;
const KEEP_CONTEXT_LIMIT = 95;

function readSetting(settings, ...segments) {
  return settings?.rawValue?.({ segments, definition: {} }) ?? settings?.get?.(segments.join("."));
}

function modelSelector(model) {
  const routing = model.compat?.vercelGatewayRouting ?? model.compat?.openRouterRouting;
  const upstream = routing?.only?.length === 1 ? routing.only[0] : undefined;
  return `${model.provider}/${model.id}${typeof upstream === "string" ? `@${upstream}` : ""}`;
}

function currentSelection(pi, ctx) {
  const model = ctx.models.current();
  if (!model) return undefined;
  const thinking = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "thinking_level_change");
  return { selector: modelSelector(model), effort: thinking?.configured ?? pi.getThinkingLevel() };
}

function resolveRole(settings, ctx, role, visited = new Set()) {
  if (visited.has(role)) return undefined;
  const value = settings?.getModelRole?.(role);
  if (!value) return undefined;
  visited.add(role);
  try {
    for (const selector of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      const suffix = EFFORT_SUFFIX.exec(selector);
      const effort = suffix?.[1].toLowerCase();
      const base = suffix ? selector.slice(0, suffix.index) : selector;
      const alias = base === "*" ? "default" : /^(?:@|pi\/)([\w-]+)$/.exec(base)?.[1];
      const model = ctx.models.resolve(selector);
      if (!model) continue;
      const nested = !effort && alias ? resolveRole(settings, ctx, alias, visited) : undefined;
      const literal = selector === `${model.provider}/${model.id}` || selector === model.id;
      return { model, effort: literal ? undefined : effort ?? nested?.effort };
    }
    return undefined;
  } finally {
    visited.delete(role);
  }
}

function planTitle(draft) {
  return /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(draft)?.[1] ?? "Plan";
}

async function autosavePlan(settings, cwd, draft) {
  if (readSetting(settings, "plan", "autosave") !== true) return;
  const configured = readSetting(settings, "plan", "autosaveDir")?.trim();
  const expanded = configured?.replace(/^~(?=$|[\\/])/, () => homedir());
  const dir = expanded ? path.resolve(cwd, expanded) : path.join(cwd, ".omp", "plans");
  const stem = planTitle(draft).normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "").slice(0, 32).replace(/_+$/, "").toUpperCase();
  const name = !stem || stem === "PLAN" ? "PLAN" : stem.endsWith("_PLAN") ? stem : `${stem}_PLAN`;
  await mkdir(dir, { recursive: true });
  for (let index = 0; ; index++) {
    const file = path.join(dir, `${name}${index ? `-${index}` : ""}.md`);
    try {
      await writeFile(file, draft, { flag: "wx" });
      return file;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export default function workspaceExtension(pi) {
  let plan = OFF;
  let previousTools;
  let recorded = false;
  let reviewController;
  let offerReview = false;
  let applying = false;
  const settings = pi.pi?.settings;

  const report = (ctx) => ctx.ui.setStatus(PLAN_KEY,
    plan.phase === "active" && !recorded ? "default" : plan.phase === "off" ? undefined : plan.phase);
  const isBuiltinRead = (tool) => READ_ONLY.has(tool.name) && tool.sourceInfo?.source === "builtin";
  const busy = (ctx) => {
    const jobs = ctx.getAsyncJobSnapshot?.();
    return !ctx.isIdle() || ctx.hasPendingMessages() || Boolean(jobs?.running.length || jobs?.delivery.queued || jobs?.delivery.delivering);
  };
  const enabled = () => readSetting(settings, "plan", "enabled") !== false;

  async function applyModel(ctx, target) {
    if (!target) return;
    const current = ctx.models.current();
    const model = target.model ?? (current && modelSelector(current) === target.selector
      ? current : ctx.models.resolve(target.selector));
    if (!model) throw new Error(`Model ${target.selector} is unavailable.`);
    if ((!current || modelSelector(current) !== modelSelector(model)) && !await pi.setModel(model)) {
      throw new Error(`Could not select ${modelSelector(model)}.`);
    }
    if (target.effort !== undefined) pi.setThinkingLevel(target.effort);
  }

  async function applyPlanningModel(ctx) {
    const target = resolveRole(settings, ctx, "plan");
    if (!target) {
      if (settings?.getModelRole?.("plan")) ctx.ui.notify("The plan role has no available model; using the current model.", "warning");
      return;
    }
    await applyModel(ctx, target);
  }

  function executionTiers(ctx, snapshot) {
    const current = ctx.models.current();
    const baseline = snapshot.previous ?? currentSelection(pi, ctx);
    const original = baseline && (current && modelSelector(current) === baseline.selector
      ? current : ctx.models.resolve(baseline.selector));
    const restored = { role: "default", model: original ?? current, effort: baseline?.effort };
    const order = readSetting(settings, "cycleOrder") ?? DEFAULT_TIERS;
    const tiers = [...new Set([...order, "default"])].flatMap((role) => {
      const target = resolveRole(settings, ctx, role);
      if (target) return [{ role, ...target }];
      return role === "default" ? [restored] : [];
    });
    // With no tier picker, leave planning on the model the session previously used.
    return tiers.length > 1 ? tiers : [restored];
  }

  async function setPlan(ctx, next, persist = true) {
    const wasActive = plan.phase === "active";
    const active = next.phase === "active";
    if (wasActive !== active) {
      if (active) {
        const tools = pi.getActiveTools();
        const permitted = new Set(pi.getAllTools().filter(isBuiltinRead).map((tool) => tool.name));
        await pi.setActiveTools([...tools.filter((name) => permitted.has(name)), PROPOSE]);
        previousTools = tools;
      } else {
        await pi.setActiveTools(previousTools);
        previousTools = undefined;
      }
    }
    plan = next;
    if (!active) offerReview = false;
    if (persist) {
      pi.appendEntry(PLAN_KEY, plan);
      if (!recorded) await ctx.sessionManager.ensureOnDisk();
      recorded = true;
    }
    report(ctx);
  }

  async function restore(ctx, useDefault = false) {
    if (!applying) reviewController?.abort();
    const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === PLAN_KEY);
    const saved = entry?.data;
    const next = saved && ["active", "paused", "off"].includes(saved.phase) && typeof saved.draft === "string"
      ? { phase: saved.phase, draft: saved.draft.slice(0, MAX_PLAN_LENGTH), previous: saved.previous }
      : useDefault && readSetting(settings, "plan", "defaultOnStartup") === true
        ? { phase: "active", draft: "" }
        : OFF;
    recorded = Boolean(saved);
    offerReview = false;
    const allowed = enabled();
    if (allowed && next.phase === "active") {
      const previous = next.previous ?? currentSelection(pi, ctx);
      await applyPlanningModel(ctx);
      await setPlan(ctx, { ...next, previous }, false);
    } else {
      await setPlan(ctx, allowed ? next : OFF, false);
      if (!allowed && next.phase === "active") await applyModel(ctx, next.previous);
    }
  }

  async function toggle(ctx, args) {
    if (busy(ctx) || reviewController) {
      ctx.ui.notify("Finish or abort the current turn and close any plan review before changing plan mode.", "warning");
      return false;
    }
    if (plan.phase === "active") {
      if (!plan.draft || await ctx.ui.confirm("Exit plan mode?", "This pauses planning without approving the draft.")) {
        await applyModel(ctx, plan.previous);
        await setPlan(ctx, { ...plan, phase: "paused" });
      }
      return false;
    }
    if (plan.phase === "paused" && !args) {
      await setPlan(ctx, OFF);
      return false;
    }
    if (!enabled()) {
      ctx.ui.notify("Plan mode is disabled in Oh My Pi settings (plan.enabled).", "warning");
      return false;
    }
    const previous = currentSelection(pi, ctx);
    await applyPlanningModel(ctx);
    await setPlan(ctx, { ...plan, phase: "active", previous });
    return Boolean(args);
  }

  async function approve(ctx, snapshot, draft, action, target, signal) {
    if (action === "compact") {
      try {
        await ctx.compact({
          readerModel: target.model,
          signal,
          suppressContinuation: true,
          internalGuidance: "Summarize the requirements, decisions, and repository findings needed to execute the approved plan.",
        });
      } catch (error) {
        if (signal.aborted || /^Compaction cancelled\b/i.test(error?.message ?? "")) {
          ctx.ui.notify("Compaction was cancelled. The plan was not executed.", "info");
          return;
        }
        if (!/^(?:Already compacted|Nothing to compact\b)/.test(error?.message ?? "")) throw error;
      }
    }
    if (signal.aborted || busy(ctx) || plan !== snapshot) return;
    await applyModel(ctx, target);
    await setPlan(ctx, OFF);
    if (action === "fresh") {
      const parentSession = ctx.sessionManager.getSessionFile();
      try {
        const result = await ctx.newSession({ parentSession });
        if (result.cancelled) throw new Error("Starting the execution session was cancelled.");
      } catch (error) {
        await setPlan(ctx, snapshot);
        await applyPlanningModel(ctx);
        throw error;
      }
      ctx.ui.setStatus("ompd:plan-session", ctx.sessionManager.getSessionFile());
      // Session initialization may restore a configured default model.
      await applyModel(ctx, target);
    }
    try {
      const file = await autosavePlan(settings, ctx.sessionManager.getCwd(), draft);
      if (file) ctx.ui.notify(`Saved plan to ${file}.`, "info");
    } catch (error) {
      ctx.ui.notify(`Could not save the approved plan: ${String(error)}`, "warning");
    }
    void pi.sendUserMessage(`Execute the approved plan below.\n\n${draft}`)
      .catch((error) => ctx.ui.notify(`Could not execute the approved plan: ${String(error)}`, "error"));
  }

  async function review(ctx) {
    if (reviewController) return;
    let snapshot = plan;
    if (snapshot.phase !== "active" || !snapshot.draft) {
      ctx.ui.notify("There is no proposed plan to review.", "info");
      return;
    }
    const controller = new AbortController();
    reviewController = controller;
    try {
      const tiers = executionTiers(ctx, snapshot);
      const defaultTier = Math.max(0, tiers.findIndex(({ role }) => role === "default"));
      const tierPicker = tiers.length > 1 ? `<label>Execution model<select name="tier">
        ${tiers.map(({ role, model, effort }, index) =>
          `<option value="${index}"${index === defaultTier ? " selected" : ""}>${escapeHtml(`${role} — ${model?.name ?? model?.id ?? "Current model"}${effort ? ` (${effort})` : ""}`)}</option>`).join("")}
      </select></label>` : "";
      const result = ctx.ui.formDialog
        ? await ctx.ui.formDialog(`<form>
            <h2>Review plan</h2>
            <label>Plan<textarea name="plan" rows="12" maxlength="${MAX_PLAN_LENGTH}" required>${escapeHtml(snapshot.draft)}</textarea></label>
            ${tierPicker}
            <label>After review<select name="action">
              <option value="continue">Keep planning</option>
              <option value="fresh">Approve and start a fresh session</option>
              <option value="compact">Approve and compact context before executing</option>
              <option value="keep">Approve and keep context</option>
            </select></label>
          </form>`, { signal: controller.signal })
        : undefined;
      const draft = result?.data?.plan;
      if (controller.signal.aborted || plan !== snapshot
        || typeof draft !== "string" || !draft.trim() || draft.length > MAX_PLAN_LENGTH) return;
      const action = result.data.action;
      if (draft !== snapshot.draft) {
        snapshot = { ...snapshot, draft };
        await setPlan(ctx, snapshot);
      }
      if (!["fresh", "compact", "keep"].includes(action)) return;
      if (busy(ctx)) {
        ctx.ui.notify("Wait for the session to finish, then reopen /plan-review to execute the plan.", "warning");
        return;
      }
      const tier = tiers.length === 1 ? 0 : /^\d+$/.test(result.data.tier) ? Number(result.data.tier) : -1;
      const target = tiers[tier];
      if (!target) return;
      const usage = ctx.getContextUsage();
      const window = target.model?.contextWindow ?? usage?.contextWindow;
      if (action === "keep" && usage && window && usage.tokens / window * 100 > KEEP_CONTEXT_LIMIT) {
        ctx.ui.notify("Context is over 95% full for this execution model. Reopen /plan-review and choose a different model or context option.", "warning");
        return;
      }
      applying = true;
      ctx.ui.setStatus("ompd:plan-applying", "Preparing plan execution…");
      await approve(ctx, snapshot, draft, action, target, controller.signal);
    } finally {
      if (applying) {
        applying = false;
        ctx.ui.setStatus("ompd:plan-applying", undefined);
      }
      reviewController = undefined;
    }
  }

  function openReview(ctx) {
    void review(ctx).catch((error) => ctx.ui.notify(`Plan review failed: ${String(error)}`, "error"));
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (agent plans before executing)",
    handler: async (args, ctx) => { await toggle(ctx, args); },
  });
  pi.registerCommand("plan-review", {
    description: "Review or execute the latest proposed plan",
    handler: (_args, ctx) => openReview(ctx),
  });
  // Preserve attachments and the RPC prompt ticket when /plan has an initial prompt.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "rpc") return;
    if (applying && event.text !== "/ompd-workspace") {
      ctx.ui.notify("Wait for the approved plan to start before sending another prompt.", "warning");
      return { handled: true };
    }
    const match = /^\/plan(?:\s|:)+(\S[\s\S]*)$/.exec(event.text.trim());
    if (!match) return;
    return await toggle(ctx, match[1]) ? { text: match[1] } : { handled: true };
  });
  pi.on("before_agent_start", (event) => {
    if (plan.phase === "active") return {
      systemPrompt: [...event.systemPrompt, `Plan mode is active. Inspect the workspace with read-only tools. Do not implement the task or delegate it. When your plan is ready for the user, call ${PROPOSE} with the complete Markdown plan. Wait for explicit approval before executing.`],
    };
  });
  pi.on("tool_call", ({ toolName }) => {
    if (plan.phase !== "active" || toolName === PROPOSE) return;
    if (READ_ONLY.has(toolName) && pi.getAllTools().some((tool) => tool.name === toolName && isBuiltinRead(tool))) return;
    return { block: true, reason: "Plan mode permits workspace inspection only." };
  });
  pi.registerTool({
    name: PROPOSE,
    label: "Propose plan",
    description: "Submit a complete Markdown implementation plan for user approval.",
    parameters: pi.typebox.Type.Object({ plan: pi.typebox.Type.String({ minLength: 1, maxLength: MAX_PLAN_LENGTH }) }),
    approval: "read",
    loadMode: "essential",
    defaultInactive: true,
    execute: async (_id, { plan: draft }, _signal, _onUpdate, ctx) => {
      if (plan.phase !== "active") throw new Error("Plan mode is not active.");
      if (!draft.trim() || draft.length > MAX_PLAN_LENGTH) throw new Error("Provide a non-empty plan.");
      await setPlan(ctx, { ...plan, draft });
      offerReview = true;
      return { content: [{ type: "text", text: "Plan submitted for review. Stop planning and wait for the user's decision." }] };
    },
  });
  pi.on("session_stop", (_event, ctx) => {
    if (!offerReview) return;
    offerReview = false;
    // The RPC host invokes /plan-review so automatic review can use newSession().
    ctx.ui.setStatus("ompd:plan-review-ready", ctx.sessionManager.getSessionId());
  });
  pi.on("session_start", (_event, ctx) => restore(ctx, true));
  for (const event of ["session_switch", "session_clear", "session_branch", "session_tree"]) {
    pi.on(event, (_event, ctx) => restore(ctx));
  }

  pi.registerCommand("ompd-workspace", {
    description: "Synchronize the desktop workspace",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("ompd:workspace", ctx.sessionManager.getCwd());
      report(ctx);
    },
  });
}
