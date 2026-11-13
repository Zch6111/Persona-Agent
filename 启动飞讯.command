#!/bin/bash
set -uo pipefail

FLYING_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYING_UI_DIR="$FLYING_PROJECT_DIR/src/adapter/web"
FLYING_UI_URL="http://127.0.0.1:4173/"

# Finder 启动的终端可能没有加载用户安装的运行环境路径。
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"

fail() {
  printf '\n启动失败：%s\n' "$1" >&2
  if [[ -t 0 ]]; then read -r -p '按回车键关闭窗口…' FLYING_REPLY; fi
  exit 1
}

command -v node >/dev/null 2>&1 || fail '没有找到 Node.js，请先安装 22.12 或以上版本。'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' \
  || fail '需要 Node.js 22.12 或以上版本。'
[[ -f "$FLYING_UI_DIR/package.json" ]] || fail '没有找到飞讯网页文件。'

if curl -fsS --max-time 2 "${FLYING_UI_URL}__local/status" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).local===true?0:1)}catch{process.exit(1)}})'; then
  printf '飞讯已在运行，正在打开网页。\n'
  open "$FLYING_UI_URL" || fail '无法打开浏览器，请手动访问 http://127.0.0.1:4173/。'
  exit 0
fi

if lsof -nP -iTCP:4173 -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail '端口 4173 已被占用，请先关闭原来的飞讯网页服务。'
fi

cd "$FLYING_UI_DIR" || fail '无法进入飞讯目录。'
if [[ ! -f node_modules/vite/bin/vite.js ]]; then
  printf '正在安装飞讯所需组件…\n'
  npm install || fail '组件安装失败，请检查网络连接。'
fi

printf '\n正在打开飞讯…\n关闭时请点击网页右上角的“关闭飞讯”。\n\n'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort --open \
  || fail '飞讯启动失败，请查看上面的提示。'
