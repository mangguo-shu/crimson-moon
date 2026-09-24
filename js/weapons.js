/* ============================================================
 * weapons.js —— 武器实例
 * 负责自动攻击：冷却计时、索敌、近战挥砍 / 远程射击、暴击与吸血结算。
 * 合成/星级系统留到后续轮次，当前用 level 表示强化等级。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;

  function fx() { return Game.FX; }

  function WeaponInstance(defId, level) {
    this.defId = defId;
    this.def = Game.WEAPONS[defId];
    this.level = level || 1;
    this.cooldownRemaining = 0;
  }

  WeaponInstance.prototype.damage = function (owner) {
    var d = this.def.damage * (1 + 0.5 * (this.level - 1));
    return d * owner.stats.damage;
  };
  WeaponInstance.prototype.cooldown = function (owner) {
    return this.def.cooldown / owner.stats.attackSpeed;
  };

  /** 寻找最近的敌人 */
  WeaponInstance.prototype.nearestEnemy = function (state) {
    var best = null, bestD = Infinity;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist2(this.ownerX, this.ownerY, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return { enemy: best, dist: best === null ? Infinity : Math.sqrt(bestD) };
  };

  /** 每帧更新；自动攻击 */
  WeaponInstance.prototype.update = function (dt, owner, state) {
    this.ownerX = owner.x; this.ownerY = owner.y;
    this.cooldownRemaining -= dt;
    if (this.cooldownRemaining > 0) return;

    var t = this.nearestEnemy(state);
    var enemy = t.enemy;
    if (!enemy) return; // 无敌人则等待

    var cd = this.cooldown(owner);
    if (this.def.type === 'melee') {
      // 近战：范围内才出手
      if (t.dist <= this.def.range + enemy.radius) {
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

  WeaponInstance.prototype._applyHit = function (owner, state, enemy, baseDmg) {
    var crit = this._rollCrit(owner);
    var dmg = baseDmg * (crit ? owner.stats.critMult : 1);
    owner.damageDealt += dmg;
    // 吸血：按造成伤害百分比回血
    if (owner.stats.lifesteal > 0) {
      owner.heal(dmg * owner.stats.lifesteal);
    }
    if (owner.stats.lifeOnHit > 0) owner.heal(owner.stats.lifeOnHit);
    // 击退方向（从玩家指向敌人）
    var dx = enemy.x - owner.x, dy = enemy.y - owner.y;
    var dd = Math.sqrt(dx * dx + dy * dy) || 1;
    var kb = this.def.knockback || 0;
    var dead = enemy.takeDamage(dmg, crit, dx / dd * kb, dy / dd * kb);
    if (dead) {
      enemy.die(state);
      if (owner.stats.lifeOnKill > 0) owner.heal(owner.stats.lifeOnKill);
    }
    if (crit && fx()) fx().shake(3);
    return dead;
  };

  // 近战挥砍：扇形范围内所有敌人受伤
  WeaponInstance.prototype._meleeAttack = function (owner, state, enemy) {
    var facing = util.angleTo(owner.x, owner.y, enemy.x, enemy.y);
    owner.aimFacing = facing;
    if (owner.playAttack) owner.playAttack('melee'); // 纯表现：下劈动作
    var dmg = this.damage(owner);
    var halfArc = this.def.arc / 2;
    var es = state.enemies;
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.dead) continue;
      var d = util.dist(owner.x, owner.y, e.x, e.y);
      if (d <= this.def.range + e.radius) {
        var ang = util.angleTo(owner.x, owner.y, e.x, e.y);
        var diff = Math.abs(((ang - facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (diff <= halfArc) {
          this._applyHit(owner, state, e, dmg);
        }
      }
    }
    if (fx()) fx().slash(owner.x, owner.y, facing, this.def.range, this.def.color);
    if (Game.Audio) Game.Audio.hit();
  };

  // 远程射击
  WeaponInstance.prototype._rangedAttack = function (owner, state, enemy) {
    var ang = util.angleTo(owner.x, owner.y, enemy.x, enemy.y);
    owner.aimFacing = ang;
    if (owner.playAttack) owner.playAttack('ranged'); // 纯表现：射击后坐
    var crit = this._rollCrit(owner);
    var dmg = this.damage(owner) * (crit ? owner.stats.critMult : 1);
    var spd = this.def.projectileSpeed;
    var p = new Game.Projectile({
      x: owner.x + Math.cos(ang) * (owner.radius + 6),
      y: owner.y + Math.sin(ang) * (owner.radius + 6),
      vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      radius: 5, damage: dmg, crit: crit, fromPlayer: true,
      pierce: this.def.pierce || 0, life: 2.5,
      color: this.def.color, type: 'bullet', knockback: this.def.knockback || 0,
      owner: owner,
    });
    state.projectiles.push(p);
    if (fx()) fx().muzzle(owner.x, owner.y, ang);
    if (Game.Audio) Game.Audio.shoot();
  };

  // 导出
  Game.WeaponInstance = WeaponInstance;
  Game.createWeapon = function (defId, level) { return new WeaponInstance(defId, level); };
})();
