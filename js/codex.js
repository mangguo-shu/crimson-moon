/* ============================================================
 * codex.js —— 图鉴（英雄 / 怪物 / BOSS / 装备 / 卡组）
 *
 * 图鉴记的是「见过」，不是「拥有」：
 *   英雄 —— 用过一个角色        （game.js 的 startRun）
 *   怪物 / BOSS —— 刷进过画面    （Enemy 构造即登记，波次计划与 Boss 召唤小怪都覆盖）
 *   装备 —— 发到手上过           （createWeapon 是唯一入口，含读档还原）
 *   卡组 —— 出现在三选一或商店里 （ui.js 的 renderLevelUp / renderShop）
 * BOSS 额外记 bossKill，打过才亮星。
 *
 * 未解锁的条目照样占位，名字与文案盖成「??」—— 图鉴的意义就是慢慢被填满。
 *
 * 存档是 profile 级别的：deleteSave 只清两个对局槽，不动图鉴（lifetime 进度）。
 * 条目本体不新增任何数值，全部从 config 的 CHARACTERS / ENEMIES / WEAPONS /
 * ITEMS / UPGRADES 读。config 是冻结区，这里只读不写。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var KEY = 'codex_v1';

  /* 五个分栏。label 是页签上的短标签（5 个并排在手机上得压到最短），
   * title 是内容区标题，hint 是标题下那行说明。
   * id 同时是存档里那一格的名字 —— 五个分栏各占一格，一一对应。 */
  var TABS = [
    { id: 'hero',    label: '英雄', title: '英雄图鉴', hint: '用过一次就收录', locked: '未使用' },
    { id: 'monster', label: '怪物', title: '怪物图鉴', hint: '刷进画面就收录', locked: '未遇到' },
    { id: 'boss',    label: 'BOSS', title: 'BOSS图鉴', hint: '刷进画面就收录，打过打星', locked: '未遇到' },
    { id: 'weapon',  label: '装备', title: '装备图鉴', hint: '发到手上就收录', locked: '未获得' },
    { id: 'card',    label: '卡组', title: '卡组图鉴', hint: '出现在三选一或商店就收录', locked: '未见到' },
  ];

  // behavior / attack 的中文标签写在图鉴这一层，不塞进 ENEMIES 表 ——
  // 那是冻结区，只读比加字段安全。
  var BEHAVIOR = { chase: '追踪近战', flyer: '快速飞行', shooter: '远程施法', boss: '首领' };
  var ATTACK = {
    fan:    '扇形弹幕 + 召唤',
    charge: '蓄力预警 + 冲撞',
    ring:   '360° 环绕弹排',
    spiral: '连续螺旋弹幕',
  };

  /* ---------------- 条目构建 ----------------
   * 条目形状：{ key, name, tag, desc, rows:[[标签,值],...], note, color, always }
   * key 是存档里那格的名字；always 表示天生已收录（通用卡，不属于任何一张具体卡）。 */
  function stars(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '★';
    return s;
  }

  function heroes() {
    var chars = Game.CHARACTERS || [], out = [];
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      out.push({
        key: c.id, name: c.name, tag: c.category || '',
        desc: c.desc || '',
        rows: [
          ['生命', c.baseHp],
          ['移动', c.speed],
          ['伤害', '×' + c.damage],
          ['攻速', '×' + c.attackSpeed],
          ['暴击', Math.round(c.critChance * 100) + '%'],
          ['护甲', c.armor],
        ],
        note: c.passive ? '被动｜' + c.passive.name + '：' + c.passive.desc : '',
      });
    }
    return [{ title: '', entries: out }];
  }

  function enemies(bossOnly) {
    var ids = Object.keys(Game.ENEMIES || {}), out = [];
    for (var i = 0; i < ids.length; i++) {
      var d = Game.ENEMIES[ids[i]];
      if (!!d.boss !== bossOnly) continue;
      var note = '';
      if (d.counter) note += '被命中反弹 ' + Math.round(d.counter * 100) + '%';
      if (d.boss && d.dashSpeed) note += (note ? ' · ' : '') + '冲撞 ' + d.dashSpeed + ' px/s';
      out.push({
        key: d.id, name: d.name,
        tag: BEHAVIOR[d.behavior] || d.behavior,
        desc: d.boss && ATTACK[d.attack] ? ATTACK[d.attack] : '',
        rows: [
          ['生命', d.hp],
          ['移动', d.speed],
          ['伤害', d.damage],
          ['体型', d.radius],
          ['经验', d.xp],
          ['材料', d.material],
        ],
        note: note,
        attack: d.attack,
        boss: !!d.boss,
      });
    }
    // Boss 按出场顺序（Game.BOSSES）排，而不是按配置表插入序
    if (bossOnly) {
      var order = Game.BOSSES || [], rank = {};
      for (var b = 0; b < order.length; b++) rank[order[b]] = b;
      out.sort(function (a, b) {
        var ra = rank[a.key] === undefined ? 99 : rank[a.key];
        var rb = rank[b.key] === undefined ? 99 : rank[b.key];
        return ra - rb;
      });
    }
    return [{ title: '', entries: out }];
  }

  function weapons() {
    var ids = Object.keys(Game.WEAPONS || {}), out = [];
    for (var i = 0; i < ids.length; i++) {
      var w = Game.WEAPONS[ids[i]];
      var melee = w.type === 'melee';
      out.push({
        key: w.id, name: w.name,
        tag: (melee ? '🗡 近战' : '🔫 远程') + ' · ' + stars(w.star || 1),
        desc: w.desc || '',
        rows: [
          ['伤害', w.damage],
          ['攻速', Math.round(100 / w.cooldown) / 100 + ' 次/秒'],
          melee ? ['射程', w.range] : ['弹速', w.projectileSpeed],
          ['穿透', w.pierce],
          ['击退', w.knockback],
        ],
        note: w.exclusive ? 'BOSS 战奖励专属，商店与升级池不刷' : '',
      });
    }
    return [{ title: '', entries: out }];
  }

  function cards() {
    var ups = [], up = Game.UPGRADES || [];
    for (var i = 0; i < up.length; i++) {
      var u = up[i];
      ups.push({
        key: 'upgrade:' + u.label, name: u.label,
        tag: rarityName(u.rarity), color: rarityColor(u.rarity),
        desc: u.desc || '',
      });
    }
    var its = [], ids = Object.keys(Game.ITEMS || {});
    for (var j = 0; j < ids.length; j++) {
      var it = Game.ITEMS[ids[j]];
      its.push({
        key: 'item:' + it.id, name: it.name,
        tag: rarityName(it.rarity), color: rarityColor(it.rarity),
        desc: it.desc || '',
        note: it.healing ? '续航件：商店与升级池会降权' : '',
      });
    }
    // 通用强化卡：没有自己的 id，任何池子里都可能出，天生已收录
    ups.push({
      key: 'weaponUpgrade', name: '武器强化',
      tag: rarityName('rare'), color: rarityColor('rare'),
      desc: '随机强化一把武器（最高 ' + (Game.CONST.MAX_WEAPON_LEVEL) + ' 星）',
      always: true,
    });
    return [{ title: '属性强化', entries: ups }, { title: '被动道具', entries: its }];
  }

  function rarityName(r) { var d = Game.RARITY[r]; return d ? d.name : (r || ''); }
  function rarityColor(r) { var d = Game.RARITY[r]; return d ? d.color : ''; }

  /* 每个 builder 都返回「小节数组」，这里直接透传、不要再裹一层：
     all() 是拿 secs[i].entries 摊平的，裹成 [[{entries}]] 后 secs[i] 变成数组本身，
     .entries 会落到 Array.prototype.entries 那个方法上，.length 是 0（形参个数），
     循环一次都不跑 —— 怪物栏和 BOSS 栏静默地变成空的。 */
  function sections(tabId) {
    if (tabId === 'hero') return heroes();
    if (tabId === 'monster') return enemies(false);
    if (tabId === 'boss') return enemies(true);
    if (tabId === 'weapon') return weapons();
    if (tabId === 'card') return cards();
    return [];
  }

  /* ---------------- 存档 ---------------- */
  function blank() {
    return { hero: {}, monster: {}, boss: {}, weapon: {}, card: {}, bossKill: {}, v: 1 };
  }

  var doc = null;   // 解析后的存档；mark 命中新条目时才写盘

  function read() {
    if (doc) return doc;
    var base = blank();
    var d = Game.Storage.getJSON(KEY);
    if (d && typeof d === 'object') {
      // 只认 base 里已有的分栏：旧存档多出来的脏键不带进内存，新分栏也不会被旧键覆盖
      for (var k in base) {
        if (k === 'v') continue;
        if (d[k] && typeof d[k] === 'object') base[k] = d[k];
      }
    }
    doc = base;
    return doc;
  }

  Game.Codex = {
    KEY: KEY,
    TABS: TABS,
    ATTACK: ATTACK,

    /** 丢掉内存里的版本，下次读重新落盘取（清空图鉴或外部改过存档时用） */
    invalidate: function () { doc = null; },

    /** 某分栏的全部条目，按小节摊平 */
    sections: sections,

    all: function (tabId) {
      var secs = this.sections(tabId), out = [];
      for (var i = 0; i < secs.length; i++)
        for (var j = 0; j < secs[i].entries.length; j++) out.push(secs[i].entries[j]);
      return out;
    },

    isUnlocked: function (tabId, key) {
      var d = read()[tabId];
      return !!(d && d[key]);
    },

    /** 条目级判定：always 的通用卡永远算收录 */
    entryUnlocked: function (tabId, e) {
      return !!e.always || this.isUnlocked(tabId, e.key);
    },

    /** 登记一次「见过」。已收录、分栏不存在、key 为空时一律不写盘。 */
    mark: function (tabId, key) {
      if (!key) return false;
      var d = read();
      if (!d[tabId]) return false;
      if (d[tabId][key]) return false;
      d[tabId][key] = 1;
      Game.Storage.setJSON(KEY, d);
      return true;
    },

    clear: function () {
      Game.Storage.remove(KEY);
      doc = blank();
    },

    /** 某分栏的收录进度 */
    progress: function (tabId) {
      var list = this.all(tabId), d = read()[tabId] || {};
      var got = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].always || d[list[i].key]) got++;
      }
      return { got: got, total: list.length };
    },

    /** 五个分栏合计 */
    total: function () {
      var got = 0, total = 0;
      for (var i = 0; i < TABS.length; i++) {
        var p = this.progress(TABS[i].id);
        got += p.got; total += p.total;
      }
      return { got: got, total: total };
    },

    /** 某只 BOSS 有没有被打过 */
    bossSlain: function (key) {
      var d = read().bossKill;
      return !!(d && d[key]);
    },
  };

  console.log('[Codex] 就绪：' + TABS.length + ' 栏 ' + Game.Codex.total().total + ' 条');
})();
