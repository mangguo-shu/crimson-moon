/* ============================================================
 * weapons.js —— 武器实例
 * 负责自动攻击：冷却计时、索敌、近战挥砍 / 远程射击、暴击与吸血结算。
 * 合成/星级系统留到后续轮次，当前用 level 表示强化等级。
 *
 * 多把武器的表现：每把武器挂在玩家身边一圈上，整圈慢速旋转，各管自己扇形
 * 宽的一块。扇形越窄越多，武器越多打得的面越广（武器数 × 扇形宽）。
 * 索敌与命中的圆心是**玩家**、半径是近战射程，武器只是「指向哪个方向」的
 * 标记 —— 以武器为圆心时贴着玩家的敌人全落在武器背后，内环永远打不到。
 * 每把武器的冷却互不影响：两把武器左右同时来怪，各打各的。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;

  function fx() { return Game.FX; }

  /** 两角之差，wrap 到 [0, π]。环绕武器固定朝外打，索敌要按角度过滤。 */
  function angDiff(a, b) {
    return Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  }

  /* ---------------- 环绕布置 ----------------
   * 角度的唯一出处。渲染侧画卫星图标时调它取同一个角，不然逻辑在打那边、
   * 图标在另一边飘，一眼穿帮。index 取武器在 player.weapons 里的序号，
   * count 取当前武器数 —— 新拿一把武器整圈重新均分，旧的不用记位置。
   *
   * 整圈按 WEAPON_ORBIT_SPEED 慢速旋转：武器转过去哪儿，就往哪儿打。
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

  /** 在 (x,y) 为中心、aim 为对称轴、半角 halfArc 的扇形里找最近的敌人。 */
  WeaponInstance.prototype.nearestInCone = function (state, x, y, aim, halfArc) {
    var best = null, bestD = Infinity;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist2(x, y, e.x, e.y);
      if (d >= bestD) continue;
      if (angDiff(util.angleTo(x, y, e.x, e.y), aim) > halfArc) continue;
      bestD = d; best = e;
    }
    return { enemy: best, dist: best === null ? Infinity : Math.sqrt(bestD) };
  };

  /** 本把武器负责的扇形半角 = 自己那个扇形宽的一半。
   *  近战用自己的 arc（冻结值：铁剑 135°、赤月斩 171°）；远程表里 arc 是 0，
   *  用统一开关 RANGED_FIRE_ARC（135°，和铁剑同手感）。
   *  总覆盖 = 武器数 × 扇形宽，武器越多打得的面越广 —— 这是「多把武器能
   *  体现出来」的来源。不能按 360°/武器数均分：那样合计恒定 360°，加武器
   *  只加输出，玩家感知不到手里多了什么。 */
  WeaponInstance.prototype.arcHalf = function () {
    var a = this.def.arc > 0 ? this.def.arc : Game.CONST.RANGED_FIRE_ARC;
    return a / 2;
  };

  /** 每帧更新；自动攻击。扇形圆心是玩家（半径 = 近战射程），不是武器 ——
   *  以武器为圆心时贴着玩家的敌人落在所有武器背后，内环永远打不到。 */
  WeaponInstance.prototype.update = function (dt, owner, state) {
    var pos = this.posAt(owner);
    this.x = pos.x; this.y = pos.y; this.aimAngle = pos.a;  // 渲染用
    this.cooldownRemaining -= dt;
    this.swingTime += dt;                                    // 出手余韵计时
    if (this.cooldownRemaining > 0) return;

    var aim = pos.a;                 // 扇形对称轴 = 这把武器当前的轨道角
    var halfArc = this.arcHalf();
    var t = this.nearestInCone(state, owner.x, owner.y, aim, halfArc);
    var enemy = t.enemy;
    if (!enemy) return;   // 扇形里没有就空转，不空挥

    var cd = this.cooldown(owner);
    if (this.def.type === 'melee') {
      if (t.dist <= this.range() + enemy.radius) {
        this._meleeAttack(owner, state, aim, halfArc);
        this.cooldownRemaining = cd;
      }
    } else {
      this._rangedAttack(owner, state, aim, enemy);
      this.cooldownRemaining = cd;
    }
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

  // 近战挥砍：以**玩家**为圆心、扇形宽 = 武器自己的 arc、半径 = 有效射程。
  // 圆心是玩家而不是武器 —— 武器在半径 62 的圈上，以它为圆心时贴着玩家的
  // 敌人全落在它背后，内环永远打不到。刀光也画在玩家身上，特效和真实命中
  // 范围必须同圆心，否则又是一次「特效和武器对不上」。
  WeaponInstance.prototype._meleeAttack = function (owner, state, aim, halfArc) {
    var rng = this.range();
    this.swingTime = 0;
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
    }
    if (fx()) fx().slash(px, py, aim, rng, this.def.color, halfArc * 2);
    if (this._primary() && Game.Audio) Game.Audio.hit();
  };

  // 远程射击：从武器所在的布置点**朝目标**出膛，不沿径向固定往外打 ——
  // 目标是扇形里离玩家最近的敌人，可能在内环（贴着玩家），固定朝外的话
  // 子弹会从敌人背后飞走。
  WeaponInstance.prototype._rangedAttack = function (owner, state, aim, enemy) {
    this.swingTime = 0;
    if (this._primary() && owner.playAttack) owner.playAttack('ranged');
    var crit = this._rollCrit(owner);
    var dmg = this.damage(owner) * (crit ? owner.stats.critMult : 1);
    var spd = this.def.projectileSpeed;
    var a = util.angleTo(this.x, this.y, enemy.x, enemy.y);
    var p = new Game.Projectile({
      x: this.x + Math.cos(a) * (owner.radius + 6),
      y: this.y + Math.sin(a) * (owner.radius + 6),
      vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
      radius: 5, damage: dmg, crit: crit, fromPlayer: true,
      pierce: this.def.pierce || 0, life: 2.5,
      color: this.def.color, type: 'bullet', knockback: this.def.knockback || 0,
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
