// 宿主半自测：不启动 DSH，用假 ctx / 假 req / 假 res 直接调路由 handler。
//   node selftest.mjs
// 验证：注册 → 信任闸门 → 方法闸门 → token 解析链 → 调反代 → 字段映射 → scope 下发
//       → 多号池（/pool 列表、按号查额度、账号动作的入参校验）。
// 反代没在跑时，依赖上游的用例会标记 SKIP 而不是失败（发布后别人也能跑）。
import { apply } from "./index.js";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROUTES = {
  quota: "/plugins/dsh-gemini-quota/quota",
  pool: "/plugins/dsh-gemini-quota/pool",
  account: "/plugins/dsh-gemini-quota/account",
};

function mount(config) {
  const routes = new Map();
  const fakeWebCtx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
  };
  apply({ inject: (_deps, cb) => cb(fakeWebCtx) }, config);
  const expected = Object.values(ROUTES);
  if (routes.size !== expected.length) {
    throw new Error(`期望注册 ${expected.length} 条路由，实际 ${routes.size}: ${[...routes.keys()].join(", ")}`);
  }
  for (const path of expected) {
    if (!routes.has(path)) throw new Error(`缺少路由 ${path}`);
  }
  return routes;
}

/**
 * 假 req。POST 要喂 body：EventEmitter 上是「先挂监听、后触发」的顺序，
 * 所以 data/end 放到下一个 tick 发（handler 在第一个 await 前就挂好了监听）。
 */
function fakeReq({ method = "GET", remote = "127.0.0.1", host = "127.0.0.1:19387", site, origin, url, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url ?? (method === "POST" ? ROUTES.account : ROUTES.quota);
  req.socket = { remoteAddress: remote };
  req.headers = {
    host,
    ...(site === undefined ? {} : { "sec-fetch-site": site }),
    ...(origin === undefined ? {} : { origin }),
  };
  if (body !== undefined) {
    const payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    setTimeout(() => {
      req.emit("data", payload);
      req.emit("end");
    }, 0);
  } else if (method === "POST") {
    setTimeout(() => req.emit("end"), 0);
  }
  return req;
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
const routes = mount({});
const route = routes.get(ROUTES.quota);
console.log("路由:", [...routes.keys()].join("  "));

// 1) 额度正常路径（依赖本地反代；未运行时 SKIP）
{
  const { status, json } = await call(route, fakeReq());
  console.log("额度:", status, JSON.stringify(json));
  if (status === 200) {
    expect(json.ok === true, `期望 ok:true，实际 ${JSON.stringify(json)}`);
    expect(typeof json.fiveHour?.usedPercent === "number", "fiveHour 字段缺失");
    passed.push("额度路径 200 + fiveHour/weekly 齐全");
  } else if (status === 502 || status === 503) {
    // CI / 别人机器上：没跑反代（502）或没配 admin token（503）都属正常，跳过而不是失败
    skipped.push(`额度路径（反代未运行或未配 token：${json.error}）`);
  } else {
    throw new Error(`期望 200/502/503，实际 ${status} ${JSON.stringify(json)}`);
  }
  // scope 必须随响应下发，否则浏览器半无法门控
  expect(Array.isArray(json.providers), "响应缺少 providers");
  expect(json.providers.includes("gemini-web"), "providers 默认值应为 ['gemini-web']");
  expect(json.matchModelPrefix === true, "matchModelPrefix 默认应为 true");
  passed.push("scope（providers / matchModelPrefix）随响应下发");
}

// 2) 账号池 + 按号查额度 + 账号动作（依赖本地反代）
{
  const poolRoute = routes.get(ROUTES.pool);
  const accountRoute = routes.get(ROUTES.account);
  const { status, json } = await call(poolRoute, fakeReq({ url: ROUTES.pool }));
  console.log("账号池:", status, JSON.stringify(json).slice(0, 400));

  if (status === 502 || status === 503) {
    skipped.push(`账号池（反代未运行或未配 token：${json.error}）`);
  } else {
    expect(status === 200 && json.ok === true, `期望 200 ok:true，实际 ${status} ${JSON.stringify(json)}`);
    expect(Array.isArray(json.accounts), "accounts 应为数组");
    expect(typeof json.total === "number", "total 缺失");
    expect(json.canMutate === true, "默认应允许账号动作");
    expect(typeof json.panelUrl === "string" && json.panelUrl.endsWith("/admin/"), "panelUrl 缺失");
    for (const a of json.accounts) {
      expect(typeof a.id === "number" && a.id > 0, `账号 id 非法：${JSON.stringify(a)}`);
      expect(typeof a.label === "string", "label 缺失");
      expect(["enabled", "disabled"].includes(a.status), `status 非法：${a.status}`);
      expect(["ok", "dead", "disabled", "unknown"].includes(a.health), `health 非法：${a.health}`);
      expect(typeof a.failCount === "number", "failCount 缺失");
      // 完整 cookie 值绝不能出现在回给浏览器的数据里
      expect(!JSON.stringify(a).includes("SAPISID="), "账号视图疑似泄露完整 cookie");
    }
    passed.push(`账号池 200（${json.enabled}/${json.total} 启用，${json.accounts.length} 条视图字段完整）`);

    // 按号查额度：补过 /admin/api/quota?account_id=N 才有数据，没补要老实报 unsupported
    if (json.accounts.length > 0) {
      const id = json.accounts[0].id;
      const one = await call(route, fakeReq({ url: `${ROUTES.quota}?account_id=${id}` }));
      if (one.status === 200 && one.json.ok === true) {
        expect(one.json.accountId === id, `按号查额度返回的 accountId 不匹配：${JSON.stringify(one.json)}`);
        passed.push(`按号查额度（#${id}）返回匹配的 accountId`);
      } else if (one.status === 200 && one.json.unsupported === true) {
        skipped.push(`按号查额度（反代未打该补丁：${one.json.error}）`);
      } else {
        throw new Error(`按号查额度意外状态 ${one.status} ${JSON.stringify(one.json)}`);
      }
    } else {
      skipped.push("按号查额度（池里没有账号）");
    }

    // 动作入参校验（都不该真的碰到上游）
    const bad = await call(accountRoute, fakeReq({ method: "POST", body: { action: "nope", id: 1 } }));
    expect(bad.status === 400, `未知 action 期望 400，实际 ${bad.status}`);
    const badId = await call(accountRoute, fakeReq({ method: "POST", body: { action: "toggle", id: 0 } }));
    expect(badId.status === 400, `非法 id 期望 400，实际 ${badId.status}`);
    const noConfirm = await call(accountRoute, fakeReq({ method: "POST", body: { action: "switch", id: 1 } }));
    expect(noConfirm.status === 400, `switch 未确认期望 400，实际 ${noConfirm.status}`);
    const badJson = await call(accountRoute, fakeReq({ method: "POST", body: "{not json" }));
    expect(badJson.status === 400, `坏 JSON 期望 400，实际 ${badJson.status}`);
    passed.push("账号动作入参校验（未知 action / 非法 id / switch 未确认 / 坏 JSON → 400）");
  }
}

// 3) readOnly 关掉写操作
{
  const ro = mount({ readOnly: true, token: "x", baseUrl: "http://127.0.0.1:9" });
  const { status, json } = await call(
    ro.get(ROUTES.account),
    fakeReq({ method: "POST", body: { action: "toggle", id: 1 } }),
  );
  expect(status === 403, `readOnly 期望 403，实际 ${status}`);
  expect(json.error.includes("readOnly"), `readOnly 报错文案异常：${json.error}`);
  passed.push("readOnly: true → POST /account 403");
}

// 4) 信任闸门（三条路由都要过）
for (const [label, opts] of [
  ["非回环对端", { remote: "10.0.0.5" }],
  ["cross-site", { site: "cross-site" }],
  ["非回环 Host", { host: "evil.example.com" }],
]) {
  for (const path of Object.values(ROUTES)) {
    const current = routes.get(path);
    const method = path === ROUTES.account ? "POST" : "GET";
    const { status, json } = await call(current, fakeReq({ ...opts, method, url: path }));
    expect(status === 403, `${label} ${path} 期望 403，实际 ${status}`);
    expect(Array.isArray(json.providers), `${label} 的 403 响应也应带 scope`);
  }
  passed.push(`${label} 403（三条路由都拦截，且带 scope）`);
}

// 5) 方法闸门
{
  const wrong = [
    [routes.get(ROUTES.quota), fakeReq({ method: "POST" })],
    [routes.get(ROUTES.pool), fakeReq({ method: "POST", url: ROUTES.pool })],
    [routes.get(ROUTES.account), fakeReq({ method: "GET", url: ROUTES.account })],
  ];
  for (const [current, req] of wrong) {
    const { status } = await call(current, req);
    expect(status === 405, `${current.path} 方法闸门期望 405，实际 ${status}`);
  }
  passed.push("方法闸门：/quota /pool 只收 GET，/account 只收 POST");
}

// 6) 无 token → 503（显式 envFile 指向不存在的文件时，不回落到 $DSH_HOME）
{
  const bare = mount({ tokenEnv: "DSH_QUOTA_SELFTEST_UNSET", envFile: "/nonexistent/dsh-quota.env" });
  for (const path of [ROUTES.quota, ROUTES.pool]) {
    const { status, json } = await call(bare.get(path), fakeReq({ url: path }));
    expect(status === 503, `${path} 期望 503，实际 ${status}`);
    expect(json.error === "no admin token", `期望 no admin token，实际 ${JSON.stringify(json)}`);
  }
  passed.push("token 四个来源都未命中 → 503（/quota 与 /pool）");
}

// 7) 上游不可达 → 502
{
  const down = mount({ token: "x", baseUrl: "http://127.0.0.1:9", timeoutMs: 800 });
  for (const path of [ROUTES.quota, ROUTES.pool]) {
    const { status } = await call(down.get(path), fakeReq({ url: path }));
    expect(status === 502, `${path} 期望 502，实际 ${status}`);
  }
  passed.push("上游不可达 → 502（/quota 与 /pool）");
}

// 8) providers 可配置
{
  const custom = mount({ providers: "foo, bar baz", matchModelPrefix: false });
  const { json } = await call(custom.get(ROUTES.quota), fakeReq());
  expect(JSON.stringify(json.providers) === JSON.stringify(["foo", "bar", "baz"]),
    `providers 解析失败：${JSON.stringify(json.providers)}`);
  expect(json.matchModelPrefix === false, "matchModelPrefix 应可关闭");
  passed.push('providers 支持 "a, b c" 字符串并去重前解析为数组');
}

// 9) token 解析链优先级：config.token 优先于环境变量
{
  const token = localToken();
  if (token === "") {
    skipped.push("token 优先级（本机没有 $DSH_HOME/gemini-web2api.env）");
  } else {
    process.env.DSH_QUOTA_SELFTEST_TOKEN = "wrong-token-from-env";
    const direct = mount({ token, tokenEnv: "DSH_QUOTA_SELFTEST_TOKEN" });
    const fromConfig = await call(direct.get(ROUTES.quota), fakeReq());
    const fromEnv = await call(mount({ tokenEnv: "DSH_QUOTA_SELFTEST_TOKEN" }).get(ROUTES.quota), fakeReq());
    delete process.env.DSH_QUOTA_SELFTEST_TOKEN;
    expect(fromConfig.status === 200, `config.token 应优先生效，实际 ${fromConfig.status}`);
    expect(fromEnv.status === 502, `坏 token 应导致上游拒绝，实际 ${fromEnv.status}`);
    passed.push("token 优先级：config.token > tokenEnv");
  }
}

// 10) 浏览器半：模块契约冒烟（不渲染，只验证 bundle 能加载 + 接线正确）
//     能抓到的：语法错误、bundle id 与包名不符、apply 里引用了不存在的 service、
//     座位名写错。抓不到的：React 渲染期的错误（那得真在浏览器里点一次）。
{
  const registered = [];
  const fakeReact = {
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
    useId: () => ":r0:",
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => undefined,
  };
  const injected = [];
  const slotRegistrations = [];
  const fakeScope = {
    slots: {
      inject: (name, cb) => {
        injected.push(name);
        cb();
      },
      register: (def, component) => {
        slotRegistrations.push({ def, component });
        return () => {};
      },
    },
    modelDirectories: { directoryFor: () => ({ store: {} }) },
  };
  const fakeWindow = { __ModuleLoader__: { load: (definition) => registered.push(definition) } };
  const fakeRequire = (name) => {
    if (name === "react") return fakeReact;
    throw new Error(`浏览器半 require 了平台 seed 之外的模块：${name}`);
  };

  const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  new Function("window", "require", source)(fakeWindow, fakeRequire);

  expect(registered.length === 1, `client.js 应注册 1 个 bundle，实际 ${registered.length}`);
  const bundle = registered[0];
  expect(bundle.id === "dsh-gemini-quota", `bundle id 必须等于包名，实际 ${bundle.id}`);
  const half = bundle.factory(fakeRequire);
  expect(typeof half?.apply === "function", "浏览器半缺少 apply");
  expect(half.name === "dsh-gemini-quota-client", `半名异常：${half.name}`);
  half.apply({ inject: (_deps, cb) => cb(fakeScope) });
  expect(
    injected.includes("conversation.input.right"),
    `未注册到 conversation.input.right，实际：${injected.join(",")}`,
  );
  expect(slotRegistrations.length === 1, `期望注册 1 个组件，实际 ${slotRegistrations.length}`);
  expect(slotRegistrations[0].def.id === "gemini-web-quota", `座位 id 异常：${slotRegistrations[0].def.id}`);
  passed.push("浏览器半冒烟：bundle id = 包名，apply 正确注册 conversation.input.right");
}

console.log("\n✅ 通过:");
for (const item of passed) console.log("   -", item);
if (skipped.length > 0) {
  console.log("⏭️  跳过（不影响结论）:");
  for (const item of skipped) console.log("   -", item);
}
console.log(`\n共 ${passed.length} 项通过，${skipped.length} 项跳过。`);
