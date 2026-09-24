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
    return state;
  };

  /* ============================================================
   * 波次管理
   * ============================================================ */
  S.waveDuration = function (wave) {
    return Math.min(45, 20 + (wave - 1));
  };

  S.isBossWave = function (wave) {
    return wave % 10 === 0;
  };

  /** 预生成整波刷新计划（用与 seed+wave 绑定的独立 RNG，保证读档一致） */
  S.buildSpawnSchedule = function (state, wave) {
    var schedule = [];
    var waveRng = Game.mulberry32(Game.hashSeed(state.seed + ':' + wave));
    var budget = 8 + wave * 6;
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
    // 高波次增加巫师（远程）比例
    var wizardChance = 0.15 + Math.min(0.2, wave * 0.01);
    var batChance = 0.3;
    if (r < wizardChance) return 'wizard';
    if (r < wizardChance + batChance) return 'bat';
    return 'zombie';
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
      // Boss 波：Boss 死亡且已出场后结束
      var anyBoss = false;
      for (var i = 0; i < state.enemies.length; i++) if (state.enemies[i].isBoss) anyBoss = true;
      if (state.bossSpawned && !anyBoss) {
        this.clearEnemies(state);
        return 'ended';
      }
    } else {
      // 普通波：计时结束，或所有敌人清空且刷新完毕
      var aliveCount = 0;
      for (var k = 0; k < state.enemies.length; k++) if (!state.enemies[k].dead) aliveCount++;
      if (state.waveTime >= state.waveDuration && aliveCount === 0) {
        return 'ended';
      }
      // 提前清场（刷完且杀光）
      if (state.spawnIndex >= state.spawnSchedule.length && aliveCount === 0 && state.waveTime > 1) {
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
    p.tickAttackAnim(dt);

    // 护盾缓慢回复
    if (p.stats.shieldMax > 0 && p.stats.shield < p.stats.shieldMax) {
      p.stats.shield = Math.min(p.stats.shieldMax, p.stats.shield + 2 * dt);
    }

    // 武器自动攻击
    for (var i = 0; i < p.weapons.length; i++) {
      p.weapons[i].update(dt, p, state);
    }
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
          var d = util.dist(p.x, p.y, e.x, e.y);
          if (d <= p.radius + e.radius) {
            var dx = e.x - player.x, dy = e.y - player.y;
            var dd = Math.sqrt(dx * dx + dy * dy) || 1;
            var dead = e.takeDamage(p.damage, p.crit, dx / dd * (p.knockback || 0), dy / dd * (p.knockback || 0));
            // 吸血 / 命中回血 / 击杀回血
            if (p.owner) {
              if (p.owner.stats.lifesteal > 0) p.owner.heal(p.damage * p.owner.stats.lifesteal);
              if (p.owner.stats.lifeOnHit > 0) p.owner.heal(p.owner.stats.lifeOnHit);
              p.owner.damageDealt += p.damage;
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
        var dp = util.dist(p.x, p.y, player.x, player.y);
        if (dp <= p.radius + player.radius && player.alive) {
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

    // 新武器（槽位未满）
    if (state.player.weapons.length < CONST.MAX_WEAPONS) {
      var wids = Object.keys(Game.WEAPONS);
      for (i = 0; i < wids.length; i++) {
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

  S.applyChoice = function (state, choice) {
    var p = state.player;
    if (choice.kind === 'upgrade') {
      p.applyUpgrade(choice.data.apply);
    } else if (choice.kind === 'weapon') {
      p.weapons.push(Game.createWeapon(choice.data.weaponId, 1));
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
    if (roll < 0.30) {
      // 道具
      var iids = Object.keys(Game.ITEMS);
      var itemId = iids[Math.floor(rng() * iids.length)];
      var item = Game.ITEMS[itemId];
      return {
        type: 'item', itemId: itemId,
        name: item.name, desc: item.desc, rarity: item.rarity,
        price: S.priceFor(item.rarity, state.wave, rng),
      };
    } else if (roll < 0.55) {
      // 武器（新武器或升级）
      if (p.weapons.length < CONST.MAX_WEAPONS) {
        var wids = Object.keys(Game.WEAPONS);
        var wid = wids[Math.floor(rng() * wids.length)];
        var wdef = Game.WEAPONS[wid];
        return {
          type: 'weapon', weaponId: wid,
          name: wdef.name, desc: wdef.desc, rarity: 'rare',
          price: S.priceFor('rare', state.wave, rng),
        };
      } else {
        return {
          type: 'weaponUpgrade',
          name: '武器强化', desc: '随机强化一把武器（最高 4 星）', rarity: 'rare',
          price: S.priceFor('rare', state.wave, rng),
        };
      }
    } else {
      // 治疗
      return {
        type: 'heal', name: '急救包', desc: '恢复 50 点生命', rarity: 'common',
        price: S.priceFor('common', state.wave, rng),
      };
    }
  };

  S.priceFor = function (rarity, wave, rng) {
    var base = { common: 15, rare: 35, epic: 55, legend: 85 }[rarity] || 20;
    var price = Math.round(base + wave * 2 + (rng() * 8 - 4));
    return Math.max(5, price);
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
    p.materials -= item.price;
    item.sold = true;
    shop.locked[index] = false; // 买掉了就不再需要锁定，避免残留标记污染下次商店
    if (item.type === 'item') p.applyItem(item.itemId, 1);
    else if (item.type === 'weapon') p.weapons.push(Game.createWeapon(item.weaponId, 1));
    else if (item.type === 'weaponUpgrade') {
      var notMax = p.weapons.filter(function (w) { return w.level < 4; });
      if (notMax.length > 0) notMax[Math.floor(Math.random() * notMax.length)].level++;
    }
    else if (item.type === 'heal') p.heal(50);
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

    return state;
  };
})();
