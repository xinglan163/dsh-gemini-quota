// 宿主半自测：不启动 DSH，用假 ctx / 假 req / 假 res 直接调路由 handler。
//   node selftest.mjs
// 验证：注册 → 信任闸门 → token 解析链 → 调反代 → 字段映射 → scope 下发。
// 反代没在跑时，依赖上游的用例会标记 SKIP 而不是失败（发布后别人也能跑）。
import { apply } from "./index.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function mount(config) {
  const routes = [];
  const fakeWebCtx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.push(route), () => {}) },
  };
  apply({ inject: (_deps, cb) => cb(fakeWebCtx) }, config);
  if (routes.length !== 1) throw new Error(`期望注册 1 条路由，实际 ${routes.length}`);
  return routes[0];
}

function fakeReq({ method = "GET", remote = "127.0.0.1", host = "127.0.0.1:19387", site, origin } = {}) {
  return {
    method,
    socket: { remoteAddress: remote },
    headers: {
      host,
      ...(site === undefined ? {} : { "sec-fetch-site": site }),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function call(route, req) {
  const res = fakeRes();
  await route.handler(req, res);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  return { status: res.status, json: parsed };
}

/** 本机 demo token（$DSH_HOME/gemini-web2api.env），没有就留空。 */
function localToken() {
  try {
    const m = /^\s*(?:export\s+)?GEMINI_WEB_ADMIN_TOKEN\s*=\s*(.+)$/mu.exec(
      readFileSync(join(homedir(), ".dsh", "gemini-web2api.env"), "utf8"),
    );
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

const passed = [];
const skipped = [];
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ── 默认配置：token 走环境变量 / envFile / $DSH_HOME 兜底 ──
const route = mount({});
console.log("路由:", route.kind, route.path);

// 1) 正常路径（依赖本地反代；未运行时 SKIP）
{
  const { status, json } = await call(route, fakeReq());
  console.log("正常:", status, JSON.stringify(json));
  if (status === 200) {
    expect(json.ok === true, `期望 ok:true，实际 ${JSON.stringify(json)}`);
    expect(typeof json.fiveHour?.usedPercent === "number", "fiveHour 字段缺失");
    passed.push("正常路径 200 + fiveHour/weekly 齐全");
  } else if (status === 502) {
    skipped.push(`正常路径（反代未运行：${json.error}）`);
  } else {
    throw new Error(`期望 200/502，实际 ${status} ${JSON.stringify(json)}`);
  }
  // scope 必须随响应下发，否则浏览器半无法门控
  expect(Array.isArray(json.providers), "响应缺少 providers");
  expect(json.providers.includes("gemini-web"), "providers 默认值应为 ['gemini-web']");
  expect(json.matchModelPrefix === true, "matchModelPrefix 默认应为 true");
  passed.push("scope（providers / matchModelPrefix）随响应下发");
}

// 2) 信任闸门
for (const [label, req] of [
  ["非回环对端", fakeReq({ remote: "10.0.0.5" })],
  ["cross-site", fakeReq({ site: "cross-site" })],
  ["非回环 Host", fakeReq({ host: "evil.example.com" })],
]) {
  const { status, json } = await call(route, req);
  expect(status === 403, `${label} 期望 403，实际 ${status}`);
  expect(Array.isArray(json.providers), `${label} 的 403 响应也应带 scope`);
  passed.push(`${label} 403（且带 scope）`);
}

// 3) 方法闸门
{
  const { status } = await call(route, fakeReq({ method: "POST" }));
  expect(status === 405, `期望 405，实际 ${status}`);
  passed.push("非 GET 405");
}

// 4) 无 token → 503（显式 envFile 指向不存在的文件时，不回落到 $DSH_HOME）
{
  const bare = mount({ tokenEnv: "DSH_QUOTA_SELFTEST_UNSET", envFile: "/nonexistent/dsh-quota.env" });
  const { status, json } = await call(bare, fakeReq());
  expect(status === 503, `期望 503，实际 ${status}`);
  expect(json.error === "no admin token", `期望 no admin token，实际 ${JSON.stringify(json)}`);
  passed.push("token 四个来源都未命中 → 503");
}

// 5) 上游不可达 → 502
{
  const down = mount({ token: "x", baseUrl: "http://127.0.0.1:9", timeoutMs: 800 });
  const { status } = await call(down, fakeReq());
  expect(status === 502, `期望 502，实际 ${status}`);
  passed.push("上游不可达 → 502");
}

// 6) providers 可配置
{
  const custom = mount({ providers: "foo, bar baz", matchModelPrefix: false });
  const { json } = await call(custom, fakeReq());
  expect(JSON.stringify(json.providers) === JSON.stringify(["foo", "bar", "baz"]),
    `providers 解析失败：${JSON.stringify(json.providers)}`);
  expect(json.matchModelPrefix === false, "matchModelPrefix 应可关闭");
  passed.push('providers 支持 "a, b c" 字符串并去重前解析为数组');
}

// 7) token 解析链优先级：config.token 优先于环境变量
{
  const token = localToken();
  if (token === "") {
    skipped.push("token 优先级（本机没有 $DSH_HOME/gemini-web2api.env）");
  } else {
    process.env.DSH_QUOTA_SELFTEST_TOKEN = "wrong-token-from-env";
    const direct = mount({ token, tokenEnv: "DSH_QUOTA_SELFTEST_TOKEN" });
    const fromConfig = await call(direct, fakeReq());
    const fromEnv = await call(mount({ tokenEnv: "DSH_QUOTA_SELFTEST_TOKEN" }), fakeReq());
    delete process.env.DSH_QUOTA_SELFTEST_TOKEN;
    expect(fromConfig.status === 200, `config.token 应优先生效，实际 ${fromConfig.status}`);
    expect(fromEnv.status === 502, `坏 token 应导致上游拒绝，实际 ${fromEnv.status}`);
    passed.push("token 优先级：config.token > tokenEnv");
  }
}

console.log("\n✅ 通过:");
for (const item of passed) console.log("   -", item);
if (skipped.length > 0) {
  console.log("⏭️  跳过（不影响结论）:");
  for (const item of skipped) console.log("   -", item);
}
console.log(`\n共 ${passed.length} 项通过，${skipped.length} 项跳过。`);
