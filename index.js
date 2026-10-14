// dsh-gemini-quota —— 宿主半
//
// 只做一件事：把本地 gemini-web2api-go 反代的 /admin/api/quota 转成同源路由
// /plugins/dsh-gemini-quota/quota 给浏览器半用。
//
// 为什么必须由宿主代理（不能浏览器直连 8083）：
//   gemini-web2api 的 writeJSON 会设 Access-Control-Allow-Origin: *，但**不设**
//   Access-Control-Allow-Headers / -Methods，/admin/api/quota 也没有 OPTIONS 分支
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
//
// providers / matchModelPrefix 会随响应下发给浏览器半——浏览器半拿不到 cordis config
// （client-modules 只传 { name: id }），所以判定范围必须由宿主告知。

import { request } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROUTE = "/plugins/dsh-gemini-quota/quota";
const DEFAULT_BASE_URL = "http://127.0.0.1:8083";
const DEFAULT_TOKEN_ENV = "GEMINI_WEB_ADMIN_TOKEN";
const DEFAULT_PROVIDERS = ["gemini-web"];

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

/** 用 node:http 而不是全局 fetch：宿主里可能存在全局 proxy dispatcher，会劫持回环请求。 */
function getJson(url, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`quota upstream ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("quota upstream timeout")));
    req.on("error", reject);
    req.end();
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

export function apply(ctx, config = {}) {
  const providers = asStringList(config.providers, DEFAULT_PROVIDERS);
  const matchModelPrefix = config.matchModelPrefix !== false;
  // scope 每次响应都带上：反代挂了也要能让浏览器半知道"该不该显示"，否则门控会失忆。
  const scope = { providers, matchModelPrefix };

  ctx.inject(["webServer"], (webCtx) => {
    // token 在每次请求时解析：用户改了环境变量 / .env 不必重启宿主。
    const token = () => resolveToken(config);

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: ROUTE,
          handler: async (req, res) => {
            const json = (status, value) => {
              res.writeHead(status, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
              });
              res.end(JSON.stringify({ ...scope, ...value }));
            };
            if (req.method !== "GET") return json(405, { error: "method not allowed" });
            if (!isTrusted(req)) return json(403, { error: "forbidden" });

            const adminToken = token();
            if (adminToken === undefined) return json(503, { error: "no admin token" });

            try {
              const base = String(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
              const snap = await getJson(
                `${base}/admin/api/quota`,
                adminToken,
                config.timeoutMs ?? 8000,
              );
              return json(200, {
                ok: snap.ok === true,
                account: snap.account,
                cached: snap.cached === true,
                fetchedAt: snap.fetched_at,
                fiveHour: metric(snap.five_hour),
                weekly: metric(snap.weekly),
                ...(snap.ok === true ? {} : { error: snap.error ?? "quota unavailable" }),
              });
            } catch (error) {
              return json(502, { ok: false, error: String(error?.message ?? error) });
            }
          },
        }),
      "dsh-gemini-quota: quota route",
    );
  });
}
