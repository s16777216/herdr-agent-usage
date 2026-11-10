// Custom workspace status bar with compact [Icon] [Progress Bar] X% indicators,
// anchored single-provider OAuth Usage Popover (Claude Code, Codex, Antigravity),
// and Codex rate-limit reset credit redemption.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, appHome, exec, readTextFile, openOverlay, closeOverlay, props, shared, setShared } from "herdr";

const REFRESH_MS = 180_000; // 3 minutes
const SHARED_KEY = "agent-usage.usage";
const MINI_BAR_W = 36;
const POP_W = 296;
const POP_BAR_W = POP_W - 28;

// Public installed application OAuth client credentials for Antigravity
const AGY_CLIENT_ID = ["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"].join("-");
const AGY_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const AGY_UA = "antigravity/cli/1.5.3 windows/amd64";
const AGY_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";

const agyAuthCache = {
  refreshToken: null,
  accessToken: null,
  expiresAtMs: 0,
  plan: null,
};

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toEpochMs(val) {
  if (!val) return null;
  const ms = typeof val === "number" ? (val < 1e12 ? val * 1000 : val) : Date.parse(val);
  return Number.isFinite(ms) ? ms : null;
}

function fmtResetClock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function fmtShortDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtResetDetail(ms) {
  if (!ms) return "";
  const clock = fmtResetClock(ms);
  const diffMin = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (diffMin <= 0) return `Resets soon (${clock})`;
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  const mins = diffMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && mins > 0) parts.push(`${mins}m`);
  return `Resets in ${parts.join(" ")} (${clock})`;
}

async function fetchClaudeUsage(h) {
  const raw = await readTextFile(`${h}/.claude/.credentials.json`);
  if (!raw) return null;
  const cred = JSON.parse(raw);
  const token = cred?.claudeAiOauth?.accessToken;
  if (!token) return null;
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const p5 = data?.five_hour?.utilization;
  const p7 = data?.seven_day?.utilization;
  if (typeof p5 !== "number" && typeof p7 !== "number") return null;
  return {
    plan: cred?.claudeAiOauth?.subscriptionType ?? null,
    fiveHour: typeof p5 === "number" ? Math.round(p5) : null,
    fiveHourResetMs: toEpochMs(data?.five_hour?.resets_at),
    sevenDay: typeof p7 === "number" ? Math.round(p7) : null,
    sevenDayResetMs: toEpochMs(data?.seven_day?.resets_at),
  };
}

async function readCodexAuthHeaders(h) {
  const raw = await readTextFile(`${h}/.codex/auth.json`);
  if (!raw) return null;
  const auth = JSON.parse(raw);
  const token = auth?.tokens?.access_token;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  if (auth?.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  return headers;
}

async function fetchCodexCreditItems(headers) {
  const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", {
    headers: { ...headers, "x-openai-codex-luna-reserve": "1" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const list = Array.isArray(data?.credits) ? data.credits : [];
  return list
    .filter((c) => c?.status === "available" && c?.id)
    .map((c) => ({
      id: c.id,
      title: c.title || "Full reset (Weekly + 5 hr)",
      expiresAtMs: toEpochMs(c.expires_at),
    }))
    .sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity));
}

async function fetchCodexUsage(h) {
  const headers = await readCodexAuthHeaders(h);
  if (!headers) return null;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const pw = data?.rate_limit?.primary_window;
  const sw = data?.rate_limit?.secondary_window;
  const p5 = pw?.used_percent;
  const p7 = sw?.used_percent;
  if (typeof p5 !== "number" && typeof p7 !== "number") return null;
  const availCount = data?.rate_limit_reset_credits?.available_count ?? null;
  const applicableCount = data?.rate_limit_reset_credits?.applicable_available_count ?? null;
  let creditItems = [];
  if (typeof availCount === "number" && availCount > 0) {
    try {
      creditItems = await fetchCodexCreditItems(headers);
    } catch {}
  }
  return {
    plan: data?.plan_type ?? null,
    email: data?.email ?? null,
    fiveHour: typeof p5 === "number" ? Math.round(p5) : null,
    fiveHourResetMs: toEpochMs(pw?.reset_at),
    sevenDay: typeof p7 === "number" ? Math.round(p7) : null,
    sevenDayResetMs: toEpochMs(sw?.reset_at),
    resetCredits: availCount,
    applicableCredits: applicableCount,
    creditItems,
  };
}

async function consumeCodexResetCredit(h, preferredCreditId) {
  const headers = await readCodexAuthHeaders(h);
  if (!headers) throw new Error("Codex OAuth credentials not found");
  let creditId = preferredCreditId;
  if (!creditId) {
    const items = await fetchCodexCreditItems(headers);
    creditId = items[0]?.id;
  }
  if (!creditId) throw new Error("No available reset credit ID found");

  const res = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
    method: "POST",
    headers: {
      ...headers,
      "x-openai-codex-luna-reserve": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      credit_id: creditId,
      redeem_request_id: uuidv4(),
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.detail || errJson?.message || errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  return true;
}

function bucketUsedPct(b) {
  if (!b || typeof b !== "object") return null;
  const f = b.remainingFraction ?? b.remaining_fraction;
  if (typeof f === "number" && f >= 0 && f <= 1) {
    return Math.round((1 - f) * 100);
  }
  if (b.resetTime || b.reset_time) return 100;
  return null;
}

async function readAgyRawCredential(h) {
  try {
    const linuxRaw = await readTextFile(`${h}/.gemini/antigravity-cli/antigravity-oauth-token`);
    if (linuxRaw) return JSON.parse(linuxRaw);
  } catch {}
  if (window()?.platform === "windows") {
    try {
      const script = `${(appHome() ?? "").replace(/\\/g, "/")}/mods/agent-usage/read-agy-cred.ps1`;
      const res = await exec(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        { timeout: 10000 },
      );
      if (res?.code === 0 && res.stdout?.trim()) {
        return JSON.parse(res.stdout.trim());
      }
    } catch {}
  }
  return null;
}

async function getAgyAccessToken(h, forceReload = false) {
  if (!forceReload && agyAuthCache.accessToken && Date.now() < agyAuthCache.expiresAtMs - 60_000) {
    return agyAuthCache.accessToken;
  }
  if (forceReload || !agyAuthCache.refreshToken) {
    const cred = await readAgyRawCredential(h);
    const tok = cred?.token;
    if (tok && typeof tok === "object") {
      if (typeof tok.refresh_token === "string" && tok.refresh_token.trim()) {
        agyAuthCache.refreshToken = tok.refresh_token.trim();
      }
      const expMs = toEpochMs(tok.expiry) ?? 0;
      if (typeof tok.access_token === "string" && tok.access_token.trim() && Date.now() < expMs - 60_000) {
        agyAuthCache.accessToken = tok.access_token.trim();
        agyAuthCache.expiresAtMs = expMs;
        return agyAuthCache.accessToken;
      }
    }
  }
  if (!agyAuthCache.refreshToken) return null;

  const body = [
    `client_id=${encodeURIComponent(AGY_CLIENT_ID)}`,
    `client_secret=${encodeURIComponent(AGY_CLIENT_SECRET)}`,
    `refresh_token=${encodeURIComponent(agyAuthCache.refreshToken)}`,
    "grant_type=refresh_token",
  ].join("&");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": AGY_UA,
    },
    body,
  });
  if (!res.ok) throw new Error(`OAuth token HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.access_token) throw new Error("Missing access_token in OAuth response");
  agyAuthCache.accessToken = data.access_token;
  agyAuthCache.expiresAtMs = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return agyAuthCache.accessToken;
}

async function fetchAgyUsage(h) {
  let token = await getAgyAccessToken(h, false);
  if (!token) return null;

  const callApi = (path, tok, payload = "{}") =>
    fetch(`${AGY_BASE}:${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": AGY_UA,
      },
      body: payload,
    });

  let res = await callApi("retrieveUserQuotaSummary", token);
  if (res.status === 401) {
    token = await getAgyAccessToken(h, true);
    if (!token) throw new Error("HTTP 401");
    res = await callApi("retrieveUserQuotaSummary", token);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const payload = data?.response && typeof data.response === "object" ? data.response : data;
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];

  const bucketMap = {};
  for (const g of groups) {
    for (const b of Array.isArray(g?.buckets) ? g.buckets : []) {
      const id = b?.bucketId || b?.bucket_id;
      if (typeof id === "string" && id && !bucketMap[id]) {
        bucketMap[id] = b;
      }
    }
  }

  const g5 = bucketMap["gemini-5h"];
  const gw = bucketMap["gemini-weekly"];
  const aw = bucketMap["gemini-argon-wtu-weekly"];
  const c5 = bucketMap["3p-5h"];
  const cw = bucketMap["3p-weekly"];

  const g5Pct = bucketUsedPct(g5);
  const gwPct = bucketUsedPct(gw);
  const awPct = bucketUsedPct(aw);
  const c5Pct = bucketUsedPct(c5);
  const cwPct = bucketUsedPct(cw);

  if (g5Pct === null && gwPct === null && awPct === null && c5Pct === null && cwPct === null) return null;

  if (!agyAuthCache.plan) {
    try {
      const lcaRes = await callApi("loadCodeAssist", token, JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }));
      if (lcaRes.ok) {
        const lca = await lcaRes.json();
        const rawPlan = lca?.paidTier?.name || lca?.currentTier?.name || "";
        if (rawPlan.toLowerCase().includes("ultra")) agyAuthCache.plan = "Ultra";
        else if (rawPlan.toLowerCase().includes("pro")) agyAuthCache.plan = "Pro";
        else if (rawPlan) agyAuthCache.plan = rawPlan;
      }
    } catch {}
  }

  return {
    plan: agyAuthCache.plan,
    fiveHour: g5Pct ?? gwPct,
    fiveHourResetMs: toEpochMs(g5?.resetTime ?? g5?.reset_time),
    sevenDay: gwPct,
    sevenDayResetMs: toEpochMs(gw?.resetTime ?? gw?.reset_time),
    argonWeekly: awPct,
    argonWeeklyResetMs: toEpochMs(aw?.resetTime ?? aw?.reset_time),
    claudeFiveHour: c5Pct,
    claudeFiveHourResetMs: toEpochMs(c5?.resetTime ?? c5?.reset_time),
    claudeSevenDay: cwPct,
    claudeSevenDayResetMs: toEpochMs(cw?.resetTime ?? cw?.reset_time),
  };
}

function popoverHeightFor(provider, usage, measured) {
  if (typeof measured === "number" && measured > 80) {
    if (provider === "claude" && measured >= 245) {
      // ignore stale height
    } else if (provider === "agy" && measured < 400) {
      // ignore stale 3-row / 4-row height
    } else {
      return measured;
    }
  }
  if (!usage) return 140;
  if (provider === "claude") return 218;
  if (provider === "agy") return 417;
  const hasAccount = Boolean(usage.email);
  const hasCredits = typeof usage.resetCredits === "number";
  if (hasAccount && hasCredits) return 292;
  if (hasAccount || hasCredits) return 270;
  return 218;
}

export default class MyWorkspaceStatus extends View {
  init(_props, cx) {
    this.loading = false;
    this.confirmReset = false;
    this.redeemingReset = false;
    this.resetNotice = null; // { ok: boolean, text: string }
    this.isPopup = Boolean(props()?.provider);
    if (this.isPopup) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      if (!shared(SHARED_KEY)?.updatedAt) this.refreshUsage(cx);
    } else {
      this.refreshUsage(cx);
      cx.timer.every(REFRESH_MS, (cx) => this.refreshUsage(cx));
    }
  }

  state() {
    return (
      shared(SHARED_KEY) ?? {
        claude: null,
        codex: null,
        agy: null,
        claudeErr: null,
        codexErr: null,
        agyErr: null,
        updatedAt: null,
      }
    );
  }

  refreshUsage(cx, targetProvider = null) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const h = (home() ?? "").replace(/\\/g, "/");
    const prev = this.state();
    cx.spawn(async (cx) => {
      const next = { ...prev };
      const tasks = [];
      if (!targetProvider || targetProvider === "claude") {
        tasks.push(
          fetchClaudeUsage(h).then(
            (val) => { next.claude = val; next.claudeErr = null; },
            (err) => { next.claudeErr = String(err?.message ?? err); },
          ),
        );
      }
      if (!targetProvider || targetProvider === "codex") {
        tasks.push(
          fetchCodexUsage(h).then(
            (val) => { next.codex = val; next.codexErr = null; },
            (err) => { next.codexErr = String(err?.message ?? err); },
          ),
        );
      }
      if (!targetProvider || targetProvider === "agy") {
        tasks.push(
          fetchAgyUsage(h).then(
            (val) => { next.agy = val; next.agyErr = null; },
            (err) => { next.agyErr = String(err?.message ?? err); },
          ),
        );
      }
      await Promise.all(tasks);
      next.updatedAt = Date.now();
      this.loading = false;
      setShared(SHARED_KEY, next);
      cx.notify();
    });
  }

  redeemCodexReset(cx) {
    if (this.redeemingReset) return;
    this.redeemingReset = true;
    this.confirmReset = false;
    this.resetNotice = null;
    cx.notify();
    const h = (home() ?? "").replace(/\\/g, "/");
    const st = this.state();
    const nextCredit = st.codex?.creditItems?.[0];
    cx.spawn(async (cx) => {
      try {
        await consumeCodexResetCredit(h, nextCredit?.id ?? null);
        this.resetNotice = { ok: true, text: "??Reset credit redeemed! Refreshing limits?? };
        cx.notify();
        const updatedCodex = await fetchCodexUsage(h);
        const cur = this.state();
        setShared(SHARED_KEY, {
          ...cur,
          codex: updatedCodex,
          codexErr: null,
          updatedAt: Date.now(),
        });
        this.resetNotice = { ok: true, text: "??Rate limits reset successfully!" };
      } catch (e) {
        const msg = String(e?.message ?? e).trim();
        this.resetNotice = { ok: false, text: `Reset not applied: ${msg}` };
      } finally {
        this.redeemingReset = false;
        cx.notify();
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "?? : "Ctrl+", ctrl: mac ? "?? : "Ctrl+", shift: mac ? "?? : "Shift+", alt: mac ? "?? : "Alt+", option: mac ? "?? : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  pctColor(pct, t) {
    if (typeof pct !== "number") return t.dim;
    if (pct >= 90) return t.ansi1;
    if (pct >= 75) return t.blocked;
    return t.muted;
  }

  barFillColor(pct, provider, t) {
    if (typeof pct !== "number") return t.dim;
    if (pct >= 90) return t.ansi1;
    if (pct >= 75) return t.blocked;
    if (provider === "claude") return "#d97757";
    if (provider === "agy") return "#3186ff";
    return t.accent;
  }

  progressBar(pct, width, height, provider, t) {
    const clamped = Math.max(0, Math.min(100, typeof pct === "number" ? pct : 0));
    const fillW = clamped > 0 ? Math.max(3, Math.round((width * clamped) / 100)) : 0;
    const radius = Math.ceil(height / 2);
    return div()
      .w(width)
      .h(height)
      .rounded(radius)
      .bg(t.border)
      .overflow_hidden()
      .flex_none()
      .when(fillW > 0, (el) =>
        el.child(
          div()
            .w(fillW)
            .h(height)
            .rounded(radius)
            .bg(this.barFillColor(clamped, provider, t)),
        ),
      );
  }

  openProviderPopover(provider, usage, e) {
    const st = this.state();
    const popH = popoverHeightFor(provider, usage, st.heights?.[provider]);
    const b = e?.bounds;
    let at = "pointer";
    if (b && typeof b.x === "number" && typeof b.y === "number") {
      // Align the popover centered horizontally over the clicked badge,
      // and float 10px above the top of the bottom status bar.
      const centerX = b.x + (b.width || 80) / 2;
      const x = Math.max(12, Math.round(centerX - POP_W / 2));
      const y = Math.max(12, Math.round(b.y - popH - 10));
      at = { x, y };
    }
    openOverlay({
      mod: "agent-usage",
      kind: "popup",
      width: POP_W,
      at,
      props: { provider },
    });
  }

  usageBadge(provider, name, iconPath, usage, err, t) {
    if (!usage && !err && !this.loading) return null;
    const p5 = usage?.fiveHour ?? usage?.sevenDay ?? null;

    return h_flex()
      .id(`usage-${provider}`)
      .gap(6)
      .px(6)
      .py(2)
      .rounded(5)
      .items_center()
      .cursor_pointer()
      .tooltip(`${name} OAuth Usage 繚 Click for details`)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.openProviderPopover(provider, usage, e);
      })
      .child(image(iconPath).size(12).flex_none())
      .when(Boolean(usage) && p5 !== null, (el) =>
        el
          .child(this.progressBar(p5, MINI_BAR_W, 5, provider, t))
          .child(div().text_size(11.5).text_color(this.pctColor(p5, t)).child(`${p5}%`)),
      )
      .when(!usage && Boolean(err), (el) => el.child(div().text_size(11).text_color(t.blocked).child("err")))
      .when(!usage && !err, (el) => el.child(div().text_size(11).text_color(t.dim).child("??)));
  }

  renderWindowRow(label, pct, resetMs, provider, t) {
    const hasPct = typeof pct === "number";
    return v_flex()
      .gap(5)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(div().text_size(12).text_color(t.foreground).child(label))
          .child(
            div()
              .text_size(12.5)
              .font_semibold()
              .text_color(hasPct ? (pct >= 75 ? this.pctColor(pct, t) : t.foreground) : t.dim)
              .child(hasPct ? `${pct}%` : "??),
          ),
      )
      .child(this.progressBar(pct ?? 0, POP_BAR_W, 7, provider, t))
      .when(Boolean(resetMs), (el) =>
        el.child(div().text_size(11).text_color(t.muted).child(fmtResetDetail(resetMs))),
      );
  }

  renderCodexCreditsSection(usage, t) {
    const count = usage.resetCredits ?? 0;
    const nextExpMs = usage.creditItems?.[0]?.expiresAtMs ?? null;
    const expHint = nextExpMs ? ` 繚 next exp. ${fmtShortDate(nextExpMs)}` : "";

    return v_flex()
      .gap(6)
      .when(Boolean(usage.email), (el) =>
        el.child(div().text_size(11).text_color(t.muted).truncate().child(`Account: ${usage.email}`)),
      )
      .when(!this.confirmReset && !this.redeemingReset, (el) =>
        el.child(
          h_flex()
            .justify_between()
            .items_center()
            .gap(6)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(t.muted)
                .child(`Reset credits: ${count}${expHint}`),
            )
            .when(count > 0, (e2) =>
              e2.child(
                div()
                  .id("codex-use-reset")
                  .px(8)
                  .py(2)
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .cursor_pointer()
                  .text_size(11)
                  .text_color(t.foreground)
                  .tooltip("Use 1 full rate-limit reset credit (5h + weekly)")
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.confirmReset = true;
                    this.resetNotice = null;
                    cx.notify();
                  })
                  .child("Use reset"),
              ),
            ),
        ),
      )
      .when(this.confirmReset && !this.redeemingReset, (el) =>
        el.child(
          h_flex()
            .justify_between()
            .items_center()
            .gap(6)
            .child(div().text_size(11.5).text_color(t.foreground).child("Redeem 1 full reset?"))
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .child(
                  div()
                    .id("codex-reset-confirm")
                    .px(8)
                    .py(2)
                    .rounded(5)
                    .bg(t.accent)
                    .cursor_pointer()
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.accent_foreground)
                    .hover((s) => s.opacity(0.9))
                    .on_click((_e, cx) => this.redeemCodexReset(cx))
                    .child("Confirm"),
                )
                .child(
                  div()
                    .id("codex-reset-cancel")
                    .px(7)
                    .py(2)
                    .rounded(5)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .cursor_pointer()
                    .text_size(11)
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.confirmReset = false;
                      cx.notify();
                    })
                    .child("Cancel"),
                ),
            ),
        ),
      )
      .when(this.redeemingReset, (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
            .child(div().text_size(11).text_color(t.dim).child("Redeeming reset credit??)),
        ),
      )
      .when(Boolean(this.resetNotice), (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(this.resetNotice?.ok ? t.ansi2 : t.blocked)
            .child(this.resetNotice?.text ?? ""),
        ),
      );
  }

  renderPopover(provider, t) {
    const st = this.state();
    const isClaude = provider === "claude";
    const isAgy = provider === "agy";
    const name = isClaude ? "Claude Code" : isAgy ? "Antigravity" : "Codex";
    const iconPath = isClaude ? "icons/claude.svg" : isAgy ? "icons/antigravity.svg" : "icons/codex.svg";
    const usage = isClaude ? st.claude : isAgy ? st.agy : st.codex;
    const err = isClaude ? st.claudeErr : isAgy ? st.agyErr : st.codexErr;
    const updatedStr = st.updatedAt
      ? new Date(st.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "";

    return v_flex()
      .id(`usage-popover-${provider}`)
      .track_focus(this.handle)
      .on_size_change((sz) => {
        if (!sz?.height) return;
        const h = Math.round(sz.height);
        const cur = this.state();
        if (cur.heights?.[provider] !== h) {
          setShared(SHARED_KEY, { ...cur, heights: { ...(cur.heights ?? {}), [provider]: h } });
        }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.confirmReset) {
            this.confirmReset = false;
            cx.notify();
            return;
          }
          closeOverlay(props()?.overlay);
        }
      })
      .w(POP_W)
      .p(14)
      .gap(11)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(image(iconPath).size(15).flex_none())
              .child(div().font_semibold().text_size(13.5).child(name))
              .when(Boolean(usage?.plan), (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10.5)
                    .text_color(t.muted)
                    .child(String(usage.plan).toUpperCase()),
                ),
              ),
          )
          .child(
            div()
              .id("usage-pop-refresh")
              .p(4)
              .rounded(6)
              .cursor_pointer()
              .text_color(t.muted)
              .tooltip("Refresh now")
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.refreshUsage(cx, provider))
              .child(
                this.loading
                  ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.working).spin(900)
                  : svg("mods/agent-usage/refresh.svg").size(13),
              ),
          ),
      )
      .child(div().h(1).w_full().bg(t.border))
      .when(Boolean(usage) && !isAgy, (el) =>
        el
          .child(this.renderWindowRow("5-hour limit", usage.fiveHour, usage.fiveHourResetMs, provider, t))
          .child(this.renderWindowRow("weekly limit", usage.sevenDay, usage.sevenDayResetMs, provider, t))
          .when(!isClaude && (Boolean(usage.email) || typeof usage.resetCredits === "number"), (e2) =>
            e2
              .child(div().h(1).w_full().bg(t.border))
              .child(this.renderCodexCreditsSection(usage, t)),
          ),
      )
      .when(Boolean(usage) && isAgy, (el) =>
        el
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Gemini (Pro / Flash)"))
          .child(this.renderWindowRow("5-hour limit", usage.fiveHour, usage.fiveHourResetMs, provider, t))
          .child(this.renderWindowRow("weekly limit", usage.sevenDay, usage.sevenDayResetMs, provider, t))
          .when(typeof usage.argonWeekly === "number", (e2) =>
            e2
              .child(div().h(1).w_full().bg(t.border))
              .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Gemini 4 Argon"))
              .child(this.renderWindowRow("weekly limit", usage.argonWeekly, usage.argonWeeklyResetMs, provider, t)),
          )
          .child(div().h(1).w_full().bg(t.border))
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("Claude / GPT"))
          .child(this.renderWindowRow("5-hour limit", usage.claudeFiveHour, usage.claudeFiveHourResetMs, provider, t))
          .child(this.renderWindowRow("weekly limit", usage.claudeSevenDay, usage.claudeSevenDayResetMs, provider, t)),
      )
      .when(!usage && Boolean(err), (el) =>
        el.child(div().py(8).text_size(12).text_color(t.blocked).child(`Failed to load OAuth usage: ${err}`)),
      )
      .when(!usage && !err, (el) =>
        el.child(div().py(8).text_size(12).text_color(t.muted).child("Fetching OAuth usage??)),
      )
      .when(Boolean(updatedStr), (el) =>
        el.child(
          div()
            .text_size(10.5)
            .text_color(t.muted)
            .child(`Updated ${updatedStr}`),
        ),
      );
  }

  render() {
    const t = theme();
    const provider = props()?.provider;
    if (provider === "claude" || provider === "codex" || provider === "agy") {
      return this.renderPopover(provider, t);
    }

    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const st = this.state();
    const claudeEl = this.usageBadge("claude", "Claude Code", "icons/claude.svg", st.claude, st.claudeErr, t);
    const codexEl = this.usageBadge("codex", "Codex", "icons/codex.svg", st.codex, st.codexErr, t);
    const agyEl = this.usageBadge("agy", "Antigravity", "icons/antigravity.svg", st.agy, st.agyErr, t);

    return h_flex()
      .size_full()
      .px(14)
      .gap(14)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agents`)
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`繚 ${needs} needs you`))),
      )
      .child(div().flex_1())
      .when(Boolean(claudeEl) || Boolean(codexEl) || Boolean(agyEl), (el) =>
        el.child(
          h_flex()
            .gap(8)
            .items_center()
            .when(Boolean(claudeEl), (e2) => e2.child(claudeEl))
            .when(Boolean(codexEl), (e2) => e2.child(codexEl))
            .when(Boolean(agyEl), (e2) => e2.child(agyEl)),
        ),
      )
      .child(div().id("palette").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.muted)).on_click(() => run("app.palette")).child(this.hint()));
  }
}

