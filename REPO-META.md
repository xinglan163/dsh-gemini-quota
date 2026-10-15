# 仓库元数据（照抄即可）

## 1. GitHub「创建一个新的仓库」页面

| 字段 | 填什么 |
|---|---|
| 所有者 | `星澜163`（即 `xinglan163`） |
| 存储库名称 | `dsh-gemini-quota` |
| **描述** | 见下方①，直接粘贴 |
| 选择可见度 | **公共** |
| 添加 README | **关掉**（本地已有 README.md） |
| 添加 .gitignore | **没有 .gitignore**（本地已有，勾了会冲突） |
| 添加许可 | **无驾照 / None**（本地已有 MIT LICENSE，勾了会多出第二个 LICENSE 文件） |

> 三个"添加"都必须留空/关掉，否则 GitHub 会先建一个初始提交，你的 `git push` 会被拒（需要先 pull）。

### ① 仓库描述（≤350 字符）

```
为 DeepSeek Harness 添加 Gemini 额度条：在输入框显示 5 小时 / 每周剩余额度，只在选中 Gemini 模型时出现；点开即多号池面板，可逐号看额度、启停冷却、检测保活、一键切号。数据来自本地 gemini-web2api-go 反代。· Gemini quota pill + account pool panel for DeepSeek Harness.
```

（可与 `package.json` 的 `description` 保持一致，见第 4 节。）

## 2. 创建后：About 栏（右侧齿轮）

| 项 | 值 |
|---|---|
| Description | 同① |
| Website | `https://www.npmjs.com/package/dsh-gemini-quota` |
| Topics | `dsh` `deepseek-harness` `dsh-plugin` `dsh-bundle` `gemini` `quota` `gemini-web2api` `cordis` |

`dsh` / `deepseek-harness` / `dsh-plugin` 这几个 topic 是别人能搜到你的关键——
DSH 插件页本身没有搜索目录，社区主要靠这些关键词和包名找。

## 2.5 已上线

- npm：https://www.npmjs.com/package/dsh-gemini-quota （`0.1.0`，latest）
- 仓库：https://github.com/xinglan163/dsh-gemini-quota

## 3. 首次推送

```sh
cd plugins/dsh-gemini-quota
git remote add origin https://github.com/xinglan163/dsh-gemini-quota.git
git push -u origin main
```

## 4. 发布到 npm（= 上架 DSH 插件页）

```sh
npm login
npm publish --access public
```

如需让 npm 页描述与仓库描述一致：

```sh
npm pkg set description="在 DeepSeek Harness 输入框显示 Gemini 额度条，点开即多号池面板：逐号剩余额度、启停冷却、检测保活、一键切号"
```
