/* ============================================================
 * systems.js —— 游戏系统层
 * 波次管理 / 生成 / 战斗结算 / 拾取 / 升级 / 商店 / 存档序列化
 * 所有函数以 Game.state 为操作对象，保持与渲染层解耦，便于测试。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;
  var CONST = Game.CONST;

  var S = Game.Systems = {};

  /* ============================================================
   * 状态创建
   * ============================================================ */
  S.createState = function (mode, charId, seed) {
    seed = seed >>> 0;
    var state = {
      screen: 'PLAYING',
      mode: mode,             // 'campaign' | 'endless'
      chapter: 1,
      wave: 0,                // 当前波号（0 = 未开始）
      waveTime: 0,
      waveDuration: 0,
      spawnSchedule: [],      // [{time, type, x, y, boss}]
      spawnIndex: 0,
      isBossWave: false,
      bossSpawned: false,
      elapsed: 0,
      seed: seed,
      rng: Game.mulberry32(seed),
      player: new Game.Player(charId),
      enemies: [],
      projectiles: [],
      pickups: [],
      stats: { kills: 0 },
      shop: null,
      levelUpChoices: [],
      lastLevel: 1,           // 用于检测升级
      levelUpsPending: 0,
      difficulty: 'normal',
    };
    // 初始武器
    var w = state.player.char.startWeapon;
    state.player.weapons.push(Game.createWeapon(w, 1));
    // 回指：拾取物只拿到 player，但吸铁石要遍历整个 state.pickups
    state.player.state = state;
    return state;
  };

  /* ============================================================
   * 波次管理
   * ============================================================ */
  S.waveDuration = function (wave) {
    var base = Math.min(45, 20 + (wave - 1));
    // Boss 波是给足的 Boss 战时长，不用普通波的节奏去催
    return S.isBossWave(wave) ? base + 45 : base;
  };

  S.isBossWave = function (wave) {
    return wave % 10 === 0;
  };

  /** 预生成整波刷新计划（用与 seed+wave 绑定的独立 RNG，保证读档一致） */
  S.buildSpawnSchedule = function (state, wave) {
    var schedule = [];
    var waveRng = Game.mulberry32(Game.hashSeed(state.seed + ':' + wave));
    // 刷新量。注意 dur 是硬上限：高波次区间密度（见下）会先把 t 顶穿 dur，
    // budget 只在低波次是瓶颈 —— 那里怪太稀，就是「没爽感」的根源。
    var budget = 16 + wave * 8;
    var dur = S.waveDuration(wave);
    var boss = S.isBossWave(wave);

    if (boss) {
      // Boss 波：第 3 秒刷 Boss，再铺少量小怪
      schedule.push({ time: 3, type: 'boss', x: 0, y: 0, boss: true });
      budget = Math.max(10, Math.floor(budget * 0.6));
    }

    // 按时间推进生成小怪
    var t = 0.5;
    var count = 0;
    while (count < budget && t < dur) {
      schedule.push({ time: t, type: S.pickEnemyType(waveRng, wave), x: 0, y: 0, boss: false });
      count++;
      t += 0.55 - Math.min(0.3, wave * 0.01); // 高波次刷新更密
      if (t < 0.1) t = 0.1;
    }

    // 为每个刷新事件确定出生点（地图边缘外侧）
    for (var i = 0; i < schedule.length; i++) {
      var ev = schedule[i];
      if (ev.boss) {
        ev.x = CONST.WORLD_W / 2;
        ev.y = CONST.WORLD_H / 2 - 200;
      } else {
        var p = S.edgeSpawnPoint(waveRng);
        ev.x = p.x; ev.y = p.y;
      }
    }
    schedule.sort(function (a, b) { return a.time - b.time; });
    return schedule;
  };

  S.pickEnemyType = function (rng, wave) {
    var r = rng();

    // 坦克只在 21 波起（无限模式）刷新。
    // wave <= 20 时 tankChance === 0：下面的分支既不会进，也不额外消耗随机数，
    // 所以闯关前 20 波的刷新构成与加入坦克前逐位一致 —— 已验收基线保持不动。
    var tankChance = 0;
    if (wave >= 21) tankChance = Math.min(0.14, 0.08 + (wave - 21) * 0.002);
    if (tankChance > 0 && r < tankChance) return S.pickTankType(rng, wave);

    // 高波次增加巫师（远程）比例。巫师是唯一的远程怪，占比直接决定近战爽感：
    // 1 波从 16% 压到 8%（近战 92%），20 波从 35% 压到 20%。
    var wizardChance = 0.07 + Math.min(0.13, wave * 0.01);
    var batChance = 0.3;
    if (r < wizardChance) return 'wizard';
    if (r < wizardChance + batChance) return 'bat';
    return 'zombie';
  };

  /** 坦克品种随波次推进：越靠后越厚（bulwark 反伤最高、最笨重） */
  S.pickTankType = function (rng, wave) {
    var t = rng();
    if (wave < 28) return t < 0.7 ? 'golem' : 'bruiser';
    if (wave < 40) return t < 0.45 ? 'golem' : (t < 0.8 ? 'bruiser' : 'bulwark');
    return t < 0.4 ? 'golem' : (t < 0.7 ? 'bruiser' : 'bulwark');
  };

  S.edgeSpawnPoint = function (rng) {
    var side = Math.floor(rng() * 4);
    var m = 24; // 地图外边缘
    var x, y;
    if (side === 0) { x = util.rand(rng, 0, CONST.WORLD_W); y = -m; }
    else if (side === 1) { x = util.rand(rng, 0, CONST.WORLD_W); y = CONST.WORLD_H + m; }
    else if (side === 2) { x = -m; y = util.rand(rng, 0, CONST.WORLD_H); }
    else { x = CONST.WORLD_W + m; y = util.rand(rng, 0, CONST.WORLD_H); }
    return { x: x, y: y };
  };

  S.startWave = function (state, wave) {
    state.wave = wave;
    state.waveTime = 0;
    state.waveDuration = S.waveDuration(wave);
    state.isBossWave = S.isBossWave(wave);
    state.bossSpawned = false;
    state.spawnSchedule = S.buildSpawnSchedule(state, wave);
    state.spawnIndex = 0;
    state.screen = 'PLAYING';
    console.log('[Wave] 开始波次 ' + wave + ' 时长=' + state.waveDuration +
                ' 敌人预算=' + state.spawnSchedule.length + (state.isBossWave ? ' [Boss]' : ''));
    if (Game.UI) Game.UI.showWaveBanner(wave, state.isBossWave);
    if (Game.Audio) Game.Audio.wave();
    if (state.isBossWave) {
      if (Game.FX) Game.FX.flash('#ff3a3a', 0.4);
      if (Game.Audio) Game.Audio.boss();
    }

    // 角色被动：波次开始（开局护盾、重置叠层等）
    if (state.player) Game.invokePassive(state.player, 'onWaveStart', state, wave);
  };

  /** 每帧更新波次；返回 'ended' 表示本波结束 */
  S.updateWave = function (state, dt) {
    if (state.screen !== 'PLAYING') return null;
    state.waveTime += dt;
    state.elapsed += dt;

    // 按计划刷新敌人
    while (state.spawnIndex < state.spawnSchedule.length &&
           state.spawnSchedule[state.spawnIndex].time <= state.waveTime) {
      var ev = state.spawnSchedule[state.spawnIndex];
      if (ev.boss) {
        state.bossSpawned = true;
        state.enemies.push(new Game.Enemy('boss', ev.x, ev.y, state.wave, { bossTier: Math.floor(state.wave / 10) || 1 }));
        if (Game.FX) Game.FX.shake(14);
        console.log('[Wave] Boss 已出场');
      } else {
        state.enemies.push(new Game.Enemy(ev.type, ev.x, ev.y, state.wave));
      }
      state.spawnIndex++;
    }

    // 波次结束判定
    if (state.isBossWave) {
      // Boss 波：Boss 阵亡即结束（奖励由 game 层先弹，见 G._triggerBossReward）
      var anyBoss = false;
      for (var i = 0; i < state.enemies.length; i++) if (state.enemies[i].isBoss) anyBoss = true;
      if (state.bossSpawned && !anyBoss) {
        this.clearEnemies(state);
        return 'ended';
      }
      // 硬超时兜底：Boss 战不可能无限拖，到时直接收场（防止卡关）
      if (state.waveTime >= state.waveDuration) {
        this.clearEnemies(state);
        return 'ended';
      }
    } else {
      // 普通波：时间一到立即结束，不必清空场上的怪（残怪由 clearEnemies 收掉）。
      // 旧实现要求 aliveCount === 0，玩家必须追杀全场才能进商店，节奏被拖死。
      var aliveCount = 0;
      for (var k = 0; k < state.enemies.length; k++) if (!state.enemies[k].dead) aliveCount++;
      if (state.waveTime >= state.waveDuration) {
        this.clearEnemies(state);
        return 'ended';
      }
      // 提前收场：刷新已排完且场上已无存活，不必等倒计时（更早进商店）
      if (state.spawnIndex >= state.spawnSchedule.length && aliveCount === 0 && state.waveTime > 1) {
        this.clearEnemies(state);
        return 'ended';
      }
    }
    return null;
  };

  S.clearEnemies = function (state) {
    for (var i = state.enemies.length - 1; i >= 0; i--) {
      if (!state.enemies[i].dead && !state.enemies[i].isBoss) {
        // 普通怪直接消失（波次结束）
      }
      if (state.enemies[i].dead) state.enemies.splice(i, 1);
    }
    // 波次结束：清空场上残余普通怪
    for (var j = state.enemies.length - 1; j >= 0; j--) {
      if (!state.enemies[j].isBoss) state.enemies.splice(j, 1);
    }
    // 敌人投射物一并清掉：这些怪刚被清场，它们的子弹不该继续存在。
    // 不清的话会冻结在商店界面，并在下一波 startWave 后重新激活。
    // 波次改为按时间结束后这种情况明显变多，必须处理。
    for (var k = state.projectiles.length - 1; k >= 0; k--) {
      if (!state.projectiles[k].fromPlayer) state.projectiles.splice(k, 1);
    }
  };

  /* ============================================================
   * 每帧更新：玩家 / 敌人 / 投射物 / 掉落
   * ============================================================ */
  S.updatePlayer = function (state, dt) {
    var p = state.player;
    if (!p.alive) return;
    var mv = Game.Input.getMove();
    p.moveX = mv.x; p.moveY = mv.y;
    var mag = Math.sqrt(mv.x * mv.x + mv.y * mv.y);
    p.moving = mag > 0.05;

    if (p.moving) {
      p.x += mv.x * p.stats.speed * dt;
      p.y += mv.y * p.stats.speed * dt;
      p.facing = Math.atan2(mv.y, mv.x);
      p.walkTime += dt * (p.stats.speed / 30);
    } else {
      p.facing = p.aimFacing;
    }
    p.x = util.clamp(p.x, p.radius, CONST.WORLD_W - p.radius);
    p.y = util.clamp(p.y, p.radius, CONST.WORLD_H - p.radius);

    if (p.invincibleTimer > 0) p.invincibleTimer -= dt;
    if (p.hitFlashTimer > 0) p.hitFlashTimer -= dt;
    if (p.counterFlash > 0) p.counterFlash -= dt;
    p.tickAttackAnim(dt);

    // 护盾缓慢回复
    if (p.stats.shieldMax > 0 && p.stats.shield < p.stats.shieldMax) {
      p.stats.shield = Math.min(p.stats.shieldMax, p.stats.shield + 2 * dt);
    }

    // 武器自动攻击
    for (var i = 0; i < p.weapons.length; i++) {
      p.weapons[i].update(dt, p, state);
    }

    // 角色被动：每帧挂点（缓慢回血、光环刷新等）
    Game.invokePassive(p, 'perTick', state, dt);
  };

  S.updateEnemies = function (state, dt) {
    var es = state.enemies;
    for (var i = es.length - 1; i >= 0; i--) {
      var e = es[i];
      e.update(dt, state.player, state);
      if (e.dead) es.splice(i, 1);
    }
  };

  S.updateProjectiles = function (state, dt) {
    var ps = state.projectiles;
    var player = state.player;
    for (var i = ps.length - 1; i >= 0; i--) {
      var p = ps[i];
      p.update(dt);
      if (p.dead) { ps.splice(i, 1); continue; }

      if (p.fromPlayer) {
        // 打敌人
        for (var j = state.enemies.length - 1; j >= 0; j--) {
          var e = state.enemies[j];
          if (e.dead) continue;
          // 扫掠判定：整条轨迹线段 vs 敌人圆，而非只看本帧终点
          if (util.sweptHit(p.px, p.py, p.x, p.y, e.x, e.y, p.radius + e.radius)) {
            var dx = e.x - player.x, dy = e.y - player.y;
            var dd = Math.sqrt(dx * dx + dy * dy) || 1;
            // 角色被动：远程命中同样计入连击
            var dealt = Game.invokePassive(player, 'onHit',
              { enemy: e, dmg: p.damage, crit: p.crit, weapon: p.owner });
            var pdmg = (typeof dealt === 'number') ? dealt : p.damage;
            // 传入攻击者：坦克会按 counter 比例反弹（见 Enemy.takeDamage）
            var dead = e.takeDamage(pdmg, p.crit, dx / dd * (p.knockback || 0), dy / dd * (p.knockback || 0), p.owner);
            // 吸血 / 命中回血 / 击杀回血
            if (p.owner) {
              if (p.owner.stats.lifesteal > 0) p.owner.heal(pdmg * p.owner.stats.lifesteal);
              if (p.owner.stats.lifeOnHit > 0) p.owner.heal(p.owner.stats.lifeOnHit);
              p.owner.damageDealt += pdmg;
              if (dead && p.owner.stats.lifeOnKill > 0) p.owner.heal(p.owner.stats.lifeOnKill);
            }
            if (dead) e.die(state);
            // 穿透
            if (p.pierce > 0) { p.pierce--; }
            else { p.dead = true; break; }
          }
        }
      } else {
        // 打玩家
        if (player.alive && util.sweptHit(p.px, p.py, p.x, p.y, player.x, player.y, p.radius + player.radius)) {
          player.takeDamage(p.damage);
          p.dead = true;
        }
      }
      if (p.dead) ps.splice(i, 1);
    }
  };

  S.updatePickups = function (state, dt) {
    var pk = state.pickups;
    for (var i = pk.length - 1; i >= 0; i--) {
      pk[i].update(dt, state.player);
      if (pk[i].dead) pk.splice(i, 1);
    }
    // 检测升级
    var p = state.player;
    if (p.level > state.lastLevel) {
      state.levelUpsPending += p.level - state.lastLevel;
      state.lastLevel = p.level;
    }
  };

  /* ============================================================
   * 升级三选一
   * ============================================================ */
  S.rollLevelUpChoices = function (state) {
    var rng = state.rng;
    var choices = [];
    var pool = [];
    var i;

    // 属性升级
    for (i = 0; i < Game.UPGRADES.length; i++) pool.push({ kind: 'upgrade', data: Game.UPGRADES[i] });

    // 新武器（槽位未满）；exclusive 武器只从 Boss 奖励产出
    if (state.player.weapons.length < CONST.MAX_WEAPONS) {
      var wids = Object.keys(Game.WEAPONS);
      for (i = 0; i < wids.length; i++) {
        if (Game.WEAPONS[wids[i]].exclusive) continue;
        pool.push({ kind: 'weapon', data: { weaponId: wids[i] } });
      }
    } else {
      // 已有武器升级
      pool.push({ kind: 'weaponUpgrade', data: {} });
    }

    // 道具
    var iids = Object.keys(Game.ITEMS);
    for (i = 0; i < iids.length; i++) {
      pool.push({ kind: 'item', data: { itemId: iids[i] } });
    }

    // 随机取 3 个（去重）
    while (choices.length < 3 && pool.length > 0) {
      var idx = Math.floor(rng() * pool.length);
      choices.push(pool[idx]);
      pool.splice(idx, 1);
    }
    state.levelUpChoices = choices;
    return choices;
  };

  /**
   * Boss 战奖励三选一：卡片强度高于平时升级池，并按概率塞入 Boss 专属武器。
   * 复用升级三选一的界面与 applyChoice，不引入新 UI。
   * 专属武器允许在槽位已满时给出 —— applyChoice 会挤掉最早加入的那把。
   */
  S.bossRewardChoices = function (state) {
    var rng = state.rng;
    var p = state.player;
    var pool = [];
    var i;

    // 强力属性卡：只收 epic / legend，别把普通卡当奖励发出去
    for (i = 0; i < Game.UPGRADES.length; i++) {
      var u = Game.UPGRADES[i];
      if (u.rarity === 'epic' || u.rarity === 'legend') pool.push({ kind: 'upgrade', data: u });
    }
    // 史诗 / 传说道具
    for (var iid in Game.ITEMS) {
      var it = Game.ITEMS[iid];
      if (it.rarity === 'epic' || it.rarity === 'legend') pool.push({ kind: 'item', data: { itemId: iid } });
    }
    pool.push({ kind: 'weaponUpgrade', data: {} });

    // 普通武器（槽位未满时给）
    if (p.weapons.length < CONST.MAX_WEAPONS) {
      var wids = Object.keys(Game.WEAPONS);
      for (i = 0; i < wids.length; i++) {
        if (Game.WEAPONS[wids[i]].exclusive) continue;
        pool.push({ kind: 'weapon', data: { weaponId: wids[i] } });
      }
    }

    // Boss 专属武器：按概率出现
    if (rng() < Game.BOSS_EXCLUSIVE_CHANCE) {
      var exIds = [];
      for (var eid in Game.WEAPONS) if (Game.WEAPONS[eid].exclusive) exIds.push(eid);
      if (exIds.length > 0) {
        pool.push({
          kind: 'weapon',
          data: { weaponId: exIds[Math.floor(rng() * exIds.length)] },
        });
      }
    }

    // 兜底：候选不足 3 张时补齐。取最强的一张属性卡（优先 epic）。
    // 不按数组末尾取 —— 那只是恰好落在强卡上，池子一改就悄悄退化；
    // 也不取治疗卡（已全部下线），兜底只能是实打实的数值卡。
    var tail = null;
    for (i = 0; i < Game.UPGRADES.length; i++) {
      var upg = Game.UPGRADES[i];
      if (upg.type !== 'stat') continue;
      if (!tail || upg.rarity === 'epic') tail = upg;
    }
    while (pool.length < 3) pool.push({ kind: 'upgrade', data: tail });

    var choices = [];
    while (choices.length < 3 && pool.length > 0) {
      var idx = Math.floor(rng() * pool.length);
      choices.push(pool[idx]);
      pool.splice(idx, 1);
    }
    state.levelUpChoices = choices;
    return choices;
  };

  S.applyChoice = function (state, choice) {
    var p = state.player;
    if (choice.kind === 'upgrade') {
      p.applyUpgrade(choice.data.apply);
    } else if (choice.kind === 'weapon') {
      p.weapons.push(Game.createWeapon(choice.data.weaponId, 1));
      // 槽位已满时挤掉最早加入的那把 —— Boss 奖励的专属武器允许替换旧武器
      if (p.weapons.length > CONST.MAX_WEAPONS) p.weapons.shift();
    } else if (choice.kind === 'weaponUpgrade') {
      // 随机升级一把未满级武器
      var notMax = p.weapons.filter(function (w) { return w.level < 4; });
      if (notMax.length > 0) notMax[Math.floor(Math.random() * notMax.length)].level++;
    } else if (choice.kind === 'item') {
      p.applyItem(choice.data.itemId, 1);
    }
    console.log('[LevelUp] 选择:', choice);
    if (Game.Audio) Game.Audio.levelup();
  };

  /* ============================================================
   * 商店
   * ============================================================ */
  S.openShop = function (state) {
    var rng = state.rng;
    // 上一次的商店：锁定的卡要延续到本次，否则「锁卡锁不住」——
    // 玩家锁了张卡想慢慢挑，只要点了「下一波」，下次进商店锁定就全部丢失。
    var prev = state.shop;
    var shop = {
      items: [],
      refreshCost: 5,
      refreshCount: 0,
      locked: [false, false, false, false],
    };
    for (var i = 0; i < 4; i++) {
      var carry = prev && prev.items ? prev.items[i] : null;
      var wasLocked = !!(prev && prev.locked && prev.locked[i]);
      if (wasLocked && carry && !carry.sold) {
        shop.locked[i] = true;
        shop.items.push(carry);          // 锁定卡本体沿用，玩家锁的就是这一张
      } else {
        // 未锁定，或上一波这张已买走 / 不存在 —— 重新抽，且不残留锁定标记
        // （后者兜底旧存档：买了卡但锁定标记没清掉的情况）
        shop.locked[i] = false;
        shop.items.push(S.rollShopItem(state, rng));
      }
    }
    state.shop = shop;
    state.screen = 'SHOP';
    console.log('[Shop] 打开商店 refreshCost=' + shop.refreshCost);
  };

  S.rollShopItem = function (state, rng) {
    var roll = rng();
    var p = state.player;
    // 权重：道具 50% / 武器 50%。治疗卡下线后原来的 45% 治疗权重平摊给两者。
    if (roll < 0.50) {
      // 道具
      var iids = Object.keys(Game.ITEMS);
      var itemId = iids[Math.floor(rng() * iids.length)];
      var item = Game.ITEMS[itemId];
      return {
        type: 'item', itemId: itemId,
        name: item.name, desc: item.desc, rarity: item.rarity,
        price: S.priceFor(item.rarity, state.wave),
      };
    } else {
      // 武器（新武器或升级）
      if (p.weapons.length < CONST.MAX_WEAPONS) {
        var wids = Object.keys(Game.WEAPONS).filter(function (id) {
          return !Game.WEAPONS[id].exclusive;   // 专属武器只在 Boss 奖励里出
        });
        var wid = wids[Math.floor(rng() * wids.length)];
        var wdef = Game.WEAPONS[wid];
        return {
          type: 'weapon', weaponId: wid,
          name: wdef.name, desc: wdef.desc, rarity: 'rare',
          price: S.priceFor('rare', state.wave),
        };
      } else {
        return {
          type: 'weaponUpgrade',
          name: '武器强化', desc: '随机强化一把武器（最高 4 星）', rarity: 'rare',
          price: S.priceFor('rare', state.wave),
        };
      }
    }
  };

  /** 定价：同一稀有度 + 同一波次 → 同一个价格。
   *  原来带 (rng() * 8 - 4) 的浮动，同一张卡在不同商店里价格不同，读起来像 bug。 */
  S.priceFor = function (rarity, wave) {
    var base = { common: 15, rare: 35, epic: 55, legend: 85 }[rarity] || 20;
    return Math.max(5, base + wave * 2);
  };

  S.buyShopItem = function (state, index) {
    var shop = state.shop;
    var item = shop.items[index];
    var p = state.player;
    if (!item || item.sold) return false;
    if (p.materials < item.price) {
      console.log('[Shop] 材料不足');
      if (Game.Audio) Game.Audio.hurt();
      return false;
    }
    // 未知类型一律不买：老存档可能残留已下线的卡片（治疗卡），
    // 「扣了钱却什么都没发生」比不卖更糟。
    if (item.type !== 'item' && item.type !== 'weapon' && item.type !== 'weaponUpgrade') {
      console.log('[Shop] 未知商品类型:', item.type);
      return false;
    }
    p.materials -= item.price;
    item.sold = true;
    shop.locked[index] = false; // 买掉了就不再需要锁定，避免残留标记污染下次商店
    if (item.type === 'item') p.applyItem(item.itemId, 1);
    else if (item.type === 'weapon') p.weapons.push(Game.createWeapon(item.weaponId, 1));
    else if (item.type === 'weaponUpgrade') {
      var notMax = p.weapons.filter(function (w) { return w.level < 4; });
      if (notMax.length > 0) notMax[Math.floor(Math.random() * notMax.length)].level++;
    }
    if (Game.Audio) Game.Audio.buy();
    console.log('[Shop] 购买:', item.name, '价格=', item.price);
    return true;
  };

  S.refreshShop = function (state) {
    var shop = state.shop;
    if (!shop) return false;
    if (state.player.materials < shop.refreshCost) return false;
    state.player.materials -= shop.refreshCost;
    shop.refreshCount++;
    shop.refreshCost += 2;
    for (var i = 0; i < shop.items.length; i++) {
      if (shop.locked[i] && shop.items[i] && !shop.items[i].sold) continue; // 锁定保留
      shop.items[i] = S.rollShopItem(state, state.rng);
    }
    console.log('[Shop] 刷新 refreshCost=' + shop.refreshCost);
    if (Game.Audio) Game.Audio.buy();
    return true;
  };

  S.toggleLock = function (state, index) {
    var shop = state.shop;
    if (!shop) return;
    shop.locked[index] = !shop.locked[index];
  };

  /* ============================================================
   * 存档序列化 / 反序列化
   * 只存可恢复的最小状态，含随机种子与完整刷新计划，保证读档后波次一致。
   * ============================================================ */
  S.serialize = function (state) {
    var p = state.player;
    return {
      version: 1,
      mode: state.mode,
      chapter: state.chapter,
      wave: state.wave,
      waveTime: state.waveTime,
      waveDuration: state.waveDuration,
      spawnSchedule: state.spawnSchedule,
      spawnIndex: state.spawnIndex,
      isBossWave: state.isBossWave,
      bossSpawned: state.bossSpawned,
      elapsed: state.elapsed,
      seed: state.seed,
      difficulty: state.difficulty,
      player: {
        charId: p.id, x: p.x, y: p.y,
        level: p.level, xp: p.xp, xpNext: p.xpNext, materials: p.materials,
        stats: p.stats, items: p.items,
        weapons: p.weapons.map(function (w) { return { defId: w.defId, level: w.level, cd: w.cooldownRemaining }; }),
        facing: p.facing, aimFacing: p.aimFacing, walkTime: p.walkTime,
        damageTaken: p.damageTaken, healedTotal: p.healedTotal, damageDealt: p.damageDealt,
        passiveState: p.passiveState,
      },
      enemies: state.enemies.map(function (e) {
        return { type: e.type, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, damage: e.damage,
                 speed: e.speed, xp: e.xp, material: e.material, attackCd: e.attackCd,
                 facing: e.facing, animTime: e.animTime, isBoss: e.isBoss };
      }),
      projectiles: state.projectiles.map(function (pr) {
        return { x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, radius: pr.radius, damage: pr.damage,
                 crit: pr.crit, fromPlayer: pr.fromPlayer, pierce: pr.pierce, life: pr.life,
                 color: pr.color, type: pr.type, knockback: pr.knockback };
      }),
      pickups: state.pickups.map(function (pk) {
        return { type: pk.type, value: pk.value, x: pk.x, y: pk.y, magnet: pk.magnet, life: pk.life };
      }),
      stats: state.stats,
      shop: state.shop,
      timestamp: Date.now(),
    };
  };

  S.deserialize = function (obj) {
    var state = {
      screen: 'PLAYING',
      mode: obj.mode || 'campaign',
      chapter: obj.chapter || 1,
      wave: obj.wave || 0,
      waveTime: obj.waveTime || 0,
      waveDuration: obj.waveDuration || 20,
      spawnSchedule: obj.spawnSchedule || [],
      spawnIndex: obj.spawnIndex || 0,
      isBossWave: obj.isBossWave || false,
      bossSpawned: obj.bossSpawned || false,
      elapsed: obj.elapsed || 0,
      seed: obj.seed >>> 0,
      rng: Game.mulberry32(obj.seed >>> 0),
      player: new Game.Player(obj.player.charId),
      enemies: [],
      projectiles: [],
      pickups: [],
      stats: obj.stats || { kills: 0 },
      shop: obj.shop || null,
      levelUpChoices: [],
      lastLevel: obj.player.level || 1,
      levelUpsPending: 0,
      difficulty: obj.difficulty || 'normal',
    };

    // 玩家状态
    var p = state.player;
    p.x = obj.player.x; p.y = obj.player.y;
    p.level = obj.player.level; p.xp = obj.player.xp; p.xpNext = obj.player.xpNext;
    p.materials = obj.player.materials;
    for (var k in obj.player.stats) p.stats[k] = obj.player.stats[k];
    p.items = obj.player.items || {};
    p.weapons = (obj.player.weapons || []).map(function (w) {
      var wi = Game.createWeapon(w.defId, w.level);
      wi.cooldownRemaining = w.cd || 0;
      return wi;
    });
    p.facing = obj.player.facing; p.aimFacing = obj.player.aimFacing;
    p.walkTime = obj.player.walkTime || 0;
    p.damageTaken = obj.player.damageTaken || 0;
    p.healedTotal = obj.player.healedTotal || 0;
    p.damageDealt = obj.player.damageDealt || 0;
    // 被动内部状态（连击层数等）必须随存档往返，否则读档后叠层静默清零
    p.passiveState = obj.player.passiveState || {};

    // 敌人 / 投射物 / 掉落
    state.enemies = (obj.enemies || []).map(function (e) {
      var en = new Game.Enemy(e.type, e.x, e.y, Math.max(1, state.wave), { bossTier: Math.floor(state.wave / 10) || 1 });
      en.hp = e.hp; en.maxHp = e.maxHp; en.damage = e.damage; en.speed = e.speed;
      en.xp = e.xp; en.material = e.material; en.attackCd = e.attackCd;
      en.facing = e.facing; en.animTime = e.animTime; en.isBoss = e.isBoss;
      return en;
    });
    state.projectiles = (obj.projectiles || []).map(function (pr) {
      var pj = new Game.Projectile({ x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, radius: pr.radius,
        damage: pr.damage, crit: pr.crit, fromPlayer: pr.fromPlayer, pierce: pr.pierce,
        life: pr.life, color: pr.color, type: pr.type, knockback: pr.knockback });
      return pj;
    });
    state.pickups = (obj.pickups || []).map(function (pk) {
      var pi = new Game.Pickup(pk.type, pk.value, pk.x, pk.y);
      pi.magnet = pk.magnet; pi.life = pk.life;
      return pi;
    });

    state.player.state = state;   // 同 createState：拾取物需要回指整个 state
    return state;
  };
})();
