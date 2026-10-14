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
