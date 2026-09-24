/* ============================================================
 * game.js —— 游戏主控制器
 * 主循环（requestAnimationFrame + deltaTime）、状态机、存档编排、
 * 相机、设置、调试功能。项目入口 Game.init()。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;
  var S = Game.Systems;

  Game.debugGod = false;
  Game.state = null;          // 当前运行状态
  Game.settings = { sound: true, vibrate: true, quality: 'high' };

  var G = Game.Game = {};

  /* ---------------- 入口 ---------------- */
  Game.init = function () {
    var canvas = document.getElementById('game');

    // 1. 存储（检测原生）
    Game.Storage.init();
    // 2. 设置
    G._loadSettings();
    // 3. 原生桥（横屏/全屏/返回键/切后台）
    Game.Native.init();
    // 4. 输入
    Game.Input.init(canvas);
    // 5. 渲染
    Game.Renderer.init(canvas);
    Game.Renderer.setQuality(Game.settings.quality);
    // 6. UI
    Game.UI.init();

    // 原生回调
    var self = this;
    Game.Native.onPause = function () {
      if (Game.state && Game.state.screen === 'PLAYING') {
        console.log('[Game] 切后台 → 自动暂停并存档');
        G.pause();
        G.saveGame();
      }
    };
    Game.Native.onResume = function () {
      console.log('[Game] 切回前台');
      if (Game.state && Game.state.screen === 'PAUSED') {
        Game.UI.showScreen('PAUSED');
        Game.UI.renderPause();
      }
    };
    Game.Native.onBack = function () { return G._handleBack(); };

    // 输入动作
    Game.Input.actions.pause = function () { G.pause(); };
    Game.Input.actions.save = function () { G.saveGame(); };
    Game.Input.actions.load = function () { G.continueCampaign(); };
    Game.Input.actions.debug = function () { G.toggleDebug(); };

    // 首次交互解锁音频
    var unlock = function () { Game.Audio.unlock(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // 主菜单
    G.toMenu();
    console.log('[Game] 初始化完成，进入主菜单');

    // 启动主循环
    G._last = 0;
    G._fpsEma = 60;
    G._lowFpsTime = 0;
    G._frame = 0;
    window.requestAnimationFrame(G._loop);
  };

  /* ---------------- 设置 ---------------- */
  G._loadSettings = function () {
    var s = Game.Storage.getJSON('settings_v1');
    if (s) Game.settings = s;
    G._applySettings();
  };
  G._applySettings = function () {
    Game.Audio.setEnabled(Game.settings.sound);
    Game.Native.haptics = Game.settings.vibrate;
    if (Game.Renderer.canvas) Game.Renderer.setQuality(Game.settings.quality);
  };
  G._saveSettings = function () {
    Game.Storage.setJSON('settings_v1', Game.settings);
  };

  /* ---------------- 状态机 ---------------- */
  G.newGame = function () {
    Game.Audio.unlock();
    Game.UI.renderCharSelect();
    Game.UI.showScreen('MENU');
  };

  G.startCampaign = function (charId) {
    var seed = Math.floor(Math.random() * 0xffffffff);
    console.log('[Game] 开始闯关 char=' + charId + ' seed=' + seed);
    Game.state = S.createState('campaign', charId, seed);
    S.startWave(Game.state, 1);
    Game.Renderer.updateCamera(Game.state.player);
    Game.UI.showScreen('PLAYING');
    Game.UI.updateHUD(Game.state);
  };

  G.continueCampaign = function () {
    var obj = Game.Storage.getJSON('campaign_v1');
    if (!obj || !obj.player) {
      console.warn('[Game] 无有效闯关存档');
      Game.UI.showSaveToast(new Error('无存档'));
      return;
    }
    if (obj.version !== 1) {
      console.warn('[Game] 存档版本不匹配 v=' + obj.version);
    }
    console.log('[Game] 继续闯关 wave=' + obj.wave + ' seed=' + obj.seed);
    Game.state = S.deserialize(obj);
    Game.Renderer.updateCamera(Game.state.player);
    if (Game.state.wave === 0) S.startWave(Game.state, 1);
    Game.UI.showScreen('PLAYING');
    Game.UI.updateHUD(Game.state);
  };

  G.toMenu = function () {
    if (Game.state && ['PLAYING', 'PAUSED', 'LEVEL_UP', 'SHOP'].indexOf(Game.state.screen) >= 0) {
      G.saveGame();
    }
    Game.state = null;
    var hasSave = !!Game.Storage.getJSON('campaign_v1');
    Game.UI.renderMenu(hasSave);
    Game.UI.showScreen('MENU');
    Game.Native.allowSleep();
  };

  G.pause = function () {
    if (!Game.state || Game.state.screen !== 'PLAYING') return;
    Game.state.screen = 'PAUSED';
    Game.UI.renderPause();
    Game.UI.showScreen('PAUSED');
    console.log('[Game] 暂停');
  };

  G.resume = function () {
    if (!Game.state || Game.state.screen !== 'PAUSED') return;
    Game.state.screen = 'PLAYING';
    Game.UI.showScreen('PLAYING');
    console.log('[Game] 继续');
  };

  G.restartRun = function () {
    var cid = Game.state ? Game.state.player.id : 'swordsman';
    G.startCampaign(cid);
  };

  G.deleteSave = function () {
    Game.Storage.remove('campaign_v1');
    Game.UI.showSaveToast();
    G.toMenu();
    console.log('[Game] 删除存档');
  };

  /* ---------------- 升级 / 商店 ---------------- */
  G.pickLevelUp = function (idx) {
    if (!Game.state || Game.state.screen !== 'LEVEL_UP') return;
    var choice = Game.state.levelUpChoices[idx];
    S.applyChoice(Game.state, choice);
    // Boss 战利品不占升级计数，别把它减成负数
    if (Game.state.levelUpsPending > 0) Game.state.levelUpsPending--;
    if (Game.state.levelUpsPending > 0) {
      // 连续升级：再roll
      S.rollLevelUpChoices(Game.state);
      Game.UI.renderLevelUp(Game.state.levelUpChoices);
    } else {
      Game.state.screen = 'PLAYING';
      Game.UI.showScreen('PLAYING');
      G.saveGame(); // 升级选择完成自动存档
    }
  };

  G.buyShop = function (idx) {
    if (!Game.state || Game.state.screen !== 'SHOP') return;
    if (S.buyShopItem(Game.state, idx)) Game.UI.renderShop(Game.state);
  };
  G.lockShop = function (idx) {
    if (!Game.state) return;
    S.toggleLock(Game.state, idx);
    Game.UI.renderShop(Game.state);
  };
  G.refreshShop = function () {
    if (!Game.state) return;
    if (S.refreshShop(Game.state)) Game.UI.renderShop(Game.state);
  };
  G.nextWave = function () {
    if (!Game.state) return;
    var next = Game.state.wave + 1;
    if (Game.state.mode === 'campaign' && next > 20) {
      G._victory();
      return;
    }
    S.startWave(Game.state, next);
    Game.UI.showScreen('PLAYING');
    G.saveGame(); // 商店关闭（新波开始）自动存档
  };

  /* ---------------- 设置面板 ---------------- */
  G.openSettings = function () {
    Game.UI.renderSettings(Game.settings);
    Game.UI.showScreen('SETTINGS');
  };
  G.closeSettings = function () {
    G._saveSettings();
    if (Game.state) {
      if (Game.state.screen === 'PAUSED') { Game.UI.showScreen('PAUSED'); Game.UI.renderPause(); }
      else if (Game.state.screen === 'PLAYING') Game.UI.showScreen('PLAYING');
      else G.toMenu();
    } else {
      G.toMenu();
    }
  };
  G.toggleSound = function () { Game.settings.sound = !Game.settings.sound; G._applySettings(); G.openSettings(); };
  G.toggleVibrate = function () { Game.settings.vibrate = !Game.settings.vibrate; G._applySettings(); G.openSettings(); };
  G.setQuality = function (q) { Game.settings.quality = q; G._applySettings(); G.openSettings(); };

  /* ---------------- 调试 ---------------- */
  G.toggleDebug = function () {
    var d = document.getElementById('debug');
    d.classList.toggle('hidden');
    console.log('[Debug] 面板', d.classList.contains('hidden') ? '关闭' : '打开');
  };
  G.debugToggleGod = function () { Game.debugGod = !Game.debugGod; console.log('[Debug] 无敌=' + Game.debugGod); };
  G.debugAddMaterial = function () { if (Game.state) Game.state.player.materials += 100; };
  G.debugSkipWave = function () {
    if (!Game.state) return;
    console.log('[Debug] 跳波');
    G._onWaveEnd();
  };
  G.debugLevelUp = function () {
    if (!Game.state) return;
    Game.state.levelUpsPending++;
    G._triggerLevelUp();
  };

  /* ---------------- 存档 ---------------- */
  G.saveGame = function () {
    if (!Game.state || !Game.state.player) return false;
    if (Game.state.player && !Game.state.player.alive) return false;
    var obj = S.serialize(Game.state);
    var ok = Game.Storage.setJSON('campaign_v1', obj, function (err) {
      Game.UI.showSaveToast(err || null);
    });
    console.log('[Save] 存档完成 wave=' + obj.wave + ' time=' + Game.util.fmtTime(obj.elapsed));
    return ok;
  };

  /* ---------------- 返回键处理 ---------------- */
  G._handleBack = function () {
    if (!Game.state) return { handled: false }; // 主菜单：交由系统退出
    switch (Game.state.screen) {
      case 'PLAYING': G.pause(); return { handled: true };
      case 'PAUSED': G._confirmExit(); return { handled: true };
      case 'LEVEL_UP':
      case 'SHOP': return { handled: true };
      case 'GAME_OVER':
      case 'VICTORY': G.toMenu(); return { handled: true };
      default: return { handled: true };
    }
  };

  // 简单退出确认（自定义覆盖层，避免原生 confirm 在 WebView 中体验差）
  G._confirmExit = function () {
    var ov = document.getElementById('confirm-exit');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'confirm-exit';
      ov.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,0.8);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;';
      document.body.appendChild(ov);
    }
    ov.innerHTML =
      '<h2 style="color:#fff">确认退出游戏？</h2>' +
      '<div style="margin-top:14px">' +
      '<button class="btn primary" onclick="Game.Game.toMenu()">确认退出</button>' +
      '<button class="btn" onclick="Game.Game._cancelExit()">取消</button></div>';
    ov.style.display = 'flex';
  };
  G._cancelExit = function () {
    var ov = document.getElementById('confirm-exit');
    if (ov) ov.style.display = 'none';
    Game.UI.showScreen('PAUSED');
    Game.UI.renderPause();
  };

  /* ---------------- 波次结束 / 胜负 ---------------- */
  G._onWaveEnd = function () {
    var state = Game.state;
    console.log('[Game] 波次 ' + state.wave + ' 结束');
    if (state.mode === 'campaign' && state.wave >= 20) {
      G._victory();
      return;
    }
    // 每轮结束血量回满：进商店前补满，让压力落在波次内而不是累计掉血
    var p = state.player;
    if (p.alive && p.stats.hp < p.stats.maxHp) {
      p.stats.hp = p.stats.maxHp;
      if (Game.FX) Game.FX.heal(p.x, p.y);
      if (Game.Audio) Game.Audio.heal();
    }
    G.saveGame(); // 波次结束自动存档
    S.openShop(state);
    Game.UI.renderShop(state);
    Game.UI.showScreen('SHOP');
  };

  G._victory = function () {
    var state = Game.state;
    state.screen = 'VICTORY'; // 停止主循环更新，冻结 elapsed
    Game.Storage.remove('campaign_v1'); // 通关后清除进行中的存档
    Game.UI.renderVictory(state);
    Game.UI.showScreen('VICTORY');
    Game.Native.allowSleep();
    console.log('[Game] 通关！');
  };

  G._gameOver = function () {
    var state = Game.state;
    state.screen = 'GAME_OVER'; // 停止主循环更新，冻结 elapsed
    Game.Storage.remove('campaign_v1'); // 死亡后清除进行中的存档
    Game.UI.renderGameOver(state);
    Game.UI.showScreen('GAME_OVER');
    Game.Native.allowSleep();
    if (Game.FX) Game.FX.flash('#ff0000', 0.5);
    console.log('[Game] 游戏结束 wave=' + state.wave);
  };

  /* ---------------- 升级触发 ---------------- */
  G._triggerLevelUp = function () {
    var state = Game.state;
    if (!state || state.screen !== 'PLAYING') return;
    S.rollLevelUpChoices(state);
    state.screen = 'LEVEL_UP';
    Game.UI.renderLevelUp(state.levelUpChoices);
    Game.UI.showScreen('LEVEL_UP');
    if (Game.FX) {
      Game.FX.flash('#ffcf5e', 0.25);
      Game.FX.levelUp(state.player.x, state.player.y); // 金色灵光环
    }
    console.log('[Game] 升级 Lv.' + state.player.level);
  };

  /** Boss 阵亡奖励：强度高于平时的三选一，有概率给 Boss 专属武器。
   *  复用 LEVEL_UP 面板与 pickLevelUp，故不占 levelUpsPending 计数。 */
  G._triggerBossReward = function () {
    var state = Game.state;
    if (!state || state.screen !== 'PLAYING') return;
    state.bossRewardPending = false;
    S.bossRewardChoices(state);
    state.screen = 'LEVEL_UP';
    Game.UI.renderLevelUp(state.levelUpChoices, '🔥 赤月年兽已阵亡！选择一份战利品');
    Game.UI.showScreen('LEVEL_UP');
    if (Game.FX) {
      Game.FX.flash('#ff7a5c', 0.5);
      Game.FX.shake(10);
      Game.FX.bossCast(state.player.x, state.player.y);
    }
    if (Game.Audio) Game.Audio.boss();
    console.log('[Game] Boss 战利品三选一');
  };

  /* ---------------- 主循环 ---------------- */
  G._loop = function (ts) {
    window.requestAnimationFrame(G._loop);
    if (!G._last) G._last = ts;
    var dt = (ts - G._last) / 1000;
    G._last = ts;
    if (dt > 0.05) dt = 0.05; // 防止切后台后大步长
    if (dt <= 0) return;

    // FPS 统计（EMA）
    var instFps = 1 / dt;
    G._fpsEma = G._fpsEma * 0.95 + instFps * 0.05;
    G._autoQuality(dt);

    var state = Game.state;
    if (state) {
      var playing = state.screen === 'PLAYING';
      if (playing) {
        G._update(state, dt);

        // 升级触发
        if (state.levelUpsPending > 0 && state.screen === 'PLAYING') {
          G._triggerLevelUp();
        }
        // 玩家死亡
        if (!state.player.alive) {
          G._gameOver();
        }
      }
      // 渲染（暂停/面板时世界冻结：dt 传 0 冻结粒子）
      Game.Renderer.render(state, playing ? dt : 0);
      Game.UI.updateHUD(state);
    } else {
      // 无运行状态：仅清屏渲染（菜单背景）
      Game.Renderer.render(null, dt);
    }

    // 摇杆平滑归位
    Game.Input.update(dt);

    // 调试面板刷新（每 30 帧）
    G._frame++;
    if (G._frame % 30 === 0 && state) {
      Game.UI.updateDebug(state, Math.round(G._fpsEma));
    }
  };

  G._update = function (state, dt) {
    // Boss 刚阵亡：先弹奖励，再让波次结算进商店
    if (state.bossRewardPending && state.screen === 'PLAYING') {
      G._triggerBossReward();
      return;
    }
    // 波次推进（含刷新敌人、结束判定）
    var ended = S.updateWave(state, dt);
    if (ended === 'ended') { G._onWaveEnd(); return; }

    S.updatePlayer(state, dt);
    S.updateEnemies(state, dt);
    S.updateProjectiles(state, dt);
    S.updatePickups(state, dt);

    // 相机跟随
    Game.Renderer.updateCamera(state.player);
  };

  /* ---------------- 自动降画质 ---------------- */
  G._autoQuality = function (dt) {
    if (G._fpsEma < 45) {
      G._lowFpsTime += dt;
      if (G._lowFpsTime >= 3) {
        G._lowFpsTime = 0;
        var order = ['high', 'mid', 'low'];
        var i = order.indexOf(Game.settings.quality);
        if (i < order.length - 1) {
          Game.settings.quality = order[i + 1];
          G._applySettings();
          console.warn('[Game] 帧率过低，自动降画质 → ' + Game.settings.quality);
        }
      }
    } else {
      G._lowFpsTime = 0;
    }
  };

  // 供 input/renderer 使用的时间（无运行状态时也渲染）
})();

/* ---------------- 自动启动 ---------------- */
// 脚本位于 body 末尾，DOM 已就绪；若仍在解析则等 DOMContentLoaded。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.Game.init(); });
  } else {
    window.Game.init();
  }
}
