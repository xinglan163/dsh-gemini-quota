// 真 HTTP 集成自检：selftest.mjs 用的是假 req/res，抓不到「真实 HTTP 下 req.url 解析、
// POST body 读取、Host/Origin 头、响应头」这类问题。这里按 DSH webServer 的契约
// 起一个真 http server 挂上三条路由，再用真 fetch 打一遍。
//
//   node scripts/http-check.mjs
//
// 只做**只读**请求 + 会被入参校验挡下的写请求：绝不真的 toggle 账号，
// 否则会把正在用的号停掉。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../index.js";

const QUOTA_ROUTE = "/plugins/dsh-gemini-quota/quota";
const POOL_ROUTE = "/plugins/dsh-gemini-quota/pool";
const ACCOUNT_ROUTE = "/plugins/dsh-gemini-quota/account";

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

const token = localToken();
const config = token === "" ? {} : { token };

const routes = [];
apply(
  { inject: (_deps, cb) => cb({ effect: (fn) => fn(), webServer: { register: (r) => (routes.push(r), () => {}) } }) },
  config,
);

const server = createServer((req, res) => {
  const path = String(req.url ?? "").split("?")[0];
  const route = routes.find((r) => r.kind === "exact" && r.path === path);
  if (route === undefined) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const passed = [];
const skipped = [];
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}
async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

console.log("监听:", base, token === "" ? "(没找到 admin token，上游用例会 SKIP)" : "");

// 1) 真实 HTTP 下的额度路由
{
  const { status, json } = await get(QUOTA_ROUTE);
  if (status === 502 || status === 503) {
    skipped.push(`额度路由（反代未运行或未配 token：${json?.error}）`);
  } else {
    expect(status === 200 && json.ok === true, `额度路由异常：${status} ${JSON.stringify(json)}`);
    passed.push("HTTP GET /quota 200 ok:true");
  }
}

// 2) 账号池 + 按号查额度
{
  const pool = await get(POOL_ROUTE);
  if (pool.status === 502 || pool.status === 503) {
    skipped.push(`账号池路由（反代未运行或未配 token：${pool.json?.error}）`);
  } else {
    expect(pool.status === 200 && pool.json.ok === true, `账号池异常：${pool.status} ${JSON.stringify(pool.json)}`);
    expect(Array.isArray(pool.json.accounts), "accounts 应为数组");
    expect(!JSON.stringify(pool.json).includes("SAPISID="), "账号池疑似泄露完整 cookie");
    passed.push(`HTTP GET /pool 200（${pool.json.enabled}/${pool.json.total} 启用）`);

    if (pool.json.accounts.length === 0) {
      skipped.push("按号查额度（池里没有账号）");
    } else {
      const id = pool.json.accounts[0].id;
      const one = await get(`${QUOTA_ROUTE}?account_id=${id}`);
      if (one.status === 200 && one.json.ok === true) {
        expect(one.json.accountId === id, `accountId 不匹配：${JSON.stringify(one.json)}`);
        passed.push(`HTTP GET /quota?account_id=${id} 200 且 accountId 匹配`);
      } else if (one.status === 200 && one.json.unsupported === true) {
        skipped.push(`按号查额度（反代未打补丁：${one.json.error}）`);
      } else {
        throw new Error(`按号查额度异常：${one.status} ${JSON.stringify(one.json)}`);
      }
    }
  }
}

// 3) 写路由的入参校验（都不该真的改状态）
{
  const noConfirm = await post(ACCOUNT_ROUTE, { action: "switch", id: 1 });
  expect(noConfirm.status === 400, `switch 未确认期望 400，实际 ${noConfirm.status}`);
  const undefinedAction = await post(ACCOUNT_ROUTE, { action: "delete-everything", id: 1 });
  expect(undefinedAction.status === 400, `未知 action 期望 400，实际 ${undefinedAction.status}`);
  const badJson = await post(ACCOUNT_ROUTE, "{oops");
  expect(badJson.status === 400, `坏 JSON 期望 400，实际 ${badJson.status}`);
  const wrongMethod = await get(ACCOUNT_ROUTE);
  expect(wrongMethod.status === 405, `GET /account 期望 405，实际 ${wrongMethod.status}`);
  passed.push("HTTP 写路由入参校验（switch 未确认 / 未知 action / 坏 JSON → 400，GET → 405）");
}

// 4) 未注册的路径确实是 404（路由是 exact，不会误吞别的路径）
{
  const nope = await get("/plugins/dsh-gemini-quota/nope");
  expect(nope.status === 404, `未注册路径期望 404，实际 ${nope.status}`);
  passed.push("未注册路径 404（exact 路由不误吞）");
}

server.close();

console.log("\n✅ 通过:");
for (const item of passed) console.log("   -", item);
if (skipped.length > 0) {
  console.log("⏭️  跳过（不影响结论）:");
  for (const item of skipped) console.log("   -", item);
}
console.log(`\n共 ${passed.length} 项通过，${skipped.length} 项跳过。`);
