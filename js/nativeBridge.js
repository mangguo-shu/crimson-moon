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

    // 由游戏逻辑注册的回调
    onPause: null,
    onResume: null,
    onBack: null,         // 返回键处理，需返回 {handled:boolean}

    /** 初始化原生集成 */
    init: function () {
      var C = window.Capacitor;
      this.isNative = !!(C && C.isNativePlatform && C.isNativePlatform());
      this.platform = this.isNative ? (C.getPlatform ? C.getPlatform() : 'native') : 'web';

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
      // 3. 屏幕常亮
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
        // 5. 安卓返回键
        P.App.addListener('backButton', function () {
          if (self.onBack) return self.onBack();
          return { handled: false };
        });
      }
      console.log('[Native] 原生初始化完成 platform=' + this.platform);
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
