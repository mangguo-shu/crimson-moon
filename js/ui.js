/* ============================================================
 * ui.js —— DOM 界面层
 * 菜单 / 角色选择 / HUD / 升级三选一 / 商店 / 暂停 / 结算 / 设置 / 调试面板
 * 通过 Game.Game.* 方法回调游戏控制器（game.js 实现），避免循环依赖。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var el = {};   // 缓存 DOM 引用

  Game.UI = {
    /* ---------------- 初始化 ---------------- */
    init: function () {
      el.hud = document.getElementById('hud');
      el.overlay = document.getElementById('overlay');
      el.menu = document.getElementById('menu');
      el.levelup = document.getElementById('levelup');
      el.shop = document.getElementById('shop');
      el.pause = document.getElementById('pause');
      el.gameover = document.getElementById('gameover');
      el.victory = document.getElementById('victory');
      el.settings = document.getElementById('settings');
      el.records = document.getElementById('records');
      el.stats = document.getElementById('stats');
      el.debug = document.getElementById('debug');
      el.btnPauseTouch = document.getElementById('btn-pause-touch');
      el.saveToast = document.getElementById('save-toast');

      el.hpFill = document.getElementById('hp-fill');
      el.hpText = document.getElementById('hp-text');
      el.shieldWrap = document.getElementById('shield-wrap');
      el.shieldFill = document.getElementById('shield-fill');
      el.xpFill = document.getElementById('xp-fill');
      el.hudWave = document.getElementById('hud-wave');
      el.hudTimer = document.getElementById('hud-timer');
      el.hudMaterial = document.getElementById('hud-material');
      el.hudLevel = document.getElementById('hud-level');
      el.weaponSlots = document.getElementById('weapon-slots');

      this._buildDebugPanel();
      this._bindPauseTouch();
      console.log('[UI] 初始化完成');
    },

    /* ---------------- 面板显隐 ---------------- */
    _hideAll: function () {
      var ids = ['menu', 'levelup', 'shop', 'pause', 'gameover', 'victory', 'settings', 'records', 'stats', 'debug'];
      for (var i = 0; i < ids.length; i++) el[ids[i]].classList.add('hidden');
      el.overlay.classList.add('hidden');
      el.hud.classList.add('hidden');
      el.btnPauseTouch.classList.add('hidden');
    },

    showScreen: function (name) {
      Game.uiScreen = name;   // 供 game.js 判断「当前显示哪个面板」（如纪录榜无运行状态）
      this._hideAll();
      switch (name) {
        case 'MENU': el.menu.classList.remove('hidden'); break;
        case 'LEVEL_UP': el.levelup.classList.remove('hidden'); el.hud.classList.remove('hidden'); break;
        case 'SHOP': el.shop.classList.remove('hidden'); el.hud.classList.remove('hidden'); break;
        case 'PAUSED': el.pause.classList.remove('hidden'); el.hud.classList.remove('hidden'); break;
        case 'GAME_OVER': el.gameover.classList.remove('hidden'); break;
        case 'VICTORY': el.victory.classList.remove('hidden'); break;
        case 'STATS': el.stats.classList.remove('hidden'); el.hud.classList.remove('hidden'); break;
        case 'SETTINGS': el.settings.classList.remove('hidden'); break;
        case 'RECORDS': el.records.classList.remove('hidden'); break;
        case 'PLAYING':
          el.hud.classList.remove('hidden');
          if (Game.Input.touchMode) el.btnPauseTouch.classList.remove('hidden');
          break;
      }
    },

    /* ---------------- 主菜单 ---------------- */
    /** hasCampaignSave / hasEndlessSave：两个模式各有独立存档槽；endlessWave 用于提示可继续的波次 */
    renderMenu: function (hasCampaignSave, hasEndlessSave, endlessWave) {
      var endlessLabel = hasEndlessSave
        ? '无限模式 · 继续 第 ' + endlessWave + ' 波'
        : '无限模式';
      el.menu.innerHTML =
        '<h1>赤月猎场</h1>' +
        '<div class="subtitle">Crimson Moon Hunt</div>' +
        '<button class="btn primary" onclick="Game.Game.newGame()">开始闯关</button>' +
        '<button class="btn" ' + (hasCampaignSave ? '' : 'disabled') +
        ' onclick="Game.Game.continueCampaign()">继续闯关</button>' +
        '<button class="btn" onclick="Game.Game.startEndless()">' + endlessLabel + '</button>' +
        '<button class="btn" onclick="Game.Game.openRecords()">纪录榜</button>' +
        '<button class="btn ghost" onclick="Game.Game.openSettings()">设置</button>' +
        '<button class="btn ghost" ' + ((hasCampaignSave || hasEndlessSave) ? '' : 'disabled') +
        ' onclick="Game.Game.deleteSave()">删除存档</button>' +
        '<div class="subtitle">' + (Game.Input.touchMode ? '触屏：左摇杆移动，右下角暂停' : '键盘：WASD 移动 · 空格暂停 · F5 存档 · F9 读档 · ~ 调试') + '</div>';
      // 主菜单内容不高，恢复垂直居中；角色选择页会覆盖成 panel-top（见下）。
      el.menu.className = 'panel';
    },

    renderCharSelect: function () {
      var chars = Game.CHARACTERS;
      var groups = Game.BODY_GROUPS || {};
      // 按职业（姿态）分组，每组内顺序同 CHARACTERS。没写 body 的老角色按
      // swordsman 归组，和 renderer 的兜底保持一致。
      var order = [], buckets = {};
      for (var i = 0; i < chars.length; i++) {
        var key = chars[i].body || 'swordsman';
        if (!buckets[key]) { buckets[key] = []; order.push(key); }
        buckets[key].push(chars[i]);
      }
      var html = '<h2>选择角色</h2>';
      for (var g = 0; g < order.length; g++) {
        var k = order[g];
        var list = buckets[k];
        html += '<div class="char-group"><div class="char-group-title">' + (groups[k] || k) + '</div>' +
                '<div class="card-row">';
        for (var j = 0; j < list.length; j++) {
          var c = list[j];
          html +=
            '<div class="card r-legend" style="cursor:pointer" onclick="Game.Game.startRun(\'' + c.id + '\')">' +
            '<div class="card-rarity">' + c.category + '</div>' +
            '<div class="card-name">' + c.name + '</div>' +
            '<div class="card-desc">' + c.desc + '</div>' +
            '<div class="card-desc" style="color:#ffcf5e;margin-top:6px">被动：' + (c.passive ? (c.passive.name + ' — ' + c.passive.desc) : '无') + '</div>' +
            '</div>';
        }
        html += '</div></div>';
      }
      html += '<button class="btn ghost" onclick="Game.Game.toMenu()">返回</button>';
      el.menu.innerHTML = html;
      // 11 张卡分 4 组，手机上必定超高。.panel 的 justify-content:center 在内容
      // 溢出时会把顶端裁掉、滚不上去，所以这里切到顶部对齐。
      el.menu.className = 'panel panel-top';
    },

    /* ---------------- HUD ---------------- */
    updateHUD: function (state) {
      var p = state.player;
      var s = p.stats;
      el.hpFill.style.width = util.clamp(s.hp / s.maxHp * 100, 0, 100) + '%';
      el.hpText.textContent = Math.ceil(s.hp) + '/' + Math.ceil(s.maxHp);
      if (s.shieldMax > 0) {
        el.shieldWrap.style.display = 'block';
        el.shieldFill.style.width = util.clamp(s.shield / s.shieldMax * 100, 0, 100) + '%';
      } else {
        el.shieldWrap.style.display = 'none';
      }
      el.xpFill.style.width = util.clamp(p.xp / p.xpNext * 100, 0, 100) + '%';
      el.hudLevel.textContent = 'Lv.' + p.level;
      el.hudWave.textContent = '波次 ' + state.wave +
        (state.mode === 'endless' ? ' · 无限' : '') +
        (state.isBossWave ? ' · BOSS' : '');
      el.hudTimer.textContent = util.fmtTime(Math.max(0, state.waveDuration - state.waveTime));
      el.hudMaterial.textContent = p.materials;

      // 武器槽：名字缩写 + 等级。等级原来只挂在 title 上，触屏完全没有悬浮，
      // 等于看不到 —— 直接画进槽里。
      var slots = '';
      for (var i = 0; i < p.weapons.length; i++) {
        var w = p.weapons[i];
        var lvCls = 'ws-lv' + Math.min(w.level, Game.CONST.MAX_WEAPON_LEVEL);
        slots += '<div class="ws ' + lvCls + '" title="' + w.def.name + ' Lv.' + w.level +
                 ' / ' + Game.CONST.MAX_WEAPON_LEVEL + '">' +
                 '<span class="ws-ic">' + (w.def.type === 'melee' ? '🗡' : '🔫') + '</span>' +
                 '<span class="ws-lv">Lv' + w.level + '</span></div>';
      }
      el.weaponSlots.innerHTML = slots;
    },

    /* ---------------- 升级三选一 ---------------- */
    renderLevelUp: function (choices, title) {
      // title 可选：Boss 战利品复用同一面板但用不同标题。
      // 「查看角色面板」盖在这张面板之上，关掉就回到这里 —— 卡片内容不清空，
      // 所以不会丢掉当前这一轮的三选一。
      var html = '<div class="lu-head">' +
        '<h2>' + (title || '升级！选择一项') + '</h2>' +
        '<button class="btn ghost" onclick="Game.Game.openStats()">查看角色面板</button>' +
        '</div><div class="card-row">';
      for (var i = 0; i < choices.length; i++) {
        var c = choices[i];
        var rarity = 'common', name = '', desc = '';
        if (c.kind === 'upgrade') { rarity = c.data.rarity; name = c.data.label; desc = c.data.desc; }
        else if (c.kind === 'weapon') { rarity = 'rare'; name = Game.WEAPONS[c.data.weaponId].name; desc = Game.WEAPONS[c.data.weaponId].desc; }
        else if (c.kind === 'weaponUpgrade') {
          rarity = 'epic'; name = '武器强化';
          desc = '随机强化一把武器（最高 ' + Game.CONST.MAX_WEAPON_LEVEL + ' 星）';
        }
        else if (c.kind === 'item') { var it = Game.ITEMS[c.data.itemId]; rarity = it.rarity; name = it.name; desc = it.desc; }
        var r = Game.RARITY[rarity];
        html +=
          '<div class="card r-' + rarity + '" style="cursor:pointer" onclick="Game.Game.pickLevelUp(' + i + ')">' +
          '<div class="card-rarity" style="color:' + r.color + '">' + r.name + '</div>' +
          '<div class="card-name">' + name + '</div>' +
          '<div class="card-desc">' + desc + '</div></div>';
      }
      html += '</div>';
      el.levelup.innerHTML = html;
    },

    /* ---------------- 角色面板（属性 / 武器 / 道具明细） ---------------- */
    /** 纯 HTML 构造：从 HUD 按钮、升级面板、暂停面板都能打开。
     *  伤害明细是这里的核心 —— 武器伤害 = 武器本体 × (1+0.5×(等级-1)) × 角色倍率，
     *  跟 weapons.js 的 WeaponInstance.damage 用同一个算式，面板上就能核对。 */
    renderStatsHTML: function (state) {
      var p = state.player, s = p.stats, c = p.char, MAXLVL = Game.CONST.MAX_WEAPON_LEVEL;
      var pct = function (v) { return v.toFixed(0) + '%'; };
      var num = function (v, d) { return v.toFixed(d === undefined ? 2 : d); };
      var stars = function (lv) {
        var out = '';
        for (var i = 1; i <= MAXLVL; i++) out += i <= lv ? '★' : '☆';
        return out;
      };
      var row = function (k, v, gold) {
        return '<div class="stats-row"><span>' + k + '</span><span class="v' +
               (gold ? ' v-gold' : '') + '">' + v + '</span></div>';
      };
      // 玩家能看懂的减伤：护甲 / (护甲+30)，上限 80%（与 Player.takeDamage 一致）
      var red = s.armor / (s.armor + 30);
      if (red > 0.8) red = 0.8;

      var html = '<div class="stats-head">' +
        '<span class="stats-char">' + c.name + '</span>' +
        '<span class="stats-tag">' + c.category + ' · Lv.' + p.level + '</span></div>' +
        '<div class="stats-passive">被动｜' + p.passive.name + '：' + p.passive.desc + '</div>';

      html += '<div class="stats-blk"><h3>属性</h3>' +
        row('生命', Math.ceil(s.hp) + ' / ' + Math.ceil(s.maxHp), true) +
        row('护盾', Math.floor(s.shield) + ' / ' + Math.floor(s.shieldMax)) +
        row('伤害倍率', '×' + num(s.damage)) +
        row('攻击速度', '×' + num(s.attackSpeed)) +
        row('暴击率', pct(s.critChance * 100)) +
        row('暴击伤害', '×' + num(s.critMult)) +
        row('护甲', Math.floor(s.armor) + '（减伤 ' + pct(red * 100) + '）') +
        row('移动速度', Math.round(s.speed)) +
        row('吸血', pct(s.lifesteal * 100)) +
        row('命中回血', num(s.lifeOnHit, 0) + ' / 次') +
        row('击杀回血', num(s.lifeOnKill, 0) + ' / 次') +
        row('治疗强度', '×' + num(s.healingPower)) +
        row('击杀数', state.stats.kills) +
        '</div>';

      html += '<div class="stats-blk"><h3>武器伤害明细</h3>';
      if (p.weapons.length === 0) {
        html += '<div class="stats-empty">还没有武器</div>';
      } else {
        for (var i = 0; i < p.weapons.length; i++) {
          var w = p.weapons[i];
          var dmg = w.damage(p);              // 已含等级成长与角色倍率
          var cd = w.cooldown(p);             // 已除攻击速度
          var lvlUp = 1 + 0.5 * (w.level - 1);
          html += '<div class="stats-weapon">' +
            '<div class="stats-wname">' +
            '<span>' + (w.def.type === 'melee' ? '🗡' : '🔫') + ' ' + w.def.name + '</span>' +
            '<span class="stats-wlvl">Lv.' + w.level + '/' + MAXLVL + ' ' + stars(w.level) + '</span></div>' +
            '<div class="stats-wstat"><span>本体 ' + w.def.damage + ' × 等级 ' +
              num(lvlUp) + ' × 角色 ' + num(s.damage) + '</span><span class="v">' + num(dmg) + '</span></div>' +
            '<div class="stats-wstat"><span>攻速 ' + num(1 / cd) + ' 次/秒' +
              (w.def.pierce ? ' · 穿透 ' + w.def.pierce : '') +
              (w.def.range ? ' · 射程 ' + w.def.range : '') + '</span>' +
              '<span class="v">DPS ' + num(dmg / cd) + '</span></div>' +
            '<div class="stats-wstat"><span>单次暴击</span><span class="v">' +
              num(dmg * s.critMult) + '</span></div>' +
            '</div>';
        }
      }
      html += '</div>';

      html += '<div class="stats-blk"><h3>道具</h3>';
      var iids = Object.keys(p.items), n = 0;
      for (var j = 0; j < iids.length; j++) n += p.items[iids[j]];
      if (n === 0) {
        html += '<div class="stats-empty">还没有道具</div>';
      } else {
        for (var k = 0; k < iids.length; k++) {
          var it = Game.ITEMS[iids[k]];
          if (!it) continue;
          html += '<div class="stats-row"><span>' + it.name + ' ×' + p.items[iids[k]] + '</span>' +
                  '<span class="stats-iv">' + it.desc + '</span></div>';
        }
      }
      html += '</div>';
      return html;
    },

    /** 打开面板。from 记录关回去该回哪张面板（升级面板的卡片不能丢）。 */
    showStats: function (state, from) {
      this._statsFrom = from || 'PLAYING';
      el.stats.innerHTML = '<h2>角色面板</h2>' + this.renderStatsHTML(state) +
        '<button class="btn primary" onclick="Game.Game.closeStats()">关闭</button>';
      el.stats.className = 'panel panel-top';
      this.showScreen('STATS');
    },
    closeStats: function () {
      var from = this._statsFrom || 'PLAYING';
      this.showScreen(from);
      if (from === 'PAUSED') this.renderPause();
    },

    /* ---------------- 商店 ---------------- */
    renderShop: function (state) {
      var shop = state.shop;
      var p = state.player;
      var html = '<h2>商店 <span style="font-size:14px;color:#ffcf5e">◈ ' + p.materials + '</span></h2><div class="shop-grid">';
      for (var i = 0; i < shop.items.length; i++) {
        var it = shop.items[i];
        var r = Game.RARITY[it.rarity || 'common'];
        var soldCls = it.sold ? ' locked' : '';
        var lockCls = shop.locked[i] ? ' 🔒' : '';
        html +=
          '<div class="shop-item' + soldCls + '" style="border-color:' + r.color + '" onclick="Game.Game.buyShop(' + i + ')">' +
          '<div style="font-weight:700">' + it.name + '</div>' +
          '<div style="font-size:12px;color:#ccc">' + it.desc + '</div>' +
          '<div class="price">' + (it.sold ? '已售' : '◈ ' + it.price + lockCls) + '</div>' +
          '<div style="font-size:11px;color:#aaa;cursor:pointer" onclick="event.stopPropagation();Game.Game.lockShop(' + i + ')">' +
          (shop.locked[i] ? '已锁定' : '锁定') + '</div>' +
          '</div>';
      }
      html += '</div><div class="shop-bar">' +
        '<button class="btn" onclick="Game.Game.refreshShop()">刷新（◈ ' + shop.refreshCost + '）</button>' +
        '<button class="btn primary" onclick="Game.Game.nextWave()">下一波 →</button>' +
        '</div>';
      el.shop.innerHTML = html;
    },

    /* ---------------- 暂停 ---------------- */
    renderPause: function () {
      el.pause.innerHTML =
        '<h2>已暂停</h2>' +
        '<button class="btn primary" onclick="Game.Game.resume()">继续</button>' +
        '<button class="btn" onclick="Game.Game.openStats()">查看角色面板</button>' +
        '<button class="btn" onclick="Game.Game.saveGame()">保存游戏</button>' +
        '<button class="btn" onclick="Game.Game.restartRun()">重新开始</button>' +
        '<button class="btn ghost" onclick="Game.Game.toMenu()">返回主菜单</button>';
    },

    /* ---------------- 结算 ---------------- */
    renderGameOver: function (state, rank) {
      var p = state.player;
      var tag = state.mode === 'endless' ? '无限' : '闯关';
      var rec = rank && rank.entered
        ? '<div class="stat-line" style="color:#ffcf5e">☆ 进入纪录榜 第 ' + rank.rank + ' 名</div>'
        : '';
      el.gameover.innerHTML =
        '<h1>败北</h1>' +
        '<div class="stat-line" style="color:#aaa">' + tag + '模式</div>' +
        '<div class="stat-line">存活波次：<b>' + state.wave + '</b></div>' +
        rec +
        '<div class="stat-line">击杀数：<b>' + state.stats.kills + '</b></div>' +
        '<div class="stat-line">存活时间：<b>' + util.fmtTime(state.elapsed) + '</b></div>' +
        '<div class="stat-line">造成伤害：<b>' + Math.round(p.damageDealt) + '</b></div>' +
        '<div class="stat-line">承受伤害：<b>' + Math.round(p.damageTaken) + '</b></div>' +
        '<div class="stat-line">治疗总量：<b>' + Math.round(p.healedTotal) + '</b></div>' +
        '<div class="stat-line">获得材料：<b>' + p.materials + '</b></div>' +
        '<button class="btn primary" onclick="Game.Game.restartRun()">重新开始</button>' +
        '<button class="btn ghost" onclick="Game.Game.toMenu()">返回主菜单</button>';
    },

    renderVictory: function (state, rank) {
      var p = state.player;
      var rec = rank && rank.entered
        ? '<div class="stat-line" style="color:#ffcf5e">☆ 进入纪录榜 第 ' + rank.rank + ' 名</div>'
        : '';
      el.victory.innerHTML =
        '<h1 style="color:#ffcf5e">通关！</h1>' +
        '<div class="stat-line">章节：<b>赤月荒原</b></div>' +
        '<div class="stat-line">击杀数：<b>' + state.stats.kills + '</b></div>' +
        '<div class="stat-line">存活时间：<b>' + util.fmtTime(state.elapsed) + '</b></div>' +
        '<div class="stat-line">造成伤害：<b>' + Math.round(p.damageDealt) + '</b></div>' +
        '<div class="stat-line">获得材料：<b>' + p.materials + '</b></div>' +
        rec +
        '<button class="btn primary" onclick="Game.Game.toMenu()">返回主菜单</button>';
    },

    /* ---------------- 纪录榜 ---------------- */
    renderRecords: function (runs) {
      runs = runs || [];
      var html = '<h2>纪录榜</h2>' +
                 '<div class="subtitle">按到达波次排序 · 最多 ' + Game.Records.TOP_N + ' 条</div>';
      if (!runs.length) {
        html += '<div class="subtitle" style="margin-top:20px">暂无纪录，打一局试试。</div>';
      } else {
        for (var i = 0; i < runs.length; i++) {
          var r = runs[i];
          var tag = r.mode === 'endless' ? '无限' : '闯关';
          var medal = i === 0 ? '🥇 ' : (i === 1 ? '🥈 ' : (i === 2 ? '🥉 ' : ''));
          html +=
            '<div class="stat-line">' +
            '<b>' + medal + 'NO.' + (i + 1) + '</b>' +
            '<span style="color:#ffcf5e;font-weight:700"> 第 ' + r.wave + ' 波</span>' +
            ' · ' + tag + ' · ' + (r.charName || '?') +
            '</div>' +
            '<div class="stat-line" style="font-size:12px;color:#aaa;margin-top:2px">' +
            'Lv.' + (r.level || 1) + ' · 击杀 ' + (r.kills || 0) +
            ' · 伤害 ' + (r.damage || 0) +
            ' · 存活 ' + util.fmtTime(r.elapsed || 0) +
            '</div>';
        }
      }
      html +=
        '<br><button class="btn primary" onclick="Game.Game.toMenu()">返回主菜单</button>' +
        '<button class="btn ghost" onclick="Game.Game.clearRecords()">清空纪录</button>';
      el.records.innerHTML = html;
      // 满 10 条时 20 行明细 + 标题 + 按钮必定超高；.panel 的垂直居中会把
      // 溢出部分的顶端裁掉、滚不上去，而溢出的恰恰是最靠前的名次。
      el.records.className = 'panel panel-top';
    },

    /* ---------------- 设置 ---------------- */
    renderSettings: function (settings) {
      var s = settings || { sound: true, vibrate: true, quality: 'high' };
      el.settings.innerHTML =
        '<h2>设置</h2>' +
        '<button class="btn" onclick="Game.Game.toggleSound()">音效：' + (s.sound ? '开' : '关') + '</button>' +
        '<button class="btn" onclick="Game.Game.toggleVibrate()">震动：' + (s.vibrate ? '开' : '关') + '</button>' +
        '<div style="color:#fff;margin-top:8px">画质：</div>' +
        '<button class="btn ' + (s.quality === 'low' ? 'primary' : '') + '" onclick="Game.Game.setQuality(\'low\')">低</button>' +
        '<button class="btn ' + (s.quality === 'mid' ? 'primary' : '') + '" onclick="Game.Game.setQuality(\'mid\')">中</button>' +
        '<button class="btn ' + (s.quality === 'high' ? 'primary' : '') + '" onclick="Game.Game.setQuality(\'high\')">高</button>' +
        '<br><button class="btn ghost" onclick="Game.Game.closeSettings()">返回</button>';
    },

    /* ---------------- 波次横幅 ---------------- */
    showWaveBanner: function (wave, boss) {
      var b = document.getElementById('wave-banner');
      if (!b) {
        b = document.createElement('div');
        b.id = 'wave-banner';
        b.style.cssText = 'position:fixed;top:38%;left:50%;transform:translate(-50%,-50%);z-index:40;' +
          'font-size:52px;font-weight:700;color:#fff;letter-spacing:4px;pointer-events:none;' +
          'text-shadow:0 0 24px rgba(226,59,59,0.9),0 2px 0 #000;transition:opacity .5s ease;';
        document.body.appendChild(b);
      }
      b.textContent = boss ? '⚠ BOSS 来袭 ⚠' : '第 ' + wave + ' 波';
      b.style.color = boss ? '#ff5e5e' : '#fff';
      b.style.opacity = '1';
      clearTimeout(this._bannerT);
      this._bannerT = setTimeout(function () { b.style.opacity = '0'; }, 1800);
    },

    /* ---------------- 存档提示 ---------------- */
    showSaveToast: function (err) {
      var t = el.saveToast;
      t.classList.remove('hidden');
      if (err) {
        t.textContent = '✗ 存档失败';
        t.style.background = 'rgba(120,20,20,0.9)';
      } else {
        t.textContent = '✓ 已保存';
        t.style.background = 'rgba(20,60,20,0.85)';
      }
      clearTimeout(this._toastT);
      this._toastT = setTimeout(function () { t.classList.add('hidden'); }, 1500);
    },

    /* ---------------- 调试面板 ---------------- */
    _buildDebugPanel: function () {
      el.debug.innerHTML =
        '<div class="db-title">调试面板（~ 开关）</div>' +
        '<div class="db-row"><span>FPS</span><span id="db-fps">0</span></div>' +
        '<div class="db-row"><span>实体数</span><span id="db-ents">0</span></div>' +
        '<div class="db-row"><span>粒子数</span><span id="db-parts">0</span></div>' +
        '<div class="db-row"><span>波次</span><span id="db-wave">0</span></div>' +
        '<div class="db-row"><span>玩家坐标</span><span id="db-pos">0,0</span></div>' +
        '<div class="db-row"><span>无敌</span><span id="db-god">关</span></div>' +
        '<div class="db-row"><span>画质</span><span id="db-quality">high</span></div>' +
        '<button onclick="Game.Game.debugToggleGod()">无敌开关</button>' +
        '<button onclick="Game.Game.debugAddMaterial()">+100 材料</button>' +
        '<button onclick="Game.Game.debugSkipWave()">跳波</button>' +
        '<button onclick="Game.Game.debugLevelUp()">直接升级</button>';
    },

    updateDebug: function (state, fps) {
      if (el.debug.classList.contains('hidden')) return;
      document.getElementById('db-fps').textContent = fps;
      document.getElementById('db-ents').textContent =
        state.enemies.length + state.projectiles.length + state.pickups.length;
      document.getElementById('db-parts').textContent = Game.Renderer.particles.length;
      document.getElementById('db-wave').textContent = state.wave;
      document.getElementById('db-pos').textContent =
        Math.round(state.player.x) + ',' + Math.round(state.player.y);
      document.getElementById('db-god').textContent = Game.debugGod ? '开' : '关';
      document.getElementById('db-quality').textContent = Game.Renderer.quality;
    },

    _bindPauseTouch: function () {
      var self = this;
      var handler = function (e) {
        e.preventDefault();
        if (Game.Game) Game.Game.pause();
      };
      el.btnPauseTouch.addEventListener('touchstart', handler, { passive: false });
      el.btnPauseTouch.addEventListener('mousedown', handler);
    },
  };

  var util = Game.util;
})();
