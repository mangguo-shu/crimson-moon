/* ============================================================
 * scripts/vendor-capacitor.js —— 把 Capacitor 的 JS 端拷进 vendor/capacitor/
 *
 * 为什么需要这一步：
 *   本项目是纯 JS + 普通 <script> 标签（没有打包器、没有 ES Module），
 *   所以没法 `import { App } from '@capacitor/app'`。Capacitor 各包的
 *   dist 是 UMD「var 赋值」构建，可以直接当脚本加载：
 *     - core.js   定义 globalThis.Capacitor（getPlatform / registerPlugin /
 *                 Plugins），原生侧设置的 androidBridge 会被保留、不会覆盖
 *     - 其余每个文件都是 UMD 工厂自调用，构造时调 core.registerPlugin(...)，
 *                 把 Plugins.App / ScreenOrientation / StatusBar / Haptics /
 *                 Preferences 注册进去
 *   少了这些 <script>，window.Capacitor 是 undefined —— js/nativeBridge.js 里
 *   的安卓返回键、锁横屏、震动、切后台暂停**全部静默失效**（2026-09-26
 *   真机验收才发现这个文件从来没人加载过）。
 *
 * 用法：npm run vendor:cap    （依赖版本变动后重跑一次）
 * 校验：见末尾的实机校验段，也会写进 test/smoke.js 的「原生桥」断言。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'vendor', 'capacitor');

// 屏幕常亮不在这个列表里，也不是漏了：安卓没有官方 @capacitor/keep-awake 包
// （npm 搜到的都是社区分支）。它由 patch-android.js 往 MainActivity 注入的
// FLAG_KEEP_SCREEN_ON 承担，全程生效，JS 端不需要任何调用。
// 目标文件名 → 源文件。顺序重要：core 必须先落地（其余 UMD 包在脚本加载时会
// 引用全局变量 capacitorExports，也就是 core 导出的那个模块对象）。
const FILES = [
  ['core.js', 'core/dist/capacitor.js'],
  ['app.js', 'app/dist/plugin.js'],
  ['screen-orientation.js', 'screen-orientation/dist/plugin.js'],
  ['status-bar.js', 'status-bar/dist/plugin.js'],
  ['haptics.js', 'haptics/dist/plugin.js'],
  ['preferences.js', 'preferences/dist/plugin.js'],
];

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const [outName, relSrc] of FILES) {
    const src = path.join(NM, '@capacitor', relSrc);
    if (!fs.existsSync(src)) {
      console.error('[vendor:cap] 缺失 ' + src);
      console.error('  先装依赖：npm i --registry=https://registry.npmmirror.com');
      process.exitCode = 1;
      continue;
    }
    fs.copyFileSync(src, path.join(OUT, outName));
    const ver = JSON.parse(fs.readFileSync(
      path.join(NM, '@capacitor', relSrc.split('/')[0], 'package.json'), 'utf8')).version;
    console.log('  ✓ ' + outName.padEnd(24) + '@' + ver + '  ← ' + relSrc);
  }

  // 实机校验：按页面里的顺序加载一遍，断言插件真的注册进去了。
  // 必须用 vm.runInThisContext：UMD 的 `var capacitorExports` 要落到**全局**作用域
  // （一串 <script> 标签就是这样共享全局的），new Function 会把它关在函数作用域里，
  // 第二个包一引用 capacitorExports 就直接 ReferenceError。
  delete globalThis.Capacitor;
  globalThis.window = globalThis;
  for (const [outName] of FILES) {
    vm.runInThisContext(fs.readFileSync(path.join(OUT, outName), 'utf8'), {
      filename: outName,
    });
  }
  delete globalThis.window;

  const plugins = (globalThis.Capacitor && globalThis.Capacitor.Plugins) || {};
  const names = Object.keys(plugins);
  console.log('[vendor:cap] 已注册插件：' + names.join(', '));
  if (names.length < 5 || !globalThis.Capacitor.getPlatform) {
    console.error('[vendor:cap] 校验失败：core 没有挂到 globalThis 或插件没注册齐');
    process.exitCode = 1;
  }
}

main();
