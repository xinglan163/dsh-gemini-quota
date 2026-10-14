# dsh-gemini-quota

在 **DeepSeek Harness** 的输入框右侧显示一条 Gemini 网页端额度小条：

```
 5h ████████░░░░░░  37%
 7d ██████████████  87%
```

- 只在**当前选中的模型属于 Gemini** 时出现，切到 DeepSeek / Codex 自动消失；
- 鼠标悬停显示剩余量与重置时间（含账号）；
- 数据来自本地 `gemini-web2api-go` 反代的 `/admin/api/quota`。

> 本插件是**显示层**，不含反代本身。你需要先自己跑一个
> [gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)（或任何实现
> `GET /admin/api/quota` + Bearer admin token 的服务）。

## 前置条件

1. 一个在跑的反代，默认地址 `http://127.0.0.1:8083`；
2. 它的 admin token，放在下面任一位置（按优先级）：
   - `token` 配置项（直接写在 config 里，不推荐提交到仓库）；
   - 环境变量 `GEMINI_WEB_ADMIN_TOKEN`（可用 `tokenEnv` 改名）；
   - `envFile` 指向的文件里的 `GEMINI_WEB_ADMIN_TOKEN=...`；
   - **`$DSH_HOME/gemini-web2api.env`**（默认 `~/.dsh/gemini-web2api.env`）——推荐，机器相关的东西放这里。

   ```sh
   install -m 600 /dev/null ~/.dsh/gemini-web2api.env
   printf 'GEMINI_WEB_ADMIN_TOKEN=%s\n' '<你的 admin token>' > ~/.dsh/gemini-web2api.env
   ```

## 安装

在 DSH 侧边栏 **插件** 页里安装（输入包名即可）：

```
dsh-gemini-quota
```

也可以走 CLI / 其他 spec 形式：

```sh
# 注册表包
dsh plugin --profile <profile> add dsh-gemini-quota
# 本地目录（开发用）
dsh plugin --profile <profile> add /path/to/dsh-gemini-quota
# tarball / git
dsh plugin --profile <profile> add ./dsh-gemini-quota-0.1.0.tgz
dsh plugin --profile <profile> add github:xinglan163/dsh-gemini-quota
```

安装后默认启用。本插件**没有任何依赖构建脚本**，因此不会触发 pnpm 的 `allowBuilds` 审批。

## 配置

改组合包自带的 `cordis.patch.yml`，或在你 profile 的 `cordis.patch.yml` 里按 `id: gemini-web-quota` 覆盖：

| 项 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8083` | 反代地址 |
| `providers` | `["gemini-web"]` | 哪些 DSH provider id 触发显示（决定门控） |
| `matchModelPrefix` | `true` | 额外按模型名 `gemini-*` 兜底 |
| `token` | — | 直接给 admin token（优先级最高） |
| `tokenEnv` | `GEMINI_WEB_ADMIN_TOKEN` | 从哪个环境变量读 token |
| `envFile` | `$DSH_HOME/gemini-web2api.env` | 从该文件读 token |
| `timeoutMs` | `8000` | 上游超时 |

`providers` 必须和你在 `llm-pi-ai` 里给反代起的 provider 名一致（默认 `gemini-web`）。

## 工作原理

- **宿主半**（`index.js`）把 `/admin/api/quota` 转成同源路由 `/plugins/dsh-gemini-quota/quota`。
  为什么不让浏览器直连反代：反代的 CORS 预检没有 `Access-Control-Allow-Headers`，带
  `Authorization` 的 fetch 会被浏览器拒；用 `?token=` 又能过但会把 admin token 泄进前端产物。
- 该路由自带最小信任闸门（回环对端 + 回环 Host + 非 cross-site + 同源 Origin）。
- 路由同时下发 `providers` / `matchModelPrefix`：浏览器半拿不到 cordis config
  （client-modules 只传 `{ name: id }`），所以门控范围必须由宿主告知。

## 疑难排查

| 现象 | 原因 |
|---|---|
| 悬停提示正常但**条一直不出现** | 当前模型不在 `providers` 里；改配置或开 `matchModelPrefix` |
| 控制台/路由 503 `no admin token` | token 四个来源都没命中 |
| 502 `quota upstream ...` | 反代没跑、端口不对、或 admin token 无效 |
| 403 `forbidden` | 不是从回环地址/同源访问的 |
| 改了 `client.js` 界面没变 | `client-hmr` 对 `link:` 安装不一定生效，**刷新页面（Cmd+R）**最稳 |

## 卸载

插件页关掉组合包，或 `dsh plugin --profile <profile> remove dsh-gemini-quota`。

## License

MIT
