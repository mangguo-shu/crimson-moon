/* ============================================================
 * scripts/patch-android.js —— 对 Capacitor 生成的安卓工程打补丁
 * 需在 `npx cap sync android` 之后运行，实现以下需求：
 *  1. AndroidManifest.xml：锁定横屏、硬件加速、移除 INTERNET 权限、全屏主题
 *  2. styles.xml：追加全屏主题样式（适配挖孔屏）
 *  3. build.gradle：versionName 1.0.0（versionCode 已在生成时为 1）
 *  4. variables.gradle：minSdkVersion 26 / targetSdkVersion 34
 *  5. MainActivity.java：屏幕常亮（FLAG_KEEP_SCREEN_ON）
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
  patchVariables();
  patchMainActivity();
  console.log('[patch] 安卓工程补丁完成');
}

main();
