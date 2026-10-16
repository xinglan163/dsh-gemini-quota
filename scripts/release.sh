#!/usr/bin/env bash
# 本地一键发版 —— CI 不可用时的替代方案（GitHub Actions 被账单锁挡住）。
#
#   ./scripts/release.sh patch        # 0.1.2 → 0.1.3
#   ./scripts/release.sh minor        # 0.1.2 → 0.2.0
#   ./scripts/release.sh 1.0.0        # 指定版本号
#   ./scripts/release.sh 0.2.0        # 指定版本号；若 package.json 已是 0.2.0 就跳过提版本那步
#   DRY_RUN=1 ./scripts/release.sh patch   # 只走流程不发布（排练）
#
# 做的事：自测 → 提版本 → 提交 → 打 tag → 推 GitHub → npm publish（提示输 OTP）
#
# 注意：macOS 自带 bash 3.2，$var 紧跟多字节字符（如全角括号）时会被解析进变量名，
# 所以本脚本所有变量引用一律写成 ${var}，不要"优化"成 $var。
set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:-patch}"
dry="${DRY_RUN:-0}"

run() {
  if [ "${dry}" = "1" ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

echo "== 0. 检查工作区 =="
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，请先提交改动："; git status --short; exit 1
fi
echo "  干净"
if [ "${dry}" = "1" ]; then echo "  （DRY_RUN 模式：不会改动任何东西）"; fi

echo "== 1. 自测（零依赖）=="
node --check index.js
node --check client.js
node selftest.mjs

echo "== 2. 提版本（${bump}）=="
current="$(node -p "require('./package.json').version")"
if [ "${bump}" = "${current}" ]; then
  # 版本号已经在功能提交里提过了（./scripts/release.sh 0.2.0 这种用法）。
  # 此时 npm version 会因为"版本没变"直接报 Version not changed 并退出，所以跳过。
  echo "  当前已是 ${current}，跳过提版本"
  version="${current}"
elif [ "${dry}" = "1" ]; then
  echo "  [dry-run] npm version ${bump} --no-git-tag-version"
  version="<新版本>"
else
  npm version "${bump}" --no-git-tag-version >/dev/null
  version="$(node -p "require('./package.json').version")"
fi
echo "  → ${version}"

echo "== 3. 提交并推送 =="
# 上面跳过了提版本，工作区就已经是干净的，硬跑 git commit 会因
# "nothing to commit" 报错并让 set -e 中止整个发版。
if [ -n "$(git status --porcelain)" ]; then
  run git commit -am "chore: release ${version}"
else
  echo "  工作区已干净，无需提交"
fi
# tag 已存在就跳过：否则"提到版本 → 打 tag → publish 失败"之后再重跑，
# 会在这一行 fatal: tag already exists 直接中止，明明只差发布这一步却发不出去。
if git rev-parse -q --verify "refs/tags/v${version}" >/dev/null 2>&1; then
  echo "  tag v${version} 已存在，跳过"
else
  run git tag "v${version}"
fi
run git push origin main --tags

echo "== 4. 发布到 npm（接下来会提示输入 6 位 OTP）=="
run npm publish --access public

echo
if [ "${dry}" = "1" ]; then
  echo "✅ 排练完成（未发布、未改动）。去掉 DRY_RUN=1 即可真发。"
else
  echo "✅ 已提交发布 dsh-gemini-quota@${version}"
  echo "   npm 是异步处理（registry 返回 202），通常 1-5 分钟后才可见，别急着重发。"
  echo "   核验是否真上线（200 = 已上线）："
  echo "     curl -s -o /dev/null -w '%{http_code}\\n' https://registry.npmjs.org/dsh-gemini-quota/${version}"
fi
