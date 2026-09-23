/* ============================================================
 * scripts/build-apk.js —— 一键构建 debug APK
 * 流程：build:web → cap add android（如需） → cap sync android
 *      → patch-android → gradlew assembleDebug
 * 本地运行需已安装 Android SDK 与 JDK 21（或直接用 Android Studio）。
 * JDK 21 是硬性要求：Capacitor 7 的 android 库模块声明了 VERSION_21 源码级别。
 * 也可走 GitHub Actions 云构建（推荐，见 BUILD_ANDROID.md）。
 * ============================================================ */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function run(cmd, cwd) {
  console.log('> ' + cmd);
  execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });
}

function main() {
  // 1. 拷贝 web 资源
  run('node scripts/build-web.js', ROOT);

  // 2. 添加/同步 android 平台
  const androidDir = path.join(ROOT, 'android');
  if (!fs.existsSync(path.join(androidDir, 'app'))) {
    run('npx cap add android', ROOT);
  }
  run('npx cap sync android', ROOT);

  // 3. 打补丁（横屏/全屏/权限/版本/常亮）
  run('node scripts/patch-android.js', ROOT);

  // 4. 构建 debug APK
  const isWin = process.platform === 'win32';
  const gradle = isWin ? 'gradlew.bat' : './gradlew';
  run(gradle + ' assembleDebug', androidDir);

  const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  console.log('\n================ 构建完成 ================');
  console.log('APK 路径: ' + apk);
  console.log('将该文件拷到安卓手机安装即可（需允许安装未知来源应用）');
}

main();
