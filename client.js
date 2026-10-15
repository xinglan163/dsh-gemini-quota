// dsh-gemini-quota —— 浏览器半（无构建：手写 __ModuleLoader__ bundle + React.createElement）
//
// 显示形态（对齐 dsh-codex-connect 的小条，但更亮更清楚）：
//   ✦  5h ████████░░░░░░  37%
//      7d ██████████████  87%
//   - 条 56×8（codex 是 48×6）；轨道用 color-mix 提亮；百分比直接写在条右侧；✦ 是 Gemini 标识；
//   - 悬停给完整文案（剩余 / 重置时间 / 账号）；
//   - 0.2.0：**点一下弹出多号池面板**——逐个账号看 5h/7d 剩余额度，并能启用/停用（冷却）、
//     检测登录态、保活、切号，不用切去反代后台网页。
//
// **只在选中 Gemini 模型时显示**：判据与 dsh-codex-connect 的额度条同款——
// 从 session 的 model-directory store 读当前选择（`state.current.{provider,model}`），
// 不是 gemini-web 就直接 return null，连轮询都不发（codex 的 isGptModel 见其 client.js:4271）。
//
// 约束（来自 DSH 客户端插件规范）：
//   - bundle id 必须等于包名，否则 client-modules 会抛 "loaded without registering"；
//   - 平台 seed 只有 react 等 9 个模块，这里只 require("react")；
//   - 拿不到 profile 里的 config，配置入口在宿主半（index.js）。
window.__ModuleLoader__.load({
  id: "dsh-gemini-quota",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const QUOTA_ROUTE = "/plugins/dsh-gemini-quota/quota";
    const POOL_ROUTE = "/plugins/dsh-gemini-quota/pool";
    const ACCOUNT_ROUTE = "/plugins/dsh-gemini-quota/account";
    const ACTUAL_ROUTE = "/plugins/dsh-gemini-quota/actual";
    const POLL_MS = 60000; // 服务端有 20s 缓存，60s 轮询足够且不打扰上游
    const MAX_BACKOFF_MS = 15 * 60000;
    const TRACK_W = 56;
    const TRACK_H = 8;
    // 面板里的逐号额度查询是**按需**触发的，别一次把反代打爆。
    const QUOTA_WORKERS = 3;
    // 兜底默认值。真正生效的范围由宿主半下发（浏览器半拿不到 cordis config），
    // 见 index.js 的 providers / matchModelPrefix。
    const DEFAULT_PROVIDERS = ["gemini-web"];

    // Google Gemini 官方四角星（品牌 logo 轮廓，24×24 viewBox）。
    // 形状就是"四条四分之一椭圆弧围成的星"，与 ✦ 那种通用星形字符的区别在于凹边曲率。
    const GEMINI_MARK_PATH =
      "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"

    /** Gemini logo（内联 SVG）：官方蓝→紫→粉渐变，走 defs+linearGradient。 */
    function GeminiMark({ size = 14 }) {
      // useId 结果形如 ":r1:"，直接当 SVG id 不合法，去掉冒号。
      const gid = `gemini-mark-${String(React.useId()).replace(/[^a-zA-Z0-9_-]/gu, "")}`;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          "aria-hidden": true,
          focusable: false,
          style: { display: "block", flex: "none" },
        },
        h(
          "defs",
          null,
          h(
            "linearGradient",
            { id: gid, x1: "0", y1: "0", x2: "1", y2: "1" },
            h("stop", { offset: "0%", stopColor: "#4285f4" }),
            h("stop", { offset: "45%", stopColor: "#9b72cb" }),
            h("stop", { offset: "78%", stopColor: "#d96570" }),
            h("stop", { offset: "100%", stopColor: "#f2a600" }),
          ),
        ),
        h("path", { fill: `url(#${gid})`, d: GEMINI_MARK_PATH }),
      );
    }

    const clamp = (n) => Math.min(100, Math.max(0, n));
    const fmtPct = (n) =>
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(clamp(n));

    /**
     * 当前选中的模型是否落在额度条的显示范围内？
     * provider 精确匹配为主（scope.providers 由宿主下发），model 前缀为可选兜底。
     */
    function matchesScope(state, scope) {
      if (!state || state.status !== "ready") return false;
      const current = state.current;
      if (!current) return false;
      const providers = Array.isArray(scope?.providers) ? scope.providers : DEFAULT_PROVIDERS;
      if (typeof current.provider === "string" && providers.includes(current.provider)) return true;
      if (scope?.matchModelPrefix !== false) {
        return typeof current.model === "string" && current.model.startsWith("gemini-");
      }
      return false;
    }

    /** 重置时间：今天只给时分，其它日期给「X月X日 HH:MM」。 */
    function resetText(epochSec) {
      if (typeof epochSec !== "number" || epochSec <= 0) return "未知";
      const d = new Date(epochSec * 1000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
    }

    /** 「多久以前」——面板里展示账号最近活动时间用。 */
    function agoText(epochSec) {
      if (typeof epochSec !== "number" || epochSec <= 0) return "从未";
      const sec = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
      if (sec < 60) return "刚刚";
      if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
      if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
      return `${Math.floor(sec / 86400)} 天前`;
    }

    /** 剩余量分档着色（比原来略亮一档，深色主题下更跳）。 */
    function colorOf(remain) {
      if (remain >= 60) return "var(--dsw-alias-state-success-primary, #34d399)";
      if (remain >= 40) return "var(--dsw-alias-state-warn-primary, #fbbf24)";
      if (remain >= 20) return "#fb923c";
      return "var(--dsw-alias-state-error-primary, #f87171)";
    }

    /** 账号健康度 → 颜色。判据同反代面板：dead=鉴权失败中，unknown=还没成功用过。 */
    function healthColor(health) {
      if (health === "dead") return "var(--dsw-alias-state-error-primary, #f87171)";
      if (health === "disabled") return "var(--dsw-alias-state-idle-primary, #9aa3af)";
      if (health === "unknown") return "var(--dsw-alias-state-warn-primary, #fbbf24)";
      return "var(--dsw-alias-state-success-primary, #34d399)";
    }

    const HEALTH_TEXT = {
      ok: "在用",
      dead: "鉴权失败",
      disabled: "已停用",
      unknown: "待检测",
    };

    /** 轨道底色：用 label-tertiary 混出半透明，浅/深主题都能看清。 */
    const TRACK_BG = "color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b93a1) 42%, transparent)";
    const TRACK_RING = "color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b93a1) 38%, transparent)";
    const MUTED = "var(--dsw-alias-label-secondary, #6b7280)";
    const PRIMARY = "var(--dsw-alias-label-primary, var(--dsw-alias-label-secondary, #f2f4f6))";

    function Row({ short, metric }) {
      const color = colorOf(metric.remainPercent);
      return h(
        "span",
        {
          "aria-hidden": true,
          style: { display: "inline-flex", alignItems: "center", gap: 5 },
        },
        h(
          "span",
          {
            style: {
              width: 22,
              // label-primary 是主题里最亮的一档文字色（secondary/tertiary 都偏暗，
              // 深色主题下小字号几乎糊在背景里）。三级 fallback 保证任何主题下都可读。
              color: PRIMARY,
              fontSize: 11,
              lineHeight: "12px",
              fontWeight: 600,
              letterSpacing: "0.02em",
              textAlign: "right",
            },
          },
          short,
        ),
        h(
          "span",
          {
            style: {
              display: "block",
              width: TRACK_W,
              height: TRACK_H,
              borderRadius: 999,
              // 兜底顺序有意义：backgroundColor 先设、background(color-mix) 后设——
              // 若运行环境不支持 color-mix，后者会被浏览器整条丢弃，仍留下面这层可见的暗色轨道。
              backgroundColor: "var(--dsw-alias-border-l2)",
              background: TRACK_BG,
              boxShadow: `inset 0 0 0 1px ${TRACK_RING}`,
              overflow: "hidden",
            },
          },
          h("span", {
            style: {
              display: "block",
              width: `${clamp(metric.remainPercent)}%`,
              height: "100%",
              borderRadius: "inherit",
              background: color,
            },
          }),
        ),
        h(
          "span",
          {
            style: {
              width: 32,
              color,
              fontSize: 11,
              lineHeight: "12px",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              textAlign: "right",
            },
          },
          `${fmtPct(metric.remainPercent)}%`,
        ),
      );
    }

    // ────────────────────────── 多号池面板 ──────────────────────────

    /** 面板里的小进度条（比额度条窄，给「5h 37%」这种一行两档用）。 */
    function MiniBar({ metric, width = 40 }) {
      const color = colorOf(metric.remainPercent);
      return h(
        "span",
        {
          style: {
            display: "inline-block",
            width,
            height: 6,
            borderRadius: 999,
            backgroundColor: "var(--dsw-alias-border-l2)",
            background: TRACK_BG,
            boxShadow: `inset 0 0 0 1px ${TRACK_RING}`,
            overflow: "hidden",
            verticalAlign: "middle",
          },
        },
        h("span", {
          style: {
            display: "block",
            width: `${clamp(metric.remainPercent)}%`,
            height: "100%",
            borderRadius: "inherit",
            background: color,
          },
        }),
      );
    }

    /** 一行「5h 37%」：短标签 + 迷你条 + 数字；没有数据时给 —。 */
    function QuotaCell({ short, metric }) {
      const has = metric && typeof metric.remainPercent === "number";
      return h(
        "span",
        {
          style: { display: "inline-flex", alignItems: "center", gap: 4 },
          title: has ? `${short} 剩余 ${fmtPct(metric.remainPercent)}%（重置 ${resetText(metric.resetAt)}）` : undefined,
        },
        h("span", { style: { fontSize: 10, color: MUTED, fontWeight: 600 } }, short),
        has ? h(MiniBar, { metric }) : null,
        h(
          "span",
          {
            style: {
              fontSize: 11,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: has ? colorOf(metric.remainPercent) : MUTED,
              minWidth: 30,
              textAlign: "right",
            },
          },
          has ? `${fmtPct(metric.remainPercent)}%` : "—",
        ),
      );
    }

    function SmallButton({ children, onClick, disabled, tone, title }) {
      const color =
        tone === "danger"
          ? "var(--dsw-alias-state-error-primary, #f87171)"
          : tone === "primary"
            ? "var(--dsw-alias-brand-primary, #4f7cff)"
            : MUTED;
      return h(
        "button",
        {
          type: "button",
          onClick,
          disabled,
          title,
          style: {
            appearance: "none",
            border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))",
            background: "transparent",
            color,
            fontSize: 11,
            lineHeight: "16px",
            padding: "2px 7px",
            borderRadius: 6,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1,
            whiteSpace: "nowrap",
            fontFamily: "inherit",
          },
        },
        children,
      );
    }

    function AccountRow({ account, quota, current, busy, canMutate, pendingSwitch, onAction }) {
      const health = account.health;
      const meta = [];
      meta.push(account.proxyName ? `出口 ${account.proxyName}` : "出口 直连");
      if (account.failCount > 0) meta.push(`失败 ${account.failCount} 次`);
      meta.push(`${account.cookieCount} 个 cookie`);
      if (account.lastOkAt > 0) meta.push(`上次成功 ${agoText(account.lastOkAt)}`);

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 5,
            padding: "7px 8px",
            borderRadius: 8,
            border: `1px solid ${
              current ? "var(--dsw-alias-brand-primary, #4f7cff)" : "var(--dsw-alias-border-l1, rgba(0,0,0,0.06))"
            }`,
            background: current
              ? "color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 8%, transparent)"
              : "transparent",
          },
        },
        // 第一行：健康点 + 名字 + #id + 当前标记 … 5h / 7d
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
          h("span", {
            style: {
              width: 7,
              height: 7,
              borderRadius: 999,
              flex: "none",
              background: healthColor(health),
              boxShadow: `0 0 0 2px color-mix(in srgb, ${healthColor(health)} 22%, transparent)`,
            },
            title: HEALTH_TEXT[health] ?? health,
          }),
          h(
            "span",
            {
              style: {
                fontSize: 12,
                fontWeight: 600,
                color: PRIMARY,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 180,
              },
              title: account.label || `账号 #${account.id}`,
            },
            account.label || `账号 #${account.id}`,
          ),
          h("span", { style: { fontSize: 10, color: MUTED, flex: "none" } }, `#${account.id}`),
          current
            ? h(
                "span",
                {
                  style: {
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--dsw-alias-brand-primary, #4f7cff)",
                    border: "1px solid currentColor",
                    borderRadius: 4,
                    padding: "0 3px",
                    flex: "none",
                  },
                },
                "当前",
              )
            : null,
          h("span", { style: { flex: 1, minWidth: 8 } }),
          h(QuotaCell, { short: "5h", metric: quota?.state === "ok" ? quota.fiveHour : undefined }),
          h(QuotaCell, { short: "7d", metric: quota?.state === "ok" ? quota.weekly : undefined }),
        ),
        // 第二行：元信息 + 操作按钮
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h(
            "span",
            {
              style: {
                fontSize: 10,
                color: quota?.state === "error" ? "var(--dsw-alias-state-warn-primary, #fbbf24)" : MUTED,
                flex: "1 1 180px",
                minWidth: 0,
                lineHeight: "14px",
              },
              title: quota?.state === "error" ? quota.error : account.lastError || meta.join(" · "),
            },
            quota?.state === "error" ? `额度读取失败：${quota.error}` : meta.join(" · "),
          ),
          canMutate
            ? h(
                "span",
                { style: { display: "inline-flex", gap: 4, flex: "none" } },
                h(
                  SmallButton,
                  {
                    onClick: () => onAction("toggle", account),
                    disabled: busy,
                    title: account.status === "enabled" ? "停用这个号（冷却）" : "重新启用这个号",
                  },
                  account.status === "enabled" ? "停用" : "启用",
                ),
                h(
                  SmallButton,
                  {
                    onClick: () => onAction("check", account),
                    disabled: busy,
                    title: "真的去上游探一次登录态",
                  },
                  "检测",
                ),
                h(
                  SmallButton,
                  {
                    onClick: () => onAction("rotate", account),
                    disabled: busy,
                    title: "刷新 cookie 保活（SAPISID 轮换）",
                  },
                  "保活",
                ),
                h(
                  SmallButton,
                  {
                    onClick: () => onAction("switch", account),
                    disabled: busy || current === true,
                    tone: pendingSwitch === account.id ? "danger" : "primary",
                    title:
                      "让接下来的请求都走这个号：启用它，并停用其它已启用的号（反代没有独立的\"活跃账号\"开关）",
                  },
                  pendingSwitch === account.id ? "确认切换" : "切到此号",
                ),
              )
            : null,
        ),
      );
    }

    function PoolPanel({ currentAccountId, actual, onClose, panelRef }) {
      const [pool, setPool] = React.useState(undefined);
      const [quotas, setQuotas] = React.useState({});
      const [note, setNote] = React.useState(undefined);
      const [busyId, setBusyId] = React.useState(0);
      const [pendingSwitch, setPendingSwitch] = React.useState(0);
      const [reload, setReload] = React.useState(0);

      React.useEffect(() => {
        let disposed = false;
        const controller = new AbortController();

        const patchQuota = (id, value) =>
          setQuotas((prev) => ({ ...prev, [id]: value }));

        const markRestUnsupported = () =>
          setQuotas((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (next[key]?.state === "loading") next[key] = { state: "unsupported" };
            }
            return next;
          });

        // 逐号查额度：并发 QUOTA_WORKERS 个 worker 拉同一个队列。
        // 一旦有一行返回 unsupported（反代没打按号查额度的补丁），立刻停手并把这些行标记出来，
        // 免得白白打 N 次上游。
        const loadQuotas = async (accounts) => {
          const queue = accounts.map((a) => a.id);
          let stopped = false;
          const worker = async () => {
            for (;;) {
              if (disposed || stopped) return;
              const id = queue.shift();
              if (id === undefined) return;
              let result;
              try {
                const res = await fetch(`${QUOTA_ROUTE}?account_id=${id}`, {
                  method: "GET",
                  credentials: "same-origin",
                  headers: { accept: "application/json" },
                  signal: controller.signal,
                });
                const value = res.ok ? await res.json().catch(() => undefined) : undefined;
                if (value?.unsupported === true) {
                  stopped = true;
                  result = { state: "unsupported" };
                } else if (value?.ok === true) {
                  result = { state: "ok", fiveHour: value.fiveHour, weekly: value.weekly };
                } else {
                  result = { state: "error", error: value?.error ?? `HTTP ${res.status}` };
                }
              } catch (error) {
                result = { state: "error", error: String(error?.message ?? error) };
              }
              if (disposed) return;
              if (stopped) {
                markRestUnsupported();
                patchQuota(id, result);
                return;
              }
              patchQuota(id, result);
            }
          };
          await Promise.all(Array.from({ length: QUOTA_WORKERS }, worker));
        };

        const load = async () => {
          setPool(undefined);
          try {
            const res = await fetch(POOL_ROUTE, {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
              signal: controller.signal,
            });
            const value = res.ok ? await res.json().catch(() => undefined) : undefined;
            if (disposed) return;
            if (value?.ok !== true) {
              setPool({ error: value?.error ?? `HTTP ${res.status}` });
              return;
            }
            setPool(value);
            const initial = {};
            for (const account of value.accounts ?? []) initial[account.id] = { state: "loading" };
            setQuotas(initial);
            await loadQuotas(value.accounts ?? []);
          } catch (error) {
            if (!disposed) setPool({ error: String(error?.message ?? error) });
          }
        };

        load();
        return () => {
          disposed = true;
          controller.abort();
        };
      }, [reload]);

      const runAction = async (action, account) => {
        // 「切到此号」会停用其它所有已启用的号，所以要点两次。
        if (action === "switch" && pendingSwitch !== account.id) {
          setPendingSwitch(account.id);
          setNote({ kind: "info", text: `「切到此号」会启用 #${account.id} 并停用其它已启用的号，再点一次确认。` });
          return;
        }
        setPendingSwitch(0);
        setBusyId(account.id);
        setNote(undefined);
        try {
          const res = await fetch(ACCOUNT_ROUTE, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ action, id: account.id, ...(action === "switch" ? { confirm: true } : {}) }),
          });
          const value = await res.json().catch(() => undefined);
          if (!res.ok || value?.ok !== true) {
            setNote({ kind: "error", text: `${action} 失败：${value?.error ?? `HTTP ${res.status}`}` });
            return;
          }
          if (action === "toggle") {
            setNote({ kind: "ok", text: `#${account.id} 已${value.result?.status === "disabled" ? "停用" : "启用"}。` });
          } else if (action === "check") {
            setNote({
              kind: value.result?.ok === true ? "ok" : "error",
              text: `#${account.id} 检测：${value.result?.detail ?? "无结果"}${
                typeof value.result?.took_ms === "number" ? `（${value.result.took_ms}ms）` : ""
              }`,
            });
          } else if (action === "rotate") {
            setNote({
              kind: value.result?.ok === true ? "ok" : "error",
              text: `#${account.id} 保活：${value.result?.detail ?? "无结果"}`,
            });
          } else if (action === "switch") {
            const others = (value.changed ?? []).filter((c) => c.id !== account.id).length;
            setNote({
              kind: value.ok === true ? "ok" : "error",
              text: `已切到 #${account.id}，停用其它 ${others} 个号${value.failed?.length ? `（${value.failed.length} 个失败）` : ""}。`,
            });
          }
          setReload((n) => n + 1);
        } catch (error) {
          setNote({ kind: "error", text: `${action} 失败：${String(error?.message ?? error)}` });
        } finally {
          setBusyId(0);
        }
      };

      const accounts = pool?.accounts ?? [];
      const unsupported = Object.values(quotas).some((q) => q?.state === "unsupported");

      // ── 降级告警条 ──
      // 额度条亮红灯时，面板顶部给出"为什么"和"怎么办"。
      // 「额度最充足的号」用面板已经拿到的逐号额度来选；选不出来（额度还没到 / 都判不了）
      // 就退化成"任一可用的号"——不能让用户卡在这里没有出路。
      const downgraded = actual?.downgraded === true && actual.latest ? actual.latest : null;
      const remainOf = (account) => {
        const q = quotas[account.id];
        return q?.state === "ok" && typeof q.fiveHour?.remainPercent === "number"
          ? q.fiveHour.remainPercent
          : undefined;
      };
      const bannerBest = accounts
        .filter((a) => a.status === "enabled" && (currentAccountId === undefined || a.id !== currentAccountId))
        .slice()
        .sort((x, y) => (remainOf(y) ?? -1) - (remainOf(x) ?? -1))[0];
      const banner = downgraded
        ? h(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: 5,
                marginBottom: 8,
                padding: "6px 8px",
                borderRadius: 8,
                border: "1px solid var(--dsw-alias-state-warn-primary, #fbbf24)",
                background:
                  "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 12%, transparent)",
              },
            },
            h(
              "div",
              { style: { fontSize: 11, lineHeight: "15px", color: PRIMARY, fontWeight: 600 } },
              `⚠️ 最近一次请求被降级：请求 ${downgraded.requested}，实际 ${downgraded.actual}`,
            ),
            h(
              "div",
              { style: { fontSize: 10, lineHeight: "14px", color: MUTED } },
              "上游在额度耗尽时会静默换成更弱的模型，但 HTTP 仍返回 200 —— 这一轮的回答质量不能按你选的模型算。",
            ),
            pool?.canMutate !== false && bannerBest
              ? h(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end" } },
                  h(
                    SmallButton,
                    {
                      onClick: () => runAction("switch", bannerBest),
                      disabled: busyId !== 0,
                      tone: pendingSwitch === bannerBest.id ? "danger" : "primary",
                      title: `把请求切到 #${bannerBest.id}（会启用它并停用其它已启用的号）`,
                    },
                    pendingSwitch === bannerBest.id
                      ? "确认切换"
                      : `切到额度最充足的号（#${bannerBest.id}）`,
                  ),
                )
              : null,
          )
        : null;

      const header = h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
        h("span", { style: { fontSize: 12, fontWeight: 700, color: PRIMARY } }, "Gemini 账号池"),
        pool?.ok === true
          ? h("span", { style: { fontSize: 11, color: MUTED } }, `${pool.enabled}/${pool.total} 启用`)
          : null,
        h("span", { style: { flex: 1 } }),
        h(SmallButton, { onClick: () => setReload((n) => n + 1), title: "重新读取账号池与额度" }, "刷新"),
        pool?.panelUrl
          ? h(
              SmallButton,
              {
                onClick: () => window.open(pool.panelUrl, "_blank", "noopener"),
                title: "打开反代自带的 web 面板（添加 cookie / 代理等）",
              },
              "反代面板",
            )
          : null,
        onClose ? h(SmallButton, { onClick: onClose, title: "关闭" }, "✕") : null,
      );

      let body;
      if (pool === undefined) {
        body = h("div", { style: { fontSize: 11, color: MUTED, padding: "6px 2px" } }, "读取账号池…");
      } else if (pool.error !== undefined) {
        body = h(
          "div",
          { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary, #f87171)", padding: "6px 2px" } },
          `读取失败：${pool.error}`,
        );
      } else if (accounts.length === 0) {
        body = h(
          "div",
          { style: { fontSize: 11, color: MUTED, padding: "6px 2px", lineHeight: "16px" } },
          "池里还没有账号。额度是账号级的——先去反代面板的 Cookie 池挂一个 Google 登录态。",
        );
      } else {
        body = h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 5 } },
          accounts.map((account) =>
            h(AccountRow, {
              key: account.id,
              account,
              quota: quotas[account.id],
              current: currentAccountId !== undefined && currentAccountId === account.id,
              busy: busyId === account.id,
              canMutate: pool.canMutate !== false,
              pendingSwitch,
              onAction: runAction,
            }),
          ),
        );
      }

      const footer = [];
      if (unsupported) {
        footer.push(
          h(
            "div",
            { key: "unsupported", style: { fontSize: 10, color: MUTED, lineHeight: "14px", marginTop: 8 } },
            "你的反代还没支持「按账号查额度」（缺少 /admin/api/quota?account_id=N）。账号状态仍可操作；要逐号看额度，见 README「多路账号池」。",
          ),
        );
      }
      if (note) {
        footer.push(
          h(
            "div",
            {
              key: "note",
              style: {
                fontSize: 11,
                lineHeight: "15px",
                marginTop: 8,
                color:
                  note.kind === "error"
                    ? "var(--dsw-alias-state-error-primary, #f87171)"
                    : note.kind === "ok"
                      ? "var(--dsw-alias-state-success-primary, #34d399)"
                      : MUTED,
              },
            },
            note.text,
          ),
        );
      }

      return h(
        "div",
        {
          ref: panelRef,
          role: "dialog",
          "aria-label": "Gemini 账号池",
          // 面板是额度条的**子节点**（这样鼠标移进来不会触发 wrapper 的 mouseleave，浮层不闪），
          // 所以面板里的点击会冒泡到额度条自己的 onClick —— 那会把面板当场关掉。这里截断。
          onClick: (event) => event.stopPropagation(),
          // 面板在额度条的父节点里，鼠标移进来不会触发 wrapper 的 mouseleave，所以浮层不会闪。
          style: {
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            zIndex: 1200,
            width: "min(92vw, 422px)",
            maxHeight: "min(62vh, 480px)",
            overflowY: "auto",
            pointerEvents: "auto",
            textAlign: "left",
            padding: 10,
            borderRadius: "var(--dsw-radius-md, 12px)",
            background:
              "var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #ffffff)))",
            backdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
            WebkitBackdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
            color: PRIMARY,
            border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
            boxShadow: "var(--dsw-elevation-soft, var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.14)))",
            fontFamily: "inherit",
          },
        },
        header,
        banner,
        body,
        ...footer,
      );
    }

    function GeminiQuotaPill({ directory }) {
      // 当前选中的模型（session 级）。codex 的额度条/fast-mode 开关用的是同一个 store。
      // directory 缺失（inject 没给到）时也不能抛：抛了会被 SlotErrorBoundary 干掉整条 entry。
      const directoryState = React.useSyncExternalStore(
        (listener) => (directory ? directory.subscribe(listener) : () => {}),
        () => (directory ? directory.getSnapshot() : undefined),
        () => (directory ? directory.getSnapshot() : undefined),
      );
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [actual, setActual] = React.useState(undefined);
      const [scope, setScope] = React.useState(undefined); // { providers, matchModelPrefix }
      const [tip, setTip] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const wrapRef = React.useRef(null);

      const eligible = scope !== undefined && matchesScope(directoryState, scope);
      const scopeRef = React.useRef(undefined);
      scopeRef.current = scope;

      // 先取一次配置（同一路由顺带带回首份额度）：反代没起来也能知道 provider 范围。
      React.useEffect(() => {
        if (scopeRef.current !== undefined) return undefined;
        const controller = new AbortController();
        let disposed = false;
        let timer;
        let attempt = 0;
        const load = async () => {
          let value;
          try {
            const res = await fetch(QUOTA_ROUTE, {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
              signal: controller.signal,
            });
            value = res.ok ? await res.json().catch(() => undefined) : undefined;
          } catch {
            value = undefined;
          }
          if (disposed) return;
          if (value && Array.isArray(value.providers)) {
            setScope({
              providers: value.providers,
              matchModelPrefix: value.matchModelPrefix !== false,
            });
            if (value.ok === true) setSnapshot(value); // 复用这次响应，省掉一次请求
            return;
          }
          attempt += 1;
          if (attempt < 5) {
            timer = window.setTimeout(load, 2000 * attempt);
            return;
          }
          // 拿不到 scope（宿主半版本旧 / 路由异常）：退回默认范围，
          // 否则新浏览器半配旧宿主半会让额度条彻底消失。
          setScope({ providers: DEFAULT_PROVIDERS, matchModelPrefix: true });
        };
        load();
        return () => {
          disposed = true;
          if (timer !== undefined) window.clearTimeout(timer);
          controller.abort();
        };
      }, []);

      React.useEffect(() => {
        // 不在范围内：不轮询、不显示
        if (!eligible) {
          setSnapshot(undefined);
          return undefined;
        }
        const controller = new AbortController();
        let disposed = false;
        let timer;
        let failures = 0;
        let nextAt = 0;

        const schedule = () => {
          if (timer !== undefined) window.clearTimeout(timer);
          timer = undefined;
          // 页面不可见时不轮询，回到前台立刻补一次
          if (!disposed && !document.hidden) {
            timer = window.setTimeout(cycle, Math.max(0, nextAt - Date.now()));
          }
        };

        const refresh = async () => {
          if (disposed || document.hidden) return;
          try {
            const res = await fetch(QUOTA_ROUTE, {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
              signal: controller.signal,
            });
            const value = res.ok ? await res.json().catch(() => undefined) : undefined;
            const usable = value?.ok === true;
            failures = usable ? 0 : Math.min(failures + 1, 5);
            if (!disposed) setSnapshot(usable ? value : undefined);
          } catch {
            failures = Math.min(failures + 1, 5);
            if (!disposed) setSnapshot(undefined);
          } finally {
            nextAt = Date.now() + Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.max(0, failures - 1));
            schedule();
          }
        };

        // 降级守卫与额度同一节奏刷。它失败一律当"不知道"（不亮红灯）——
        // 旧宿主半没有这条路由时只是 404，绝不能影响额度条本身。
        const refreshActual = async () => {
          try {
            const res = await fetch(ACTUAL_ROUTE, {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
              signal: controller.signal,
            });
            const value = res.ok ? await res.json().catch(() => undefined) : undefined;
            if (!disposed) setActual(value?.ok === true ? value : undefined);
          } catch {
            if (!disposed) setActual(undefined);
          }
        };
        const cycle = () => {
          refresh();
          refreshActual();
        };
        cycle();
        document.addEventListener("visibilitychange", schedule);
        return () => {
          disposed = true;
          document.removeEventListener("visibilitychange", schedule);
          if (timer !== undefined) window.clearTimeout(timer);
          controller.abort();
        };
      }, [eligible]);

      // 面板打开时：点外面 / 按 Esc 关掉。
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      // 非 Gemini 模型 / 加载中 / 取数失败 → 整条隐藏（不显示 0%，避免误导）
      if (!eligible || snapshot === undefined) return null;

      const rows = [];
      if (snapshot.fiveHour) {
        rows.push({
          kind: "five-hour",
          short: "5h",
          summary: `Gemini 5 小时额度：剩余 ${fmtPct(snapshot.fiveHour.remainPercent)}%；重置时间 ${resetText(
            snapshot.fiveHour.resetAt,
          )}`,
          remainText: `${fmtPct(snapshot.fiveHour.remainPercent)}%`,
          resetLabel: resetText(snapshot.fiveHour.resetAt),
          metric: snapshot.fiveHour,
        });
      }
      if (snapshot.weekly) {
        rows.push({
          kind: "weekly",
          short: "7d",
          summary: `Gemini 周额度：剩余 ${fmtPct(snapshot.weekly.remainPercent)}%；重置时间 ${resetText(
            snapshot.weekly.resetAt,
          )}`,
          remainText: `${fmtPct(snapshot.weekly.remainPercent)}%`,
          resetLabel: resetText(snapshot.weekly.resetAt),
          metric: snapshot.weekly,
        });
      }
      if (rows.length === 0) return null;

      const detail = rows.map((r) => r.summary).join("；");
      // 降级 = 最近一次可判定的请求，上游实际给的不是你选的模型
      const downgraded = actual?.downgraded === true && actual.latest ? actual.latest : null;
      const label =
        (snapshot.account ? `${detail}（账号 ${snapshot.account}）` : detail) +
        (downgraded
          ? `；警告：最近一次请求被降级，请求 ${downgraded.requested}，实际 ${downgraded.actual}`
          : "");

      // 悬停浮层：一行一个信息（额度、重置时间各占一行），账号单独一行。
      // 这里只消费上面算好的 remainText / resetLabel，不再直接摸 raw 字段，避免字段名写错又出 undefined。
      // 降级警告放最前面：它比任何额度数字都重要（额度低只是原因，降级才是后果）。
      const tipLines = [];
      if (downgraded) {
        tipLines.push(`⚠️ 最近一次请求被降级：请求 ${downgraded.requested}，实际 ${downgraded.actual}`);
      }
      tipLines.push(
        ...rows.flatMap((r) => [
          `${r.short} 额度：剩余 ${r.remainText}`,
          `${r.short} 重置：${r.resetLabel}`,
        ]),
      );
      if (snapshot.account) tipLines.push(`账号：${snapshot.account}`);
      tipLines.push("点一下：账号池面板");

      return h(
        "span",
        {
          ref: wrapRef,
          role: "status",
          "data-gemini-quota": [...rows.map((r) => r.kind), ...(downgraded ? ["downgraded"] : [])].join(","),
          "aria-label": label,
          "aria-expanded": open,
          // 刻意不设 title：原生提示无法定制样式，会和自绘 tooltip 叠成两个。
          tabIndex: 0,
          onClick: () => setOpen((v) => !v),
          onKeyDown: (event) => {
            // 面板里的按键不要被这里接管（否则在面板里按空格/回车会顺手把面板关掉，
            // 而且会抢掉 Esc 关面板的 document 监听）。
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setOpen((v) => !v);
            }
          },
          onMouseEnter: () => setTip(true),
          onMouseLeave: () => setTip(false),
          onFocus: () => setTip(true),
          onBlur: () => setTip(false),
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "1px 2px",
            cursor: "pointer",
            // 降级时整条染成警告色：这是"你刚才那句话不是你以为的模型答的"，
            // 必须比额度条本身更显眼，否则用户永远注意不到。
            ...(downgraded
              ? {
                  borderRadius: 6,
                  background:
                    "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 14%, transparent)",
                  boxShadow:
                    "inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 55%, transparent)",
                }
              : {}),
          },
        },
        // Gemini 官方 logo（内联 SVG，渐变填色），替代原来的 ✦ 星形字符
        h(GeminiMark, { size: 14 }),
        downgraded
          ? h(
              "span",
              {
                style: {
                  fontSize: 11,
                  lineHeight: "12px",
                  color: "var(--dsw-alias-state-warn-primary, #fbbf24)",
                },
                "aria-hidden": true,
              },
              "⚠️",
            )
          : null,
        h(
          "span",
          {
            style: {
              display: "inline-flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 3,
            },
          },
          rows.map((r) => h(Row, { key: r.kind, short: r.short, metric: r.metric })),
        ),
        tip && !open
          ? h(
              "span",
              {
                role: "tooltip",
                style: {
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 1000,
                  width: "max-content",
                  maxWidth: "min(50vw, 520px)",
                  whiteSpace: "normal",
                  overflowWrap: "break-word",
                  pointerEvents: "none",
                  padding: "6px 10px",
                  borderRadius: "var(--dsw-radius-sm, 8px)",
                  background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #f2f3f5))",
                  backdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
                  WebkitBackdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
                  color: "var(--dsw-alias-label-primary, #151517)",
                  border: "1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))",
                  boxShadow: "var(--dsw-elevation-soft, var(--dsw-shadow-lv2, 0 4px 16px rgba(0, 0, 0, 0.08)))",
                  fontSize: 13,
                  fontWeight: 400,
                  lineHeight: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                },
              },
              tipLines.map((text, i) => h("div", { key: i }, text)),
            )
          : null,
        open
          ? h(PoolPanel, {
              currentAccountId: snapshot.accountId,
              actual,
              onClose: () => setOpen(false),
            })
          : null,
      );
    }

    return {
      name: "dsh-gemini-quota-client",
      inject: ["slots"],
      apply(ctx) {
        // 与 dsh-codex-connect 同款接线：slots + modelDirectories，
        // 通过 inject(sessionId) 把该 session 的模型目录 store 传给组件，
        // 组件再据当前选择决定显示与否。
        ctx.inject(["slots", "modelDirectories"], (scope) => {
          scope.slots.inject("conversation.input.right", () =>
            scope.slots.register(
              {
                name: "conversation.input.right",
                id: "gemini-web-quota",
                order: 20,
                inject: (sessionId) => ({
                  directory: scope.modelDirectories.directoryFor(sessionId).store,
                }),
              },
              GeminiQuotaPill,
            ),
          );

          // 想改成「输入框正下方整行居中」就换成下面这个座位（与 ui-chat 的 StatsPills 并排）：
          // scope.slots.inject("conversation.composer.dock", () =>
          //   scope.slots.register({ name: "conversation.composer.dock", id: "gemini-web-quota", order: 5,
          //     inject: (sessionId) => ({ directory: scope.modelDirectories.directoryFor(sessionId).store }) },
          //     GeminiQuotaPill));
        });
      },
    };
  },
});
