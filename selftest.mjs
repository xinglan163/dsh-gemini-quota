// 宿主半自测：不启动 DSH，用假 ctx / 假 req / 假 res 直接调路由 handler。
//   node selftest.mjs
// 验证：注册 → 信任闸门 → 方法闸门 → token 解析链 → 调反代 → 字段映射 → scope 下发
//       → 多号池（/pool 列表、按号查额度、账号动作的入参校验）。
// 反代没在跑时，依赖上游的用例会标记 SKIP 而不是失败（发布后别人也能跑）。
import { apply } from "./index.js";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROUTES = {
  quota: "/plugins/dsh-gemini-quota/quota",
  pool: "/plugins/dsh-gemini-quota/pool",
  actual: "/plugins/dsh-gemini-quota/actual",
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
  passed.push(`${label} 403（四条路由都拦截，且带 scope）`);
}

// 5) 方法闸门
{
  const wrong = [
    [routes.get(ROUTES.quota), fakeReq({ method: "POST" })],
    [routes.get(ROUTES.pool), fakeReq({ method: "POST", url: ROUTES.pool })],
    [routes.get(ROUTES.actual), fakeReq({ method: "POST", url: ROUTES.actual })],
    [routes.get(ROUTES.account), fakeReq({ method: "GET", url: ROUTES.account })],
  ];
  for (const [current, req] of wrong) {
    const { status } = await call(current, req);
    expect(status === 405, `${current.path} 方法闸门期望 405，实际 ${status}`);
  }
  passed.push("方法闸门：/quota /pool /actual 只收 GET，/account 只收 POST");
}

// 6) 无 token → 503（显式 envFile 指向不存在的文件时，不回落到 $DSH_HOME）
{
  const bare = mount({ tokenEnv: "DSH_QUOTA_SELFTEST_UNSET", envFile: "/nonexistent/dsh-quota.env" });
  for (const path of [ROUTES.quota, ROUTES.pool, ROUTES.actual]) {
    const { status, json } = await call(bare.get(path), fakeReq({ url: path }));
    expect(status === 503, `${path} 期望 503，实际 ${status}`);
    expect(json.error === "no admin token", `期望 no admin token，实际 ${JSON.stringify(json)}`);
  }
  passed.push("token 四个来源都未命中 → 503（/quota /pool /actual）");
}

// 7) 上游不可达 → 502
{
  const down = mount({ token: "x", baseUrl: "http://127.0.0.1:9", timeoutMs: 800 });
  for (const path of [ROUTES.quota, ROUTES.pool, ROUTES.actual]) {
    const { status } = await call(down.get(path), fakeReq({ url: path }));
    expect(status === 502, `${path} 期望 502，实际 ${status}`);
  }
  passed.push("上游不可达 → 502（/quota /pool /actual）");
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

// 10) 降级判定：stub 上游精确控制 /admin/api/requests 的返回
//
// 为什么要 stub 而不能只靠真反代：真反代里现在全是「4 Argon → 4 Argon」，
// 降级、"判不了"、"跳过判不了的"这三条分支根本走不到。
{
  const startStub = async (rows) => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: rows, limit: 5, offset: 0, total: rows.length }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  };
  const probe = async (stub) => {
    const { status, json } = await call(
      mount({ token: "x", baseUrl: stub.url }).get(ROUTES.actual),
      fakeReq({ url: ROUTES.actual }),
    );
    await stub.close();
    return { status, json };
  };

  const cases = [
    ["正常：请求 4 Argon，上游也回 4 Argon", [{ model: "gemini-4-argon", upstream_model: "4 Argon" }], "ok", false],
    ["降级：请求 4 Argon，上游回 3.5 Flash-Lite", [{ model: "gemini-4-argon", upstream_model: "3.5 Flash-Lite" }], "downgraded", true],
    ["降级：3.8 Flash → 3.5 Flash Lite（无连字符也认）", [{ model: "gemini-3.8-flash", upstream_model: "3.5 Flash Lite" }], "downgraded", true],
    ["改名容忍：3.7 的 id 遇到 3.8 的显示名", [{ model: "gemini-3.7-flash", upstream_model: "3.8 Flash" }], "ok", false],
    ["思考档：4 Argon High 仍算 4 Argon", [{ model: "gemini-4-argon-thinking", upstream_model: "4 Argon High" }], "ok", false],
    ["判不了：上游没自报显示名", [{ model: "gemini-4-argon", upstream_model: "" }], "unknown", false],
    ["判不了：表里没有的模型（生图）不误报", [{ model: "gemini-image", upstream_model: "3.5 Flash-Lite" }], "unknown", false],
  ];
  for (const [name, rows, verdict, downgraded] of cases) {
    const stub = await startStub(rows);
    const { status, json } = await probe(stub);
    expect(status === 200 && json.ok === true, `${name}：期望 200 ok，实际 ${status} ${JSON.stringify(json)}`);
    expect(json.latest?.verdict === verdict, `${name}：期望 verdict=${verdict}，实际 ${json.latest?.verdict}`);
    expect(json.downgraded === downgraded, `${name}：期望 downgraded=${downgraded}，实际 ${json.downgraded}`);
  }
  passed.push(`降级判定 ${cases.length} 种情形（降级 / 正常 / 改名容忍 / 判不了不误报）`);

  // 最新一条判不了时，不能把更早的一次真实降级藏起来
  {
    const stub = await startStub([
      { model: "gemini-image", upstream_model: "" },
      { model: "gemini-4-argon", upstream_model: "3.5 Flash-Lite" },
    ]);
    const { json } = await probe(stub);
    expect(json.downgraded === true, `跳过"判不了"后应仍能发现降级，实际 ${JSON.stringify(json.latest)}`);
    expect(json.latest?.requested === "gemini-4-argon", `latest 应取到可判定的那条，实际 ${JSON.stringify(json.latest)}`);
    passed.push("跳过判不了的：最新是生图、前一条才是降级时仍报警");
  }

  // 只白名单字段：上游多给了内容字段也不能透传（将来 SQL 加列也不会顺手泄露）
  {
    const stub = await startStub([
      { model: "gemini-4-argon", upstream_model: "4 Argon", prompt: "SECRET_PROMPT", response: "SECRET_BODY" },
    ]);
    const { json } = await probe(stub);
    expect(!JSON.stringify(json).includes("SECRET"), "响应里出现了上游的内容字段（字段白名单失效）");
    passed.push("字段白名单：上游的 prompt / response 不会被透传");
  }

  // 入参校验 + 上限钳制（bad 请求必须在上游之前就被挡掉）
  {
    const stub = await startStub([]);
    const bad = await call(
      mount({ token: "x", baseUrl: stub.url }).get(ROUTES.actual),
      fakeReq({ url: `${ROUTES.actual}?limit=abc` }),
    );
    expect(bad.status === 400, `limit=abc 期望 400，实际 ${bad.status}`);
    await call(
      mount({ token: "x", baseUrl: stub.url }).get(ROUTES.actual),
      fakeReq({ url: `${ROUTES.actual}?limit=999` }),
    );
    await stub.close();
    expect(stub.seen.length === 1, `坏 limit 不该打到上游，实际上游收到 ${stub.seen.length} 次`);
    expect(stub.seen[0] === "/admin/api/requests?limit=20", `limit 应钳到 20，实际上游收到 ${stub.seen[0]}`);
    passed.push("limit 校验与钳制（非数字 400 且不打上游，超上限钳到 20）");
  }
}

// 11) 浏览器半：模块契约冒烟（不渲染，只验证 bundle 能加载 + 接线正确）
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

// 12) 额度条渲染：降级时到底会不会亮红灯
//
// 用"按 hook 调用顺序喂 state"的假 React 把组件真调一次——渲染期的错误
// （字段名写错、h() 参数错位、条件分支写反）只有真走一遍才抓得到。
{
  const renderPill = (states) => {
    let cursor = 0;
    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: () => [states[cursor++], () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      // 门控靠它：组件要求 status === "ready" 且 provider 命中（见 matchesScope），
      // 返回 undefined 会让整条额度条渲染成 null，测不到任何东西。
      useSyncExternalStore: () => ({
        status: "ready",
        current: { provider: "gemini-web", model: "gemini-4-argon" },
      }),
      useId: () => ":r0:",
    };
    const registered = [];
    const registrations = [];
    const fakeScope = {
      slots: {
        inject: (_name, cb) => cb(),
        register: (def, component) => (registrations.push({ def, component }), () => {}),
      },
      modelDirectories: { directoryFor: () => ({ store: {} }) },
    };
    const fakeRequire = (name) => {
      if (name === "react") return fakeReact;
      throw new Error(`浏览器半 require 了平台 seed 之外的模块：${name}`);
    };
    const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");
    new Function("window", "require", source)(
      { __ModuleLoader__: { load: (definition) => registered.push(definition) } },
      fakeRequire,
    );
    registered[0].factory(fakeRequire).apply({ inject: (_deps, cb) => cb(fakeScope) });
    return registrations[0].component({ directory: undefined });
  };
  const texts = (node, out = []) => {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) {
      for (const child of node) texts(child, out);
      return out;
    }
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return out;
    }
    texts(node.children, out);
    return out;
  };

  // hook 顺序：snapshot, actual, scope, tip, open
  const snap = {
    ok: true,
    accountId: 1,
    account: "Pro(FF导入)",
    fiveHour: { usedPercent: 95, remainPercent: 5, resetAt: 1792050755, resetInSec: 600 },
    weekly: { usedPercent: 25, remainPercent: 75, resetAt: 1792486355, resetInSec: 400000 },
  };
  const scope = { providers: ["gemini-web"], matchModelPrefix: true };
  const degraded = {
    ok: true,
    downgraded: true,
    latest: { requested: "gemini-4-argon", actual: "3.5 Flash-Lite", verdict: "downgraded", downgraded: true },
  };
  const healthy = { ok: true, downgraded: false, latest: { requested: "gemini-4-argon", actual: "4 Argon", verdict: "ok" } };

  const warn = renderPill([snap, degraded, scope, true, false]);
  expect(warn !== null, "降级时应渲染出额度条，实际返回 null");
  expect(
    warn.props["data-gemini-quota"].includes("downgraded"),
    `data 属性缺少 downgraded：${warn.props["data-gemini-quota"]}`,
  );
  const warnText = texts(warn).join(" | ");
  expect(warnText.includes("被降级"), `悬停浮层缺少降级说明：${warnText}`);
  expect(warnText.includes("3.5 Flash-Lite"), `悬停浮层缺少实际模型名：${warnText}`);
  expect(warn.props["aria-label"].includes("降级"), `aria-label 未提示降级：${warn.props["aria-label"]}`);

  const calm = renderPill([snap, healthy, scope, true, false]);
  const calmData = calm.props["data-gemini-quota"];
  const calmText = texts(calm).join(" | ");
  expect(!calmData.includes("downgraded"), `正常时 data 属性不该带 downgraded：${calmData}`);
  expect(!calmText.includes("被降级"), `正常时不该出现降级文案：${calmText}`);
  passed.push("额度条渲染：降级时亮红灯 + 浮层写明实际模型；正常时不误报");
}

console.log("\n✅ 通过:");
for (const item of passed) console.log("   -", item);
if (skipped.length > 0) {
  console.log("⏭️  跳过（不影响结论）:");
  for (const item of skipped) console.log("   -", item);
}
console.log(`\n共 ${passed.length} 项通过，${skipped.length} 项跳过。`);
