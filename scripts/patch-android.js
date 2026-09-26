/* ============================================================
 * scripts/patch-android.js —— 对 Capacitor 生成的安卓工程打补丁
 * 需在 `npx cap sync android` 之后运行，实现以下需求：
 *  1. AndroidManifest.xml：锁定横屏、硬件加速、移除 INTERNET 权限、全屏主题
 *  2. styles.xml：追加全屏主题样式（适配挖孔屏）
 *  3. build.gradle：versionName 1.0.0（versionCode 已在生成时为 1）
 *  4. variables.gradle：minSdkVersion 26 / targetSdkVersion 34
 *  5. MainActivity.java：屏幕常亮（FLAG_KEEP_SCREEN_ON）
 *  6. app/build.gradle：注入 web assets 同步守卫（防跳过 cap sync 打包旧资源）
 * 所有替换均幂等，可重复执行。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const glob = require('./_glob');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APP = path.join(ANDROID, 'app', 'src', 'main');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }

function ensureDir() {
  if (!fs.existsSync(ANDROID)) {
    console.error('[patch] 未找到 android/ 目录，请先执行 `npx cap add android` 或 `npx cap sync android`');
    process.exit(1);
  }
}

/* ---------- 1. AndroidManifest.xml ---------- */
function patchManifest() {
  const p = path.join(APP, 'AndroidManifest.xml');
  let s = read(p);
  let changed = [];

  // 1.1 移除 INTERNET 权限（纯单机，不申请网络权限）
  if (/<uses-permission\s+android:name="android\.permission\.INTERNET"\s*\/?>/.test(s)) {
    s = s.replace(/<uses-permission\s+android:name="android\.permission\.INTERNET"\s*\/?>\s*/g, '');
    changed.push('移除 INTERNET 权限');
  }

  // 1.2 activity 增加横屏 + 硬件加速
  if (!/android:screenOrientation="landscape"/.test(s)) {
    s = s.replace(/<activity\s+/, '<activity android:screenOrientation="landscape" ');
    changed.push('锁定横屏');
  }
  if (!/android:hardwareAccelerated="true"/.test(s)) {
    s = s.replace(/<activity\s+/, '<activity android:hardwareAccelerated="true" ');
    changed.push('硬件加速');
  }

  // 1.3 全屏主题：把 NoActionBarLaunch 替换为自定义 Fullscreen 主题
  if (/AppTheme\.NoActionBarLaunch/.test(s)) {
    s = s.replace('@style/AppTheme.NoActionBarLaunch', '@style/AppTheme.NoActionBar.Fullscreen');
    changed.push('全屏主题');
  }

  write(p, s);
  console.log('[patch] AndroidManifest.xml: ' + (changed.join('、') || '无变化'));
}

/* ---------- 2. styles.xml ---------- */
function patchStyles() {
  const p = path.join(APP, 'res', 'values', 'styles.xml');
  if (!fs.existsSync(p)) { console.warn('[patch] 未找到 styles.xml，跳过'); return; }
  let s = read(p);
  if (!s.includes('AppTheme.NoActionBar.Fullscreen')) {
    const style =
      '    <style name="AppTheme.NoActionBar.Fullscreen" parent="AppTheme.NoActionBar">\n' +
      '        <item name="android:windowFullscreen">true</item>\n' +
      '        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>\n' +
      '    </style>\n';
    s = s.replace('</resources>', style + '</resources>');
    write(p, s);
    console.log('[patch] styles.xml: 追加全屏主题');
  } else {
    console.log('[patch] styles.xml: 已存在');
  }
}

/* ---------- 3. app/build.gradle ---------- */
function patchAppGradle() {
  const p = path.join(ANDROID, 'app', 'build.gradle');
  if (!fs.existsSync(p)) { console.warn('[patch] 未找到 app/build.gradle，跳过'); return; }
  let s = read(p);
  let changed = [];
  if (!/versionName "1\.0\.0"/.test(s)) {
    s = s.replace(/versionName "[^"]*"/, 'versionName "1.0.0"');
    changed.push('versionName 1.0.0');
  }
  if (!/versionCode 1\b/.test(s)) {
    s = s.replace(/versionCode \d+/, 'versionCode 1');
    changed.push('versionCode 1');
  }
  if (changed.length) { write(p, s); console.log('[patch] app/build.gradle: ' + changed.join('、')); }
  else console.log('[patch] app/build.gradle: 无变化');
}

/* ---------- 3b. web assets 同步守卫 ---------- */
// 2026-09-26 真机验收的教训：手机装的是 9/21 的 assets，因为 `npx cap sync android`
// 从没跑过（多半是在 Android Studio 里直接点 Build APK，那步只编译不拷 web 资源）。
// 结果 7 条修复一条都没进包，看起来像「代码全是坏的」。
// 守卫挂在 preBuild 上，任何构建入口（npm script / Android Studio / CI）都绕不过。
var SYNC_GUARD =
  '\n' +
  '// ---- 赤月猎场：web assets 同步守卫（scripts/patch-android.js 注入，勿手改） ----\n' +
  "// 直接用 Android Studio 构建不会执行 `npx cap sync android`，assets/public 会\n" +
  "// 停留在上一次同步时的旧资源，打出来的 APK 看着像修复没生效。\n" +
  "tasks.register('verifyWebAssets') {\n" +
  "    doLast {\n" +
  "        def pub = file('src/main/assets/public')\n" +
  "        def missing = []\n" +
  "        if (!new File(pub, 'vendor/capacitor/core.js').exists()) missing << 'vendor/capacitor/core.js'\n" +
  "        def idx = new File(pub, 'index.html')\n" +
  "        if (idx.exists() && idx.text.indexOf('vendor/capacitor/core.js') < 0)\n" +
  "            missing << 'index.html 未引用 Capacitor'\n" +
  "        if (missing.size() > 0) {\n" +
  "            logger.error('[assets] assets/public 是旧资源，缺：' + missing.join('；'))\n" +
  "            logger.error('[assets] 请先执行  npm run sync:android  再重新构建')\n" +
  "            throw new GradleException('web assets 未同步，拒绝打包旧版本')\n" +
  "        }\n" +
  "        logger.lifecycle('[assets] assets/public 已是最新')\n" +
  "    }\n" +
  "}\n" +
  "tasks.whenTaskAdded { t -> if (t.name == 'preBuild') t.dependsOn 'verifyWebAssets' }\n" +
  '// ---- web assets 同步守卫结束 ----\n';

// 早先版本写的是 'vendor/core.js'，真实路径是 'vendor/capacitor/core.js'。
// 路径错了守卫会永远报「assets 是旧资源」，CI 每次都在 preBuild 失败，
// 而报错信息看起来完全像资源真的过期了 —— 排查会往错的方向走。
const STALE_CORE_REF = "'vendor/core.js'";
const REAL_CORE_REF = "'vendor/capacitor/core.js'";

function patchSyncGuard() {
  const p = path.join(ANDROID, 'app', 'build.gradle');
  if (!fs.existsSync(p)) { console.warn('[patch] 未找到 app/build.gradle，跳过 assets 守卫'); return; }
  let s = read(p);
  if (!s.includes("tasks.register('verifyWebAssets')")) {
    write(p, s.replace(/\s*$/, '') + SYNC_GUARD);
    console.log('[patch] build.gradle: 注入 assets 同步守卫');
    return;
  }
  // 已经注进去也要复核内容：幂等只保证不叠加两份任务，不保证内容还是对的。
  if (s.indexOf(STALE_CORE_REF) >= 0) {
    write(p, s.split(STALE_CORE_REF).join(REAL_CORE_REF));
    console.log('[patch] build.gradle: 修正 assets 守卫的路径（vendor/core.js → vendor/capacitor/core.js）');
    return;
  }
  console.log('[patch] build.gradle: assets 同步守卫已存在');
}

/* ---------- 4. variables.gradle ---------- */
function patchVariables() {
  const p = path.join(ANDROID, 'variables.gradle');
  if (!fs.existsSync(p)) { console.warn('[patch] 未找到 variables.gradle，跳过'); return; }
  let s = read(p);
  let changed = [];
  if (!/minSdkVersion = 26\b/.test(s)) {
    s = s.replace(/minSdkVersion = \d+/, 'minSdkVersion = 26');
    changed.push('minSdkVersion 26');
  }
  if (!/targetSdkVersion = 34\b/.test(s)) {
    s = s.replace(/targetSdkVersion = \d+/, 'targetSdkVersion = 34');
    changed.push('targetSdkVersion 34');
  }
  if (changed.length) { write(p, s); console.log('[patch] variables.gradle: ' + changed.join('、')); }
  else console.log('[patch] variables.gradle: 无变化');
}

/* ---------- 5. MainActivity.java（屏幕常亮） ---------- */
function patchMainActivity() {
  const java = path.join(APP, 'java');
  const files = glob(java, /MainActivity\.java$/);
  if (files.length === 0) { console.warn('[patch] 未找到 MainActivity.java，跳过'); return; }
  const p = files[0];
  let s = read(p);
  if (s.includes('FLAG_KEEP_SCREEN_ON')) {
    console.log('[patch] MainActivity.java: 屏幕常亮已存在');
    return;
  }

  const FLAG_LINES = '        // 屏幕常亮：游戏进行中禁止息屏\n' +
                     '        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);';

  if (s.includes('super.onCreate(savedInstanceState);')) {
    // MainActivity 已重写 onCreate：紧随 super 调用后插入
    s = s.replace(/(super\.onCreate\(savedInstanceState\);)/, '$1\n' + FLAG_LINES);
  } else {
    // Capacitor 默认生成的是空类 `extends BridgeActivity {}`，没有 onCreate。
    // 之前直接 replace 会静默失败（字符串未变却仍上报成功），这里补写整个方法。
    if (!s.includes('import android.os.Bundle;')) {
      s = s.replace(/^import\s+com\.getcapacitor\.BridgeActivity;/m,
                    'import android.os.Bundle;\n$&');
    }
    s = s.replace(/(public\s+class\s+MainActivity\s+extends\s+BridgeActivity)\s*\{\s*\}\s*$/,
      '$1 {\n' +
      '    @Override\n' +
      '    protected void onCreate(Bundle savedInstanceState) {\n' +
      '        super.onCreate(savedInstanceState);\n' +
      FLAG_LINES +
      '\n    }\n}\n');
  }

  if (s.includes('FLAG_KEEP_SCREEN_ON')) {
    write(p, s);
    console.log('[patch] MainActivity.java: 屏幕常亮');
  } else {
    // 结构不符合两种已知形态时明确告警，避免再次静默成功
    console.warn('[patch] MainActivity.java: 结构无法识别，屏幕常亮未注入，请手工检查');
  }
}

function main() {
  ensureDir();
  patchManifest();
  patchStyles();
  patchAppGradle();
  patchSyncGuard();
  patchVariables();
  patchMainActivity();
  console.log('[patch] 安卓工程补丁完成');
}

main();
