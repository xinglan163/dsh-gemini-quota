// dsh-gemini-quota —— 宿主半
//
// 0.1.x 只做一件事：把本地 gemini-web2api-go 反代的 /admin/api/quota 转成同源路由
// /plugins/dsh-gemini-quota/quota 给浏览器半用。
//
// 0.2.0 起多了「多号池面板」：额度条点一下弹出账号列表，逐号看 5h/7d 剩余额度，
// 并且能直接在 DSH 里 启用/停用（冷却）、检测登录态、保活、切号——不用切去反代后台网页。
// 新增两条同源路由：
//   GET  /plugins/dsh-gemini-quota/pool     账号池状态（读 /admin/api/cookies）
//   POST /plugins/dsh-gemini-quota/account  账号动作（toggle / check / rotate / switch）
//
// 0.3.0 起多了「降级守卫」：
//   GET  /plugins/dsh-gemini-quota/actual   最近几次请求「请求的模型 vs 实际用的模型」
//
// 为什么需要它：Gemini 网页端在账号额度耗尽时会**静默降级**——把你的 4 Argon 换成更笨的
// 3.5 Flash-Lite，但 HTTP 依然返回 200。于是 DSH 以为自己用的是强模型，agent 还会
// "信誓旦旦说做完了"（issue #41 原话：产生严重幻觉并破坏任务）。
//
// 判定依据在反代里**早就有了**：每次请求都会把上游在响应帧里自报的显示名存进
// upstream_model（internal/app/gemini.go:207 → db.go:186），并通过
// GET /admin/api/requests 暴露。只是从来没有代码去读它。
//
// 注意：**不能靠响应体判断**。反代回给客户端的 OpenAI 响应里 "model" 填的是
// 「你请求的那个」（internal/app/server.go:383 ← resolveModel(modelInput)），
// 也就是说响应体本身在撒谎。真相只在反代的 DB 里，所以必须由宿主半去查。
//
// 为什么必须由宿主代理（不能浏览器直连 8083）：
//   gemini-web2api 的 writeJSON 会设 Access-Control-Allow-Origin: *，但**不设**
//   Access-Control-Allow-Headers / -Methods，/admin/api/* 也没有 OPTIONS 分支
//   （internal/app/app.go、server.go）。浏览器带 Authorization 头去 fetch 会触发
//   预检，预检落到 requireAuth 返回 401 且缺 Allow-Headers → 被浏览器拒绝。
//   退一步用 ?token= 能过（简单请求），但会把 admin token 写进前端产物，不可接受。
//   宿主同源代理则完全不涉及 CORS。
//
// 鉴权：/plugins/* 的 webServer 路由**不在** DSH 的 /api 信任栅栏内
//   （dsh-client-connection 的 isTrustedApiRequest 只作用于 /api 通道），
//   所以这里自己加最小闸门：回环对端 + 回环 Host + 非 cross-site + 同源 Origin。
//
// 配置（cordis.patch.yml 的 config，或 profile patch 覆盖）：
//   baseUrl            反代地址，默认 http://127.0.0.1:8083
//   providers          触发显示额度条的 DSH provider id，默认 ["gemini-web"]
//   matchModelPrefix   额外按模型名前缀兜底，默认 true
//   token              直接给 admin token（优先级最高）
//   tokenEnv           从哪个环境变量读 token，默认 GEMINI_WEB_ADMIN_TOKEN
//   envFile            从该文件里读 GEMINI_WEB_ADMIN_TOKEN=...（可选，本地开发用）
//                      未配置时兜底读 $DSH_HOME/gemini-web2api.env（默认 ~/.dsh/）——
//                      机器相关的东西放 DSH home，包里不留任何绝对路径。
//   timeoutMs          上游超时，默认 8000
//   readOnly           true 时禁用 POST /account（只看不动），默认 false
//
// providers / matchModelPrefix 会随响应下发给浏览器半——浏览器半拿不到 cordis config
// （client-modules 只传 { name: id }），所以判定范围必须由宿主告知。

import { request } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUOTA_ROUTE = "/plugins/dsh-gemini-quota/quota";
const POOL_ROUTE = "/plugins/dsh-gemini-quota/pool";
const ACCOUNT_ROUTE = "/plugins/dsh-gemini-quota/account";
const ACTUAL_ROUTE = "/plugins/dsh-gemini-quota/actual";
const DEFAULT_BASE_URL = "http://127.0.0.1:8083";
const DEFAULT_TOKEN_ENV = "GEMINI_WEB_ADMIN_TOKEN";
const DEFAULT_PROVIDERS = ["gemini-web"];
const MAX_BODY_BYTES = 4096;
// 面板一次最多操作多少个账号（切号会遍历整个池；设个上限防止池子异常大时把上游打爆）。
const MAX_ACCOUNTS = 100;
// 降级判定一次看几条请求：只看最近一条会被"生图/生视频"这类没有上游显示名的请求挡住，
// 多看几条才能在最近一条判不了时继续往前找一条能判的。
const DEFAULT_ACTUAL_LIMIT = 5;
const MAX_ACTUAL_LIMIT = 20;

// 模型 id → 上游自报显示名里**必须出现**的片段（判定前两边都会规范化）。
//
// 这张表是"有没有被降级"的唯一判据：请求的是 A，上游自报的是别的 → 降级。
// 为什么不从反代读这张表：反代里根本没有（`gw argon` 是打印两列让人眼对比的），
// 而且上游显示名会随 Google 改名漂移（3.7 → 3.8 就发生过一次）。
//
// 两个刻意的设计：
//   1. 表里没有的 id 一律判 unknown，**绝不猜**——生图/生视频/画布这些模型上游
//      不一定回显示名，误报比漏报更糟（用户会开始无视这个红灯）。
//   2. thinking 变体与普通版共用同一个 hex，上游显示名不带 thinking（实测 4 Argon
//      开思考也只回报 "4 Argon High"），所以两者共用同一个片段。
const EXPECTED_UPSTREAM = {
  "gemini-4-argon": ["4 argon"],
  "gemini-4-argon-thinking": ["4 argon"],
  "gemini-3.8-flash": ["3.8 flash"],
  "gemini-3.7-flash": ["3.8 flash", "3.7 flash"],
  "gemini-3.8-flash-thinking": ["3.8 flash"],
  "gemini-3.7-flash-thinking": ["3.8 flash", "3.7 flash"],
  "gemini-3.6-flash": ["3.6 flash"],
  "gemini-3.6-flash-thinking": ["3.6 flash"],
  "gemini-3.1-pro": ["3.1 pro"],
  "gemini-3.1-pro-thinking": ["3.1 pro"],
  "gemini-3.5-flash-lite": ["3.5 flash lite"],
  "gemini-3.5-flash-lite-thinking": ["3.5 flash lite"],
};

/** 规范化模型名：小写 + 非字母数字点一律折叠成单个空格（"3.5 Flash-Lite" → "3.5 flash lite"）。 */
function normalizeModelName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/gu, " ")
    .trim();
}

/**
 * 判定一次请求有没有被静默降级。
 * @returns {"ok" | "downgraded" | "unknown"} unknown 表示判不了——**不能当成"没问题"**。
 */
function classifyActual(requested, actual) {
  const raw = String(actual ?? "").trim();
  // 上游没自报显示名（生图/生视频/旧版反代/抽取失败）→ 判不了。
  // 这里绝不能返回 ok：那等于把"看不见"伪装成"没问题"。
  if (raw === "") return "unknown";
  const expected = EXPECTED_UPSTREAM[String(requested ?? "").trim()];
  if (expected === undefined) return "unknown";
  const hay = normalizeModelName(raw);
  return expected.some((token) => hay.includes(normalizeModelName(token))) ? "ok" : "downgraded";
}

/**
 * 反代 /admin/api/requests 的一条 item → 降级判定用的紧凑视图。
 *
 * **只白名单字段**：上游那条 SQL 目前只回元数据（不含 prompt/正文），但这里仍然逐个
 * 字段显式挑出来，避免将来上游往里加了内容字段后被顺手透传出去。
 */
function requestView(raw) {
  const requested = String(raw.model ?? "");
  const actual = String(raw.upstream_model ?? "");
  const verdict = classifyActual(requested, actual);
  return {
    id: Number(raw.id ?? 0),
    ts: Number(raw.ts ?? 0),
    endpoint: String(raw.endpoint ?? ""),
    requested,
    actual,
    verdict,
    downgraded: verdict === "downgraded",
    status: Number(raw.status ?? 0),
    accountId: Number(raw.account_id ?? 0) || undefined,
    accountLabel: String(raw.account_label ?? ""),
    stream: raw.stream === true,
    totalMs: Number(raw.total_ms ?? 0),
  };
}

/** 配置里既接受数组也接受 "a,b c" 这种字符串；空则退回默认值。 */
function asStringList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter((item) => item !== "");
    return list.length > 0 ? list : fallback;
  }
  if (typeof value === "string") {
    const list = value
      .split(/[\s,]+/u)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    return list.length > 0 ? list : fallback;
  }
  return fallback;
}

function readEnvFileToken(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u)) {
    const matched = /^\s*(?:export\s+)?GEMINI_WEB_ADMIN_TOKEN\s*=\s*(.*)$/u.exec(line);
    if (matched) return matched[1].trim().replace(/^["']|["']$/gu, "");
  }
  return undefined;
}

/** 兜底配置文件：$DSH_HOME/gemini-web2api.env（可用 DSH_HOME 环境变量覆盖）。 */
function defaultEnvFile() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, "gemini-web2api.env");
}

/** admin token 解析链：config.token → 环境变量 → config.envFile → $DSH_HOME/gemini-web2api.env。 */
function resolveToken(config) {
  const direct = typeof config.token === "string" ? config.token.trim() : "";
  if (direct !== "") return direct;

  const envName =
    typeof config.tokenEnv === "string" && config.tokenEnv.trim() !== ""
      ? config.tokenEnv.trim()
      : DEFAULT_TOKEN_ENV;
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();

  const envFile = typeof config.envFile === "string" ? config.envFile.trim() : "";
  if (envFile !== "") return readEnvFileToken(envFile);

  return readEnvFileToken(defaultEnvFile());
}

function baseUrlOf(config) {
  return String(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
}

/**
 * 用 node:http 而不是全局 fetch：宿主里可能存在全局 proxy dispatcher，会劫持回环请求。
 * body 给了就发 JSON POST（反代的账号动作接口全是 POST）。
 */
function httpJson(url, { method = "GET", token, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers = { accept: "application/json", authorization: `Bearer ${token}` };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`upstream ${res.statusCode}`));
            return;
          }
          if (text.trim() === "") {
            resolve({});
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** 读请求体（限长），返回解析后的 JSON 对象。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** 最小信任闸门，与 dsh-codex-connect 的 trustedRequestDecision 同构（去掉它的持久化名单）。 */
function isTrusted(req) {
  const remote = req.socket?.remoteAddress;
  if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) return false;
  if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
  const host = req.headers.host;
  if (typeof host !== "string" || !/^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/u.test(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const metric = (m) =>
  m === undefined || m === null
    ? undefined
    : {
        usedPercent: m.used_percent,
        remainPercent: m.remain_percent,
        resetAt: m.reset_at,
        resetInSec: m.reset_in_sec,
      };

/** 反代 /admin/api/cookies 的一条 item → 面板用的紧凑视图（字段名保持上游语义）。 */
function accountView(raw) {
  return {
    id: Number(raw.id ?? 0),
    label: String(raw.label ?? ""),
    status: raw.status === "disabled" ? "disabled" : "enabled",
    health: typeof raw.health === "string" ? raw.health : "unknown",
    note: String(raw.note ?? ""),
    failCount: Number(raw.fail_count ?? 0),
    lastUsedAt: Number(raw.last_used_at ?? 0),
    lastOkAt: Number(raw.last_ok_at ?? 0),
    lastError: String(raw.last_error ?? ""),
    cookieCount: Number(raw.cookie_count ?? 0),
    keyCookies: Array.isArray(raw.key_cookies) ? raw.key_cookies.map(String) : [],
    sapisidTail: String(raw.sapisid_tail ?? ""),
    has1psidts: raw.has_1psidts === true,
    proxyId: Number(raw.proxy_id ?? 0),
    proxyName: String(raw.proxy_name ?? ""),
  };
}

/** 从 req.url 里取查询串（自测的假 req 可能没有 url）。 */
function queryOf(req) {
  const url = typeof req.url === "string" ? req.url : "";
  const at = url.indexOf("?");
  return new URLSearchParams(at >= 0 ? url.slice(at + 1) : "");
}

export function apply(ctx, config = {}) {
  const providers = asStringList(config.providers, DEFAULT_PROVIDERS);
  const matchModelPrefix = config.matchModelPrefix !== false;
  const readOnly = config.readOnly === true;
  // scope 每次响应都带上：反代挂了也要能让浏览器半知道"该不该显示"，否则门控会失忆。
  const scope = { providers, matchModelPrefix };

  ctx.inject(["webServer"], (webCtx) => {
    // token 在每次请求时解析：用户改了环境变量 / .env 不必重启宿主。
    const token = () => resolveToken(config);
    const timeoutMs = () => config.timeoutMs ?? 8000;

    const register = (path, label, handler) =>
      webCtx.effect(
        () => webCtx.webServer.register({ kind: "exact", path, handler }),
        `dsh-gemini-quota: ${label}`,
      );

    /** 统一出参：所有响应都带 scope，前端门控不会因为一次报错失忆。 */
    const makeJson = (res) => (status, value) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({ ...scope, ...value }));
    };

    /** 每个 handler 开头都过一遍的闸门：方法 + 信任 + token。返回 undefined 表示已放行。 */
    const guard = (req, res, json, allowedMethod) => {
      if (req.method !== allowedMethod) {
        json(405, { error: "method not allowed" });
        return true;
      }
      if (!isTrusted(req)) {
        json(403, { error: "forbidden" });
        return true;
      }
      if (token() === undefined) {
        json(503, { error: "no admin token" });
        return true;
      }
      return false;
    };

    // ── GET /quota：额度（自动选号，或被 ?account_id=N 指定账号）──
    register(QUOTA_ROUTE, "quota route", async (req, res) => {
      const json = makeJson(res);
      if (guard(req, res, json, "GET")) return;

      const query = queryOf(req);
      const rawAccount = (query.get("account_id") ?? "").trim();
      let accountId;
      if (rawAccount !== "") {
        if (!/^\d+$/u.test(rawAccount)) {
          json(400, { ok: false, error: "bad account_id" });
          return;
        }
        accountId = Number(rawAccount);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) {
          json(400, { ok: false, error: "bad account_id" });
          return;
        }
      }

      const search = new URLSearchParams();
      if (accountId !== undefined) search.set("account_id", String(accountId));
      if (query.get("refresh") === "1") search.set("refresh", "1");
      const suffix = search.toString() === "" ? "" : `?${search.toString()}`;

      try {
        const snap = await httpJson(`${baseUrlOf(config)}/admin/api/quota${suffix}`, {
          token: token(),
          timeoutMs: timeoutMs(),
        });

        // 按号查额度是本地的扩展接口。上游若没有这段逻辑，会原样返回「自动选号」的结果——
        // 那就必须用 account_id 对不上来识别，绝不能把别人的数字挂到这个账号名下。
        if (
          accountId !== undefined &&
          (snap.ok !== true || Number(snap.account_id ?? 0) !== accountId)
        ) {
          json(200, {
            ok: false,
            unsupported: true,
            accountId,
            error:
              snap.error ??
              "上游不支持按账号查额度：需要带 /admin/api/quota?account_id=N 的反代（见 README「多号池面板」）",
          });
          return;
        }

        json(200, {
          ok: snap.ok === true,
          accountId: Number(snap.account_id ?? 0) || undefined,
          account: snap.account,
          direct: snap.direct === true,
          proxy: snap.proxy,
          cached: snap.cached === true,
          fetchedAt: snap.fetched_at,
          fiveHour: metric(snap.five_hour),
          weekly: metric(snap.weekly),
          ...(snap.ok === true ? {} : { error: snap.error ?? "quota unavailable" }),
        });
      } catch (error) {
        json(502, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // ── GET /pool：账号池状态 ──
    register(POOL_ROUTE, "pool route", async (req, res) => {
      const json = makeJson(res);
      if (guard(req, res, json, "GET")) return;

      try {
        const upstream = await httpJson(`${baseUrlOf(config)}/admin/api/cookies`, {
          token: token(),
          timeoutMs: timeoutMs(),
        });
        const items = Array.isArray(upstream.items) ? upstream.items : [];
        const accounts = items.slice(0, MAX_ACCOUNTS).map(accountView);
        json(200, {
          ok: true,
          fetchedAt: Math.floor(Date.now() / 1000),
          total: Number(upstream.total ?? accounts.length),
          enabled: Number(upstream.enabled ?? accounts.filter((a) => a.status === "enabled").length),
          truncated: items.length > accounts.length,
          canMutate: !readOnly,
          // 面板里「打开反代后台」按钮用。回环地址，不算敏感信息。
          panelUrl: `${baseUrlOf(config)}/admin/`,
          accounts,
        });
      } catch (error) {
        json(502, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // ── GET /actual：最近几次请求「请求的模型 vs 实际用的模型」──
    //
    // 降级守卫的判据来源。响应体里的 model 是「你请求的」（反代原样回填，
    // internal/app/server.go:383），真相只在反代的 /admin/api/requests 里，
    // 所以必须由宿主半去查——浏览器半看不到，直连 8083 又会撞 CORS。
    register(ACTUAL_ROUTE, "actual route", async (req, res) => {
      const json = makeJson(res);
      if (guard(req, res, json, "GET")) return;

      const query = queryOf(req);
      const rawLimit = (query.get("limit") ?? "").trim();
      let limit = DEFAULT_ACTUAL_LIMIT;
      if (rawLimit !== "") {
        if (!/^\d+$/u.test(rawLimit)) {
          json(400, { ok: false, error: "bad limit" });
          return;
        }
        limit = Math.min(MAX_ACTUAL_LIMIT, Math.max(1, Number(rawLimit)));
      }

      try {
        const upstream = await httpJson(
          `${baseUrlOf(config)}/admin/api/requests?limit=${limit}`,
          { token: token(), timeoutMs: timeoutMs() },
        );
        const rawItems = Array.isArray(upstream.items) ? upstream.items : [];
        const items = rawItems.slice(0, limit).map(requestView);
        // 「最近一次能判定的请求」：生图/生视频这类没有上游显示名的请求会被跳过，
        // 但不能因为它排在最前面，就把更早的一次真实降级藏起来。
        const latest = items.find((item) => item.verdict !== "unknown") ?? items[0] ?? null;
        json(200, {
          ok: true,
          fetchedAt: Math.floor(Date.now() / 1000),
          checked: items.length,
          downgraded: latest !== null && latest.verdict === "downgraded",
          latest,
          items,
        });
      } catch (error) {
        json(502, { ok: false, error: String(error?.message ?? error) });
      }
    });

    // ── POST /account：账号动作 ──
    register(ACCOUNT_ROUTE, "account route", async (req, res) => {
      const json = makeJson(res);
      if (guard(req, res, json, "POST")) return;
      if (readOnly) {
        json(403, { ok: false, error: "readOnly: 宿主配置禁用了账号动作" });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        json(400, { ok: false, error: String(error?.message ?? error) });
        return;
      }

      const action = typeof body.action === "string" ? body.action.trim() : "";
      const id = Number(body.id ?? 0);
      if (!["toggle", "check", "rotate", "switch"].includes(action)) {
        json(400, { ok: false, error: "unknown action" });
        return;
      }
      if (!Number.isSafeInteger(id) || id <= 0) {
        json(400, { ok: false, error: "bad id" });
        return;
      }

      const base = baseUrlOf(config);
      const call = (path, options = {}) =>
        httpJson(`${base}${path}`, { token: token(), timeoutMs: timeoutMs(), ...options });

      try {
        if (action === "toggle" || action === "check" || action === "rotate") {
          const path = `/admin/api/cookies/${id}/${action}`;
          // 反代三个动作都是 POST；check / rotate 的结果体原样透传给面板展示。
          const result = await call(path, { method: "POST", body: {} });
          json(200, { ok: true, action, id, result });
          return;
        }

        // ── switch：切号 = 启用目标号 + 停用其余已启用的号 ──
        // 反代的调度器只按 (fail_count, last_used_at) 轮转，没有「活跃账号」这个开关，
        // 所以"让接下来的请求都走这个号"唯一诚实的实现就是把别的号禁用掉。
        // 这是会改动多行状态的动作，必须显式 confirm。
        if (body.confirm !== true) {
          json(400, { ok: false, error: "switch 需要 confirm:true" });
          return;
        }
        const upstream = await call("/admin/api/cookies");
        const items = (Array.isArray(upstream.items) ? upstream.items : []).slice(0, MAX_ACCOUNTS);
        const target = items.find((a) => Number(a.id) === id);
        if (target === undefined) {
          json(404, { ok: false, error: `account #${id} not found` });
          return;
        }

        const changed = [];
        const failed = [];
        const toggle = async (accountId) => {
          try {
            const r = await call(`/admin/api/cookies/${accountId}/toggle`, {
              method: "POST",
              body: {},
            });
            changed.push({ id: accountId, status: r.status });
          } catch (error) {
            failed.push({ id: accountId, error: String(error?.message ?? error) });
          }
        };

        if (target.status !== "enabled") await toggle(id);
        for (const account of items) {
          if (Number(account.id) !== id && account.status === "enabled") await toggle(Number(account.id));
        }
        json(200, { ok: failed.length === 0, action, id, changed, failed });
      } catch (error) {
        json(502, { ok: false, error: String(error?.message ?? error) });
      }
    });
  });
}
