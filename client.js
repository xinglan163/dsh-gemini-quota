// dsh-gemini-quota —— 浏览器半（无构建：手写 __ModuleLoader__ bundle + React.createElement）
//
// 显示形态（对齐 dsh-codex-connect 的小条，但更亮更清楚）：
//   ✦  5h ████████░░░░░░  37%
//      7d ██████████████  87%
//   - 条 56×8（codex 是 48×6）；轨道用 color-mix 提亮；百分比直接写在条右侧；✦ 是 Gemini 标识；
//   - 悬停给完整文案（剩余 / 重置时间 / 账号）。
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

    const ROUTE = "/plugins/dsh-gemini-quota/quota";
    const POLL_MS = 60000; // 服务端有 20s 缓存，60s 轮询足够且不打扰上游
    const MAX_BACKOFF_MS = 15 * 60000;
    const TRACK_W = 56;
    const TRACK_H = 8;
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

    /** 剩余量分档着色（比原来略亮一档，深色主题下更跳）。 */
    function colorOf(remain) {
      if (remain >= 60) return "var(--dsw-alias-state-success-primary, #34d399)";
      if (remain >= 40) return "var(--dsw-alias-state-warn-primary, #fbbf24)";
      if (remain >= 20) return "#fb923c";
      return "var(--dsw-alias-state-error-primary, #f87171)";
    }

    /** 轨道底色：用 label-tertiary 混出半透明，浅/深主题都能看清。 */
    const TRACK_BG = "color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b93a1) 42%, transparent)";
    const TRACK_RING = "color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b93a1) 38%, transparent)";

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
              color:
                "var(--dsw-alias-label-primary, var(--dsw-alias-label-secondary, #f2f4f6))",
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

    function GeminiQuotaPill({ directory }) {
      // 当前选中的模型（session 级）。codex 的额度条/fast-mode 开关用的是同一个 store。
      // directory 缺失（inject 没给到）时也不能抛：抛了会被 SlotErrorBoundary 干掉整条 entry。
      const directoryState = React.useSyncExternalStore(
        (listener) => (directory ? directory.subscribe(listener) : () => {}),
        () => (directory ? directory.getSnapshot() : undefined),
        () => (directory ? directory.getSnapshot() : undefined),
      );
      const [snapshot, setSnapshot] = React.useState(undefined);
      const [scope, setScope] = React.useState(undefined); // { providers, matchModelPrefix }
      const [tip, setTip] = React.useState(false);

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
            const res = await fetch(ROUTE, {
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
            timer = window.setTimeout(refresh, Math.max(0, nextAt - Date.now()));
          }
        };

        const refresh = async () => {
          if (disposed || document.hidden) return;
          try {
            const res = await fetch(ROUTE, {
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

        refresh();
        document.addEventListener("visibilitychange", schedule);
        return () => {
          disposed = true;
          document.removeEventListener("visibilitychange", schedule);
          if (timer !== undefined) window.clearTimeout(timer);
          controller.abort();
        };
      }, [eligible]);

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
          metric: snapshot.weekly,
        });
      }
      if (rows.length === 0) return null;

      const detail = rows.map((r) => r.summary).join("；");
      const label = snapshot.account ? `${detail}（账号 ${snapshot.account}）` : detail;

      return h(
        "span",
        {
          role: "status",
          "data-gemini-quota": rows.map((r) => r.kind).join(","),
          "aria-label": label,
          // 刻意不设 title：原生提示无法定制样式，会和自绘 tooltip 叠成两个。
          tabIndex: 0,
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
          },
        },
        // Gemini 官方 logo（内联 SVG，渐变填色），替代原来的 ✦ 星形字符
        h(GeminiMark, { size: 14 }),
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
        tip
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
              rows.map((r) => h("div", { key: r.kind }, `${r.short}：剩余 ${r.metric.remainingPercent}%；重置时间 ${r.metric.resetTime} (${r.metric.account})`)),
            )
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
