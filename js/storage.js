/* ============================================================
 * storage.js —— 统一存档接口
 * 电脑端：localStorage（双击 index.html 直接可用）
 * 安卓端：@capacitor/preferences（原生持久化），并同时镜像到 localStorage
 *
 * 设计要点：
 *  - localStorage 在任何环境（含 Capacitor WebView）都可用，作为同步层；
 *  - 原生环境额外异步写入 Preferences，作为更持久的存储，失败时提示；
 *  - 所有读写先经过内存缓存，保证读档瞬时完成。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var PREFIX = 'crimsonmoon_';
  var cache = {};          // 内存缓存
  var isNative = false;
  var prefs = null;        // Capacitor Preferences 插件实例

  function key(name) { return PREFIX + name; }

  // 同步读（localStorage）
  function lsGet(name) {
    try { return window.localStorage.getItem(key(name)); }
    catch (e) { return null; }
  }
  function lsSet(name, value) {
    try { window.localStorage.setItem(key(name), value); return true; }
    catch (e) { console.error('[Storage] localStorage 写入失败:', e); return false; }
  }
  function lsRemove(name) {
    try { window.localStorage.removeItem(key(name)); return true; }
    catch (e) { return false; }
  }

  Game.Storage = {
    keys: {
      campaign: 'campaign_v1',   // 闯关存档
      endless:  'endless_v1',    // 无限存档
      profile:  'profile_v1',    // 全局档案
      settings: 'settings_v1',   // 设置
      codex:    'codex_v1',      // 图鉴收录记录（lifetime 进度，deleteSave 不动它）
    },

    /** 初始化：检测环境，预载缓存 */
    init: function () {
      isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                    window.Capacitor.isNativePlatform());
      if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) {
        prefs = window.Capacitor.Plugins.Preferences;
      }
      // 预载缓存
      var names = ['campaign_v1', 'endless_v1', 'profile_v1', 'settings_v1', 'codex_v1'];
      for (var i = 0; i < names.length; i++) {
        var v = lsGet(names[i]);
        if (v !== null) cache[names[i]] = v;
      }
      // 原生环境异步拉取 Preferences 覆盖缓存
      if (prefs) {
        var that = this;
        for (var j = 0; j < names.length; j++) {
          (function (n) {
            prefs.get({ key: key(n) }).then(function (r) {
              if (r && r.value !== null && r.value !== undefined) cache[n] = r.value;
            }).catch(function (e) {
              console.warn('[Storage] Preferences.get 失败:', n, e);
            });
          })(names[j]);
        }
      }
      console.log('[Storage] 初始化完成 isNative=' + isNative);
      return isNative;
    },

    /** 读字符串 */
    get: function (name) {
      if (name in cache) return cache[name];
      return lsGet(name);
    },

    /** 写字符串；onDone(err) 在原生异步落盘后回调 */
    set: function (name, value, onDone) {
      cache[name] = value;
      var ok = lsSet(name, value);
      if (!ok) {
        console.error('[Storage] 存档失败（localStorage）:', name);
        if (onDone) onDone(new Error('localStorage 写入失败'));
        return false;
      }
      if (prefs) {
        prefs.set({ key: key(name), value: value }).then(function () {
          if (onDone) onDone(null);
        }).catch(function (e) {
          console.error('[Storage] 存档失败（Preferences）:', name, e);
          if (onDone) onDone(e);
        });
      } else if (onDone) {
        onDone(null);
      }
      return true;
    },

    remove: function (name) {
      delete cache[name];
      lsRemove(name);
      if (prefs) {
        prefs.remove({ key: key(name) }).catch(function (e) {
          console.warn('[Storage] Preferences.remove 失败:', e);
        });
      }
    },

    /** JSON 便捷读写 */
    getJSON: function (name) {
      var s = this.get(name);
      if (!s) return null;
      try { return JSON.parse(s); }
      catch (e) { console.error('[Storage] JSON 解析失败:', name, e); return null; }
    },
    setJSON: function (name, obj, onDone) {
      var s;
      try { s = JSON.stringify(obj); }
      catch (e) { console.error('[Storage] JSON 序列化失败:', name, e); if (onDone) onDone(e); return false; }
      return this.set(name, s, onDone);
    },

    isNative: function () { return isNative; },
  };
})();
