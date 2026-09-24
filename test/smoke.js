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
  'entities.js', 'weapons.js', 'renderer.js', 'systems.js', 'ui.js', 'game.js',
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

/* ---------------- 汇总 ---------------- */
console.log('\n================ 测试结果 ================');
console.log('通过: ' + passed + '  失败: ' + failed);
process.exit(failed > 0 ? 1 : 0);
