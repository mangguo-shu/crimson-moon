/* ============================================================
 * weapons.js —— 武器实例
 * 负责自动攻击：冷却计时、索敌、近战挥砍 / 远程射击、暴击与吸血结算。
 * 合成/星级系统留到后续轮次，当前用 level 表示强化等级。
 *
 * 多把武器的表现：每把武器挂在玩家身边一圈上，整圈慢速旋转（纯画面）。
 * 索敌不做角度过滤 —— 永远打射程内最近的那个，剑转到哪儿不影响能不能打。
 * 圆心是**玩家**、半径是近战射程，不是武器 —— 以武器为圆心时贴着玩家的敌人
 * 全落在武器背后，内环永远打不到。
 * 每把武器冷却互不影响；同一帧里按顺序各挑一个「还没被别的武器处理」的目标，
 * 所以两把武器遇到上下两个敌人会各打一个，而不是都去打同一个。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;

  // 弹体造型按武器 id 派生，**不加进 WEAPONS 表** —— 武器表本体在冻结区，
  // 只准通过 CONST 系数调（见 RANGED_DMG_SCALE 那一块的说明）。
  // renderer._drawProjectile 按这个键分支：'arrow' 画箭矢，其余按子弹画。
  // 之前所有远程弹共用一条金色胶囊，手枪 #ffd76e 打出来是一串铜钱。
  var PROJ_SHAPE = {
    pistol: 'bullet',
    jade_crossbow: 'arrow',
  };

  function fx() { return Game.FX; }

  /** 两角之差，wrap 到 [0, π]。近战挥砍用它判断敌人有没有落进这道扇形。 */
  function angDiff(a, b) {
    return Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  }

  /* ---------------- 环绕布置 ----------------
   * 角度的唯一出处。渲染侧画卫星图标时调它取同一个角，不然逻辑在打那边、
   * 图标在另一边飘，一眼穿帮。index 取武器在 player.weapons 里的序号，
   * count 取当前武器数 —— 新拿一把武器整圈重新均分，旧的不用记位置。
   *
   * 整圈按 WEAPON_ORBIT_SPEED 慢速旋转，纯画面 —— 转到哪儿不影响打哪儿，
   * 索敌看全场（见 nearestFree）。
   *
   * 返回值必须归一化到 [-π, π]：cos/sin 不在乎角度大小，但「角度差取模」在乎。
   * 取模一旦吃掉大数目的周期，double 精度全丢，结果不是差值而是随机垃圾 ——
   * 表现为武器永远「背对」敌人、一刀砍不出去。
   * 时间项先按「整圈周期」取模再换算弧度，让参与运算的量始终在 [0, 2π) 内。 */
  Game.orbitSlot = function (count, index) {
    if (!count || count < 1) return 0;
    var K = Game.CONST;
    var t = performance.now();
    var phase = ((t / 1000 % (Math.PI * 2 / K.WEAPON_ORBIT_SPEED)) * K.WEAPON_ORBIT_SPEED);
    var a = (index / count) * Math.PI * 2 + phase + K.WEAPON_ORBIT_OFFSET;
    a %= Math.PI * 2;
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  function WeaponInstance(defId, level, slot) {
    this.defId = defId;
    this.def = Game.WEAPONS[defId];
    this.level = level || 1;
    this.cooldownRemaining = 0;
    this.slot = slot || 0;   // 槽位序号 → 轨道角度
    this.swingTime = 0;      // 距上次出手多久（渲染画出手余韵用；不持久化）
    this.swingAim;           // 上次出手的朝向：剑身绕它挥、弩机朝它放箭（不持久化）
  }

  /** 本把武器挂在轨道上的位置。纯查询、不改状态：
   *  测试想提前摆一个「就在武器旁边」的敌人时也走这里。 */
  WeaponInstance.prototype.posAt = function (owner) {
    var r = Game.CONST.WEAPON_ORBIT_R;
    var a = Game.orbitSlot(owner.weapons.length, this.slot);
    return { x: owner.x + Math.cos(a) * r, y: owner.y + Math.sin(a) * r, a: a };
  };

  WeaponInstance.prototype.damage = function (owner) {
    var d = this.def.damage * (1 + 0.5 * (this.level - 1));
    // 远程统一压一档：环绕后近战能打到玩家身后，远程该让位（用户 2026-09-25 点名）
    if (this.def.type === 'ranged') d *= Game.CONST.RANGED_DMG_SCALE;
    return d * owner.stats.damage;
  };
  WeaponInstance.prototype.cooldown = function (owner) {
    return this.def.cooldown / owner.stats.attackSpeed;
  };
  /** 有效攻击距离。只近战用（远程靠子弹射程，range 字段无意义）。 */
  WeaponInstance.prototype.range = function () {
    return this.def.range * Game.CONST.MELEE_RANGE_SCALE;
  };

  /** 在 (x,y) 为圆心的全场范围内找最近的一个敌人，跳过本帧已被别的武器处理的。
   *  没有角度门槛 —— 剑的朝向只管画面，不再决定能不能打到（用户 2026-09-26：
   *  「怪物在上方，即使剑转到了下方，也可以攻击上方的怪物」）。多把武器要各打
   *  各的目标，所以按更新顺序跳过 `claimed` 里已经有人要的。 */
  WeaponInstance.prototype.nearestFree = function (state, x, y, claimed) {
    var best = null, bestD = Infinity;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      if (claimed && claimed[e.uid] === true) continue;
      var d = util.dist2(x, y, e.x, e.y);
      if (d >= bestD) continue;
      bestD = d; best = e;
    }
    return { enemy: best, dist: best === null ? Infinity : Math.sqrt(bestD) };
  };

  /** 挥砍扇形半角 = WEAPON_ARC / 2 = 30°。
   *  扇形不再用来限制索敌（索敌看全场），只决定「朝目标挥出去时，顺带扫到
   *  多少邻居」。取 360°/6 让六把武器正好排满一圈。 */
  WeaponInstance.prototype.arcHalf = function () {
    return Game.CONST.WEAPON_ARC / 2;
  };

  /** 每帧更新；自动攻击。命中范围是「以玩家为圆心、半径 = 近战射程」的整圈，
   *  不做角度过滤 —— 剑的朝向只管画面。武器更新顺序决定目标分配，所以
   *  Systems.updatePlayer 里要先清一次 state._claimedThisFrame。 */
  WeaponInstance.prototype.update = function (dt, owner, state) {
    var pos = this.posAt(owner);
    this.x = pos.x; this.y = pos.y; this.aimAngle = pos.a;  // 渲染用
    this.cooldownRemaining -= dt;
    this.swingTime += dt;                                    // 出手余韵计时
    if (this.cooldownRemaining > 0) return;

    var claimed = state._claimedThisFrame || (state._claimedThisFrame = {});
    var t = this.nearestFree(state, owner.x, owner.y, claimed);
    if (!t.enemy) t = this.nearestFree(state, owner.x, owner.y, null);
    //         ↑ 目标全被别的武器占了就打「已被占的那个」—— 敌人比武器少时
    //           每把武器都得有活干，不能因为别人先出手就整把闲置。
    var enemy = t.enemy;
    if (!enemy) return;   // 场上没有敌人就空转，不空挥

    // 朝目标挥出去 —— 不再跟着剑的轨道方向走
    var aim = util.angleTo(owner.x, owner.y, enemy.x, enemy.y);

    if (this.def.type === 'melee') {
      if (t.dist > this.range() + enemy.radius) return;   // 最近的那个都够不着
      this._meleeAttack(owner, state, aim, this.arcHalf(), claimed);
    } else {
      this._rangedAttack(owner, state, enemy, claimed);
    }
    this.cooldownRemaining = this.cooldown(owner);
  };

  WeaponInstance.prototype._rollCrit = function (owner) {
    return Math.random() < owner.stats.critChance;
  };

  /** 命中结算。kx0/ky0 是击退方向，从**玩家**指向敌人 ——
   *  和索敌同圆心，敌人被往远离玩家的方向推开。 */
  WeaponInstance.prototype._applyHit = function (owner, state, enemy, baseDmg, kx0, ky0) {
    var crit = this._rollCrit(owner);
    var dmg = baseDmg * (crit ? owner.stats.critMult : 1);
    // 角色被动：连击等按目标叠加伤害
    var dealt = Game.invokePassive(owner, 'onHit', { enemy: enemy, dmg: dmg, crit: crit, weapon: this });
    if (typeof dealt === 'number') dmg = dealt;
    owner.damageDealt += dmg;
    // 吸血：按造成伤害百分比回血
    if (owner.stats.lifesteal > 0) {
      owner.heal(dmg * owner.stats.lifesteal);
    }
    var hitHeal = owner.healForHit();
    if (hitHeal > 0) owner.heal(hitHeal);
    var dd = Math.sqrt(kx0 * kx0 + ky0 * ky0) || 1;
    var kb = this.def.knockback || 0;
    // 传入攻击者：坦克会按 counter 比例反弹（见 Enemy.takeDamage）
    var dead = enemy.takeDamage(dmg, crit, kx0 / dd * kb, ky0 / dd * kb, owner);
    if (dead) {
      enemy.die(state);
      var killHeal = owner.healForKill();
      if (killHeal > 0) owner.heal(killHeal);
    }
    return dead;
  };

  // 只有主武器（slot 0）驱动玩家身上的动作与音效：6 把武器同时挥砍，
  // 玩家的抬手动画和打击音会每帧重触发，等于一阵持续的噪音。
  // 其余武器靠各自位置上的刀光/枪口火焰表现，玩家不需要再摆一次姿势。
  WeaponInstance.prototype._primary = function () {
    return this.slot === 0;
  };

  // 近战挥砍：以**玩家**为圆心、朝目标方向扫一道 WEAPON_ARC 宽的扇形、
  // 半径 = 有效射程。圆心是玩家而不是武器 —— 武器在半径 62 的圈上，以它为
  // 圆心时贴着玩家的敌人全落在它背后，内环永远打不到。刀光也画在玩家身上，
  // 特效和真实命中范围必须同圆心，否则又是一次「特效和武器对不上」。
  // 被扫到的都记进 claimed，同帧里下一把武器就去找别的目标了。
  WeaponInstance.prototype._meleeAttack = function (owner, state, aim, halfArc, claimed) {
    var rng = this.range();
    this.swingTime = 0;
    this.swingAim = aim;      // 渲染用：剑身绕这个方向挥，和刀光同向
    if (this._primary() && owner.playAttack) owner.playAttack('melee');
    var dmg = this.damage(owner);
    var px = owner.x, py = owner.y;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist(px, py, e.x, e.y);
      if (d > rng + e.radius) continue;
      if (angDiff(util.angleTo(px, py, e.x, e.y), aim) > halfArc) continue;
      // 击退也从玩家身上算：把敌人往外推，和索敌同心
      this._applyHit(owner, state, e, dmg, e.x - px, e.y - py);
      if (claimed) claimed[e.uid] = true;
    }
    if (fx()) fx().slash(px, py, aim, rng, this.def.color, halfArc * 2);
    if (this._primary() && Game.Audio) Game.Audio.hit();
  };

  // 远程射击：从武器所在的布置点**朝目标**出膛 —— 目标是全场最近的敌人，
  // 可能落在内环（贴着玩家），朝外打会让子弹从敌人背后飞走。
  WeaponInstance.prototype._rangedAttack = function (owner, state, enemy, claimed) {
    if (claimed) claimed[enemy.uid] = true;
    this.swingTime = 0;
    if (this._primary() && owner.playAttack) owner.playAttack('ranged');
    var crit = this._rollCrit(owner);
    var dmg = this.damage(owner) * (crit ? owner.stats.critMult : 1);
    var spd = this.def.projectileSpeed;
    var a = util.angleTo(this.x, this.y, enemy.x, enemy.y);
    this.swingAim = a;        // 渲染用：弩机朝这个方向放箭、弩弦回弹
    var p = new Game.Projectile({
      x: this.x + Math.cos(a) * (owner.radius + 6),
      y: this.y + Math.sin(a) * (owner.radius + 6),
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      radius: 5, damage: dmg, crit: crit, fromPlayer: true,
      pierce: this.def.pierce || 0, life: 2.5,
      color: this.def.color, type: PROJ_SHAPE[this.defId] || 'bullet',
      knockback: this.def.knockback || 0,
      owner: owner,
    });
    state.projectiles.push(p);
    if (fx()) fx().muzzle(this.x, this.y, a);
    if (this._primary() && Game.Audio) Game.Audio.shoot();
  };

  // 导出
  Game.WeaponInstance = WeaponInstance;
  Game.createWeapon = function (defId, level, slot) { return new WeaponInstance(defId, level, slot); };
})();
