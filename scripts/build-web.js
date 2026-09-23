/* ============================================================
 * scripts/build-web.js —— 把游戏资源拷贝到 www/ 目录
 * Capacitor 的 webDir 指向 www/，打包安卓前必须先执行本脚本。
 * 使用 Node 原生 fs，跨平台（Windows / Linux / macOS）。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

// 要拷贝到 www/ 的条目
const ENTRIES = ['index.html', 'css', 'js'];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  // 清空旧 www
  fs.rmSync(WWW, { recursive: true, force: true });
  fs.mkdirSync(WWW, { recursive: true });

  for (const entry of ENTRIES) {
    const src = path.join(ROOT, entry);
    const dest = path.join(WWW, entry);
    if (fs.statSync(src).isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
    console.log('  ✓ 拷贝 ' + entry);
  }
  console.log('[build:web] 完成 → ' + WWW);
}

main();
