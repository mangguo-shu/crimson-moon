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

  /* ---------------- 环绕轨道 ----------------
   * 角度的唯一出处。渲染侧画卫星图标时调它取同一个角，不然逻辑在打那边、
   * 图标在另一边飘，一眼穿帮。index 取武器在 player.weapons 里的序号，
   * count 取当前武器数 —— 新拿一把武器整条轨道会重新均分，旧的不用记位置。
   * 慢速自转（WEAPON_ORBIT_SPEED）让它活起来；不用绝对角度，
   * 因此存档里不需要存轨道位置。 */
  Game.orbitSlot = function (count, index) {
    if (!count || count < 1) return 0;
    return (index / count) * Math.PI * 2 + Game.CONST.WEAPON_ORBIT_SPEED * performance.now() * 0.001;
  };

  function WeaponInstance(defId, level, slot) {
    this.defId = defId;
    this.def = Game.WEAPONS[defId];
    this.level = level || 1;
    this.cooldownRemaining = 0;
    this.slot = slot || 0;   // 槽位序号 → 轨道角度
    this.swingTime = 0;      // 距上次出手多久（渲染画出手余韵用；不持久化）
    this.lastAim = 0;        // 上次出手的朝向：挥砍时让剑身指向敌人，而不是沿径向朝外
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

  /** 寻找最近的敌人（从 x,y 出发，不是从玩家身上） */
  WeaponInstance.prototype.nearestEnemy = function (state, x, y) {
    var best = null, bestD = Infinity;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist2(x, y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return { enemy: best, dist: best === null ? Infinity : Math.sqrt(bestD) };
  };

  /** 每帧更新；自动攻击 */
  WeaponInstance.prototype.update = function (dt, owner, state) {
    var pos = this.posAt(owner);
    this.x = pos.x; this.y = pos.y; this.aimAngle = pos.a;  // 渲染与击退方向共用
    this.cooldownRemaining -= dt;
    this.swingTime += dt;                                    // 出手余韵计时
    if (this.cooldownRemaining > 0) return;

    var t = this.nearestEnemy(state, pos.x, pos.y);
    var enemy = t.enemy;
    if (!enemy) return; // 无敌人则等待

    var cd = this.cooldown(owner);
    if (this.def.type === 'melee') {
      // 近战：范围内才出手
      if (t.dist <= this.range() + enemy.radius) {
        this._meleeAttack(owner, state, enemy);
        this.cooldownRemaining = cd;
      }
    } else {
      // 远程：自动瞄准最近敌人
      this._rangedAttack(owner, state, enemy);
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

  // 近战挥砍：以武器位置为圆心的扇形范围内所有敌人受伤
  WeaponInstance.prototype._meleeAttack = function (owner, state, enemy) {
    var facing = util.angleTo(this.x, this.y, enemy.x, enemy.y);
    var rng = this.range();
    this.swingTime = 0;
    this.lastAim = facing;
    if (this._primary()) {
      // 视觉朝向仍以玩家为中心，别被轨道角度带偏
      owner.aimFacing = util.angleTo(owner.x, owner.y, enemy.x, enemy.y);
      if (owner.playAttack) owner.playAttack('melee');   // 纯表现：下劈动作
    }
    var dmg = this.damage(owner);
    var halfArc = this.def.arc / 2;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist(this.x, this.y, e.x, e.y);
      if (d <= rng + e.radius) {
        var ang = util.angleTo(this.x, this.y, e.x, e.y);
        var diff = Math.abs(((ang - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (diff <= halfArc) {
          this._applyHit(owner, state, e, dmg, e.x - this.x, e.y - this.y);
        }
      }
    }
    if (fx()) fx().slash(this.x, this.y, facing, rng, this.def.color, this.def.arc);
    if (this._primary() && Game.Audio) Game.Audio.hit();
  };

  // 远程射击：从武器所在的轨道位置出膛
  WeaponInstance.prototype._rangedAttack = function (owner, state, enemy) {
    var ang = util.angleTo(this.x, this.y, enemy.x, enemy.y);
    this.swingTime = 0;
    this.lastAim = ang;
    if (this._primary()) {
      owner.aimFacing = ang;
      if (owner.playAttack) owner.playAttack('ranged');  // 纯表现：射击后坐
    }
    var crit = this._rollCrit(owner);
    var dmg = this.damage(owner) * (crit ? owner.stats.critMult : 1);
    var spd = this.def.projectileSpeed;
    var p = new Game.Projectile({
      x: this.x + Math.cos(ang) * (owner.radius + 6),
      y: this.y + Math.sin(ang) * (owner.radius + 6),
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      radius: 5, damage: dmg, crit: crit, fromPlayer: true,
      pierce: this.def.pierce || 0, life: 2.5,
      color: this.def.color, type: 'bullet', knockback: this.def.knockback || 0,
      owner: owner,
    });
    state.projectiles.push(p);
    if (fx()) fx().muzzle(this.x, this.y, ang);
    if (this._primary() && Game.Audio) Game.Audio.shoot();
  };

  // 导出
  Game.WeaponInstance = WeaponInstance;
  Game.createWeapon = function (defId, level, slot) { return new WeaponInstance(defId, level, slot); };
})();
