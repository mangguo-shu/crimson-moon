# 《赤月猎场》安卓打包与安装说明

本游戏采用 **HTML5 Canvas + 原生 JavaScript**，由 **Capacitor** 包裹为安卓原生应用。
开发阶段直接在电脑浏览器双击 `index.html` 调试；交付阶段打包成 APK 安装到安卓手机。

---

## 0. 目录结构速览

```
crimson-moon/
├── index.html                # 游戏入口（浏览器双击即可玩）
├── css/style.css             # 样式
├── js/                       # 游戏全部逻辑（11 个模块，按 index.html 顺序加载）
├── www/                      # build:web 生成（打包用，自动生成勿手改）
├── capacitor.config.json     # Capacitor 配置
├── package.json              # 依赖与脚本
├── scripts/                  # 构建/补丁脚本
├── test/smoke.js             # 无头冒烟测试（node test/smoke.js）
├── android/                  # npx cap add android 生成（已 gitignore）
└── .github/workflows/build-apk.yml  # 云构建
```

---

## 1. 路线 A：GitHub Actions 云构建（推荐，无需装 Android Studio）

你只需要一个浏览器和 GitHub 账号，不需要本地安装 Android SDK / Android Studio。

### 1.1 推送到 GitHub

本仓库地址：<https://github.com/mangguo-shu/crimson-moon>

首次推送：

```bash
cd crimson-moon
git init
git add .
git commit -m "赤月猎场 MVP"
git branch -M main
git remote add origin git@github.com:mangguo-shu/crimson-moon.git
git push -u origin main
```

> 用 HTTPS 克隆的话地址是 `https://github.com/mangguo-shu/crimson-moon.git`。
> 换机器/换仓库时用 `git remote set-url origin <新地址>` 更新。

推送后，GitHub 会自动运行 `.github/workflows/build-apk.yml` 开始构建。

### 1.2 下载 APK

1. 打开仓库页面 → **Actions** 标签。
2. 找到正在运行/已完成的 `Build Android APK` 工作流。
3. 进入后拉到页面底部 **Artifacts**，下载 `crimson-moon-debug-apk`（一个 zip）。
4. 解压得到 `app-debug.apk`。

### 1.3 手动触发 + 自动发 Release

- 仓库页面 → **Actions** → **Build Android APK** → **Run workflow** 手动触发。
- 手动触发时，工作流会额外调用 `softprops/action-gh-release` 创建一个 Release 并直接附加 APK，
  在仓库 **Releases** 页面即可直接下载 `.apk`（无需解压）。

### 1.4 构建产物说明

云构建产出的 APK 是 **debug 签名**（用 debug keystore 签名），可以直接安装测试，
但不能上架 Google Play。正式发布需 release 签名，见本文第 4 节。

---

## 2. 路线 B：本地 Android Studio 构建

### 2.1 环境要求

| 软件 | 版本要求 |
|------|----------|
| Node.js | ≥ 18（推荐 20+） |
| JDK | 17 |
| Android SDK | API 34 及以上（含 Build-Tools） |
| Android Studio | 最新稳定版（自带 SDK 与 JDK，最省心） |

### 2.2 步骤

```bash
# 1. 安装依赖
npm install

# 2. 拷贝 web 资源到 www
npm run build:web

# 3. 添加安卓平台（首次）
npx cap add android

# 4. 同步（以后每次改完 web 资源都要跑）
npm run sync:android

# 5. 打补丁（横屏/全屏/权限/版本/常亮，幂等可重复执行）
node scripts/patch-android.js

# 6. 用 Android Studio 打开 android/ 目录
npx cap open android
```

在 Android Studio 中点击 **Build → Build APK(s)**，或直接运行到真机。
也可以用命令行一键构建：

```bash
npm run build:apk
# 等价于：build:web → cap add/sync → patch → gradlew assembleDebug
# 产物在 android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 3. 安装到安卓手机

1. 把 `app-debug.apk` 拷到手机（微信/QQ/数据线/网盘均可）。
2. 手机上点击该文件，系统会提示「禁止安装未知来源应用」。
   - 首次安装时，按提示进入设置，**允许该来源安装未知应用**。
   - 不同品牌路径略有差异：`设置 → 安全 → 安装未知应用` 或 `设置 → 应用 → 特殊访问权限`。
3. 安装完成后打开「赤月猎场」即可游玩（首次启动会请求横屏，游戏强制横屏全屏）。

---

## 4. 生成 release 签名并打包正式版

debug 签名仅供测试。正式发布需自己的 keystore：

```bash
# 生成 keystore（记住 storePassword / keyPassword / alias）
keytool -genkeypair -v \
  -keystore crimsonmoon.keystore \
  -alias crimsonmoon \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=CrimsonMoon,O=YourCompany,C=CN"
```

在 `android/app/build.gradle` 的 `android {}` 内追加（`crimsonmoon.keystore` 放到 `android/app/` 下）：

```gradle
signingConfigs {
    release {
        storeFile file('crimsonmoon.keystore')
        storePassword '你的store密码'
        keyAlias 'crimsonmoon'
        keyPassword '你的key密码'
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

然后：

```bash
cd android
./gradlew assembleRelease        # 或 gradlew.bat assembleRelease（Windows）
# 产物在 android/app/build/outputs/apk/release/app-release.apk
```

> 安全提示：不要将 keystore 和密码提交到公开仓库。正式上架请改用环境变量或 CI Secrets 注入。

---

## 5. 常见错误排查

### 5.1 Gradle 版本 / 下载慢
- 现象：`Could not download gradle-*.zip` 或长时间卡住。
- 解决：国内网络建议在 `android/gradle/wrapper/gradle-wrapper.properties` 中把
  `distributionUrl` 指向镜像（如腾讯/阿里镜像），或配置全局代理。

### 5.2 JDK 版本不匹配
- 现象：`Unsupported class file major version 6x` 或 `Could not determine java version`。
- 解决：确认使用 **JDK 17**。`java -version` 查看；Android Studio 可在
  `File → Project Structure → SDK Location → Gradle Settings` 里指定 JDK 17。

### 5.3 SDK 路径 / 未安装平台
- 现象：`SDK location not found` 或 `Failed to find target with hash string 'android-34'`。
- 解决：在 `android/local.properties` 指定 `sdk.dir`（Windows 形如 `C\:\\Users\\你\\AppData\\Local\\Android\\Sdk`），
  或用 Android Studio 打开项目，它会自动提示安装缺失的 SDK 组件（SDK Platform 34、Build-Tools）。

### 5.4 签名失败
- 现象：`Keystore file not set for signing config release` 或 `keystore was tampered with`。
- 解决：debug 构建无需手动签名（会自动用 debug keystore）。release 构建请按第 4 节配置
  `signingConfigs.release`；密码错误时确认 alias / 大小写 / 前后空格。

### 5.5 Capacitor 同步失败
- 现象：`Unable to find web asset directory` 或 `platform android not found`。
- 解决：
  - 先 `npm install` 安装依赖。
  - 先 `npm run build:web` 生成 `www/`。
  - 首次需 `npx cap add android`，之后 `npx cap sync android`。

### 5.6 云构建 APK 装不上
- 现象：手机提示「解析错误」或「应用未安装」。
- 解决：确认手机 Android ≥ 8.0（API 26）；确认下载的是解压后的 `.apk` 而不是 `.zip`；
  确认已允许安装未知来源。

---

## 6. 关键配置对照（技术说明）

- **锁横屏**：`capacitor.config.json` 的 `android.screenOrientation` 为说明性字段，真正的锁定由
  ① 运行时代码 `nativeBridge.js` 调用 `ScreenOrientation.lock({ orientation: 'landscape' })`，
  ② `patch-android.js` 写入 `AndroidManifest.xml` 的 `android:screenOrientation="landscape"` 双保险完成。
- **全屏沉浸**：`StatusBar.hide()` + `styles.xml` 中的 `AppTheme.NoActionBar.Fullscreen`（`windowFullscreen`）。
- **不申请网络权限**：`patch-android.js` 会移除 Capacitor 默认生成的 `INTERNET` 权限（纯单机游戏）。
- **屏幕常亮**：`patch-android.js` 在 `MainActivity.java` 的 `onCreate` 注入
  `getWindow().addFlags(FLAG_KEEP_SCREEN_ON)`。
- **appId**：`capacitor.config.json` 里 `com.yourname.crimsonmoon` 的 `yourname` 是占位符，
  发布前请改为你自己的反向域名（如 `com.you.crimsonmoon`）。
