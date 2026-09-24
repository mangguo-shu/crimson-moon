/* ============================================================
 * entities.js —— 核心实体类
 * Player（玩家）、Enemy（敌人）、Projectile（投射物）、Pickup（掉落物）
 * 特效与音效统一通过 Game.FX / Game.Audio 触发，避免与渲染层强耦合。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;
  var CONST = Game.CONST;

  function fx() { return Game.FX; }

  /* ============================================================
   * Player
   * ============================================================ */
  function Player(charId) {
    var c = null;
    var chars = Game.CHARACTERS;
    for (var i = 0; i < chars.length; i++) if (chars[i].id === charId) c = chars[i];
    if (!c) c = chars[0];

    this.char = c;
    this.id = c.id;
    this.name = c.name;
    this.x = CONST.WORLD_W / 2;
    this.y = CONST.WORLD_H / 2;
    this.radius = 16;

    this.stats = {
      maxHp: c.baseHp, hp: c.baseHp,
      speed: c.speed,
      damage: c.damage,        // 伤害倍率
      attackSpeed: c.attackSpeed,
      critChance: c.critChance,
      critMult: c.critMult,
      armor: c.armor,
      lifesteal: 0,            // 吸血（造成伤害百分比回血）
      lifeOnHit: 0,            // 命中回血
      lifeOnKill: 0,           // 击杀回血
      healingPower: 1.0,       // 治疗加成
      shield: 0, shieldMax: 0, // 护盾
      pickupSpeed: Game.DROP.pickupSpeed, // 掉落物被吸起时的初速（吸铁石会拉满）
    };

    this.level = 1;
    this.xp = 0;
    this.xpNext = this.xpForLevel(1);
    this.materials = 0;

    this.weapons = [];         // WeaponInstance 列表
    this.items = {};           // itemId -> 堆叠数
    this.passive = c.passive;  // { id, name, desc }
    this.passiveState = {};    // 被动内部状态（连击层数等），随存档持久化

    this.facing = -Math.PI / 2;      // 视觉朝向（移动优先，其次瞄准）
    this.aimFacing = -Math.PI / 2;   // 攻击瞄准方向
    this.moveX = 0; this.moveY = 0;
    this.walkTime = 0;
    this.moving = false;

    this.invincibleTimer = 0;
    this.hitFlashTimer = 0;
    this.counterFlash = 0;   // 反伤专用闪色计时（与受击白闪区分，见 renderer 取色）
    this.alive = true;

    // 攻击动作（纯表现：只驱动绘制姿态，不参与伤害判定与冷却）
    // { kind: 'melee' | 'ranged', t: 已播时长, dur: 总时长 }
    this.attackAnim = null;

    // 本局统计（用于结算面板）
    this.damageTaken = 0;   // 承受总伤害
    this.healedTotal = 0;   // 治疗总量
    this.damageDealt = 0;   // 造成总伤害
  }

  Player.prototype.xpForLevel = function (lvl) { return 5 + lvl * 4; };

  /** 触发攻击动作（纯表现）。kind: 'melee' 下劈 / 'ranged' 后坐 */
  Player.prototype.playAttack = function (kind) {
    this.attackAnim = { kind: kind, t: 0, dur: kind === 'melee' ? 0.30 : 0.20 };
  };

  /** 推进攻击动作计时；播完即清空 */
  Player.prototype.tickAttackAnim = function (dt) {
    var a = this.attackAnim;
    if (!a) return;
    a.t += dt;
    if (a.t >= a.dur) this.attackAnim = null;
  };

  /** 应用被动道具（可叠加） */
  Player.prototype.applyItem = function (itemId, count) {
    count = count || 1;
    this.items[itemId] = (this.items[itemId] || 0) + count;
    var item = Game.ITEMS[itemId];
    if (!item) return;
    this._applyStatDelta(item.stat, count);
  };

  /** 应用升级选项。即时回血卡已下线，这里只剩数值卡。 */
  Player.prototype.applyUpgrade = function (apply) {
    this._applyStatDelta(apply, 1);
  };

  /** 内部：按属性键应用增量，处理 maxHp / 百分比 / 护甲等 */
  Player.prototype._applyStatDelta = function (stat, mult) {
    var s = this.stats;
    for (var k in stat) {
      var v = stat[k] * mult;
      if (k === 'maxHp') {
        s.maxHp += v;
        s.hp += v;
      } else if (k === 'speed' || k === 'damage' || k === 'attackSpeed' ||
                 k === 'critChance' || k === 'lifesteal') {
        s[k] += v; // 百分比/倍率类
      } else if (k === 'critMult' || k === 'armor' || k === 'lifeOnHit' ||
                 k === 'lifeOnKill' || k === 'healingPower' || k === 'shieldMax') {
        s[k] += v;
      }
    }
    // 上限修正
    if (s.hp > s.maxHp) s.hp = s.maxHp;
    s.speed = Math.max(80, s.speed);
    s.attackSpeed = Math.max(0.4, s.attackSpeed);
  };

  /** 治疗：过量治疗转化为护盾。
   *  opts.audio === false / opts.fx === false 关掉对应表现 —— 高频触发的被动
   *  （回春每 2 秒一次、掠影每次击杀一次）如果每次都响治疗音会非常吵。 */
  Player.prototype.heal = function (amount, opts) {
    opts = opts || {};
    var s = this.stats;
    var real = amount * s.healingPower;
    this.healedTotal += real;
    var missing = s.maxHp - s.hp;
    var toHp = Math.min(real, missing);
    s.hp += toHp;
    var overflow = real - toHp;
    if (overflow > 0 && s.shieldMax > 0) {
      s.shield = Math.min(s.shieldMax, s.shield + overflow);
    }
    if (fx() && opts.fx !== false) fx().heal(this.x, this.y);
    if (Game.Audio && opts.audio !== false) Game.Audio.heal();
    return toHp + (overflow > 0 ? Math.min(s.shieldMax, s.shield + overflow) - s.shield : 0);
  };

  /** 承受伤害（含护甲减伤、护盾、无敌帧）。返回实际扣血。
   *  cause === 'counter'：由怪物反伤反弹而来（见 Enemy.takeDamage），
   *  视觉上叠一层青色闪色，让玩家分清「这是被反弹的」。
   *  反伤和普通伤害走同一条减伤管线，不豁免护甲 / 护盾 / 无敌帧 / 被动减免。 */
  Player.prototype.takeDamage = function (raw, cause) {
    var s = this.stats;
    if (!this.alive || this.invincibleTimer > 0) return 0;
    if (Game.debugGod) return 0; // 调试无敌
    // 角色被动：承伤减免。「格挡」在这里把伤害减到 0，走下面的免伤分支。
    var dealt = Game.invokePassive(this, 'onDamageTaken', raw);
    var blocked = (typeof dealt === 'number' && dealt <= 0);
    if (typeof dealt === 'number') raw = blocked ? 0 : dealt;
    if (blocked) {
      // 格挡成立：不当作受击。不扣血、不闪白、不播痛音、不占无敌帧 ——
      // 挡下一击不该换来额外的无敌时间；给点金属火花让挡下这件事看得见。
      if (fx()) { fx().spark(this.x, this.y, 4); fx().ring(this.x, this.y, 24, '#ffcf5e'); }
      return 0;
    }
    this.damageTaken += raw;
    // 护甲减伤：减伤 = 护甲 / (护甲 + 30)，上限 80%
    var reduction = s.armor / (s.armor + 30);
    if (reduction > 0.8) reduction = 0.8;
    var dmg = raw * (1 - reduction);
    // 护盾优先
    var hpDmg = 0;
    if (s.shield > 0) {
      var shieldTake = Math.min(s.shield, dmg);
      s.shield -= shieldTake;
      dmg -= shieldTake;
      if (fx()) fx().shieldBreak(this.x, this.y);
    }
    hpDmg = dmg;
    s.hp -= hpDmg;
    this.invincibleTimer = 0.35; // 无敌帧
    this.hitFlashTimer = 0.18;
    if (cause === 'counter') this.counterFlash = 0.3;
    if (fx()) {
      fx().blood(this.x, this.y, 6);
      if (cause === 'counter') fx().spark(this.x, this.y, 5);
      fx().shake(cause === 'counter' ? 4 : 6);
    }
    if (Game.Audio) Game.Audio.hurt();
    if (Game.Native) Game.Native.vibrate(40);
    if (s.hp <= 0) { s.hp = 0; this.alive = false; }
    return hpDmg;
  };

  /** 获得经验，返回升级次数 */
  Player.prototype.addXp = function (v) {
    this.xp += v;
    var ups = 0;
    while (this.xp >= this.xpNext && ups < 50) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = this.xpForLevel(this.level);
      ups++;
    }
    return ups;
  };

  /* ============================================================
   * Enemy
   * ============================================================ */
  Enemy._uid = 0;  // 全局自增，给 Enemy 构造函数用

  function Enemy(type, x, y, wave, opts) {
    opts = opts || {};
    var def = Game.ENEMIES[type];
    this.type = type;
    this.def = def;
    this.uid = ++Enemy._uid;  // 唯一编号，被动用它区分「同一目标」（同类型怪 uid 不同）
    this.x = x; this.y = y;
    this.radius = def.radius;
    this.isBoss = type === 'boss';

    // 波次成长系数
    var w = Math.max(1, wave);
    var hpScale = 1 + 0.18 * (w - 1);
    var dmgScale = 1 + 0.12 * (w - 1);
    var spdScale = Math.min(1.6, 1 + 0.02 * (w - 1));

    this.maxHp = def.hp * hpScale;
    if (this.isBoss) this.maxHp = def.hp * hpScale * (1 + 0.5 * ((opts.bossTier || 1) - 1));
    this.hp = this.maxHp;
    this.damage = def.damage * dmgScale;
    this.speed = def.speed * spdScale;
    this.xp = def.xp;
    this.material = def.material;

    this.attackCd = 0;
    this.hitFlash = 0;
    this.counter = def.counter || 0;  // 反伤比例：仅坦克配置，旧怪恒为 0（行为不变）
    this.counterFlash = 0;           // 反伤预警光晕的脉动/触发计时（纯表现）
    this.knockbackX = 0; this.knockbackY = 0;
    this.facing = 0;
    this.animTime = Math.random() * 10;
    this.dead = false;
    this.armorPierce = 0; // 破甲比例（后续高波次破甲怪使用）

    // 攻击动作（纯表现）
    // { kind: 'lunge' 跳尸前扑 | 'dive' 蝠妖俯冲 | 'cast' 邪修施法 | 'boss' 年兽拍击 }
    this.attackAnim = null;
  }

  /** 触发攻击动作（纯表现）。 */
  Enemy.prototype.playAttack = function (kind) {
    var dur = kind === 'boss' ? 0.55 : (kind === 'cast' ? 0.45 : 0.28);
    this.attackAnim = { kind: kind, t: 0, dur: dur };
  };

  /** 推进攻击动作计时；播完即清空 */
  Enemy.prototype.tickAttackAnim = function (dt) {
    var a = this.attackAnim;
    if (!a) return;
    a.t += dt;
    if (a.t >= a.dur) this.attackAnim = null;
  };

  Enemy.prototype.update = function (dt, player, state) {
    this.animTime += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.counterFlash > 0) this.counterFlash -= dt;
    this.attackCd -= dt;
    this.tickAttackAnim(dt);

    var dx = player.x - this.x, dy = player.y - this.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    this.facing = Math.atan2(dy, dx);

    // 击退衰减
    this.x += this.knockbackX * dt;
    this.y += this.knockbackY * dt;
    this.knockbackX *= Math.pow(0.001, dt);
    this.knockbackY *= Math.pow(0.001, dt);

    var def = this.def;
    var behavior = def.behavior;

    if (behavior === 'chase' || behavior === 'flyer') {
      // 靠近到一定距离后接触攻击
      var stopDist = this.radius + player.radius + 2;
      if (d > stopDist) {
        var spd = this.speed;
        this.x += dx / d * spd * dt;
        this.y += dy / d * spd * dt;
      } else if (this.attackCd <= 0) {
        // 接触伤害
        player.takeDamage(this.damage);
        this.attackCd = def.attackCd;
        this.playAttack(behavior === 'flyer' ? 'dive' : 'lunge');
        if (behavior === 'flyer') {
          // 血蝠攻击后小幅后撤
          this.knockbackX -= dx / d * 60;
          this.knockbackY -= dy / d * 60;
        }
      }
    } else if (behavior === 'shooter') {
      // 保持距离，远程施法
      var keep = 260;
      if (d < keep - 30) {
        this.x -= dx / d * this.speed * dt;
        this.y -= dy / d * this.speed * dt;
      } else if (d > keep) {
        this.x += dx / d * this.speed * dt;
        this.y += dy / d * this.speed * dt;
      }
      if (this.attackCd <= 0 && d < keep + 60) {
        this.attackCd = def.attackCd;
        this.playAttack('cast');
        state.projectiles.push(new Projectile({
          x: this.x, y: this.y,
          vx: dx / d * def.projectileSpeed, vy: dy / d * def.projectileSpeed,
          radius: 7, damage: this.damage, fromPlayer: false,
          life: 3, color: '#c48aff', type: 'spell',
        }));
        if (fx()) fx().cast(this.x, this.y);
      }
    } else if (behavior === 'boss') {
      // Boss：缓慢逼近 + 弹幕 + 冲刺
      if (d > this.radius + player.radius + 40) {
        this.x += dx / d * this.speed * dt;
        this.y += dy / d * this.speed * dt;
      }
      if (this.attackCd <= 0) {
        this.attackCd = def.attackCd;
        this.playAttack('boss');
        this._bossAttack(player, state, dx, dy, d);
      }
    }

    // 限制在地图内
    this.x = util.clamp(this.x, this.radius, CONST.WORLD_W - this.radius);
    this.y = util.clamp(this.y, this.radius, CONST.WORLD_H - this.radius);
  };

  // Boss 攻击：扇形弹幕 + 召唤小怪
  Enemy.prototype._bossAttack = function (player, state, dx, dy, d) {
    var def = this.def;
    var base = this.facing;
    var n = 7;
    for (var i = 0; i < n; i++) {
      var a = base + (i - (n - 1) / 2) * (Math.PI / 8);
      state.projectiles.push(new Projectile({
        x: this.x, y: this.y,
        vx: Math.cos(a) * def.projectileSpeed, vy: Math.sin(a) * def.projectileSpeed,
        radius: 8, damage: this.damage * 0.7, fromPlayer: false,
        life: 4, color: '#ff5e6e', type: 'spell',
      }));
    }
    if (fx()) fx().bossCast(this.x, this.y);
    if (Game.Audio) Game.Audio.boss();
    // 每隔几次攻击召唤小怪（由外部 state 控制，这里简单概率）
    if (state.rng() < 0.4 && state.enemies.length < 60) {
      for (var k = 0; k < 3; k++) {
        var p = util.onCircle(this.x, this.y, 60, Math.random() * Math.PI * 2);
        state.enemies.push(new Enemy('bat', p.x, p.y, state.wave));
      }
    }
  };

  /** 承受伤害，返回是否死亡。
   *  attacker：攻击者（Player）。本怪配置了 counter 时，把该次伤害按 counter 比例
   *  反弹给它 —— 走 Player.takeDamage，因此同样吃护甲 / 护盾 / 无敌帧。
   *  三条约定：不暴击反弹（crit 不参与）、致死一击不反弹（死了就不再反弹）、
   *  counter 为 0 时完全不触发（旧怪无此行为，基线不动）。 */
  Enemy.prototype.takeDamage = function (dmg, crit, kbx, kby, attacker) {
    if (this.dead) return false;
    this.hp -= dmg;
    this.hitFlash = 0.12;
    if (kbx || kby) {
      this.knockbackX += (kbx || 0);
      this.knockbackY += (kby || 0);
    }
    if (fx()) {
      fx().blood(this.x, this.y, crit ? 10 : 4);
      if (crit) {
        fx().crit(this.x, this.y);
        // 暴击抖屏挪到这里：原来只挂在近战路径（weapons.js _applyHit），
        // 远程暴击毫无反馈。crit 本就已传进本函数，近战远程由此统一。
        fx().shake(3);
      }
      // 伤害飘字：此前游戏里没有任何伤害数字，暴击只有一圈金环，
      // 玩家无从目视核验暴击倍率。显示的是已含被动加成的结算值。
      fx().damageNumber(this.x, this.y - this.radius - 8, dmg, crit);
    }
    if (this.hp <= 0) { this.dead = true; return true; }
    if (this.counter > 0 && attacker && typeof attacker.takeDamage === 'function') {
      this.counterFlash = 0.35;
      attacker.takeDamage(dmg * this.counter, 'counter');
      if (fx()) {
        fx().ring(this.x, this.y, this.radius + 16, this.def.color3 || '#8fd0e8');
        fx().spark(attacker.x, attacker.y, 3);
      }
    }
    return false;
  };

  /** 死亡：掉落经验/材料/宝箱 + 碎裂特效。
   *  各怪的 xp / material 本体数值冻结在 ENEMIES 里不动，倍数集中在
   *  config.js 的 Game.DROP 一张表里调 —— 想改掉落手感只动那一处。 */
  Enemy.prototype.die = function (state) {
    var D = Game.DROP;
    var jx = function () { return util.rand(state.rng, -8, 8); };
    state.pickups.push(new Pickup('xp', Math.ceil(this.xp * D.xpMult),
      this.x + jx(), this.y + jx()));
    if (state.rng() < D.matChance) {
      state.pickups.push(new Pickup('material', Math.ceil(this.material * D.matMult),
        this.x + jx(), this.y + jx()));
    }
    // 宝箱：Boss 固定给回血 + 吸铁石各一；小怪按概率给，回血 / 吸铁石二选一。
    if (this.isBoss) {
      for (var ci = 0; ci < D.bossChests.length; ci++) {
        var bk = D.bossChests[ci];
        state.pickups.push(new Pickup(bk, bk === 'heal' ? D.chestHeal * D.bossChestHealMult : 0,
          this.x + util.rand(state.rng, -40, 40), this.y + util.rand(state.rng, -40, 40)));
      }
    } else if (state.rng() < D.chestChance) {
      var kind = state.rng() < D.chestMagnetChance ? 'magnet' : 'heal';
      state.pickups.push(new Pickup(kind, kind === 'heal' ? D.chestHeal : 0,
        this.x + util.rand(state.rng, -16, 16), this.y + util.rand(state.rng, -16, 16)));
    }
    if (fx()) fx().death(this.x, this.y, this.isBoss);
    if (this.isBoss && fx()) fx().shake(18);
    // Boss 阵亡先给奖励面板，再结算波次（见 G._triggerBossReward）
    if (this.isBoss) state.bossRewardPending = true;
    // 角色被动：onKill（吸血、叠 buff 等）
    if (state.player) Game.invokePassive(state.player, 'onKill', this, state);
    state.stats.kills++;
  };

  /* ============================================================
   * Projectile
   * ============================================================ */
  function Projectile(opts) {
    this.x = opts.x; this.y = opts.y;
    this.px = this.x; this.py = this.y;   // 上一帧位置：扫掠碰撞的线段起点
    this.vx = opts.vx; this.vy = opts.vy;
    this.radius = opts.radius || 6;
    this.damage = opts.damage;
    this.crit = !!opts.crit;
    this.fromPlayer = !!opts.fromPlayer;
    this.pierce = opts.pierce || 0;
    this.life = opts.life || 3;
    this.color = opts.color || '#fff';
    this.type = opts.type || 'bullet';
    this.knockback = opts.knockback || 0;
    this.owner = opts.owner || null;
    this.dead = false;
    this.angle = Math.atan2(this.vy, this.vx);
  }

  Projectile.prototype.update = function (dt) {
    // 先记下起点再位移：updateProjectiles 用 (px,py)→(x,y) 做扫掠判定。
    // 只判终点的话，低帧率下一大步会把整个敌人踩过去（见 util.sweptHit）。
    this.px = this.x;
    this.py = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
    // 出界
    if (this.x < -40 || this.x > CONST.WORLD_W + 40 || this.y < -40 || this.y > CONST.WORLD_H + 40) {
      this.dead = true;
    }
  };

  /* ============================================================
   * Pickup（经验 / 材料）
   * ============================================================ */
  function Pickup(type, value, x, y) {
    this.type = type;       // 'xp' | 'material' | 'heal' | 'magnet'
    this.value = value;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.magnet = false;
    this.life = 60;         // 超时消失（秒）
    this.dead = false;
    this.bob = Math.random() * Math.PI * 2;
  }

  /** 吸铁石：把场上已有的全部掉落物一下吸起来。
   *  给每个拾取物设初速指向玩家，update 里下一帧就会按磁铁逻辑接管；
   *  同时把 magnet 置真，让它拿到 400 的捕获半径（而不是默认的 90）。
   *  箱子本身不吸（吸完就没箱子了）。 */
  Pickup.prototype.pullBy = function (player) {
    var dx = player.x - this.x, dy = player.y - this.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var sp = (player.stats.pickupSpeed || Game.DROP.pickupSpeed) * 1.3;
    this.vx = dx / d * sp;
    this.vy = dy / d * sp;
    this.magnet = true;
  };

  Pickup.prototype.update = function (dt, player) {
    this.bob += dt * 4;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    var dx = player.x - this.x, dy = player.y - this.y;
    var d2 = dx * dx + dy * dy;
    var magnetR = this.magnet ? 400 : 90;
    var collectR = 22;

    if (d2 < magnetR * magnetR) {
      this.magnet = true;
      // 加速飞向玩家（带弧线感的简单直线加速）
      var d = Math.sqrt(d2) || 1;
      var sp = this.type === 'material'
        ? (player.stats.pickupSpeed || Game.DROP.pickupSpeed) * 0.85
        : (player.stats.pickupSpeed || Game.DROP.pickupSpeed);
      this.vx = dx / d * sp;
      this.vy = dy / d * sp;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (d2 < collectR * collectR) {
      // 拾取
      this.dead = true;
      if (this.type === 'xp') {
        var ups = player.addXp(this.value);
        if (fx()) fx().pickup(this.x, this.y, '#9dff7a');
        if (ups > 0) { if (Game.Audio) Game.Audio.levelup(); }
      } else if (this.type === 'material') {
        player.materials += this.value;
        if (fx()) fx().pickup(this.x, this.y, '#ffcf5e');
        if (Game.Audio) Game.Audio.pickup();
      } else if (this.type === 'heal') {
        // 回血箱：走 heal()，过量转化护盾由 heal 内部处理
        var healed = player.heal(this.value);
        if (fx()) fx().heal(this.x, this.y);
        if (Game.Audio) Game.Audio.heal();
      } else if (this.type === 'magnet') {
        // 吸铁石：全场拾取物立即被吸过来，并永久提速
        var all = player.state.pickups;
        for (var i = 0; i < all.length; i++) {
          if (all[i] === this) continue;
          if (all[i].type === 'xp' || all[i].type === 'material') all[i].pullBy(player);
        }
        if (fx()) fx().ring(this.x, this.y, 150, '#8fd0e8');
        if (Game.Audio) Game.Audio.buy();
      }
    }
  };

  // 导出
  Game.Player = Player;
  Game.Enemy = Enemy;
  Game.Projectile = Projectile;
  Game.Pickup = Pickup;
})();
