/* ============================================================
 * weapons.js —— 武器实例
 * 负责自动攻击：冷却计时、索敌、近战挥砍 / 远程射击、暴击与吸血结算。
 * 合成/星级系统留到后续轮次，当前用 level 表示强化等级。
 *
 * 多把武器的表现：每把武器挂在玩家身边的环绕轨道上，按槽位序号均分角度，
 * 出手时以「自己的位置」为圆心索敌、挥砍、开枪 —— 而不是全部叠在玩家身上。
 * 不这么做的话，第二把武器在游戏里等于「攻击频率翻倍」，玩家完全感知不到。
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

  /* ---------------- 环绕轨道 ----------------
   * 角度的唯一出处。渲染侧画卫星图标时调它取同一个角，不然逻辑在打那边、
   * 图标在另一边飘，一眼穿帮。index 取武器在 player.weapons 里的序号，
   * count 取当前武器数 —— 新拿一把武器整条轨道会重新均分，旧的不用记位置。
   * 慢速自转（WEAPON_ORBIT_SPEED）让它活起来；不用绝对角度，
   * 因此存档里不需要存轨道位置。
   *
   * 返回值必须归一化到 [-π, π]：cos/sin 不在乎角度大小，但「角度差取模」在乎。
   * 拿 Date.now() 量级的原始角度（~1e8 rad）去做 (a - b) % 2π，double 精度全丢，
   * 结果不是差值而是随机垃圾 —— 表现为武器永远「背对」敌人、一刀砍不出去。
   * 先在「秒」这个量级对整圈周期取模，再压到 [-π, π]。 */
  Game.orbitSlot = function (count, index) {
    if (!count || count < 1) return 0;
    var S = Game.CONST;
    var period = Math.PI * 2 / S.WEAPON_ORBIT_SPEED;   // 整圈多少秒
    var a = (index / count) * Math.PI * 2 + (performance.now() * 0.001 % period);
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

  /** 只在「朝外扇形」里找最近的敌人（从 x,y 出发，不是从玩家身上）。
   *  环绕武器固定围绕人物往外打，不做全场自动瞄准 —— 敌人得走进扇形里才被砍到；
   *  扇形里没有就空转等它转过来，不空挥。 */
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

  /** 本把武器的扇形半角。近战用自己的 arc（冻结值），远程用统一常量。 */
  WeaponInstance.prototype.halfArc = function () {
    return (this.def.type === 'melee' ? this.def.arc : Game.CONST.RANGED_FIRE_ARC) / 2;
  };

  /** 每帧更新；自动攻击。出手方向固定朝外（沿轨道径向），不追全场目标。 */
  WeaponInstance.prototype.update = function (dt, owner, state) {
    var pos = this.posAt(owner);
    this.x = pos.x; this.y = pos.y; this.aimAngle = pos.a;  // 渲染与击退方向共用
    this.cooldownRemaining -= dt;
    this.swingTime += dt;                                    // 出手余韵计时
    if (this.cooldownRemaining > 0) return;

    var aim = pos.a;   // 朝外：玩家 → 武器 → 敌人
    var t = this.nearestInCone(state, pos.x, pos.y, aim, this.halfArc());
    var enemy = t.enemy;
    if (!enemy) return;   // 扇形里没有敌人就空转

    var cd = this.cooldown(owner);
    if (this.def.type === 'melee') {
      if (t.dist <= this.range() + enemy.radius) {
        this._meleeAttack(owner, state, aim);
        this.cooldownRemaining = cd;
      }
    } else {
      this._rangedAttack(owner, state, aim);
      this.cooldownRemaining = cd;
    }
  };

  WeaponInstance.prototype._rollCrit = function (owner) {
    return Math.random() < owner.stats.critChance;
  };

  /** 命中结算。kx0/ky0 是击退方向，从「武器位置」指向敌人 ——
   *  环绕后如果还从玩家身上算，敌人会被往错误的方向弹。 */
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

  // 近战挥砍：以武器位置为圆心、朝外方向 aim 的扇形内所有敌人受伤。
  // 扇形朝外而不是朝敌人 —— 环绕武器围绕人物往外打，敌人得走进扇形里。
  WeaponInstance.prototype._meleeAttack = function (owner, state, aim) {
    var rng = this.range();
    this.swingTime = 0;
    if (this._primary() && owner.playAttack) owner.playAttack('melee');
    var dmg = this.damage(owner);
    var halfArc = this.def.arc / 2;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist(this.x, this.y, e.x, e.y);
      if (d > rng + e.radius) continue;
      if (angDiff(util.angleTo(this.x, this.y, e.x, e.y), aim) > halfArc) continue;
      this._applyHit(owner, state, e, dmg, e.x - this.x, e.y - this.y);
    }
    if (fx()) fx().slash(this.x, this.y, aim, rng, this.def.color, this.def.arc);
    if (this._primary() && Game.Audio) Game.Audio.hit();
  };

  // 远程射击：从武器所在的轨道位置沿朝外方向出膛，不自动追远处的敌人。
  // 只有「朝外扇形」里有敌人时才开枪，不朝空处扫射。
  WeaponInstance.prototype._rangedAttack = function (owner, state, aim) {
    this.swingTime = 0;
    if (this._primary() && owner.playAttack) owner.playAttack('ranged');
    var crit = this._rollCrit(owner);
    var dmg = this.damage(owner) * (crit ? owner.stats.critMult : 1);
    var spd = this.def.projectileSpeed;
    var p = new Game.Projectile({
      x: this.x + Math.cos(aim) * (owner.radius + 6),
      y: this.y + Math.sin(aim) * (owner.radius + 6),
      vx: Math.cos(aim) * spd, vy: Math.sin(aim) * spd,
      radius: 5, damage: dmg, crit: crit, fromPlayer: true,
      pierce: this.def.pierce || 0, life: 2.5,
      color: this.def.color, type: 'bullet', knockback: this.def.knockback || 0,
      owner: owner,
    });
    state.projectiles.push(p);
    if (fx()) fx().muzzle(this.x, this.y, aim);
    if (this._primary() && Game.Audio) Game.Audio.shoot();
  };

  // 导出
  Game.WeaponInstance = WeaponInstance;
  Game.createWeapon = function (defId, level, slot) { return new WeaponInstance(defId, level, slot); };
})();
