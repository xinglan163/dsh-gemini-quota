# 发布到 npm（= 上架到 DSH 插件页）

DSH 的插件页没有独立商店后端：它就是把包名交给 `pnpm add`，默认走
<https://registry.npmjs.org/>，失败时回落 <https://registry.npmmirror.com/>。
所以「上架」= **发一个公开的 npm 包**，别人在插件页输入包名即可安装。

## 0. 发布前检查

```sh
cd plugins/dsh-gemini-quota
node --check index.js && node --check client.js
node selftest.mjs                 # 宿主半单测（不起 App）
npx --yes publint                 # 可选：清单/导出体检
npm pack --dry-run                # 看最终 tarball 里到底有什么
```

必须满足（来自 DSH plugin-manager 的安装前检查）：

- [ ] `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`（否则报 `not-a-bundle`）；
- [ ] `exports["./client"]` 存在（client-modules 靠它找浏览器半）；
- [ ] **无 `private: true`**；
- [ ] `files` 里包含运行时需要的全部文件；
- [ ] 没有 `postinstall`/`prepare` 等依赖构建脚本（否则用户要额外批准 `allowBuilds`）；
- [ ] 包内**不出现任何机器专属绝对路径**。

## 1. 仓库地址

已填好 `xinglan163/dsh-gemini-quota`。仓库还不存在——先在 GitHub 建一个同名空仓库
（不要勾选 README/.gitignore），然后：

```sh
git init && git add -A && git commit -m "feat: dsh-gemini-quota 0.1.0"
git branch -M main
git remote add origin https://github.com/xinglan163/dsh-gemini-quota.git
git push -u origin main
```

本地仓库和首个提交已经帮你做好了，只剩 `git remote add` + `git push`。

## 2. 登录并发布

```sh
npm login                      # 需要 npm 账号（开了 2FA 的要输一次性验证码）
npm publish --access public    # 首次发布
# 想先小范围试点就用预发布 tag，用户装 dsh-gemini-quota@alpha：
# npm publish --access public --tag alpha
```

发布前建议打一次包看内容：

```sh
npm pack && tar -tzf dsh-gemini-quota-0.1.0.tgz
```

## 3. 发布后验证（重要）

```sh
npm view dsh-gemini-quota version dist.tarball
# 让 DSH 走一遍真实安装路径：
dsh plugin --profile <你的 profile> add dsh-gemini-quota
```

## 4. 让别人能装

DSH 插件页**没有搜索目录**，所以传播靠包名。建议：

- README 里写清前置条件（`gemini-web2api-go` + admin token），否则别人装了看不到任何东西；
- 在 DSH 社区/Issue 里贴一句安装命令；
- 需要时把包名加到自己的文档里。

## 4.5 新包的「暂存发布」——实测流程（2026-10）

首次发布**不会立刻生效**，npm 对新包启用了 staged publishing：

1. `npm publish` 成功后，registry 上先出现一个占位版本 **`0.0.0-stage`**
   （README 写着"临时占位，等待 staged release"）；
2. 真版本随后自动转正——实测**约 1 分钟**后 `dist-tags.latest` 变成 `0.1.0`；
3. 期间用 `npm view dsh-gemini-quota version` 会看到 `0.0.0-stage`，**不要慌、也不要重发**。

判断是否真的上线，看这两个字段：

```sh
curl -s https://registry.npmjs.org/dsh-gemini-quota | \
  python3 -c "import json,sys;d=json.load(sys.stdin);print(list(d['versions']), d['dist-tags'])"
# 期望：versions 含你的版本；dist-tags.latest 指向它
```

**后续版本**（包已存在）不再走这套占位流程，`npm publish` 直接生效。

想主动走暂存（先审后发、或 CI 里免 2FA 提交）用 npm **v12** 的 `npm stage`：

```sh
npm stage publish              # 提交到暂存区（不需要 2FA，可用任意 token）
npm stage list dsh-gemini-quota
npm stage view <stage-id>
npm stage download <stage-id>  # 下载 tarball 自查
npm stage approve <stage-id>   # 批准上线（**这一步要 2FA**）
npm stage reject <stage-id>
```

npm 11 没有 `npm stage`；临时借用：
`npx --yes npm@12 stage list dsh-gemini-quota`（会有 EBADENGINE 警告，功能正常）。

## 5. 版本与回滚

```sh
npm version patch|minor|major
npm publish --access public
```

- npm 允许 `npm unpublish dsh-gemini-quota@x.y.z` 的时间窗只有 **72 小时**，且已被别人下载过会有额外限制；发坏了更稳的做法是**发一个修好的新版本**。
- 若最终想永久弃用某个版本：`npm deprecate dsh-gemini-quota@x.y.z "原因"`。

## 备选：不想发 npm

`dsh plugin add` 也接受本地路径、tarball 和 git：

```sh
npm pack && dsh plugin --profile <p> add ./dsh-gemini-quota-0.1.0.tgz
dsh plugin --profile <p> add github:xinglan163/dsh-gemini-quota
```

## 6. 可信发布（OIDC）：推 tag 自动发版，免 token 免 OTP

工作流已在 `.github/workflows/publish.yml`。启用只需要在 npm 侧登记一次：

1. 打开 **https://www.npmjs.com/package/dsh-gemini-quota/access**
   （这是包设置页；点路径是：包页面 → 右侧 **Settings** → **Trusted Publisher** 一节。
   注意 `/settings` 这种 URL 是 404，npm 用的是 `/access`）
2. **Select your publisher** → 点 **GitHub Actions**
3. 填：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `xinglan163` |
   | Repository | `dsh-gemini-quota` |
   | Workflow filename | `publish.yml` |
   | Environment name | 留空 |

4. 保存（会要求 2FA 验证）；文档另提到启用后到 Overview → Publishing access → **Update Package Settings** 再存一次

之后发版只需三步：

```sh
cd plugins/dsh-gemini-quota
npm version patch --no-git-tag-version   # 或手改 package.json
git commit -am "chore: release 0.1.1"
git tag v0.1.1 && git push origin main --tags
```

工作流会：语法检查 → 跑 `selftest.mjs` → 校验 **tag 与 package.json 版本一致** →
`npm publish --provenance`（OIDC 换凭证，**不需要任何 secret**）。

要点：

- 预发布版本（`0.2.0-alpha.1`）自动发到 `alpha` dist-tag，不会污染 `latest`；
- **tag 与 package.json 版本不一致会直接失败**，避免发错版本号；
- npm 页面上会出现 "Built and signed on GitHub Actions" 的 provenance 徽章；
- 本地 `npm publish` 仍需 OTP；CI 这条路完全不需要；
- 如果包名/工作流文件名改了，必须同步改 npm 侧的登记，否则报 `not authorized`。

## 7. 没有 CI 时的日常发版（当前采用）

本账号的 GitHub Actions 被**账单问题**锁住（注解原文：*The job was not started because
your account is locked due to a billing issue.*），任务在启动前就被拦，所以自动发布暂时不可用。
`.github/workflows/publish.yml` 已改为**仅手动触发**，推 tag 不会再产生失败红叉。

日常发版改走本地脚本：

```sh
npm login                 # 只需一次
./scripts/release.sh patch   # 或 minor / major / 1.0.0
```

脚本会：自测 → 提版本 → 提交 → 打 tag → 推 GitHub → `npm publish`（提示输 6 位 OTP）。

**与 CI 的唯一差别**：没有 OIDC provenance 签名，npm 页面不会出现
"Built and signed on GitHub Actions" 徽章。功能与安装完全不受影响。

账单恢复后想切回自动发布：把 `publish.yml` 里 `restore` 注释的三行填回 `on:` 之下即可。

### 别人多久能装到新版（实测坑）

pnpm 有「最小发布年龄」供应链保护：**刚发布几分钟的版本可能被拦**，
表现是 `pnpm update dsh-gemini-quota` 回答 "Already up to date"，版本号不动。

急着装就显式关掉这次检查：

```sh
dsh plugin --profile <profile> update dsh-gemini-quota --config.minimumReleaseAge=0
```

实测：发布后立刻更新被拦，加上这个参数后 2.9 秒装到新版本。
DSH 插件页安装走的是同一个 pnpm，所以新版发布后可能需要等一段时间才会被装上。
