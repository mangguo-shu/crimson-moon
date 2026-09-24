/* ============================================================
 * test/smoke.js —— 无头冒烟测试
 * 不依赖浏览器：stub 掉 window/document/canvas/localStorage，
 * 按 index.html 的加载顺序执行全部脚本，然后直接驱动游戏逻辑，
 * 验证：脚本加载、RNG 确定性、存储回环、状态创建、波次生成、
 * 战斗（近战/远程）、升级、存档序列化回环。
 *
 * 运行：node test/smoke.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');
const ORDER = [
  'config.js', 'storage.js', 'nativeBridge.js', 'audio.js', 'input.js',
  'entities.js', 'weapons.js', 'renderer.js', 'systems.js', 'records.js', 'ui.js', 'game.js',
];

/* ---------------- 断言工具 ---------------- */
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

/* ---------------- DOM / Canvas stub ---------------- */
function makeCtxStub() {
  const gradient = { addColorStop() {} };
  const handler = {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient;
      if (key === 'canvas') return null;
      if (typeof target[key] !== 'undefined') return target[key];
      // 其余方法一律返回 no-op 函数；属性写入用 set
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  };
  return new Proxy({}, handler);
}

function makeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    innerHTML: '',
    textContent: '',
    width: 0, height: 0,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getContext() { return makeCtxStub(); },
  };
  return el;
}

const byId = {};
const gameCanvas = makeElement('canvas');
byId['game'] = gameCanvas;

global.window = global;
Object.defineProperty(global, 'navigator', { value: { maxTouchPoints: 0, userAgent: 'node' }, configurable: true });
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.innerWidth = 1280;
global.innerHeight = 720;
Object.defineProperty(global, 'devicePixelRatio', { value: 1, configurable: true });

const storageMap = {};
global.localStorage = {
  getItem(k) { return k in storageMap ? storageMap[k] : null; },
  setItem(k, v) { storageMap[k] = String(v); },
  removeItem(k) { delete storageMap[k]; },
};

global.document = {
  hidden: false,
  readyState: 'loading', // 让 game.js 的自动启动走 DOMContentLoaded（测试中不触发）
  body: { appendChild() {} },
  getElementById(id) {
    if (!byId[id]) byId[id] = makeElement('div');
    return byId[id];
  },
  createElement(tag) { return makeElement(tag); },
  addEventListener() {},
};

/* ---------------- 按序加载脚本 ---------------- */
console.log('== 加载脚本 ==');
for (const f of ORDER) {
  const code = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
  try {
    vm.runInThisContext(code, { filename: f });
    console.log('  ✓ 加载 ' + f);
  } catch (e) {
    console.error('  ✗ 加载失败 ' + f + ': ' + e.stack);
    failed++;
  }
}

const Game = global.Game;
assert(!!Game, 'Game 命名空间存在');
assert(!!Game.Player && !!Game.Enemy && !!Game.Projectile && !!Game.Pickup, '实体类已挂载');
assert(!!Game.Systems && !!Game.Renderer && !!Game.UI && !!Game.Storage, '系统/渲染/UI/存储模块已挂载');

/* ---------------- RNG 确定性 ---------------- */
console.log('\n== RNG 确定性 ==');
const r1 = Game.mulberry32(12345);
const r2 = Game.mulberry32(12345);
let same = true;
for (let i = 0; i < 20; i++) if (r1() !== r2()) same = false;
assert(same, '相同种子产生相同随机序列');
const a = Game.mulberry32(1)(), b = Game.mulberry32(2)();
assert(a !== b, '不同种子产生不同序列');

/* ---------------- 存储回环 ---------------- */
console.log('\n== 存储回环 ==');
Game.Storage.init();
Game.Storage.setJSON('campaign_v1', { hello: '世界', n: 42 });
const readBack = Game.Storage.getJSON('campaign_v1');
assert(readBack && readBack.hello === '世界' && readBack.n === 42, 'Storage JSON 写读回环一致');
Game.Storage.remove('campaign_v1');
assert(Game.Storage.getJSON('campaign_v1') === null, 'Storage remove 生效');

/* ---------------- 状态创建 ---------------- */
console.log('\n== 状态创建 ==');
const state = Game.Systems.createState('campaign', 'swordsman', 777);
assert(state.player.name === '流浪剑客', '角色为流浪剑客');
assert(state.player.stats.maxHp === 100 && state.player.stats.hp === 100, '初始生命 100');
assert(state.player.stats.speed === 220, '初始移速 220');
assert(state.player.weapons.length === 1 && state.player.weapons[0].defId === 'iron_sword', '初始武器铁剑');
assert(state.player.xpNext === 9, '升级经验公式 5+1*4=9');

/* ---------------- 波次生成 ---------------- */
console.log('\n== 波次生成 ==');
Game.Systems.startWave(state, 1);
assert(state.wave === 1, '波次=1');
assert(state.spawnSchedule.length === 14, '敌人预算 8+1*6=14，实际 ' + state.spawnSchedule.length);
assert(state.isBossWave === false, '第1波非Boss');
const sch1 = Game.Systems.buildSpawnSchedule({ seed: 999, wave: 3 }, 3);
const sch2 = Game.Systems.buildSpawnSchedule({ seed: 999, wave: 3 }, 3);
assert(JSON.stringify(sch1) === JSON.stringify(sch2), '相同 seed+wave 的刷新计划一致（读档一致）');

/* ---------------- 敌人刷新（模拟时间推进） ---------------- */
console.log('\n== 敌人刷新 ==');
const st2 = Game.Systems.createState('campaign', 'swordsman', 42);
Game.Systems.startWave(st2, 1);
for (let i = 0; i < 40; i++) Game.Systems.updateWave(st2, 0.1); // 推进 4 秒
assert(st2.enemies.length > 0, '4 秒后已有敌人刷新（' + st2.enemies.length + ' 个）');

/* ---------------- 近战战斗 ---------------- */
console.log('\n== 近战战斗 ==');
const st3 = Game.Systems.createState('campaign', 'swordsman', 5);
Game.Systems.startWave(st3, 1);
const player = st3.player;
const zombie = new Game.Enemy('zombie', player.x + 40, player.y, 1);
zombie.hp = 1000; // 防死，验证扣血
st3.enemies.push(zombie);
player.weapons[0].update(0.1, player, st3); // 首次攻击立即出手
assert(player.damageDealt > 0, '近战命中造成伤害（' + player.damageDealt.toFixed(1) + '）');
assert(zombie.hp < 1000, '敌人血量下降（' + zombie.hp.toFixed(1) + '）');

/* ---------------- 远程战斗 ---------------- */
console.log('\n== 远程战斗 ==');
const st4 = Game.Systems.createState('campaign', 'swordsman', 6);
Game.Systems.startWave(st4, 1);
const p4 = st4.player;
p4.weapons.push(Game.createWeapon('pistol', 1));
const far = new Game.Enemy('wizard', p4.x + 300, p4.y, 1);
far.hp = 1000;
st4.enemies.push(far);
const pistol = p4.weapons[1];
pistol.update(0.1, p4, st4); // 触发远程射击
assert(st4.projectiles.length > 0, '远程武器发射投射物');
const hpBefore = far.hp;
for (let i = 0; i < 120; i++) Game.Systems.updateProjectiles(st4, 0.02); // 推进碰撞
assert(far.hp < hpBefore, '投射物命中敌人扣血');

/* ---------------- 升级 ---------------- */
console.log('\n== 升级 ==');
const st5 = Game.Systems.createState('campaign', 'swordsman', 7);
const p5 = st5.player;
const ups = p5.addXp(50);
assert(ups >= 1 && p5.level > 1, '经验累积触发升级（Lv.' + p5.level + '）');
const choices = Game.Systems.rollLevelUpChoices(st5);
assert(choices.length === 3, '升级三选一（' + choices.length + ' 项）');

/* ---------------- 存档序列化回环 ---------------- */
console.log('\n== 存档回环 ==');
const st6 = Game.Systems.createState('campaign', 'swordsman', 88);
Game.Systems.startWave(st6, 3);
for (let i = 0; i < 60; i++) Game.Systems.updateWave(st6, 0.1);
st6.player.x = 1234; st6.player.y = 567;
st6.player.materials = 99;
const json = JSON.stringify(Game.Systems.serialize(st6));
const restored = Game.Systems.deserialize(JSON.parse(json));
assert(restored.player.x === 1234 && restored.player.y === 567, '玩家坐标恢复一致');
assert(restored.player.materials === 99, '材料恢复一致');
assert(restored.wave === 3 && restored.seed === 88, '波次与种子恢复一致');
assert(restored.enemies.length === st6.enemies.length, '敌人数恢复一致（' + restored.enemies.length + '）');
assert(restored.player.weapons.length === st6.player.weapons.length, '武器槽恢复一致');
assert(restored.player.stats.maxHp === st6.player.stats.maxHp, '属性恢复一致');

/* ---------------- 渲染无崩溃（含空状态） ---------------- */
console.log('\n== 渲染无崩溃 ==');
try {
  Game.Renderer.init(gameCanvas);
  Game.Renderer.render(null, 0.016); // 主菜单：空状态只画地面
  Game.Renderer.render(st6, 0.016);  // 游戏中：完整渲染
  assert(true, '渲染空状态与游戏状态均无异常');
} catch (e) {
  assert(false, '渲染异常: ' + e.stack);
}

/* ---------------- 状态机：死亡/胜利切换屏幕 ---------------- */
console.log('\n== 状态机 ==');
Game.UI.init(); // 初始化 DOM 引用，供 renderGameOver 等使用
const st7 = Game.Systems.createState('campaign', 'swordsman', 11);
Game.Systems.startWave(st7, 1);
Game.state = st7;
Game.Game._gameOver();
assert(Game.state.screen === 'GAME_OVER', '死亡后 screen 切换为 GAME_OVER（elapsed 冻结）');
const elapsedFrozen = Game.state.elapsed;
Game.Systems.updateWave(Game.state, 0.016); // 非 PLAYING 状态下不应再累计时间
assert(Game.state.elapsed === elapsedFrozen, 'GAME_OVER 后 elapsed 不再累加');

const st8 = Game.Systems.createState('campaign', 'swordsman', 12);
Game.Systems.startWave(st8, 20);
Game.state = st8;
Game.Game._victory();
assert(Game.state.screen === 'VICTORY', '胜利后 screen 切换为 VICTORY');

/* ---------------- 国风渲染覆盖：全怪物类型 + 全特效 + 双画质 ---------------- */
console.log('\n== 国风渲染覆盖 ==');
try {
  var st9 = Game.Systems.createState('campaign', 'swordsman', 21);
  Game.Systems.startWave(st9, 1);
  // 四种怪物各一只（含 Boss），并触发血条 / 受击闪白分支
  var types = ['zombie', 'bat', 'wizard', 'boss'];
  for (var ti = 0; ti < types.length; ti++) {
    var en = new Game.Enemy(types[ti], 300 + ti * 130, 400, 1);
    en.hp = en.maxHp * 0.5;   // 非满血 → 画血条
    en.hitFlash = 0.1;        // 受击闪白
    st9.enemies.push(en);
  }
  // 两种投射物：子弹 / 法术符咒
  st9.projectiles.push(new Game.Projectile({
    x: 400, y: 300, vx: 100, vy: 0, radius: 6, damage: 5,
    fromPlayer: true, color: '#ffd76e', type: 'bullet',
  }));
  st9.projectiles.push(new Game.Projectile({
    x: 420, y: 320, vx: 100, vy: 0, radius: 7, damage: 5,
    fromPlayer: false, color: '#c48aff', type: 'spell',
  }));
  // 两种掉落物：灵气珠 / 铜钱
  st9.pickups.push(new Game.Pickup('xp', 3, 380, 360));
  st9.pickups.push(new Game.Pickup('material', 2, 400, 360));
  // 玩家各状态分支：行走 / 待机呼吸 / 受击闪白 / 无敌帧 / 濒死暗角
  st9.player.moving = true;
  st9.player.walkTime = 1.2;
  st9.player.hitFlashTimer = 0.1;
  st9.player.invincibleTimer = 0.2;
  st9.player.stats.hp = st9.player.stats.maxHp * 0.2;
  // 逐一触发全部特效接口
  Game.FX.slash(st9.player.x, st9.player.y, 0, 66, '#4fbfa0');
  Game.FX.ring(st9.player.x, st9.player.y, 80, '#ffcf5e');
  Game.FX.levelUp(st9.player.x, st9.player.y);
  Game.FX.talisman(st9.player.x, st9.player.y, 1.2);
  Game.FX.cast(st9.player.x, st9.player.y);
  Game.FX.bossCast(st9.player.x, st9.player.y);
  Game.FX.crit(st9.player.x, st9.player.y);
  Game.FX.blood(st9.player.x, st9.player.y, 8);
  Game.FX.spark(st9.player.x, st9.player.y, 8);
  Game.FX.heal(st9.player.x, st9.player.y);
  Game.FX.shieldBreak(st9.player.x, st9.player.y);
  Game.FX.death(st9.player.x, st9.player.y, true);
  Game.FX.death(st9.player.x, st9.player.y, false);
  Game.FX.muzzle(st9.player.x, st9.player.y, 0.5);
  Game.FX.shake(8);
  Game.FX.flash('#ffcf5e', 0.3);
  assert(Game.FX.levelUp && Game.FX.talisman, '国风特效接口已挂载');

  Game.state = st9;
  Game.Renderer.setQuality('high');
  assert(Game.Renderer.outline === true, '高画质开启赛璐璐描边');
  for (var f1 = 0; f1 < 8; f1++) Game.Renderer.render(st9, 0.016); // 推进粒子/特效
  Game.Renderer.setQuality('low');
  assert(Game.Renderer.outline === false, '低画质关闭描边（省性能）');
  for (var f2 = 0; f2 < 8; f2++) Game.Renderer.render(st9, 0.016);
  assert(true, '四种怪物 / 两种投射物 / 两种掉落 / 全特效 双画质渲染无异常');

  // 触屏摇杆分支（国风配色）
  Game.Renderer.setQuality('high');
  Game.Input.touchMode = true;
  var j = Game.Input.joystick;
  j.visible = true; j.active = true;
  j.baseX = 200; j.baseY = 500; j.headX = 224; j.headY = 512;
  Game.Renderer.render(st9, 0.016);
  Game.Input.touchMode = false;
  assert(true, '虚拟摇杆渲染无异常');

  // 青色地面纹理确已生成（青砖庭院替代暗红荒原）
  assert(!!Game.Renderer.ground, '程序化地面纹理已生成');
} catch (e) {
  assert(false, '国风渲染异常: ' + e.stack);
}

/* ---------------- 直立化 + 攻击动作 ---------------- */
console.log('\n== 直立化 / 攻击动作覆盖 ==');
try {
  var st10 = Game.Systems.createState('campaign', 'swordsman', 22);
  Game.Systems.startWave(st10, 1);
  Game.state = st10;
  var pl = st10.player;

  // ① 八方向直立渲染：覆盖左右镜像 + 绕脚底倾斜（正左/正右倾斜量最大）分支
  Game.Renderer.setQuality('high');
  for (var a8 = 0; a8 < 8; a8++) {
    pl.facing = a8 * (Math.PI / 4);
    Game.Renderer.render(st10, 0.016);
  }
  assert(true, '玩家 8 方向直立渲染无异常');

  // ② 四种怪物八方向（各自脚底支点不同，boss 与蝠妖差异最大）
  var types2 = ['zombie', 'bat', 'wizard', 'boss'];
  st10.enemies.length = 0;
  for (var t2 = 0; t2 < types2.length; t2++) {
    st10.enemies.push(new Game.Enemy(types2[t2], 400 + t2 * 120, 400, 1));
  }
  for (var a8b = 0; a8b < 8; a8b++) {
    for (var e2 = 0; e2 < st10.enemies.length; e2++) {
      st10.enemies[e2].facing = a8b * (Math.PI / 4);
    }
    Game.Renderer.render(st10, 0.016);
  }
  assert(true, '四种怪物 8 方向直立渲染无异常');

  // ③ 玩家攻击动作：全程 t=0→dur 逐帧，覆盖抬剑蓄力/下劈/收势三段
  var pKinds = ['melee', 'ranged'];
  for (var k2 = 0; k2 < pKinds.length; k2++) {
    pl.playAttack(pKinds[k2]);
    var pdur = pl.attackAnim.dur;
    for (var s2 = 0; s2 <= 10; s2++) {
      pl.attackAnim.t = pdur * (s2 / 10);
      Game.Renderer.render(st10, 0.016);
    }
    pl.attackAnim = null;
  }
  assert(true, '玩家 近战下劈 / 远程后坐 全程姿态渲染无异常');

  // ④ 怪物攻击动作：四种类型全程逐帧
  var eKinds = ['lunge', 'dive', 'cast', 'boss'];
  for (var k3 = 0; k3 < eKinds.length; k3++) {
    var en2 = new Game.Enemy(types2[k3], 500, 400, 1);
    en2.playAttack(eKinds[k3]);
    var edur = en2.attackAnim.dur;
    st10.enemies.push(en2);
    for (var s3 = 0; s3 <= 10; s3++) {
      en2.attackAnim.t = edur * (s3 / 10);
      Game.Renderer.render(st10, 0.016);
    }
    st10.enemies.pop();
  }
  assert(true, '跳尸前扑 / 蝠妖俯冲 / 邪修施法 / 年兽拍击 全程姿态渲染无异常');

  // ⑤ 计时推进：播完必须自动清空，否则姿态会永久卡在出手帧
  var en3 = new Game.Enemy('zombie', 500, 400, 1);
  en3.playAttack('lunge');
  assert(en3.attackAnim !== null, 'playAttack 后 attackAnim 已挂载');
  var guard = 0;
  while (en3.attackAnim && guard++ < 300) en3.tickAttackAnim(0.016);
  assert(en3.attackAnim === null, '动作播完后自动清空（' + guard + ' 帧内结束）');

  // ⑥ 集成：真实战斗路径必须触发动作，而不是只有直接调 playAttack 才动
  st10.enemies.length = 0;
  pl.attackAnim = null;
  var target = new Game.Enemy('zombie', pl.x + 20, pl.y, 1); // 贴脸 → 在近战范围内
  target.hp = target.maxHp = 1e9;                            // 打不死，便于断言
  st10.enemies.push(target);
  var sword = new Game.WeaponInstance('iron_sword', 1);
  sword.cooldownRemaining = 0;
  sword.update(0.016, pl, st10);
  assert(pl.attackAnim !== null && pl.attackAnim.kind === 'melee',
         '铁剑近战命中触发下劈动作（集成路径，非直接调用）');

  // ⑦ 低画质（描边关闭）下同样不崩
  Game.Renderer.setQuality('low');
  pl.playAttack('melee', 0);
  for (var s4 = 0; s4 <= 6; s4++) {
    pl.attackAnim.t = pl.attackAnim.dur * (s4 / 6);
    Game.Renderer.render(st10, 0.016);
  }
  Game.Renderer.setQuality('high');
  assert(true, '低画质（无描边）下攻击姿态渲染无异常');

  /* ⑧ 量化验证「竖向」：追踪 canvas 变换矩阵，确认角色没有被转倒。
     旧实现是 rotate(facing + PI/2)，朝右时局部「上」向量会被映射到 (1,0)
     —— 也就是整个人横躺着，正是要修的问题。这里直接断言「上」仍朝上。 */
  function makeMatrixCtx() {
    var m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    var stack = [], arcs = [];
    function mul(n) {
      m = {
        a: m.a * n.a + m.c * n.b,
        b: m.b * n.a + m.d * n.b,
        c: m.a * n.c + m.c * n.d,
        d: m.b * n.c + m.d * n.d,
        e: m.a * n.e + m.c * n.f + m.e,
        f: m.b * n.e + m.d * n.f + m.f,
      };
    }
    var api = {
      save: function () { stack.push({ a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }); },
      restore: function () { if (stack.length) m = stack.pop(); },
      translate: function (x, y) { mul({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
      rotate: function (t) { mul({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t), e: 0, f: 0 }); },
      scale: function (x, y) { mul({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
      arc: function (x, y, r) {
        arcs.push({ x: x, r: r, a: m.a, b: m.b, c: m.c, d: m.d });
      },
    };
    return {
      ctx: new Proxy(api, {
        get: function (t, k) { return (k in t) ? t[k] : function () {}; },
        set: function (t, k, v) { t[k] = v; return true; },
      }),
      arcs: arcs,
    };
  }

  /** 局部「上」向量 (0,-1) 经矩阵后的 y 分量；-1 = 完全朝上，0 = 横躺 */
  function upY(mx) { return -mx.d; }

  pl.attackAnim = null; // 排除手臂挥砍带来的局部旋转，只看身体基准朝向
  var maxUy = -2, worstAngle = 0, tilts = 0;
  for (var a9 = 0; a9 < 8; a9++) {
    var ang9 = a9 * (Math.PI / 4);
    pl.facing = ang9;
    var rec = makeMatrixCtx();
    Game.Renderer._drawPlayer(rec.ctx, pl);
    // 头部圆：arc(0, ..., 9.6, ...) —— 半径 9.6 且 x=0 在全函数中唯一
    var head = null;
    for (var hi = 0; hi < rec.arcs.length; hi++) {
      if (rec.arcs[hi].x === 0 && Math.abs(rec.arcs[hi].r - 9.6) < 0.01) head = rec.arcs[hi];
    }
    if (!head) { assert(false, '未捕获到头部变换矩阵（角度 ' + a9 + '）'); break; }
    var uy = upY(head);
    if (uy > maxUy) { maxUy = uy; worstAngle = a9; } // 取最接近 0 的 = 最不直立的
    if (Math.abs(head.c) > 0.3) tilts++;
  }
  assert(maxUy < -0.9,
         '8 方向下角色始终直立：最差「上」向量 y=' + maxUy.toFixed(3) +
         '（角度 ' + worstAngle + '×45°，旧实现此值为 0 = 横躺）');
  assert(tilts === 0, '倾斜量受控（|c| ≤ 0.3，无任何方向出现横躺）');

  /* ⑨ 怪物走的是同一个 upright 工具，抽验跳尸头部基准朝向 */
  var zrec = makeMatrixCtx();
  var zom = new Game.Enemy('zombie', 400, 400, 1);
  zom.facing = 0; // 朝右 —— 旧实现下必然横躺
  Game.Renderer._drawEnemy(zrec.ctx, zom);
  var zhead = null;
  for (var zi = 0; zi < zrec.arcs.length; zi++) {
    if (zrec.arcs[zi].x === 0 && Math.abs(zrec.arcs[zi].r - 8.2) < 0.01) zhead = zrec.arcs[zi];
  }
  assert(zhead !== null && upY(zhead) < -0.9,
         '跳尸朝右时仍直立（上向量 y=' + (zhead ? upY(zhead).toFixed(3) : 'n/a') + '）');
} catch (e) {
  assert(false, '直立化/攻击动作异常: ' + e.stack);
}

/* ---------------- 商店锁卡 ---------------- */
console.log('\n== 商店锁卡 ==');
try {
  var st11 = Game.Systems.createState('campaign', 'swordsman', 42);
  st11.player.materials = 1e6;
  Game.state = st11;
  Game.Systems.startWave(st11, 1);
  Game.Game._onWaveEnd();
  assert(st11.screen === 'SHOP' && st11.shop.items.length === 4, '波次结束进入商店，4 张卡');

  // ① 同一次商店内：锁定卡在连续刷新中始终保留
  var sig11 = st11.shop.items[0].name + '#' + st11.shop.items[0].price;
  Game.Game.lockShop(0);
  assert(st11.shop.locked[0] === true, '点击后锁定标记置位');
  for (var rf = 0; rf < 6; rf++) {
    Game.Game.refreshShop();
    if (st11.shop.items[0].name + '#' + st11.shop.items[0].price !== sig11) break;
    if (rf === 5) assert(true, '连续 6 次刷新，锁定卡始终保留（' + sig11 + '）');
  }
  assert(st11.shop.items[0].name + '#' + st11.shop.items[0].price === sig11,
         '刷新不会替换锁定卡：期望 ' + sig11 + '，实际 ' + st11.shop.items[0].name + '#' + st11.shop.items[0].price);

  // ② 关键回归：锁定卡必须跨商店延续。
  //    旧实现 openShop 无条件把 locked 重置为 [false×4] 并重新抽卡，
  //    导致玩家锁了卡只要点「下一波」，下次进商店锁定全部丢失（「锁卡锁不住」）。
  var wave1Shop = st11.shop;
  var wave1LockedCard = st11.shop.items[1].name + '#' + st11.shop.items[1].price;
  Game.Game.lockShop(1);
  Game.Game.nextWave();
  Game.Game._onWaveEnd();
  assert(st11.shop !== wave1Shop, '新商店是新对象');
  assert(st11.shop.locked[1] === true, '跨商店后锁定标记保留');
  assert(st11.shop.items[1].name + '#' + st11.shop.items[1].price === wave1LockedCard,
         '跨商店后锁定卡本体保留（' + wave1LockedCard + '）');

  // ③ 购买必须清除锁定，否则已购卡会作为「锁定卡」一直带回后续商店
  Game.Game.lockShop(2);
  var bought2 = st11.shop.items[2].name;
  Game.Game.buyShop(2);
  assert(st11.shop.items[2].sold === true, '锁定卡可正常购买（' + bought2 + '）');
  assert(st11.shop.locked[2] === false, '购买后清除锁定标记（' + bought2 + '）');
  Game.Game.nextWave();
  Game.Game._onWaveEnd();
  assert(st11.shop.locked[2] === false, '已购卡的锁定不会延续到下次商店');

  // ⑤ 兜底旧存档：已购卡带着残留锁定标记时，不应污染新商店
  Game.Game.nextWave();
  Game.Game._onWaveEnd();
  st11.shop.items[1].sold = true;   // 模拟旧版本买完没清锁定标记的存档
  st11.shop.locked[1] = true;
  Game.Game.nextWave();
  Game.Game._onWaveEnd();
  assert(st11.shop.locked[1] === false, '已购卡的残留锁定标记不污染新商店');
  assert(st11.shop.items[1].sold !== true, '该槽位为新抽卡');

  // ④ 锁定指示器渲染：文案与图标都要出现
  Game.Game.lockShop(3);
  var shopHtml = document.getElementById('shop').innerHTML;
  assert(shopHtml.indexOf('已锁定') >= 0 && shopHtml.indexOf('🔒') >= 0,
         '锁定卡渲染出「已锁定」文案与 🔒 图标');
} catch (e) {
  assert(false, '商店锁卡异常: ' + e.stack);
}

/* ---------------- 节奏 / Boss 奖励 / 全屏触控 ---------------- */
console.log('\n== 波次节奏 / Boss 奖励 / 全屏触控 ==');
try {
  // ① 普通波：时间一到立即结束，不必清怪（旧实现要求 aliveCount === 0）
  var st20 = Game.Systems.createState('campaign', 'swordsman', 31);
  Game.state = st20;
  Game.Systems.startWave(st20, 2);
  // 全程不调 updateEnemies / 不做任何击杀，只让时间流逝
  var res20 = null, g20 = 0;
  while (g20++ < 400) { res20 = Game.Systems.updateWave(st20, 0.2); if (res20 === 'ended') break; }
  assert(res20 === 'ended', '时间到波次立即结束（共推进 ' + (g20 * 0.2).toFixed(1) + ' 秒）');
  assert(st20.stats.kills === 0, '结束时一只怪都没杀（kills=' + st20.stats.kills + '）');
  assert(st20.enemies.length === 0, '残怪已被清场');

  // ①b 残留在场的敌人投射物也要清掉，玩家自己的保留
  st20.projectiles.length = 0;
  st20.projectiles.push(new Game.Projectile({
    x: 400, y: 300, vx: 100, vy: 0, radius: 7, damage: 5, fromPlayer: false, life: 3, type: 'spell',
  }));
  st20.projectiles.push(new Game.Projectile({
    x: 420, y: 300, vx: 100, vy: 0, radius: 6, damage: 5, fromPlayer: true, life: 3, type: 'bullet',
  }));
  Game.Systems.clearEnemies(st20);
  assert(st20.projectiles.length === 1 && st20.projectiles[0].fromPlayer === true,
         '清场时敌人投射物被移除，玩家投射物保留');

  // ② 波末血量回满
  st20.player.stats.hp = 30;
  Game.Game._onWaveEnd();
  assert(st20.player.stats.hp === st20.player.stats.maxHp,
         '波末血量回满（30 → ' + st20.player.stats.hp + '/' + st20.player.stats.maxHp + '）');

  // ③ Boss 波时长显著加长
  var nonBoss10 = Math.min(45, 20 + (10 - 1));
  assert(Game.Systems.isBossWave(10) === true, '第 10 波是 Boss 波');
  assert(Game.Systems.waveDuration(10) === nonBoss10 + 45,
         'Boss 波时长 = 普通波基准 +45：' + nonBoss10 + ' → ' + Game.Systems.waveDuration(10));
  assert(Game.Systems.waveDuration(9) === nonBoss10 - 1,
         '非 Boss 波不受影响：第 9 波 ' + Game.Systems.waveDuration(9) + ' 秒');

  // ④ Boss 阵亡 → 弹出战利品三选一（而不是直接进商店）
  var st21 = Game.Systems.createState('campaign', 'swordsman', 33);
  Game.state = st21;
  Game.Systems.startWave(st21, 1);
  var boss = new Game.Enemy('boss', st21.player.x + 28, st21.player.y, 1);
  boss.hp = 1;                                  // 一刀毙命，走真实战斗路径
  st21.enemies.push(boss);
  var wp21 = st21.player.weapons[0];
  wp21.cooldownRemaining = 0;
  wp21.update(0.016, st21.player, st21);
  assert(st21.bossRewardPending === true, 'Boss 阵亡挂起奖励');
  Game.Game._update(st21, 0.016);
  assert(st21.screen === 'LEVEL_UP', '奖励面板已弹出（screen=' + st21.screen + '）');
  assert(st21.levelUpChoices.length === 3, '战利品三选一（' + st21.levelUpChoices.length + ' 张）');
  Game.Game.pickLevelUp(0);
  assert(st21.screen === 'PLAYING', '选完后回到 PLAYING');
  assert(st21.levelUpsPending === 0, 'Boss 奖励不污染升级计数（=' + st21.levelUpsPending + '）');
  assert(st21.player.weapons.length > 0,
         '战利品已应用到玩家（当前武器 ' +
         st21.player.weapons.map(function (w) { return w.defId; }).join(',') + '）');

  // ⑤ 专属武器：普通升级池与商店都不给，只在 Boss 奖励里按概率出现
  var normalExcl = 0, shopExcl = 0, bossExcl = 0, weakCard = 0;
  for (var t22 = 0; t22 < 200; t22++) {
    var sn = Game.Systems.createState('campaign', 'swordsman', 6000 + t22);
    var cn = Game.Systems.rollLevelUpChoices(sn);
    for (var a22 = 0; a22 < cn.length; a22++) {
      if (cn[a22].kind === 'weapon' && Game.WEAPONS[cn[a22].data.weaponId].exclusive) normalExcl++;
    }
  }
  for (var t23 = 0; t23 < 200; t23++) {
    var ss = Game.Systems.createState('campaign', 'swordsman', 8000 + t23);
    Game.Systems.openShop(ss);
    for (var b22 = 0; b22 < ss.shop.items.length; b22++) {
      var it22 = ss.shop.items[b22];
      if (it22.type === 'weapon' && Game.WEAPONS[it22.weaponId].exclusive) shopExcl++;
    }
  }
  for (var t24 = 0; t24 < 300; t24++) {
    var sb = Game.Systems.createState('campaign', 'swordsman', 9000 + t24);
    var cb = Game.Systems.bossRewardChoices(sb);
    var hasEx = false;
    for (var c22 = 0; c22 < cb.length; c22++) {
      var ch22 = cb[c22];
      if (ch22.kind === 'weapon' && Game.WEAPONS[ch22.data.weaponId].exclusive) hasEx = true;
      // 非武器卡必须是 epic/legend，不能把普通卡当 Boss 奖励发
      if (ch22.kind === 'upgrade' && ch22.data.rarity !== 'epic' && ch22.data.rarity !== 'legend') weakCard++;
      if (ch22.kind === 'item' && Game.ITEMS[ch22.data.itemId].rarity !== 'epic' &&
          Game.ITEMS[ch22.data.itemId].rarity !== 'legend') weakCard++;
    }
    if (hasEx) bossExcl++;
  }
  assert(normalExcl === 0, '普通升级池 200 次未出现专属武器');
  assert(shopExcl === 0, '商店 200 次未出现专属武器');
  assert(bossExcl > 0 && bossExcl < 300,
         'Boss 奖励有概率出专属武器（' + bossExcl + '/300 次，概率 ' +
         (Game.BOSS_EXCLUSIVE_CHANCE).toFixed(2) + '）');
  assert(weakCard === 0, 'Boss 奖励里的属性/道具卡全是 epic 或 legend（弱卡 ' + weakCard + ' 张）');

  // ⑥ 槽位已满时，专属武器挤掉最早加入的那一把
  var st25 = Game.Systems.createState('campaign', 'swordsman', 37);
  st25.player.weapons = [];
  for (var w22 = 0; w22 < Game.CONST.MAX_WEAPONS; w22++) {
    st25.player.weapons.push(new Game.WeaponInstance('pistol', 1));
  }
  var oldest22 = st25.player.weapons[0].defId;
  Game.Systems.applyChoice(st25, { kind: 'weapon', data: { weaponId: 'moon_sword' } });
  assert(st25.player.weapons.length === Game.CONST.MAX_WEAPONS,
         '武器槽上限不变（' + st25.player.weapons.length + '/' + Game.CONST.MAX_WEAPONS + '）');
  var last22 = st25.player.weapons[st25.player.weapons.length - 1].defId;
  assert(last22 === 'moon_sword',
         '专属武器进入最后一槽（' + last22 + '）');
  assert(st25.player.weapons.filter(function (w) { return w.defId === oldest22; }).length ===
         Game.CONST.MAX_WEAPONS - 1,
         '最早加入的那把被挤掉（' + oldest22 + ' 只剩 ' +
         st25.player.weapons.filter(function (w) { return w.defId === oldest22; }).length + ' 把）');

  // ⑦ 安卓触控：屏幕任意位置都能生成摇杆（旧实现只有左半屏生效）
  Game.Input.joystick.active = false;
  Game.Input.joystick.visible = false;
  Game.Input.joystick.pointerId = -1;
  var rightTouch = {
    preventDefault: function () {},
    changedTouches: [{ identifier: 1, clientX: 1200, clientY: 600 }],
    length: 1,
  };
  Game.Input._onTouchStart(rightTouch);
  assert(Game.Input.joystick.active === true, '右半屏（x=1200）触摸能生成摇杆');
  assert(Game.Input.joystick.baseX === 1200 && Game.Input.joystick.baseY === 600,
         '摇杆底盘落在触点位置（' + Game.Input.joystick.baseX + ',' + Game.Input.joystick.baseY + '）');
  // 上滑 → 应朝「上」移动（验证方向换算正确，不只是「有响应」）
  Game.Input._onTouchMove({
    preventDefault: function () {},
    changedTouches: [{ identifier: 1, clientX: 1200, clientY: 540 }],
    length: 1,
  });
  var mv22 = Game.Input.getMove();
  assert(mv22.y < -0.5, '上滑产生向上移动向量（y=' + mv22.y.toFixed(2) + '）');
  // 多点触控：第二个指头不应抢占摇杆
  var base22 = Game.Input.joystick.baseX;
  Game.Input._onTouchStart({
    preventDefault: function () {},
    changedTouches: [{ identifier: 2, clientX: 100, clientY: 100 }],
    length: 1,
  });
  assert(Game.Input.joystick.baseX === base22, '第二个指头不抢占摇杆');
  // 触摸结束 → 归位
  Game.Input._onTouchEnd({
    preventDefault: function () {},
    changedTouches: [{ identifier: 1 }],
    length: 1,
  });
  assert(Game.Input.joystick.active === false, '抬手后摇杆释放');
} catch (e) {
  assert(false, '节奏/Boss奖励/触控异常: ' + e.stack);
}

/* ---------------- 角色被动 ---------------- */
console.log('\n== 角色被动（挂点派发 / 连击叠层 / 存档往返）==');
try {
  var S26 = Game.Systems;

  // ① 每个角色的被动 id 都必须在注册表里有实现，否则界面上写着、进游戏没效果
  var reg26 = true;
  for (var ci = 0; ci < Game.CHARACTERS.length; ci++) {
    var cp = Game.CHARACTERS[ci].passive;
    if (!cp || !cp.id || !Game.PASSIVES[cp.id]) reg26 = false;
  }
  assert(reg26, '所有角色的被动 id 都在 Game.PASSIVES 里注册');

  // ② 角色卡渲染出被动名与描述，不能是 [object Object]
  Game.UI.renderCharSelect();
  var cs26 = document.getElementById('menu').innerHTML;
  assert(cs26.indexOf('[object Object]') < 0, '角色选择界面不出现 [object Object]');
  assert(cs26.indexOf('连击 — 连续命中同一目标伤害 +5%') >= 0, '角色卡渲染出被动名与描述');

  // ③ 连击叠层：同一目标每层 +5%，6 层封顶 +30%，换目标清零
  var pl26 = new Game.Player('swordsman');
  var tgt26 = new Game.Enemy('zombie', 200, 200, 1);
  var hits26 = [];
  for (var h26 = 1; h26 <= 8; h26++) {
    hits26.push(Game.invokePassive(pl26, 'onHit', { enemy: tgt26, dmg: 100, crit: false, weapon: null }) / 100);
  }
  assert(hits26[0] === 1 && hits26[1] === 1.05 && hits26[2] === 1.1,
    '连击按目标逐层 +5%（首击 1.00 → ' + hits26[1].toFixed(2) + ' → ' + hits26[2].toFixed(2) + '）');
  assert(hits26[6] === 1.3 && hits26[7] === 1.3,
    '连击封顶 6 层 +30%（第 7/8 击都是 ' + hits26[6].toFixed(2) + '）');
  var other26 = new Game.Enemy('bat', 300, 300, 1);
  assert(tgt26.uid !== other26.uid, '同类型怪也有各自 uid（被动靠它区分「同一目标」）');
  var reset26 = Game.invokePassive(pl26, 'onHit', { enemy: other26, dmg: 100, crit: false, weapon: null }) / 100;
  assert(reset26 === 1, '换成另一只怪立即清零重算（' + reset26.toFixed(2) + '）');

  // ④ 派发器必须无副作用：没被动 / 没这个挂点 / id 不存在 → 一律返回 undefined
  assert(Game.invokePassive(null, 'onHit', {}) === undefined, '没有 player 时不派发');
  var nop26 = new Game.Player('swordsman');
  nop26.passive = null;
  assert(Game.invokePassive(nop26, 'onHit', { dmg: 10 }) === undefined, 'passive 为空时不派发');
  assert(Game.invokePassive(pl26, 'perTick', {}, 0.016) === undefined,
    '被动未实现该挂点时不派发（连击不实现 perTick）');
  var ghost26 = new Game.Player('swordsman');
  ghost26.passive = { id: '不存在的被动' };
  assert(Game.invokePassive(ghost26, 'onHit', { dmg: 10 }) === undefined, '注册表里没有的 id 不派发');

  // ⑤ 挂点全链路：注册一个测试被动，逐个挂点验证「真的被调用、真的生效」
  Game.PASSIVES._test2x = {
    name: '测试翻倍', desc: '',
    onHit: function (player, info) { return info.dmg * 2; },
    onDamageTaken: function (player, raw) { return raw * 0.5; },
    onKill: function (player, enemy, state) { player.passiveState.kills = (player.passiveState.kills || 0) + 1; },
    onWaveStart: function (player, state, wave) { player.passiveState.waveStart = wave; },
    perTick: function (player, state, dt) { player.passiveState.regen = (player.passiveState.regen || 0) + dt; },
  };

  // ⑤a 近战武器命中 → onHit 生效，且记账伤害与敌人实扣一致
  var st26 = S26.createState('campaign', 'swordsman', 41);
  var tp26 = new Game.Player('swordsman');
  tp26.passive = { id: '_test2x', name: '测试翻倍', desc: '' };
  tp26.stats.critChance = 0;
  tp26.weapons = st26.player.weapons;   // 接回起始武器（Player 构造不带武器）
  st26.player = tp26; st26.enemies = []; st26.projectiles = []; st26.pickups = [];
  var me26 = new Game.Enemy('zombie', tp26.x + 40, tp26.y, 1);
  var hp026 = me26.hp;
  st26.enemies.push(me26);
  var w26 = tp26.weapons[0];
  w26.cooldownRemaining = 0;
  w26.update(0.016, tp26, st26);
  assert(me26.dead === true, 'onHit 生效：铁剑 14 翻成 28，一刀打死 20 血的跳尸');
  assert(tp26.damageDealt === 28, '记账伤害 = 28（被动加成后，不是原始 14）');
  assert(hp026 - me26.hp === 28, '敌人实扣 = 28（记账与实扣一致，没漏算）');
  assert(tp26.passiveState.stacks === undefined, '测试被动不污染连击内部状态');
  assert(tp26.passiveState.kills === 1, 'onKill 挂点被调用');

  // ⑤b 远程投射物命中 → onHit 同样生效
  var st27 = S26.createState('campaign', 'swordsman', 42);
  var tp27 = new Game.Player('swordsman');
  tp27.passive = { id: '_test2x', name: '测试翻倍', desc: '' };
  tp27.stats.critChance = 0;
  st27.player = tp27; st27.enemies = []; st27.projectiles = []; st27.pickups = [];
  st27.enemies.push(new Game.Enemy('bat', tp27.x + 30, tp27.y, 1));
  st27.projectiles.push(new Game.Projectile({
    x: tp27.x + 30, y: tp27.y, vx: 0, vy: 0, radius: 6, damage: 10, crit: false,
    fromPlayer: true, pierce: 0, life: 2, type: 'bullet', knockback: 0, owner: tp27,
  }));
  S26.updateProjectiles(st27, 0.016);
  assert(tp27.damageDealt === 20, '远程命中也走被动（10 → 20）');

  // ⑤c 承伤减免，且无敌帧仍然优先
  var hp27 = tp27.stats.hp;
  tp27.takeDamage(20);
  assert(tp27.stats.hp === hp27 - 10, 'onDamageTaken 生效：20 伤害减半为 10（剩 ' + tp27.stats.hp + '）');
  assert(tp27.takeDamage(20) === 0, '无敌帧仍然优先于被动（第二次不吃伤害）');

  // ⑤d 每帧挂点
  var st28 = S26.createState('campaign', 'swordsman', 43);
  var tp28 = new Game.Player('swordsman');
  tp28.passive = { id: '_test2x', name: '测试翻倍', desc: '' };
  st28.player = tp28; st28.enemies = []; st28.projectiles = []; st28.pickups = [];
  S26.updatePlayer(st28, 0.5);
  S26.updatePlayer(st28, 0.25);
  assert(Math.abs(tp28.passiveState.regen - 0.75) < 1e-9,
    'perTick 每帧被调用并累加（累计 ' + tp28.passiveState.regen.toFixed(2) + ' 秒）');

  // ⑤e 波次开始挂点
  Game.state = st28;
  S26.startWave(st28, 3);
  assert(tp28.passiveState.waveStart === 3, 'onWaveStart 挂点被调用并收到波号');

  // ⑥ passiveState 必须随存档往返，读档不能悄悄清零叠层
  var st29 = S26.createState('campaign', 'swordsman', 44);
  st29.player.passiveState = { lastUid: 999, stacks: 4 };
  var sv26 = S26.serialize(st29);
  assert(sv26.player.passiveState.stacks === 4, '序列化写入了 passiveState');
  var ld26 = S26.deserialize(sv26);
  assert(ld26.player.passiveState.stacks === 4, '读档后连击层数保留（stacks=4）');
  assert(ld26.player.passiveState.lastUid === 999, '读档后 lastUid 保留');
  assert(ld26.player.passive && ld26.player.passive.id === 'combo', '读档后被动定义仍绑定该角色');
  // 旧档没有这个字段也不能崩
  var legacy26 = JSON.parse(JSON.stringify(sv26));
  delete legacy26.player.passiveState;
  var ld27 = S26.deserialize(legacy26);
  assert(ld27.player.passiveState && typeof ld27.player.passiveState === 'object',
    '旧档缺 passiveState 时回落到空对象');

  delete Game.PASSIVES._test2x;
} catch (e) {
  assert(false, '角色被动异常: ' + e.stack);
}

/* ---------------- 纪录榜数据层 ---------------- */
console.log('\n== 纪录榜 ==');
try {
  assert(!!Game.Records, 'Records 模块已挂载');

  Game.Records.clear();
  assert(Game.Records.load().runs.length === 0, '无档案时 load 回落空榜');

  // 排序：波次降序 → 同波次伤害降序
  Game.Records.clear();
  Game.Records.add({ mode: 'endless',  wave: 5,  damage: 100, at: 1 });
  Game.Records.add({ mode: 'campaign', wave: 20, damage: 50,  at: 2 });
  Game.Records.add({ mode: 'endless',  wave: 20, damage: 999, at: 3 });
  Game.Records.add({ mode: 'campaign', wave: 20, damage: 200, at: 4 });
  var runs = Game.Records.load().runs;
  assert(runs.length === 4, '四条成绩全部保留（未达 TOP_N）');
  assert(runs[0].wave === 20 && runs[0].damage === 999, '同波次按伤害降序：999 排第一');
  assert(runs[1].damage === 200, '同波次次高伤害排第二');
  assert(runs[2].damage === 50, '同波次最低伤害排第三');
  assert(runs[3].wave === 5, '低波次排在所有高波次之后');

  // TOP_N 截断与名次
  Game.Records.clear();
  var last = null;
  for (var ri = 0; ri < 14; ri++) {
    last = Game.Records.add({ mode: 'endless', wave: 23 - ri, damage: ri, at: ri + 1 });
  }
  var top = Game.Records.load().runs;
  assert(top.length === Game.Records.TOP_N, '榜单截断到 TOP_N（实际 ' + top.length + '）');
  assert(top[0].wave === 23, '最高波次排第一（wave=23）');
  assert(last.entered === false && last.rank === null,
         '不入榜时 rank 为 null（截断后名次算不出，不给假数字）');
  var r = Game.Records.add({ mode: 'endless', wave: 30, damage: 1, at: 999 });
  assert(r.entered === true && r.rank === 1, '高于榜首的新成绩入榜且排第一');

  // 旧档案兼容
  Game.Storage.setJSON('profile_v1', { best: { wave: 3 } });
  assert(Game.Records.load().runs.length === 0, '旧档案无 runs 字段时回落空榜');
  Game.Storage.setJSON('profile_v1', { runs: '不是数组' });
  assert(Game.Records.load().runs.length === 0, 'runs 类型不对时回落空榜');

  // toRun 摘取
  var st32 = Game.Systems.createState('endless', 'swordsman', 77);
  Game.Systems.startWave(st32, 33);
  st32.stats.kills = 42; st32.elapsed = 123.7;
  st32.player.damageDealt = 8888.4; st32.player.materials = 15; st32.player.level = 9;
  var run = Game.Records.toRun(st32);
  assert(run.mode === 'endless' && run.wave === 33, 'toRun 摘取模式与波次');
  assert(run.kills === 42 && run.damage === 8888 && run.elapsed === 124,
         'toRun 摘取统计（伤害取整、时间取整）');
  assert(run.charName === '流浪剑客', 'toRun 带角色名');
  assert(run.level === 9 && run.materials === 15, 'toRun 带等级与材料');
  assert(run.player === undefined && run.seed === undefined, 'toRun 不含存档字段');
} catch (e) {
  assert(false, '纪录榜异常: ' + e.stack);
}

/* ---------------- 无限模式：波次不封顶 + 存档槽隔离 ---------------- */
console.log('\n== 无限模式 ==');
try {
  // 先放一条闯关存档当哨兵，用来验证无限模式不会碰它
  Game.Storage.setJSON('campaign_v1', { mode: 'campaign', wave: 13, player: { id: 'swordsman' } });

  // 存档槽分流：无限模式写 endless_v1，不占 campaign_v1
  var stE = Game.Systems.createState('endless', 'swordsman', 101);
  Game.Systems.startWave(stE, 1);
  Game.state = stE;
  Game.Game.saveGame();
  var slot = Game.Storage.getJSON('endless_v1');
  assert(slot && slot.mode === 'endless' && slot.wave === 1, '无限模式存档落进 endless_v1');
  assert(Game.Storage.getJSON('campaign_v1').wave === 13, '无限模式存档不占用 campaign_v1（哨兵仍在）');

  // HUD 标出模式，免得玩家不知道自己不在闯关
  Game.UI.updateHUD(stE);
  assert(document.getElementById('hud-wave').textContent.indexOf('无限') >= 0,
         '无限模式 HUD 波次栏带「无限」标记');
  var stC = Game.Systems.createState('campaign', 'swordsman', 102);
  Game.Systems.startWave(stC, 3);
  Game.state = stC;
  Game.UI.updateHUD(stC);
  assert(document.getElementById('hud-wave').textContent.indexOf('无限') < 0,
         '闯关模式 HUD 不带「无限」标记');

  // 关键回归：无限模式死亡只清自己的槽，不能误删闯关存档
  var stE2 = Game.Systems.createState('endless', 'swordsman', 103);
  Game.Systems.startWave(stE2, 25);
  stE2.stats.kills = 30; stE2.player.damageDealt = 5000;
  Game.state = stE2;
  Game.Game.saveGame();
  Game.Game._gameOver();
  assert(Game.Storage.getJSON('endless_v1') === null, '无限模式死亡清掉了自己的 endless_v1');
  assert(Game.Storage.getJSON('campaign_v1').wave === 13,
         '【回归】无限模式死亡不误删闯关存档（wave=13 仍在）');

  // 成绩已入榜
  var board = Game.Records.load().runs;
  assert(board.length > 0 && board.some(function (x) { return x.wave === 25 && x.mode === 'endless'; }),
         '无限模式结算成绩已写入纪录榜');

  // 波次不封顶：无限模式第 21 波结束应进商店而不是胜利
  var stE3 = Game.Systems.createState('endless', 'swordsman', 104);
  Game.Systems.startWave(stE3, 21);
  Game.state = stE3;
  Game.Game._onWaveEnd();
  assert(Game.state.screen === 'SHOP', '无限模式第 21 波结束进商店，不触发胜利');
  assert(!!Game.state.shop, '无限模式第 21 波商店正常打开');

  // 商店点「下一波」能进 22 波
  Game.Game.nextWave();
  assert(Game.state.screen === 'PLAYING' && Game.state.wave === 22,
         '无限模式商店「下一波」进入第 22 波');

  // 无限模式存档可继续（序列化回环保留 mode 与波次）
  var stE4 = Game.Systems.createState('endless', 'swordsman', 555);
  Game.Systems.startWave(stE4, 8);
  Game.state = stE4;
  Game.Game.saveGame();
  Game.state = null;
  Game.Game.continueEndless();
  assert(Game.state.mode === 'endless' && Game.state.wave === 8,
         '无限模式存档可继续（mode/endless 与 wave=8 保留）');

  // 闯关封顶行为未被改坏
  var stC2 = Game.Systems.createState('campaign', 'swordsman', 105);
  Game.Systems.startWave(stC2, 20);
  Game.state = stC2;
  Game.Game._onWaveEnd();
  assert(Game.state.screen === 'VICTORY', '闯关第 20 波结束仍触发胜利（未被无限模式影响）');
  Game.state = null;
} catch (e) {
  assert(false, '无限模式异常: ' + e.stack);
}

/* ---------------- 菜单 / 纪录榜界面 ---------------- */
console.log('\n== 菜单与纪录榜界面 ==');
try {
  Game.Records.clear();
  Game.Storage.remove('campaign_v1');
  Game.Storage.remove('endless_v1');
  Game.state = null;
  Game.Game.toMenu();
  var menuHtml = document.getElementById('menu').innerHTML;
  assert(menuHtml.indexOf('startEndless') >= 0, '菜单有无限模式入口');
  assert(menuHtml.indexOf('openRecords') >= 0, '菜单有纪录榜入口');
  assert(menuHtml.indexOf('开发中') < 0, '菜单不再有「开发中」占位按钮');
  assert(menuHtml.indexOf('删除存档') >= 0, '菜单保留删除存档');

  // 有未完成对局时按钮提示可继续的波次
  Game.Storage.setJSON('endless_v1', { wave: 25, player: { id: 'swordsman' } });
  Game.state = null;
  Game.Game.toMenu();
  assert(document.getElementById('menu').innerHTML.indexOf('继续 第 25 波') >= 0,
         '有无尽存档时菜单提示可继续的波次');

  // 角色选择卡片走统一入口（按 pendingMode 分流）
  Game.pendingMode = 'endless';
  Game.UI.renderCharSelect();
  assert(document.getElementById('menu').innerHTML.indexOf('startRun') >= 0,
         '角色卡片改调 startRun（按 pendingMode 分流）');
  Game.pendingMode = 'campaign';

  // 纪录榜界面
  Game.Game.openRecords();
  assert(Game.uiScreen === 'RECORDS', 'openRecords 切换到 RECORDS 面板');
  assert(document.getElementById('records').innerHTML.indexOf('暂无纪录') >= 0, '空榜显示占位文案');

  // 榜有数据时的行渲染
  Game.Records.add({ mode: 'endless', charName: '流浪剑客', wave: 42, kills: 120,
                     damage: 8888, materials: 30, level: 12, elapsed: 950 });
  Game.Game.openRecords();
  var rHtml = document.getElementById('records').innerHTML;
  assert(rHtml.indexOf('NO.1') >= 0 && rHtml.indexOf('第 42 波') >= 0, '榜单渲染名次与波次');
  assert(rHtml.indexOf('无限') >= 0 && rHtml.indexOf('流浪剑客') >= 0, '榜单渲染模式与角色名');
  assert(rHtml.indexOf('15:50') >= 0, '榜单渲染存活时间（15:50）');

  // 清空纪录
  Game.Game.clearRecords();
  assert(Game.Storage.getJSON('profile_v1') === null, '清空纪录移除 profile_v1');
  assert(document.getElementById('records').innerHTML.indexOf('暂无纪录') >= 0, '清空后回到空榜占位');

  // 纪录榜上按安卓返回键应回菜单，而不是把 App 退出去
  var bk = Game.Game._handleBack();
  assert(bk.handled === true && Game.uiScreen === 'MENU', '纪录榜按返回键回菜单而非退出 App');

  // 主菜单按返回键仍交给系统（无运行状态、无面板需要拦）
  var bk2 = Game.Game._handleBack();
  assert(bk2.handled === false, '主菜单按返回键仍交由系统处理');

  // 收尾：清掉测试写的存档，避免污染本地开发环境
  Game.Storage.remove('campaign_v1');
  Game.Storage.remove('endless_v1');
  Game.Records.clear();
  Game.state = null;
} catch (e) {
  assert(false, '菜单/纪录榜界面异常: ' + e.stack);
}

/* ---------------- 反伤机制 + 坦克（21 波起才出场） ---------------- */
console.log('\n== 反伤机制 / 坦克 ==');
try {
  var EN33 = Game.ENEMIES;
  var TANKS33 = ['golem', 'bulwark', 'bruiser'];
  var OLD33 = ['zombie', 'bat', 'wizard', 'boss'];

  // ① 配置形状：新怪都配了 counter，旧怪一个字段都没加
  var cfg33 = true;
  for (var c33 = 0; c33 < TANKS33.length; c33++) {
    if (!(EN33[TANKS33[c33]].counter > 0)) cfg33 = false;
  }
  assert(cfg33, '三个坦克都配置了 counter（石甲力士/铁壁武卒/铁拳力士）');
  var oldUntouched = true;
  for (var c34 = 0; c34 < OLD33.length; c34++) {
    if (EN33[OLD33[c34]].counter !== undefined) oldUntouched = false;
  }
  assert(oldUntouched, '现有四种怪没有新增 counter 字段（ENEMIES 旧条目未改动）');
  var tanksConstruct = [];
  for (var c35 = 0; c35 < TANKS33.length; c35++) {
    tanksConstruct.push(new Game.Enemy(TANKS33[c35], 200, 200, 21));
  }
  assert(tanksConstruct.length === 3 &&
         tanksConstruct[0].def.name === '石甲力士' &&
         tanksConstruct[1].def.name === '铁壁武卒' &&
         tanksConstruct[2].def.name === '铁拳力士',
         '三种坦克都能按配置构造');

  // ② 反弹比例：被命中时按 counter 把该次伤害反弹给攻击者
  var plA = new Game.Player('swordsman');
  plA.stats.critChance = 0;
  plA.x = 0; plA.y = 0;
  var g0 = new Game.Enemy('golem', 40, 0, 21);
  g0.hp = 1e9;                                  // 防死，专注验证反弹
  g0.takeDamage(100, false, 0, 0, plA);
  var expA = 100 * EN33.golem.counter;
  assert(Math.abs((100 - plA.stats.hp) - expA) < 1e-9,
         '石甲力士按 counter=' + EN33.golem.counter + ' 反弹 ' + expA +
         '（实扣 ' + (100 - plA.stats.hp).toFixed(2) + '）');
  assert(plA.counterFlash > 0, '反伤受击触发专属闪色计时（区别于普通受击白闪）');
  assert(g0.counterFlash > 0, '反弹触发时坦克亮起反伤环');

  // ③ 旧怪不反弹（基线不动）
  var plB = new Game.Player('swordsman');
  plB.stats.critChance = 0;
  var z0 = new Game.Enemy('zombie', 40, 0, 1);
  z0.hp = 1e9;
  assert(z0.counter === 0, '旧怪 counter 恒为 0');
  z0.takeDamage(100, false, 0, 0, plB);
  assert(plB.stats.hp === 100, '旧怪不反弹，攻击者不掉血');
  assert(z0.counterFlash === 0, '旧怪不触发反伤环');
  assert(plB.counterFlash === 0, '旧怪命中不触发反伤闪色');

  // ④ 不暴击反弹：crit 不放大反伤
  var plC = new Game.Player('swordsman'), plC0 = new Game.Player('swordsman');
  plC.stats.critChance = 0; plC0.stats.critChance = 0;
  var gC = new Game.Enemy('golem', 0, 40, 21); gC.hp = 1e9;
  var gC0 = new Game.Enemy('golem', 0, 40, 21); gC0.hp = 1e9;
  gC.takeDamage(100, true, 0, 0, plC);
  gC0.takeDamage(100, false, 0, 0, plC0);
  assert(Math.abs(plC.stats.hp - plC0.stats.hp) < 1e-9,
         '暴击与普通命中反弹完全一致（暴击不参与反伤放大）');

  // ⑤ 致死一击不反弹：死了就不再反弹，也不产生自我递归
  var plD = new Game.Player('swordsman');
  var gD = new Game.Enemy('golem', 0, 40, 21);
  assert(gD.takeDamage(1e9, false, 0, 0, plD) === true, '一击致死返回死亡');
  assert(gD.dead === true, '坦克已死');
  assert(plD.stats.hp === 100, '致死一击不反弹（不打断玩家连招、不无限连锁）');

  // ⑥ 反伤走完整减伤管线：护甲生效、护盾优先
  var plE = new Game.Player('swordsman');
  plE.stats.critChance = 0;
  plE.stats.armor = 30;                          // 减伤 = 30/(30+30) = 50%
  plE.stats.shield = 3; plE.stats.shieldMax = 3;
  var gE = new Game.Enemy('golem', 0, 40, 21); gE.hp = 1e9;
  gE.takeDamage(100, false, 0, 0, plE);
  var rawE = 100 * EN33.golem.counter;
  var afterArmorE = rawE * (1 - plE.stats.armor / (plE.stats.armor + 30));
  assert(plE.stats.shield === 0, '反伤先吃护盾（护盾 3 已耗尽）');
  assert(Math.abs(plE.stats.hp - (100 - (afterArmorE - 3))) < 1e-9,
         '反伤吃护甲减伤：原始 ' + rawE + ' → 减伤后 ' + afterArmorE.toFixed(1) +
         '，护盾吃 3，净扣 ' + (100 - plE.stats.hp).toFixed(2));

  // ⑦ 无敌帧仍然吃：反弹不能穿透 0.35s 无敌帧
  var plF = new Game.Player('swordsman');
  plF.stats.critChance = 0;
  var gF = new Game.Enemy('golem', 0, 40, 21); gF.hp = 1e9;
  gF.takeDamage(100, false, 0, 0, plF);
  assert(plF.invincibleTimer > 0, '首次反伤置上了无敌帧');
  var hpF = plF.stats.hp;
  gF.takeDamage(100, false, 0, 0, plF);
  assert(plF.stats.hp === hpF, '无敌帧内第二次反伤被吞掉（不会被坦克贴脸连打致死）');

  // ⑧ 集成：近战命中坦克 → 真实战斗路径触发反弹
  var st33 = Game.Systems.createState('campaign', 'swordsman', 45);
  var tp33 = st33.player;
  tp33.stats.critChance = 0;
  st33.enemies.length = 0; st33.projectiles.length = 0;
  var g33 = new Game.Enemy('golem', tp33.x + 40, tp33.y, 21);
  g33.hp = 1e9;
  st33.enemies.push(g33);
  var sw33 = tp33.weapons[0];
  sw33.cooldownRemaining = 0;
  sw33.update(0.016, tp33, st33);
  assert(tp33.damageDealt > 0, '近战命中坦克造成正向伤害');
  assert(tp33.stats.hp < 100,
         '近战命中坦克后被反弹（hp=' + tp33.stats.hp.toFixed(2) + '）');
  assert(tp33.counterFlash > 0, '集成路径下玩家拿到反伤闪色标记');

  // ⑨ 集成：远程投射物命中坦克同样反弹
  var st34 = Game.Systems.createState('campaign', 'swordsman', 46);
  var tp34 = st34.player;
  tp34.stats.critChance = 0;
  st34.enemies.length = 0; st34.pickups.length = 0;
  st34.enemies.push(new Game.Enemy('bulwark', tp34.x + 30, tp34.y, 35));
  st34.projectiles.push(new Game.Projectile({
    x: tp34.x + 30, y: tp34.y, vx: 0, vy: 0, radius: 6, damage: 20, crit: false,
    fromPlayer: true, pierce: 0, life: 2, type: 'bullet', knockback: 0, owner: tp34,
  }));
  Game.Systems.updateProjectiles(st34, 0.016);
  assert(tp34.stats.hp < 100,
         '投射物命中坦克也被反弹（hp=' + tp34.stats.hp.toFixed(2) + '）');

  // ⑩ 反伤环计时会衰减归零（否则光晕会永久挂住）
  var g35 = new Game.Enemy('golem', 0, 0, 21);
  var farPlayer = { x: 10000, y: 10000, radius: 16, takeDamage: function () { return 0; } };
  g35.counterFlash = 0.35;
  g35.update(0.2, farPlayer, { projectiles: [] });
  assert(g35.counterFlash < 0.35,
         '反伤环计时随时间衰减（0.35 → ' + g35.counterFlash.toFixed(3) + '）');

  /* ⑪ 关键护栏：wave <= 20 的刷新构成必须与加入坦克前逐位一致。
     把旧算法原样复刻一份当参照，逐波逐种子比对照刷序列 ——
     只要新代码多消耗了一次 rng()，参照序列会在第 2 只怪就分叉。 */
  function oldPick(rng, wave) {
    var r = rng();
    var wizardChance = 0.15 + Math.min(0.2, wave * 0.01);
    var batChance = 0.3;
    if (r < wizardChance) return 'wizard';
    if (r < wizardChance + batChance) return 'bat';
    return 'zombie';
  }
  var same33 = 0, monsters33 = 0;
  for (var w33 = 1; w33 <= 20; w33++) {
    for (var sd33 = 1; sd33 <= 30; sd33++) {
      var sch33 = Game.Systems.buildSpawnSchedule({ seed: sd33, wave: w33 }, w33);
      var rngRef = Game.mulberry32(Game.hashSeed(sd33 + ':' + w33));
      var budget33 = 8 + w33 * 6;
      if (Game.Systems.isBossWave(w33)) budget33 = Math.max(10, Math.floor(budget33 * 0.6));
      var seq33 = [], t33 = 0.5, n33 = 0;
      while (n33 < budget33 && t33 < Game.Systems.waveDuration(w33)) {
        seq33.push(oldPick(rngRef, w33));
        n33++; t33 += 0.55 - Math.min(0.3, w33 * 0.01);
        if (t33 < 0.1) t33 = 0.1;
      }
      var got33 = [];
      for (var gi33 = 0; gi33 < sch33.length; gi33++) {
        if (!sch33[gi33].boss) got33.push(sch33[gi33].type);
      }
      monsters33 += got33.length;
      if (JSON.stringify(got33) === JSON.stringify(seq33)) same33++;
    }
  }
  assert(same33 === 600,
         'wave 1~20 全部 600 组刷新计划与旧算法逐位一致（' + same33 +
         '/600，共 ' + monsters33 + ' 只怪）—— 已验收基线未漂移');

  var rngCnt = 0, baseRng33 = Game.mulberry32(7);
  Game.Systems.pickEnemyType(function () { rngCnt++; return baseRng33(); }, 20);
  assert(rngCnt === 1, 'wave≤20 每次刷新只消耗 1 次随机数（不额外取数，后续序列不漂移）');

  // ⑫ 20 波（闯关上限）绝不刷坦克
  var tankAt20 = 0;
  for (var sd34 = 1; sd34 <= 200; sd34++) {
    var sch34 = Game.Systems.buildSpawnSchedule({ seed: sd34, wave: 20 }, 20);
    for (var si34 = 0; si34 < sch34.length; si34++) {
      if (TANKS33.indexOf(sch34[si34].type) >= 0) tankAt20++;
    }
  }
  assert(tankAt20 === 0, '20 波（闯关上限）200 组计划里 0 只坦克');

  // ⑬ 21 波起三种坦克都会出场，且旧怪仍在刷（是增量，不是替换）
  var seen33 = {};
  for (var w34 = 21; w34 <= 45; w34++) {
    for (var sd35 = 1; sd35 <= 30; sd35++) {
      var sch35 = Game.Systems.buildSpawnSchedule({ seed: sd35, wave: w34 }, w34);
      for (var si35 = 0; si35 < sch35.length; si35++) seen33[sch35[si35].type] = true;
    }
  }
  var tankSeen = 0;
  for (var ti33 = 0; ti33 < TANKS33.length; ti33++) if (seen33[TANKS33[ti33]]) tankSeen++;
  assert(tankSeen === 3, 'wave≥21 三种坦克都会刷新（实见 ' + tankSeen + '/3）');
  assert(seen33.zombie && seen33.bat && seen33.wizard,
         '坦克加入后跳尸/蝠妖/邪修仍正常刷新');

  // ⑭ 坦克品种分布随波次推进：28 波前不出铁壁武卒
  var tierEarly = {}, tierLate = {};
  for (var t34 = 0; t34 < 3000; t34++) {
    var rr33 = Game.mulberry32(9000 + t34);
    var early33 = Game.Systems.pickTankType(rr33, 25);
    var late33 = Game.Systems.pickTankType(rr33, 45);
    tierEarly[early33] = (tierEarly[early33] || 0) + 1;
    tierLate[late33] = (tierLate[late33] || 0) + 1;
  }
  assert(!!tierEarly.golem && !!tierEarly.bruiser && !tierEarly.bulwark,
         '28 波前只出石甲力士与铁拳力士（无铁壁武卒）：' + JSON.stringify(tierEarly));
  assert(!!tierLate.golem && !!tierLate.bruiser && !!tierLate.bulwark,
         '40 波起三种坦克同框：' + JSON.stringify(tierLate));

  // ⑮ 反伤随存档往返：counter 从配置重建，血量/伤害按存档恢复不被波次系数覆盖
  var st35 = Game.Systems.createState('endless', 'swordsman', 500);
  Game.Systems.startWave(st35, 30);
  st35.enemies.length = 0;
  var g36 = new Game.Enemy('bulwark', 300, 300, 30);
  g36.maxHp = 400; g36.hp = 400; g36.damage = 33;
  st35.enemies.push(g36);
  var sv33 = Game.Systems.serialize(st35);
  assert(sv33.enemies[0].type === 'bulwark', '序列化写入了坦克类型');
  var ld33 = Game.Systems.deserialize(sv33);
  var g37 = ld33.enemies[0];
  assert(g37.counter === EN33.bulwark.counter,
         '读档后反伤比例按配置重建（' + g37.counter + '）');
  assert(Math.abs(g37.maxHp - 400) < 1e-9 && Math.abs(g37.hp - 400) < 1e-9 &&
         Math.abs(g37.damage - 33) < 1e-9,
         '读档后坦克血量/伤害按存档恢复，不被构造函数按新波次重算');
  assert(g37.counterFlash === 0, '反伤环计时不持久化（纯表现状态）');

  // ⑯ 渲染：三种坦克 8 方向 + 反伤环分支 + 双画质
  Game.state = null;
  var st36 = Game.Systems.createState('endless', 'swordsman', 501);
  Game.Systems.startWave(st36, 21);
  Game.state = st36;
  st36.enemies.length = 0;
  for (var t35 = 0; t35 < TANKS33.length; t35++) {
    var en33 = new Game.Enemy(TANKS33[t35], 350 + t35 * 120, 400, 30);
    en33.hp = en33.maxHp * 0.4;                  // 非满血 → 画血条
    st36.enemies.push(en33);
  }
  Game.Renderer.setQuality('high');
  for (var a33 = 0; a33 < 8; a33++) {
    for (var e33 = 0; e33 < st36.enemies.length; e33++) st36.enemies[e33].facing = a33 * (Math.PI / 4);
    Game.Renderer.render(st36, 0.016);
  }
  assert(true, '三种坦克 8 方向直立渲染无异常');

  st36.enemies[0].counterFlash = 0.2;
  st36.enemies[1].counterFlash = 0.05;
  st36.enemies[2].hitFlash = 0.1;
  for (var f33 = 0; f33 < 14; f33++) {
    st36.enemies[0].counterFlash -= 0.016;
    st36.enemies[1].counterFlash -= 0.016;
    Game.Renderer.render(st36, 0.016);
  }
  assert(true, '反伤预警环脉动 / 触发扩散 / 受击闪白 渲染无异常');

  st36.player.counterFlash = 0.25;
  Game.Renderer.render(st36, 0.016);
  st36.player.counterFlash = 0;
  assert(true, '玩家反伤受击圈渲染无异常');

  Game.Renderer.setQuality('low');
  Game.Renderer.render(st36, 0.016);
  Game.Renderer.setQuality('high');
  st36.enemies.length = 0;
  Game.state = null;
  assert(true, '低画质（无描边）下三种坦克渲染无异常');
} catch (e) {
  assert(false, '反伤机制/坦克异常: ' + e.stack);
}

/* ---------------- 职业姿态 + 新角色 ---------------- */
console.log('\n== 职业姿态 / 新角色 ==');
try {
  var BODIES38 = Object.keys(Game.Renderer._PLAYER_BODY);
  var B38 = ['swordsman', 'archer', 'monk', 'brawler'];

  // ① 配置形状：每个角色的 body 都有对应姿态实现，起始武器与被动都注册了
  var chars38 = Game.CHARACTERS;
  assert(chars38.length === 11, '角色总数 11（实际 ' + chars38.length + '）');
  var shape38 = true, bodiesUsed = {}, ids38 = {}, pids38 = {};
  for (var i38 = 0; i38 < chars38.length; i38++) {
    var ch38 = chars38[i38];
    if (!ch38.body || BODIES38.indexOf(ch38.body) < 0) shape38 = false;
    if (!Game.WEAPONS[ch38.startWeapon]) shape38 = false;
    if (!Game.PASSIVES[ch38.passive.id]) shape38 = false;
    if (!ch38.colors.cloth || !ch38.colors.cloth2 || !ch38.colors.skin || !ch38.colors.hair) shape38 = false;
    if (!Game.BODY_GROUPS[ch38.body]) shape38 = false;
    ids38[ch38.id] = true; pids38[ch38.passive.id] = true;
    bodiesUsed[ch38.body] = true;
  }
  assert(shape38, '每个角色的 body / 分组 / startWeapon / 被动 / 配色字段齐全');
  assert(Object.keys(ids38).length === chars38.length, '角色 id 互不重复（否则读档取到错人）');
  assert(Object.keys(pids38).length === chars38.length, '被动 id 互不重复（11 个角色各挂一个不同被动）');
  var allBodiesUsed = true;
  for (var b38 = 0; b38 < B38.length; b38++) if (!bodiesUsed[B38[b38]]) allBodiesUsed = false;
  assert(allBodiesUsed, '4 组职业姿态各有角色使用（不白写一套剪影）');

  // ② 老角色不动：流浪剑客的原字段与旧实现一致
  var sw38 = null;
  for (var i39 = 0; i39 < chars38.length; i39++) {
    if (chars38[i39].id === 'swordsman') sw38 = chars38[i39];
  }
  assert(sw38 && sw38.baseHp === 100 && sw38.speed === 220 &&
         sw38.damage === 1.0 && sw38.startWeapon === 'iron_sword' &&
         sw38.passive.id === 'combo' && sw38.colors.cloth === '#3f6b8a',
         '流浪剑客的数值 / 武器 / 被动 / 配色未被新角色影响');

  // ③ 每个角色都能构造出带正确属性的玩家
  var built38 = true;
  for (var i40 = 0; i40 < chars38.length; i40++) {
    var pl38 = new Game.Player(chars38[i40].id);
    if (pl38.char.id !== chars38[i40].id) built38 = false;
    if (pl38.stats.maxHp !== chars38[i40].baseHp) built38 = false;
    if (pl38.stats.critChance !== chars38[i40].critChance) built38 = false;
    if (pl38.passive.id !== chars38[i40].passive.id) built38 = false;
  }
  assert(built38, '11 个角色都能按配置构造出玩家（数值 / 被动绑定正确）');

  // ④ 穿杨：只有暴击命中追加 35%
  var archer38 = new Game.Player('archer');
  var tgt38 = new Game.Enemy('zombie', 200, 200, 1);
  assert(Game.invokePassive(archer38, 'onHit', { enemy: tgt38, dmg: 100, crit: false, weapon: null }) === 100,
         '穿杨：非暴击命中伤害不变（100 → 100）');
  assert(Game.invokePassive(archer38, 'onHit', { enemy: tgt38, dmg: 100, crit: true, weapon: null }) === 135,
         '穿杨：暴击命中额外 +35%（100 → 135）');

  // ⑤ 金刚：承伤减免，且不依赖叠层
  var monk38 = new Game.Player('monk');
  assert(Game.invokePassive(monk38, 'onDamageTaken', 100) === 82,
         '金刚：承受伤害 -18%（100 → 82）');
  // 开局护盾：先设盾为 0，开波应补上 maxHp 的 25%
  monk38.stats.shieldMax = 0; monk38.stats.shield = 0;
  var st41 = Game.Systems.createState('campaign', 'monk', 41);
  st41.player = monk38;
  Game.state = st41;
  Game.Systems.startWave(st41, 2);
  assert(monk38.stats.shieldMax === 35,
         '金刚：开局把护盾上限抬到能装下这波护盾（maxHp 140 的 25% = 35）');
  assert(monk38.stats.shield === 35, '金刚：开局获得最大生命 25% 的护盾（35）');
  // 上限不无限抬升：上限已经是这个数时不再往上加
  var smBefore38 = monk38.stats.shieldMax;
  Game.Systems.startWave(st41, 3);
  assert(monk38.stats.shieldMax === smBefore38,
         '金刚：护盾上限不随波次无限抬升（仍为 ' + smBefore38 + '）');
  // 盾满了不再叠
  var sh38 = monk38.stats.shield;
  monk38.stats.shield = monk38.stats.shieldMax;
  Game.Systems.startWave(st41, 4);
  assert(monk38.stats.shield === sh38, '金刚：护盾已满时不再叠加溢出');

  // ⑥ 铁骨：只有残血时增伤
  var bw38 = new Game.Player('brawler');
  var tgtB38 = new Game.Enemy('zombie', 300, 300, 1);
  assert(bw38.stats.hp === bw38.stats.maxHp, '前置：力士满血');
  assert(Game.invokePassive(bw38, 'onHit', { enemy: tgtB38, dmg: 100, crit: false, weapon: null }) === 100,
         '铁骨：满血时伤害不变（100 → 100）');
  bw38.stats.hp = bw38.stats.maxHp * 0.4;
  assert(Game.invokePassive(bw38, 'onHit', { enemy: tgtB38, dmg: 100, crit: false, weapon: null }) === 135,
         '铁骨：血量低于 50% 时伤害 +35%（100 → 135）');
  bw38.stats.hp = bw38.stats.maxHp;
  assert(Game.invokePassive(bw38, 'onHit', { enemy: tgtB38, dmg: 100, crit: false, weapon: null }) === 100,
         '铁骨：回满血后增伤关闭');

  // ⑦ 集成：新角色进真实战斗路径
  var st42 = Game.Systems.createState('campaign', 'monk', 42);
  Game.Systems.startWave(st42, 1);
  var mp38 = st42.player;
  assert(mp38.char.id === 'monk' && mp38.weapons[0].defId === 'iron_sword',
         '武僧开局装备铁剑（起始武器按配置生效）');
  st42.enemies.length = 0;
  var z38 = new Game.Enemy('zombie', mp38.x + 40, mp38.y, 1);
  st42.enemies.push(z38);
  mp38.weapons[0].cooldownRemaining = 0;
  mp38.weapons[0].update(0.016, mp38, st42);
  assert(mp38.damageDealt > 0, '武僧近战正常出手');
  var ar38 = Game.Systems.createState('campaign', 'archer', 43);
  assert(ar38.player.weapons[0].defId === 'pistol', '弓手开局装备手枪（远程职业）');

  // ⑧ 角色选择界面：11 张卡按职业分 4 组，各带被动名与描述，无占位文本
  Game.UI.renderCharSelect();
  var cs38 = document.getElementById('menu').innerHTML;
  assert(cs38.indexOf('[object Object]') < 0, '角色选择界面不出现 [object Object]');
  var cardCount38 = (cs38.match(/startRun/g) || []).length;
  assert(cardCount38 === 11, '角色选择界面渲染 11 张卡（实际 ' + cardCount38 + '）');
  var names38 = ['流浪剑客', '疾风刺客', '铁卫武人', '青木弓手', '裂石弩手', '寒江射手',
                 '玄铁武僧', '慈心尼师', '苦行僧', '赤岩力士', '狂岩巨擘'];
  for (var n38 = 0; n38 < names38.length; n38++) {
    assert(cs38.indexOf(names38[n38]) >= 0, '角色选择界面出现「' + names38[n38] + '」');
  }
  var pNames38 = ['连击', '掠影', '格挡', '穿杨', '疾风', '贯甲', '金刚', '回春', '禅心', '铁骨', '狂战'];
  for (var pn38 = 0; pn38 < pNames38.length; pn38++) {
    assert(cs38.indexOf(pNames38[pn38]) >= 0, '角色选择界面渲染出被动「' + pNames38[pn38] + '」');
  }
  var gTitles38 = ['剑客', '弓手', '武僧', '力士'];
  var gCount38 = (cs38.match(/char-group-title/g) || []).length;
  assert(gCount38 === 4, '角色选择界面按 4 个职业分组（实际 ' + gCount38 + ' 组）');
  for (var gt38 = 0; gt38 < gTitles38.length; gt38++) {
    assert(cs38.indexOf(gTitles38[gt38]) >= 0, '分组标题出现「' + gTitles38[gt38] + '」');
  }
  var idsInHtml38 = [], re38 = /startRun\('([^']+)'\)/g, m38;
  while ((m38 = re38.exec(cs38)) !== null) idsInHtml38.push(m38[1]);
  var idMap38 = {};
  for (var idm38 = 0; idm38 < idsInHtml38.length; idm38++) {
    idMap38[idsInHtml38[idm38]] = (idMap38[idsInHtml38[idm38]] || 0) + 1;
  }
  var oneEach38 = true;
  for (var ci39 = 0; ci39 < chars38.length; ci39++) {
    if (idMap38[chars38[ci39].id] !== 1) oneEach38 = false;
  }
  assert(oneEach38, '11 个角色各出现恰好一次（不多不少）');
  assert(document.getElementById('menu').className.indexOf('panel-top') >= 0,
         '角色选择页切到顶部对齐（11 张卡超高时垂直居中会裁掉顶端、滚不上去）');
  Game.UI.renderMenu(false, false, 0);
  assert(document.getElementById('menu').className === 'panel',
         '主菜单恢复垂直居中（panel-top 不残留）');

  // ⑨ 存档往返：新角色的姿态与配色随 charId 恢复
  var st44 = Game.Systems.createState('endless', 'monk', 700);
  Game.Systems.startWave(st44, 5);
  var sv38 = Game.Systems.serialize(st44);
  var ld38 = Game.Systems.deserialize(sv38);
  assert(ld38.player.char.id === 'monk' && ld38.player.char.body === 'monk',
         '读档后职业姿态保留（body=monk）');
  assert(ld38.player.stats.maxHp === 140, '读档后武僧属性保留（maxHp=140）');
  assert(ld38.player.passive.id === 'jingKang', '读档后被动绑定保留');

  // ⑩ 渲染：4 种姿态各 8 方向 + 攻击动作全程 + 受击闪白 / 反伤闪色 / 无敌帧
  Game.state = null;
  var st45 = Game.Systems.createState('campaign', 'swordsman', 701);
  Game.Systems.startWave(st45, 1);
  Game.state = st45;
  st45.enemies.length = 0;
  Game.Renderer.setQuality('high');
  for (var ci38 = 0; ci38 < chars38.length; ci38++) {
    var p38 = new Game.Player(chars38[ci38].id);
    p38.x = st45.player.x; p38.y = st45.player.y;
    p38.weapons = [Game.createWeapon(chars38[ci38].startWeapon, 1)];
    st45.player = p38;
    p38.moving = true; p38.walkTime = 1.2;
    for (var a38 = 0; a38 < 8; a38++) {
      p38.facing = a38 * (Math.PI / 4);
      Game.Renderer.render(st45, 0.016);
    }
    // 待机呼吸分支
    p38.moving = false;
    Game.Renderer.render(st45, 0.016);
    // 两种攻击动作全程逐帧
    for (var k38 = 0; k38 < 2; k38++) {
      var kind38 = k38 === 0 ? 'melee' : 'ranged';
      p38.playAttack(kind38);
      var dur38 = p38.attackAnim.dur;
      for (var s38 = 0; s38 <= 10; s38++) {
        p38.attackAnim.t = dur38 * (s38 / 10);
        Game.Renderer.render(st45, 0.016);
      }
      p38.attackAnim = null;
    }
    // 受击白闪 / 反伤青色闪 / 无敌帧 三种覆盖态
    p38.hitFlashTimer = 0.1;
    Game.Renderer.render(st45, 0.016);
    p38.hitFlashTimer = 0; p38.counterFlash = 0.2;
    Game.Renderer.render(st45, 0.016);
    p38.counterFlash = 0; p38.invincibleTimer = 0.2;
    Game.Renderer.render(st45, 0.016);
    p38.invincibleTimer = 0;
  }
  assert(true, '4 种职业姿态 × 8 方向 + 攻击动作全程 + 闪色 / 无敌帧 渲染无异常');

  // ⑪ 低画质（描边关闭）下同样不崩
  Game.Renderer.setQuality('low');
  var pLow38 = new Game.Player('monk');
  pLow38.x = st45.player.x; pLow38.y = st45.player.y;
  pLow38.weapons = [Game.createWeapon('iron_sword', 1)];
  st45.player = pLow38;
  for (var aL38 = 0; aL38 < 8; aL38++) {
    pLow38.facing = aL38 * (Math.PI / 4);
    Game.Renderer.render(st45, 0.016);
  }
  Game.Renderer.setQuality('high');
  st45.enemies.length = 0;
  Game.state = null;
  assert(true, '低画质（无描边）下新姿态渲染无异常');

  // ⑫ 量化回归：老角色的头仍是同一个圆（重构没有把 swordsman 画偏）
  function makeMatrixCtx38() {
    var m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, stack = [], arcs = [];
    function mul(n) {
      m = { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
            c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
            e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f };
    }
    return {
      ctx: new Proxy({
        save: function () { stack.push(m); },
        restore: function () { if (stack.length) m = stack.pop(); },
        translate: function (x, y) { mul({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
        rotate: function (t) { mul({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t), e: 0, f: 0 }); },
        scale: function (x, y) { mul({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
        arc: function (x, y, r) { arcs.push({ x: x, r: r }); },
      }, { get: function (t, k) { return (k in t) ? t[k] : function () {}; },
           set: function (t, k, v) { t[k] = v; return true; } }),
      arcs: arcs,
    };
  }
  var swP38 = new Game.Player('swordsman');
  swP38.weapons = [Game.createWeapon('iron_sword', 1)];
  swP38.facing = 0;
  var rec38 = makeMatrixCtx38();
  Game.Renderer._drawPlayer(rec38.ctx, swP38);
  var head38 = null;
  for (var hi38 = 0; hi38 < rec38.arcs.length; hi38++) {
    if (rec38.arcs[hi38].x === 0 && Math.abs(rec38.arcs[hi38].r - 9.6) < 0.01) head38 = rec38.arcs[hi38];
  }
  assert(head38 !== null, '重构后剑客的头部仍是那个半径 9.6 的圆（观感未漂移）');

  /* ---- 第二批 7 个角色的被动 ---- */

  // ⑬ 掠影：击杀回 4 点；满血时多余治疗蒸发、不越界
  var as38 = new Game.Player('assassin');
  as38.stats.hp = as38.stats.maxHp - 10;
  Game.invokePassive(as38, 'onKill', new Game.Enemy('zombie', 0, 0, 1), null);
  assert(as38.stats.hp === as38.stats.maxHp - 6, '掠影：击杀回复 4 点生命');
  as38.stats.hp = as38.stats.maxHp; as38.stats.shieldMax = 0;
  Game.invokePassive(as38, 'onKill', new Game.Enemy('zombie', 0, 0, 1), null);
  assert(as38.stats.hp === as38.stats.maxHp, '掠影：满血时治疗不溢出');

  // ⑭ 格挡：减到 0 时不扣血、不闪白、不占无敌帧、不计承伤。
  // 把护甲归零只为让算术干净（格挡与护甲互相独立，不影响该测什么）。
  var mr38 = Math.random;
  Math.random = function () { return 0; };   // 必定命中格挡
  var gd38 = new Game.Player('guard');
  gd38.stats.armor = 0; gd38.stats.hp = 100; gd38.stats.shield = 0;
  assert(gd38.takeDamage(50) === 0 && gd38.stats.hp === 100, '格挡成立时不掉血');
  assert(gd38.invincibleTimer === 0, '格挡成立不占无敌帧（挡下一击不该换来额外无敌时间）');
  assert(gd38.hitFlashTimer === 0, '格挡成立不触发受击闪白');
  assert(gd38.damageTaken === 0, '格挡成立不计入承伤统计');
  // 格挡不中时照旧全额结算（含无敌帧）
  Math.random = function () { return 1; };   // 必定没挡上
  assert(gd38.takeDamage(50) === 50 && gd38.stats.hp === 50, '格挡不中时正常结算伤害（100 → 50）');
  assert(gd38.invincibleTimer === 0.35, '格挡不中时正常给无敌帧');
  assert(gd38.damageTaken === 50, '格挡不中时计入承伤统计');
  Math.random = mr38;

  // ⑮ 疾风：击杀叠暴击率，5 层封顶不再涨
  var cb38 = new Game.Player('crossbowman');
  var cc0 = cb38.stats.critChance;
  for (var k39 = 1; k39 <= 7; k39++) {
    Game.invokePassive(cb38, 'onKill', new Game.Enemy('bat', 0, 0, 1), null);
  }
  assert(Math.abs(cb38.stats.critChance - (cc0 + 0.10)) < 1e-9,
         '疾风：叠满 5 层后暴击率 +10%（' + cc0 + ' → ' + cb38.stats.critChance + '）');
  assert(cb38.passiveState.critStacks === 5, '疾风叠层封顶在 5 层（第 7 次击杀不再加）');

  // ⑯ 贯甲：只放大平砍，不放大暴击（与穿杨互为镜像）
  var rg38 = new Game.Player('ranger');
  var tgt39 = new Game.Enemy('zombie', 200, 200, 1);
  assert(Game.invokePassive(rg38, 'onHit', { enemy: tgt39, dmg: 100, crit: false, weapon: null }) === 125,
         '贯甲：非暴击命中 +25%（100 → 125）');
  assert(Game.invokePassive(rg38, 'onHit', { enemy: tgt39, dmg: 100, crit: true, weapon: null }) === 100,
         '贯甲：暴击命中不变（100 → 100）');

  // ⑰ 回春：每 2 秒回 1 点，推进累加不漂移
  var nu38 = new Game.Player('nun');
  nu38.stats.hp = nu38.stats.maxHp - 10;
  Game.invokePassive(nu38, 'perTick', null, 1.999);
  assert(nu38.stats.hp === nu38.stats.maxHp - 10, '回春：不足 2 秒不回血');
  Game.invokePassive(nu38, 'perTick', null, 0.001);
  assert(nu38.stats.hp === nu38.stats.maxHp - 9, '回春：累计满 2 秒回 1 点');
  nu38.stats.hp = nu38.stats.maxHp - 10;
  Game.invokePassive(nu38, 'perTick', null, 5);
  assert(nu38.stats.hp === nu38.stats.maxHp - 8, '回春：一次推进 5 秒恰好回 2 点（不多不少）');

  // ⑱ 禅心：按原始伤害回 30%，且 heal 不回调 takeDamage（无递归）
  var ac38 = new Game.Player('ascetic');
  ac38.stats.armor = 0; ac38.stats.shieldMax = 0; ac38.stats.shield = 0;
  ac38.stats.hp = ac38.stats.maxHp - 50;
  var hp0_38 = ac38.stats.hp;
  assert(Math.abs(ac38.takeDamage(40) - 40) < 1e-9, '禅心角色正常承伤 40');
  assert(Math.abs(ac38.stats.hp - (hp0_38 + 12 - 40)) < 1e-9,
         '禅心：受击回复所受伤害的 30%（回 12，扣 40，净 ' + (ac38.stats.hp - hp0_38).toFixed(0) + '）');

  // ⑲ 狂战：击杀叠伤害倍率，10 层封顶，且真的进了武器伤害
  var br38 = new Game.Player('brute');
  var bd0 = br38.stats.damage;
  for (var k40 = 1; k40 <= 12; k40++) {
    Game.invokePassive(br38, 'onKill', new Game.Enemy('zombie', 0, 0, 1), null);
  }
  assert(Math.abs(br38.stats.damage - (bd0 + 0.30)) < 1e-9,
         '狂战：叠满 10 层后伤害 +30%（' + bd0 + ' → ' + br38.stats.damage.toFixed(2) + '）');
  assert(br38.passiveState.dmgStacks === 10, '狂战叠层封顶在 10 层（第 12 次击杀不再加）');
  var w39 = Game.createWeapon('iron_sword', 1);
  assert(Math.abs(w39.damage(br38) - w39.def.damage * (bd0 + 0.30)) < 1e-9,
         '狂战叠层后的倍率进入武器实际伤害');

  // ⑳ 存档往返：叠层数与已被动改过的属性一起保存，读档不会二次累加
  var st46 = Game.Systems.createState('endless', 'crossbowman', 702);
  Game.Systems.startWave(st46, 8);
  for (var k41 = 1; k41 <= 3; k41++) {
    Game.invokePassive(st46.player, 'onKill', new Game.Enemy('zombie', 0, 0, 1), st46);
  }
  var cc46 = st46.player.stats.critChance, cs46 = st46.player.passiveState.critStacks;
  var ld46 = Game.Systems.deserialize(Game.Systems.serialize(st46));
  assert(Math.abs(ld46.player.stats.critChance - cc46) < 1e-9,
         '读档后暴击率按存档恢复（' + cc46 + '），不被重新累加');
  assert(ld46.player.passiveState.critStacks === cs46, '读档后叠层数恢复（' + cs46 + ' 层）');

  // ㉑ heal 的表现开关不改变数值（只关特效 / 音效，供高频被动用）
  var hl38 = new Game.Player('swordsman');
  hl38.stats.hp = hl38.stats.maxHp - 20;
  hl38.heal(10, { audio: false, fx: false });
  assert(hl38.stats.hp === hl38.stats.maxHp - 10, '静音治疗数值照常结算');
  hl38.stats.hp = hl38.stats.maxHp - 20;
  hl38.heal(10);
  assert(hl38.stats.hp === hl38.stats.maxHp - 10, '常规治疗与静音治疗数值一致');

  /* ㉒ 回血卡下线 / 定价确定 / 伤害飘字 —— 用户报的三项，逐项锁死
     治疗只剩角色被动与吸血两条来源，任何卡片都不该再瞬间补血。 */

  // ① 升级池里不再有回血卡，applyUpgrade 也不再接遗留的 heal 字段
  var healCards47 = [];
  for (var t47 = 0; t47 < Game.UPGRADES.length; t47++) {
    var u47 = Game.UPGRADES[t47];
    if (u47.type === 'heal' || u47.apply.heal) healCards47.push(u47.label);
  }
  assert(healCards47.length === 0,
         '升级池 ' + Game.UPGRADES.length + ' 张卡里无即时回血卡（异常: ' + healCards47.join(',') + '）');
  var pu47 = new Game.Player('swordsman');
  pu47.stats.hp = pu47.stats.maxHp - 30;
  pu47.applyUpgrade({ heal: 30 });
  assert(pu47.stats.hp === pu47.stats.maxHp - 30,
         'applyUpgrade 收到遗留 heal 字段时不再回血（治疗只来自被动/吸血）');

  // ② 三处发卡路径（商店 / 升级三选一 / Boss 奖励）500 轮都不出治疗卡
  var healSeen47 = 0, badType47 = [], shopTypes47 = {}, bossShort47 = 0;
  for (var t48 = 0; t48 < 500; t48++) {
    var sh48 = Game.Systems.createState('campaign', 'swordsman', 90000 + t48);
    Game.Systems.openShop(sh48);
    for (var b48 = 0; b48 < sh48.shop.items.length; b48++) {
      var it48 = sh48.shop.items[b48];
      shopTypes47[it48.type] = (shopTypes47[it48.type] || 0) + 1;
      if (it48.type === 'heal') healSeen47++;
      if (it48.type !== 'item' && it48.type !== 'weapon' && it48.type !== 'weaponUpgrade') badType47.push(it48.type);
    }
    var ch48a = Game.Systems.rollLevelUpChoices(sh48);
    var ch48b = Game.Systems.bossRewardChoices(sh48);
    var cands47 = ch48a.concat(ch48b);
    for (var b49 = 0; b49 < cands47.length; b49++) {
      var c49 = cands47[b49];
      if (c49.kind === 'upgrade' && c49.data.type === 'heal') healSeen47++;
      if (c49.kind === 'item' && Game.ITEMS[c49.data.itemId].type === 'heal') healSeen47++;
    }
    // Boss 奖励的兜底必须真的凑够 3 张 —— 兜底卡从「数组末尾」改成「最强属性卡」后
    if (ch48b.length !== 3) bossShort47++;
  }
  assert(bossShort47 === 0, '500 组 Boss 奖励全部凑够 3 张（兜底补齐生效，缺张 ' + bossShort47 + ' 组）');
  assert(healSeen47 === 0, '商店 / 升级 / Boss 奖励 500 轮从未出现治疗卡（实测 ' + healSeen47 + ' 张）');
  assert(badType47.length === 0, '商店不再出现未定义的商品类型（异常: ' + badType47.join(',') + '）');
  assert(shopTypes47.item > 0 && shopTypes47.weapon > 0,
         '治疗权重下放后商店仍有道具（' + shopTypes47.item + '）与武器（' + shopTypes47.weapon + '）');

  // ③ 定价：priceFor 是纯函数，跨 9 个波次 × 4 种稀有度 × 3000 条独立随机流全部一致
  var bases47 = { common: 15, rare: 35, epic: 55, legend: 85 };
  var pfBad47 = 0, pfN47 = 0;
  for (var r47 in bases47) for (var wv47 = 0; wv47 < 12; wv47++) {
    pfN47++;
    if (Game.Systems.priceFor(r47, wv47) !== bases47[r47] + wv47 * 2) pfBad47++;
  }
  assert(pfBad47 === 0, 'priceFor 严格等于 稀有度基础价 + 波次×2（' + pfN47 + ' 组全对）');
  var priceSeen47 = {}, priceBad47 = 0, priceN47 = 0;
  for (var t50 = 0; t50 < 800; t50++) {
    var sh50 = Game.Systems.createState('campaign', 'swordsman', 150000 + t50);
    sh50.wave = 1 + (t50 % 9);
    Game.Systems.openShop(sh50);
    for (var b50 = 0; b50 < sh50.shop.items.length; b50++) {
      var it50 = sh50.shop.items[b50];
      var key47 = it50.rarity + '#' + sh50.wave;
      priceN47++;
      if (priceSeen47[key47] === undefined) priceSeen47[key47] = it50.price;
      else if (priceSeen47[key47] !== it50.price) priceBad47++;
    }
  }
  assert(priceBad47 === 0,
         '同稀有度同波次价格完全一致（' + priceN47 + ' 次跨随机流对照、' +
         Object.keys(priceSeen47).length + ' 组稀有度×波次，冲突 ' + priceBad47 + ' 次）');

  // ④ 老存档残留的已下线卡片不可购买 —— 扣钱不给东西是最糟的结果
  var st51 = Game.Systems.createState('campaign', 'swordsman', 31337);
  Game.Systems.openShop(st51);
  st51.shop.items.push({ type: 'heal', name: '急救包', desc: '恢复 50 点生命', rarity: 'common', price: 15 });
  var idx51 = st51.shop.items.length - 1;
  st51.player.materials = 100;
  assert(Game.Systems.buyShopItem(st51, idx51) === false, '存档里残留的治疗卡不可购买');
  assert(st51.player.materials === 100, '买不到时不扣材料');
  assert(st51.shop.items[idx51].sold !== true, '买不到时不标记已售');

  // ⑤ 伤害飘字：暴击放大字号并延长生命；命中路径确实产出
  Game.Renderer.effects.length = 0;
  Game.FX.damageNumber(100, 100, 14.6, false);
  assert(Game.Renderer.effects.length === 1, 'damageNumber 生成一个飘字特效');
  var dt52 = Game.Renderer.effects[0];
  assert(dt52.type === 'dmgtext' && dt52.text === '15' && !dt52.big,
         '普通飘字四舍五入取整（14.6→15）且不加粗');
  Game.FX.damageNumber(100, 100, 28, true);
  var dc52 = Game.Renderer.effects[1];
  assert(dc52.text === '28' && dc52.big && dc52.life === 0.7, '暴击飘字加粗且显示更久');

  // ⑥ 命中路径真的产出飘字，且暴击抖屏已挪进 Enemy.takeDamage（近战远程统一）
  var realCrit47 = Game.WeaponInstance.prototype._rollCrit;
  Game.WeaponInstance.prototype._rollCrit = function () { return true; };

  Game.Renderer.effects.length = 0;
  Game.Renderer.shake = 0;
  var p54 = new Game.Player('swordsman');
  var e54 = new Game.Enemy('zombie', p54.x + 30, p54.y, 1);
  e54.takeDamage(28, true, 0, 0, p54);
  var big54 = Game.Renderer.effects.filter(function (f) { return f.type === 'dmgtext' && f.big; });
  assert(big54.length === 1 && big54[0].text === '28', '暴击命中产出加粗飘字（数值 28）');
  assert(Game.Renderer.shake > 0, '暴击命中抖屏（shake=' + Game.Renderer.shake.toFixed(2) + '）');

  Game.Renderer.effects.length = 0;
  Game.Renderer.shake = 0;
  var e55 = new Game.Enemy('zombie', p54.x + 30, p54.y, 1);
  e55.takeDamage(14, false, 0, 0, p54);
  var norm55 = Game.Renderer.effects.filter(function (f) { return f.type === 'dmgtext' && !f.big; });
  assert(norm55.length === 1 && norm55[0].text === '14', '普通命中产出常规飘字（数值 14）');
  // 上面这条同时覆盖「非暴击不抖屏」的另一半：飘字存在但不加粗。
  assert(Game.Renderer.shake === 0, '普通命中不抖屏');

  // ⑦ 远程暴击端到端：子弹命中后同样产出加粗飘字并抖屏（抖动逻辑从近战挪走后回归）
  Game.Renderer.effects.length = 0;
  Game.Renderer.shake = 0;
  var p56 = new Game.Player('archer');
  p56.weapons = [Game.createWeapon('pistol', 1)];
  var st56 = Game.Systems.createState('campaign', 'archer', 909);
  Game.state = st56;
  st56.player = p56; st56.enemies = []; st56.projectiles = [];
  st56.enemies.push(new Game.Enemy('zombie', p56.x + 120, p56.y, 1));
  p56.weapons[0].cooldownRemaining = 0;
  p56.weapons[0].update(0.016, p56, st56);
  for (var g56 = 0; g56 < 30; g56++) Game.Systems.updateProjectiles(st56, 0.016);
  var rc56 = Game.Renderer.effects.filter(function (f) { return f.type === 'dmgtext' && f.big; });
  assert(rc56.length >= 1, '远程暴击端到端产出加粗飘字（' + rc56.length + ' 条）');
  assert(Game.Renderer.shake > 0, '远程暴击同样抖屏（shake=' + Game.Renderer.shake.toFixed(2) + '）');
  Game.WeaponInstance.prototype._rollCrit = realCrit47;

} catch (e) {
  assert(false, '职业姿态/新角色异常: ' + e.stack);
}

/* ---------------- 汇总 ---------------- */
console.log('\n================ 测试结果 ================');
console.log('通过: ' + passed + '  失败: ' + failed);
process.exit(failed > 0 ? 1 : 0);
