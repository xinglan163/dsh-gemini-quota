#!/usr/bin/env bash
# 本地一键发版 —— CI 不可用时的替代方案（本账号 GitHub Actions 被账单锁挡住）。
#
#   ./scripts/release.sh patch        # 0.1.2 → 0.1.3
#   ./scripts/release.sh minor        # 0.1.2 → 0.2.0
#   ./scripts/release.sh 1.0.0        # 指定版本号
#
# 做的事：自测 → 提版本 → 提交 → 打 tag → 推 GitHub → npm publish（提示输 OTP）
set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:-patch}"

echo "== 0. 检查工作区 =="
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区不干净，请先提交改动："; git status --short; exit 1
fi
echo "  干净"

echo "== 1. 自测（零依赖）=="
node --check index.js
node --check client.js
node selftest.mjs

echo "== 2. 提版本（$bump）=="
npm version "$bump" --no-git-tag-version >/dev/null
version="$(node -p "require('./package.json').version")"
echo "  → $version"

echo "== 3. 提交并推送 =="
git commit -am "chore: release $version"
git tag "v$version"
git push origin main --tags

echo "== 4. 发布到 npm（接下来会提示输入 6 位 OTP）=="
npm publish --access public

echo
echo "✅ 已发布 dsh-gemini-quota@$version"
echo "   核验： npm view dsh-gemini-quota version"
