#!/bin/bash
set -uo pipefail

COMPANION_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"

fail() {
  printf '\n启动失败：%s\n' "$1" >&2
  if [[ -t 0 ]]; then read -r -p '按回车键关闭窗口…' COMPANION_REPLY; fi
  exit 1
}

command -v node >/dev/null 2>&1 || fail '没有找到 Node.js。'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail '新后端需要 Node.js 24 或以上版本。'
for COMPANION_COMPONENT in . src/adapter/web; do
  [[ -f "$COMPANION_PROJECT_DIR/$COMPANION_COMPONENT/package.json" ]] || fail "没有找到 $COMPANION_COMPONENT 文件。"
done

if [[ ! -f "$COMPANION_PROJECT_DIR/node_modules/tsx/dist/cli.mjs" ]]; then
  npm --prefix "$COMPANION_PROJECT_DIR" install || fail '后端组件安装失败。'
fi
if [[ ! -f "$COMPANION_PROJECT_DIR/src/adapter/web/node_modules/vite/bin/vite.js" ]]; then
  npm --prefix "$COMPANION_PROJECT_DIR/src/adapter/web" install || fail '网页组件安装失败。'
fi

cd "$COMPANION_PROJECT_DIR" || fail '无法进入后端目录。'
node --import tsx src/adapter/platform/launcher.ts || fail '陪伴聊天启动失败，请查看上方提示。'
