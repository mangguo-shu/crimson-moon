/* ============================================================
 * nativeBridge.js —— 安卓原生系统集成
 * 在 Capacitor 原生环境调用插件；桌面浏览器优雅降级为 no-op。
 *
 * 职责：
 *  - 锁定横屏、隐藏状态栏、沉浸全屏
 *  - 切后台自动暂停存档 / 切回前台恢复
 *  - 安卓返回键：游戏中暂停 → 暂停界面退出确认 → 主菜单退出
 *  - 震动反馈（受伤/暴击/Boss），可开关
 *  - 屏幕常亮（keep awake）
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  Game.Native = {
    isNative: false,
    platform: 'web',
    haptics: true,        // 震动开关（由设置控制）
    keepAwakeOn: true,
    missingPlugins: [],   // init 时点名缺失的插件名（调试面板用）

    // 由游戏逻辑注册的回调
    onPause: null,
    onResume: null,
    onBack: null,         // 返回键处理，需返回 {handled:boolean}

    /** 初始化原生集成 */
    init: function () {
      var C = window.Capacitor;
      this.isNative = !!(C && C.isNativePlatform && C.isNativePlatform());
      this.platform = this.isNative ? (C.getPlatform ? C.getPlatform() : 'native') : 'web';

      // 致命但静默的失败模式：跑在 Capacitor 壳里、JS 端却没加载进来。
      // 此时 isNative 为 false，下面会走浏览器降级——返回键、锁横屏、切后台暂停
      // 全部消失，而玩家看到的只是「按返回直接退 App」，毫无报错。
      // 2026-09-26 小米9 真机就是这个状态：vendor/capacitor/*.js 从来没被引用过。
      if (!C && /Capacitor/i.test(navigator.userAgent || '')) {
        console.error('[Native] 严重：跑在 Capacitor 壳里但 window.Capacitor 不存在！' +
          '原生能力（返回键/锁横屏/震动/切后台暂停）全部失效。' +
          '检查 index.html 是否加载了 vendor/capacitor/core.js 及其余 5 个插件包。');
      }

      if (!this.isNative) {
        // 桌面端：监听窗口失焦，自动暂停（体验与移动端切后台一致）
        var self = this;
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) {
            if (self.onPause) self.onPause();
          }
        });
        window.addEventListener('blur', function () {
          if (self.onPause && !document.hidden) self.onPause();
        });
        console.log('[Native] 非原生环境，使用浏览器降级');
        return;
      }

      var P = C.Plugins;
      var self = this;

      // 逐个点名缺失的插件，别让整个原生层因为少一个包就静默变哑巴
      var missing = [];
      ['App', 'ScreenOrientation', 'StatusBar', 'Haptics', 'KeepAwake'].forEach(function (n) {
        if (!P || !P[n]) missing.push(n);
      });
      this.missingPlugins = missing;
      if (missing.length) {
        console.warn('[Native] 以下插件未加载，相关能力失效：' + missing.join(', ') +
          '（npm run vendor:cap 重新生成 vendor/capacitor/）');
      }

      // 1. 锁定横屏
      if (P && P.ScreenOrientation) {
        P.ScreenOrientation.lock({ orientation: 'landscape' }).catch(function (e) {
          console.warn('[Native] 锁定横屏失败', e);
        });
      }
      // 2. 隐藏状态栏，全屏沉浸
      if (P && P.StatusBar) {
        P.StatusBar.hide().catch(function () {});
      }
      // 3. 屏幕常亮。KeepAwake 不在依赖里，缺失时这里会被跳过——
      // 手机上玩久了屏幕会自己熄，是缺包不是逻辑 bug。
      if (P && P.KeepAwake && this.keepAwakeOn) {
        P.KeepAwake.keepAwake().catch(function (e) {
          console.warn('[Native] keepAwake 失败', e);
        });
      }
      // 4. 切后台 / 回前台
      if (P && P.App) {
        P.App.addListener('pause', function () {
          console.log('[Native] app pause → 自动暂停存档');
          if (self.onPause) self.onPause();
        });
        P.App.addListener('resume', function () {
          console.log('[Native] app resume → 恢复并弹暂停确认');
          if (self.onResume) self.onResume();
        });
        // 5. 安卓返回键。必须同步返回 {handled:true}，异步会让系统认为没处理掉、
        // 直接退 App。
        P.App.addListener('backButton', function () {
          if (self.onBack) return self.onBack();
          return { handled: false };
        });
      } else {
        console.warn('[Native] @capacitor/app 未加载，返回键与切后台监听不会注册');
      }
      console.log('[Native] 原生初始化完成 platform=' + this.platform +
        (missing.length ? ' 缺失=' + missing.join(',') : ''));
    },

    /** 震动反馈。pattern 可为毫秒数或数组；仅原生 + 开关开启时生效 */
    vibrate: function (ms) {
      if (!this.isNative || !this.haptics) return;
      var C = window.Capacitor;
      var P = C && C.Plugins;
      if (P && P.Haptics) {
        try {
          P.Haptics.vibrate({ duration: Math.max(10, ms | 0) }).catch(function () {});
        } catch (e) {}
      }
    },

    /** 关闭屏幕常亮（退出到主菜单/结算时可释放） */
    allowSleep: function () {
      var C = window.Capacitor;
      var P = C && C.Plugins;
      if (P && P.KeepAwake) {
        P.KeepAwake.allowSleep().catch(function () {});
      }
    },
  };
})();
