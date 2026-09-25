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

/* ---------------- 环绕武器测试助手 ---------------- */
// 武器从「自己所在的轨道位置」出手，不再从玩家身上。想测命中就得按武器位置摆敌人；
// 而且轨道角度随 performance.now() 转，写死「player.x + 40」会随进程耗时漂移成 flaky
// （进程跑得慢一点角度就转开，最坏情况武器正好在敌人背后，够不着）。
const atWeapon = function (w, owner, dist, type, wave) {
  // 索敌圆心是玩家（不是武器），所以「摆进这把武器的扇形」= 沿该武器的固定角、
  // 离玩家 dist 那么远。武器自己挂在半径 62 的圈上，只是这块扇形的标记。
  const a = w.posAt(owner).a;
  return new Game.Enemy(type, owner.x + Math.cos(a) * dist, owner.y + Math.sin(a) * dist, wave);
};

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
assert(state.spawnSchedule.length === 32, '敌人预算 22+1*10=32，实际 ' + state.spawnSchedule.length);
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
const zombie = atWeapon(player.weapons[0], player, 40, 'zombie', 1);
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
const pistol = p4.weapons[1];
// 武器已改为固定朝外打，敌人必须摆在「武器外侧」的朝外扇形里才会被索到
const far = atWeapon(pistol, p4, 300, 'wizard', 1);
far.hp = 1000;
st4.enemies.push(far);
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
  var sword = new Game.WeaponInstance('iron_sword', 1);
  // 武器已改为固定朝外打：敌人要摆在「武器外侧」的朝外扇形里才算命中
  var target = atWeapon(sword, pl, 40, 'zombie', 1);
  target.hp = target.maxHp = 1e9;                            // 打不死，便于断言
  st10.enemies.push(target);
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
  var wp21 = st21.player.weapons[0];
  var boss = atWeapon(wp21, st21.player, 28, 'boss', 1);
  boss.hp = 1;                                  // 一刀毙命，走真实战斗路径
  st21.enemies.push(boss);
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
  var w26 = tp26.weapons[0];
  var me26 = atWeapon(w26, tp26, 40, 'zombie', 1);
  var hp026 = me26.hp;
  st26.enemies.push(me26);
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
  var sw33 = tp33.weapons[0];
  var g33 = atWeapon(sw33, tp33, 40, 'golem', 21);
  g33.hp = 1e9;
  st33.enemies.push(g33);
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

  /* ⑪ 关键护栏：刷新计划必须逐位可复现。
     把当前算法原样复刻一份当参照，逐波逐种子比对照刷序列 ——
     只要新代码多消耗了一次 rng()，参照序列会在第 2 只怪就分叉。
     （这条 2026-09-24 起盯的是「管线没被扰动」，不再钉旧数值：
       刷新量与巫师占比已按用户要求上调/下调，见下 ㉔。） */
  function refPick(rng, wave) {
    var r = rng();
    var wizardChance = 0.07 + Math.min(0.13, wave * 0.01);
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
      var budget33 = 22 + w33 * 10;
      if (Game.Systems.isBossWave(w33)) budget33 = Math.max(10, Math.floor(budget33 * 0.6));
      var seq33 = [], t33 = 0.5, n33 = 0;
      while (n33 < budget33 && t33 < Game.Systems.waveDuration(w33)) {
        seq33.push(refPick(rngRef, w33));
        n33++; t33 += 0.5 - Math.min(0.26, w33 * 0.01);
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
         'wave 1~20 全部 600 组刷新计划与参照算法逐位一致（' + same33 +
         '/600，共 ' + monsters33 + ' 只怪）—— 管线未被扰动');

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
  var z38 = atWeapon(mp38.weapons[0], mp38, 40, 'zombie', 1);
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
  // 武器固定朝外打：敌人摆在武器外侧，子弹才会打出去（朝外扇形内才有目标）
  st56.enemies.push(atWeapon(p56.weapons[0], p56, 120, 'zombie', 1));
  p56.weapons[0].cooldownRemaining = 0;
  p56.weapons[0].update(0.016, p56, st56);
  for (var g56 = 0; g56 < 30; g56++) Game.Systems.updateProjectiles(st56, 0.016);
  var rc56 = Game.Renderer.effects.filter(function (f) { return f.type === 'dmgtext' && f.big; });
  assert(rc56.length >= 1, '远程暴击端到端产出加粗飘字（' + rc56.length + ' 条）');
  assert(Game.Renderer.shake > 0, '远程暴击同样抖屏（shake=' + Game.Renderer.shake.toFixed(2) + '）');
  Game.WeaponInstance.prototype._rollCrit = realCrit47;

  /* ㉓ 子弹隧穿：单步位移超过判定半径时仍能命中
     旧代码只判「本帧终点 vs 目标圆心」，低帧率下一大步会把整只敌人踩过去。 */

  var u48 = Game.util;
  assert(u48.sweptHit(0, 0, 100, 0, 50, 0, 20) === true, '扫掠：轨迹穿过圆心 → 命中');
  assert(u48.sweptHit(0, 0, 100, 0, 50, 60, 20) === false, '扫掠：轨迹从圆心之外擦过 → 不中');
  assert(u48.sweptHit(50, 0, 50, 0, 50, 0, 20) === true, '扫掠：零长线段落在圆内 → 命中');
  assert(u48.sweptHit(0, 0, 0, 0, 50, 0, 20) === false, '扫掠：零长线段在圆外 → 不中');
  assert(u48.sweptHit(0, 0, 30, 0, 30, 0, 20) === true, '扫掠：终点恰好停在圆心 → 命中（旧行为不回归）');

  // 构造出一个「点判定必漏」的场景，再证明扫掠判定能接住
  var p57 = new Game.Player('crossbowman');
  p57.weapons = [Game.createWeapon('jade_crossbow', 1)];
  var st57 = Game.Systems.createState('campaign', 'crossbowman', 4242);
  Game.state = st57; st57.player = p57; st57.enemies = []; st57.projectiles = [];
  var e57 = atWeapon(p57.weapons[0], p57, 80, 'zombie', 1);
  e57.hp = 1e9;
  st57.enemies.push(e57);
  p57.weapons[0].cooldownRemaining = 0;
  p57.weapons[0].update(0.016, p57, st57);
  var bp57 = st57.projectiles[0];
  bp57.update(0.2);   // 本帧位移 780 × 0.2 = 156 像素
  var gap57 = u48.dist(bp57.x, bp57.y, e57.x, e57.y);
  var rad57 = bp57.radius + e57.radius;
  assert(gap57 > rad57,
         '已构造到隧穿场景：终点离敌人 ' + gap57.toFixed(0) + 'px，大于判定半径 ' + rad57 + 'px');
  assert(u48.sweptHit(bp57.px, bp57.py, bp57.x, bp57.y, e57.x, e57.y, rad57) === true,
         '同一条轨迹的扫掠判定命中');
  var moved57 = u48.dist(bp57.px, bp57.py, bp57.x, bp57.y);
  assert(Math.abs(moved57 - 780 * 0.2) < 1,
         'px/py 记录的是本帧位移前位置（位移 ' + moved57.toFixed(0) + 'px ≈ 780 × 0.2）');

  // 走真实路径：同一场景交给 updateProjectiles，敌人确实掉血、子弹确实被清除
  var p58 = new Game.Player('crossbowman');
  p58.weapons = [Game.createWeapon('jade_crossbow', 1)];
  var st58 = Game.Systems.createState('campaign', 'crossbowman', 4242);
  Game.state = st58; st58.player = p58; st58.enemies = []; st58.projectiles = [];
  var e58 = atWeapon(p58.weapons[0], p58, 80, 'zombie', 1);
  e58.hp = 1e9;
  st58.enemies.push(e58);
  p58.weapons[0].cooldownRemaining = 0;
  p58.weapons[0].update(0.016, p58, st58);
  var hp58 = e58.hp;
  Game.Systems.updateProjectiles(st58, 0.2);
  assert(e58.hp < hp58, '大 dt 一步跨过的子弹仍打到敌人（掉血 ' + (hp58 - e58.hp).toFixed(1) + '）');
  assert(st58.projectiles.length === 1 && st58.projectiles[0].pierce === 1,
         '穿透子弹命中后 pierce 递减（2 → 1）而非消失');

  // 反向：敌方高速弹也不再穿过玩家（玩家侧同样改成了扫掠判定）
  var p59 = new Game.Player('swordsman');
  var st59 = Game.Systems.createState('campaign', 'swordsman', 555);
  Game.state = st59; st59.player = p59; st59.enemies = []; st59.projectiles = [];
  st59.projectiles.push(new Game.Projectile({
    x: p59.x - 60, y: p59.y, vx: 900, vy: 0,
    radius: 5, damage: 7, crit: false, fromPlayer: false, life: 2,
  }));
  var hp59 = p59.stats.hp;
  Game.Systems.updateProjectiles(st59, 0.2);   // 一步 180 像素，越过玩家
  assert(p59.stats.hp < hp59, '敌方高速弹不再穿过玩家（掉血 ' + (hp59 - p59.stats.hp).toFixed(1) + '）');

  // 贴脸射击不回归：子弹出生在敌人内部时仍要命中（零长/近零长线段退化到点检测）
  var p60 = new Game.Player('archer');
  p60.weapons = [Game.createWeapon('pistol', 1)];
  var st60 = Game.Systems.createState('campaign', 'archer', 666);
  Game.state = st60; st60.player = p60; st60.enemies = []; st60.projectiles = [];
  // 环绕后子弹从武器所在的轨道位置出膛，「贴脸」要按武器位置摆敌人，
  // 且必须落在朝外扇形里 —— 固定在出膛距离（玩家半径+6 = 20px）上，
  // 子弹正好出生在敌人身上。
  var w60 = p60.weapons[0];
  var e60 = atWeapon(w60, p60, 20, 'zombie', 1);
  e60.hp = 1e9;
  st60.enemies.push(e60);
  w60.cooldownRemaining = 0;
  w60.update(0.016, p60, st60);
  var hp60 = e60.hp;
  Game.Systems.updateProjectiles(st60, 0.016);
  assert(e60.hp < hp60, '贴脸射击仍命中（掉血 ' + (hp60 - e60.hp).toFixed(1) + '）');
  assert(st60.projectiles.length === 0, '无穿透的子弹命中后消失（pierce=0）');

  /* ㉔ 道具扩容 / 回血箱 / 吸铁石 / 掉率上调 / 近战占比 —— 用户报的「没爽感」五项 */

  var D61 = Game.DROP;
  assert(!!D61 && typeof D61.xpMult === 'number' && typeof D61.matChance === 'number',
         '掉落调参集中在 Game.DROP 一张表（xp×' + D61.xpMult + ' / 材料×' + D61.matMult +
         ' / 材料率 ' + D61.matChance + '）');

  // —— 道具 12 件，且每件声明的属性键都真实生效（此前有 6 个属性键根本没入口）——
  var ids61 = Object.keys(Game.ITEMS);
  assert(ids61.length === 12, '道具总数 12（实 ' + ids61.length + '）');
  var newIds61 = ['herbal', 'vampiric', 'shieldcharm', 'lifeluck', 'critemerald', 'deathbell'];
  var missing61 = newIds61.filter(function (n) { return !Game.ITEMS[n]; });
  assert(missing61.length === 0, '新增 6 件道具齐全（缺: ' + missing61.join(',') + '）');
  var dead61 = [];
  for (var i61 = 0; i61 < ids61.length; i61++) {
    var iid61 = ids61[i61];
    var pl61 = new Game.Player('swordsman');
    var keys61 = Object.keys(Game.ITEMS[iid61].stat);
    if (keys61.length === 0) { dead61.push(iid61 + '(空stat)'); continue; }
    var snap61 = {};
    for (var k61 = 0; k61 < keys61.length; k61++) snap61[keys61[k61]] = pl61.stats[keys61[k61]];
    for (var k62 = 0; k62 < keys61.length; k62++) {
      if (snap61[keys61[k62]] === undefined) dead61.push(iid61 + ':' + keys61[k62]);
    }
    pl61.applyItem(iid61, 1);
    var moved61 = false;
    for (var k63 = 0; k63 < keys61.length; k63++) {
      if (pl61.stats[keys61[k63]] !== snap61[keys61[k63]]) moved61 = true;
    }
    if (!moved61) dead61.push(iid61 + '(应用后无变化)');
  }
  assert(dead61.length === 0,
         '12 件道具的属性键全部真实生效（坏: ' + JSON.stringify(dead61) + '）');

  // 此前买不到的数值现在都有入口了
  var used61 = {};
  for (var i62 in Game.ITEMS) {
    var st61 = Game.ITEMS[i62].stat;
    for (var k64 in st61) used61[k64] = true;
  }
  var noEntry61 = ['healingPower', 'lifesteal', 'shieldMax', 'lifeOnHitPct', 'critMult',
                   'lifeOnKillPct'].filter(function (k) { return !used61[k]; });
  assert(noEntry61.length === 0,
         '暴击伤害/护盾/吸血/击杀回血/治疗强度都有道具入口了（缺: ' + noEntry61.join(',') + '）');

  // —— 拾取速度进了属性表，箱子拾取物能序列化回环 ——
  var pl62 = new Game.Player('swordsman');
  assert(pl62.stats.pickupSpeed === D61.pickupSpeed,
         '拾取速度挂在属性表上（' + pl62.stats.pickupSpeed + '）');
  var st63 = Game.Systems.createState('campaign', 'swordsman', 31337);
  st63.pickups.push(new Game.Pickup('heal', D61.chestHeal, 111, 222));
  st63.pickups.push(new Game.Pickup('magnet', 0, 333, 444));
  st63.pickups[0].vx = 5; st63.pickups[0].life = 40;
  var rt63 = Game.Systems.deserialize(Game.Systems.serialize(st63));
  assert(rt63.pickups.length === 2, '箱子类拾取物能存档回环（' + rt63.pickups.length + ' 件）');
  assert(rt63.pickups[0].type === 'heal' && rt63.pickups[0].value === D61.chestHeal,
         '回血箱回环后类型与数值不变（' + rt63.pickups[0].type + '/' + rt63.pickups[0].value + '）');
  assert(rt63.pickups[1].type === 'magnet', '吸铁石箱回环后类型不变');
  assert(rt63.player.state === rt63, '读档后 player.state 回指重建（吸铁石依赖它）');

  // —— 掉落量：本体数值冻结，倍数走 DROP 表 ——
  function kindsOf(st64) {
    var m = {};
    st64.pickups.forEach(function (p) { m[p.type] = (m[p.type] || 0) + 1; });
    return m;
  }
  var st65 = Game.Systems.createState('campaign', 'swordsman', 4242);
  new Game.Enemy('zombie', 500, 500, 1).die(st65);
  var kd65 = kindsOf(st65);
  assert(kd65.xp === 1, '跳尸必掉经验（' + JSON.stringify(kd65) + '）');
  var xp65 = st65.pickups.filter(function (p) { return p.type === 'xp'; })[0];
  var mat65 = st65.pickups.filter(function (p) { return p.type === 'material'; })[0];
  assert(xp65.value === Math.ceil(Game.ENEMIES.zombie.xp * D61.xpMult),
         '跳尸经验 1×' + D61.xpMult + ' = ' + xp65.value);
  assert(mat65 === undefined || mat65.value === Math.ceil(Game.ENEMIES.zombie.material * D61.matMult),
         '材料按 ' + D61.matMult + ' 倍掉（值 ' + (mat65 ? mat65.value : '未掉') + '）');

  // 同种子掉落逐位一致（读档可复现）
  var dropSig = function (st66) {
    return st66.pickups.map(function (p) { return p.type + ':' + p.value; }).join('|');
  };
  var A66 = Game.Systems.createState('campaign', 'swordsman', 9001);
  var B66 = Game.Systems.createState('campaign', 'swordsman', 9001);
  new Game.Enemy('zombie', 500, 500, 1).die(A66);
  new Game.Enemy('zombie', 500, 500, 1).die(B66);
  assert(dropSig(A66) === dropSig(B66), '同种子掉落一致（' + dropSig(A66) + '）');

  // —— Boss 必给回血箱 + 吸铁石，且回血翻倍 ——
  var st67 = Game.Systems.createState('campaign', 'swordsman', 77);
  new Game.Enemy('boss', 500, 500, 10).die(st67);
  var kd67 = kindsOf(st67);
  assert(kd67.heal === 1 && kd67.magnet === 1,
         'Boss 必给回血箱 + 吸铁石各一（' + JSON.stringify(kd67) + '）');
  var bHeal67 = st67.pickups.filter(function (p) { return p.type === 'heal'; })[0];
  assert(bHeal67.value === D61.chestHeal * D61.bossChestHealMult,
         'Boss 回血箱翻倍（' + D61.chestHeal + '×' + D61.bossChestHealMult + ' = ' +
         bHeal67.value + '）');

  // —— 小怪掉箱概率与配置一致，两种箱子都会出 ——
  var chestCnt68 = 0, killCnt68 = 0, healSeen68 = 0, magSeen68 = 0;
  for (var s68 = 1; s68 <= 300; s68++) {
    var st68 = Game.Systems.createState('campaign', 'swordsman', 50000 + s68);
    for (var n68 = 0; n68 < 8; n68++) new Game.Enemy('zombie', 500, 500, 1).die(st68);
    killCnt68 += 8;
    st68.pickups.forEach(function (p) {
      if (p.type === 'heal') { chestCnt68++; healSeen68++; }
      if (p.type === 'magnet') { chestCnt68++; magSeen68++; }
    });
  }
  var rate68 = chestCnt68 / killCnt68;
  assert(chestCnt68 > 0 && Math.abs(rate68 - D61.chestChance) < 0.03,
         '小怪掉箱概率 ≈ ' + (D61.chestChance * 100).toFixed(1) +
         '%（' + killCnt68 + ' 只实出 ' + chestCnt68 + ' 个 = ' + (rate68 * 100).toFixed(1) + '%）');
  assert(healSeen68 > 0 && magSeen68 > 0,
         '回血箱与吸铁石箱都真的会掉（' + healSeen68 + ' / ' + magSeen68 + '）');

  // —— 回血箱：真回血，且满血不溢出 ——
  var st69 = Game.Systems.createState('campaign', 'swordsman', 101);
  Game.state = st69;
  var p69 = st69.player;
  p69.stats.hp = 40;
  new Game.Pickup('heal', D61.chestHeal, p69.x, p69.y).update(0.016, p69);
  assert(p69.stats.hp === 70, '回血箱回 ' + D61.chestHeal + ' 点（40 → ' + p69.stats.hp.toFixed(0) + '）');

  var st70 = Game.Systems.createState('campaign', 'swordsman', 102);
  Game.state = st70;
  var p70 = st70.player;
  p70.stats.hp = p70.stats.maxHp;
  new Game.Pickup('heal', D61.chestHeal, p70.x, p70.y).update(0.016, p70);
  assert(p70.stats.hp === p70.stats.maxHp,
         '满血吃回血箱不溢出（仍 ' + p70.stats.hp.toFixed(0) + '）');

  // 治疗强度会放大回血箱（herbal +25% → 30 变 37.5）
  var st71 = Game.Systems.createState('campaign', 'swordsman', 103);
  Game.state = st71;
  var p71 = st71.player;
  p71.applyItem('herbal', 1);
  p71.stats.hp = 40;
  var hp71 = p71.stats.hp;
  new Game.Pickup('heal', D61.chestHeal, p71.x, p71.y).update(0.016, p71);
  var got71 = p71.stats.hp - hp71;
  assert(Math.abs(got71 - D61.chestHeal * 1.25) < 0.01,
         '回春药草放大回血箱（实回 ' + got71.toFixed(1) + '）');

  // —— 吸铁石：一把把场上全部经验/材料吸回来 ——
  var st72 = Game.Systems.createState('campaign', 'swordsman', 104);
  Game.state = st72;
  var p72 = st72.player;
  st72.pickups = [];
  var far72 = 900;
  var xp72 = new Game.Pickup('xp', 2, p72.x + far72, p72.y);
  var mt72 = new Game.Pickup('material', 3, p72.x - far72, p72.y);
  st72.pickups.push(xp72, mt72);
  var mag72 = new Game.Pickup('magnet', 0, p72.x, p72.y);
  st72.pickups.push(mag72);
  mag72.update(0.016, p72);
  assert(mag72.dead, '吸铁石被拾取');
  assert(xp72.magnet && xp72.vx !== 0,
         '900px 外的经验被吸起来（vx=' + xp72.vx.toFixed(0) + '）');
  assert(mt72.magnet && mt72.vx !== 0,
         '900px 外的材料被吸起来（vx=' + mt72.vx.toFixed(0) + '）');
  assert(xp72.vx < 0 && mt72.vx > 0,
         '速度都指向玩家（经验在右所以向左 ' + xp72.vx.toFixed(0) +
         ' / 材料在左所以向右 ' + mt72.vx.toFixed(0) + '）');
  var matBefore72 = p72.materials, xpBefore72 = p72.xp;
  for (var i72 = 0; i72 < 300 && (!xp72.dead || !mt72.dead); i72++) {
    if (!xp72.dead) xp72.update(0.016, p72);
    if (!mt72.dead) mt72.update(0.016, p72);
  }
  assert(xp72.dead && mt72.dead, '吸铁石之后全场掉落物都到玩家手上');
  assert(p72.materials === matBefore72 + 3 && p72.xp === xpBefore72 + 2,
         '吸来的经验/材料实际到账（材料 ' + (p72.materials - matBefore72) +
         ' / 经验 ' + (p72.xp - xpBefore72) + '）');

  // 箱子本身不被吸（吸完就没箱子了）
  var st73 = Game.Systems.createState('campaign', 'swordsman', 105);
  Game.state = st73;
  var p73 = st73.player;
  st73.pickups = [];
  var xp73 = new Game.Pickup('xp', 2, p73.x + 900, p73.y);
  var heal73 = new Game.Pickup('heal', D61.chestHeal, p73.x - 900, p73.y);
  st73.pickups.push(xp73, heal73);
  var mag73 = new Game.Pickup('magnet', 0, p73.x, p73.y);
  st73.pickups.push(mag73);
  mag73.update(0.016, p73);
  assert(xp73.vx !== 0 && heal73.vx === 0,
         '吸铁石吸经验但不动箱子（经验 vx=' + xp73.vx.toFixed(0) +
         ' / 箱子 vx=' + heal73.vx.toFixed(0) + '）');

  // —— 近战占比：巫师是唯一的远程怪，压它的权重就等于加近战 ——
  var tally74 = { zombie: 0, bat: 0, wizard: 0, golem: 0, bruiser: 0, bulwark: 0 };
  var total74 = 0;
  for (var w74 = 1; w74 <= 5; w74++) {
    for (var s74 = 1; s74 <= 200; s74++) {
      var sch74 = Game.Systems.buildSpawnSchedule({ seed: s74, wave: w74 }, w74);
      for (var i74 = 0; i74 < sch74.length; i74++) {
        if (sch74[i74].boss) continue;
        tally74[sch74[i74].type] = (tally74[sch74[i74].type] || 0) + 1;
        total74++;
      }
    }
  }
  var melee74 = (tally74.zombie + tally74.bat) / total74;
  var ranged74 = tally74.wizard / total74;
  assert(melee74 >= 0.85,
         '1~5 波近战占比 ' + (melee74 * 100).toFixed(1) + '%（≥85%，跳尸 ' +
         (tally74.zombie / total74 * 100).toFixed(1) + '% / 蝠妖 ' +
         (tally74.bat / total74 * 100).toFixed(1) + '%）');
  assert(ranged74 <= 0.12,
         '1~5 波远程巫师 ' + (ranged74 * 100).toFixed(1) + '%（旧配比同波段是 25.2%）');

  // —— 刷新量：低波次原本被 budget 卡死，怪太稀 ——
  // 注意 6 波以后波次时长本身就够长，预算不再是瓶颈（旧预算也已顶满时长），
  // 所以增量集中在 1~5 波 —— 正好是「开局没人打」的爽感缺口所在。
  function countMonsters(wave76) {
    var sch76 = Game.Systems.buildSpawnSchedule({ seed: 13, wave: wave76 }, wave76);
    var c76 = 0;
    for (var i76 = 0; i76 < sch76.length; i76++) if (!sch76[i76].boss) c76++;
    return c76;
  }
  function countOldMonsters(wave77) {
    var dur77 = Game.Systems.waveDuration(wave77);
    var bud77 = 8 + wave77 * 6, t77 = 0.5, c77 = 0;
    while (c77 < bud77 && t77 < dur77) {
      c77++; t77 += 0.55 - Math.min(0.3, wave77 * 0.01);
      if (t77 < 0.1) t77 = 0.1;
    }
    return c77;
  }
  var earlyOld78 = 0, earlyNew78 = 0;
  for (var w78 = 1; w78 <= 5; w78++) { earlyOld78 += countOldMonsters(w78); earlyNew78 += countMonsters(w78); }
  assert(earlyNew78 >= earlyOld78 * 1.4,
         '1~5 波总怪量 ' + earlyOld78 + ' → ' + earlyNew78 +
         '（+' + ((earlyNew78 / earlyOld78 - 1) * 100).toFixed(0) + '%，至少 +40%）');
  assert(countMonsters(1) >= countOldMonsters(1) * 1.7,
         '第 1 波怪量 +70% 以上（' + countOldMonsters(1) + ' → ' + countMonsters(1) + '）');

  // 6~10 波旧预算本就顶满时长：不许回落（防误改 budget 公式把高波次刷稀）
  var lateOld79 = 0, lateNew79 = 0;
  for (var w79 = 6; w79 <= 15; w79++) { lateOld79 += countOldMonsters(w79); lateNew79 += countMonsters(w79); }
  assert(lateNew79 >= lateOld79,
         '6~15 波怪量不低于旧值（旧 ' + lateOld79 + ' → 新 ' + lateNew79 + '）');

  /* ㉕ 武器等级可见 + 角色面板 —— 用户报「武器看不到等级」
     原来等级只挂在 title 上，触屏没有悬浮，等于看不到。 */

  var MAXLVL80 = Game.CONST.MAX_WEAPON_LEVEL;
  assert(MAXLVL80 === 4, '武器等级上限提到常量（' + MAXLVL80 + '，与旧字面量一致）');

  // —— 升级逻辑收敛到一处（升级卡与商店强化共用），且封顶不越界
  var st80 = Game.Systems.createState('campaign', 'swordsman', 61);
  var p80 = st80.player;
  p80.weapons = [Game.createWeapon('iron_sword', 1)];
  Game.Systems.upgradeRandomWeapon(p80);
  assert(p80.weapons[0].level === 2, '随机强化 +1 级（1 → ' + p80.weapons[0].level + '）');
  for (var n80 = 0; n80 < 50; n80++) Game.Systems.upgradeRandomWeapon(p80);
  assert(p80.weapons[0].level === MAXLVL80,
         '连升 51 次仍封顶 ' + MAXLVL80 + '（实际 ' + p80.weapons[0].level + '）');
  Game.Systems.upgradeRandomWeapon(p80);
  assert(p80.weapons[0].level === MAXLVL80, '已满级时强化不再加星');

  var st81 = Game.Systems.createState('campaign', 'archer', 62);
  st81.player.weapons = [Game.createWeapon('pistol', 1), Game.createWeapon('iron_sword', 1)];
  Game.Systems.upgradeRandomWeapon(st81.player);
  var sum82 = st81.player.weapons[0].level + st81.player.weapons[1].level;
  assert(sum82 === 3, '一次只升一把武器（总等级 ' + sum82 + '）');

  // —— HUD 武器槽：等级画在槽上，并按星级着色
  var st82 = Game.Systems.createState('campaign', 'archer', 63);
  st82.player.weapons = [Game.createWeapon('pistol', 3), Game.createWeapon('iron_sword', 1)];
  Game.UI.updateHUD(st82);
  var slots82 = document.getElementById('weapon-slots').innerHTML;
  assert(slots82.indexOf('class="ws ws-lv3"') >= 0, '3 级武器槽按星级着色（ws-lv3）');
  assert(slots82.indexOf('class="ws ws-lv1"') >= 0, '1 级武器槽基础色（ws-lv1）');
  assert(slots82.indexOf('>Lv3</span>') >= 0, '武器等级直接画在槽上（Lv3）');
  assert(slots82.indexOf('>Lv1</span>') >= 0, '第二把武器同样显示等级（Lv1）');
  assert(slots82.indexOf('🔫') >= 0 && slots82.indexOf('🗡') >= 0, '槽上区分近战/远程图标');

  // —— 角色面板：属性 / 武器伤害明细 / 道具
  var st83 = Game.Systems.createState('campaign', 'archer', 64);
  var p83 = st83.player;
  p83.weapons = [Game.createWeapon('pistol', 3)];
  p83.items = { herbal: 2, deathbell: 1 };
  var st83html = Game.UI.renderStatsHTML(st83);
  assert(st83html.indexOf('青木弓手') >= 0, '面板显示角色名');
  assert(st83html.indexOf('暴击远程') >= 0, '面板显示职业分类');
  assert(st83html.indexOf('穿杨') >= 0, '面板显示被动');
  assert(st83html.indexOf('属性') >= 0 && st83html.indexOf('武器伤害明细') >= 0,
         '面板有属性与武器伤害明细两个区块');
  assert(st83html.indexOf('手枪') >= 0, '面板列出武器名');
  assert(st83html.indexOf('Lv.3/' + MAXLVL80) >= 0,
         '面板显示武器等级（Lv.3/' + MAXLVL80 + '）');
  assert(st83html.indexOf('<span class="stats-wlvl">Lv.3/' + MAXLVL80 + ' ★★★☆</span>') >= 0,
         '面板用星级显示武器等级（Lv.3/4 ★★★☆）');
  assert(st83html.indexOf('单次暴击') >= 0, '面板显示单次暴击');
  assert(st83html.indexOf('回春药草 ×2') >= 0, '面板列出道具与堆叠数');
  assert(st83html.indexOf('夺命金铃 ×1') >= 0, '面板列出第二件道具');

  // 关键：面板上的数字必须等于真实结算值，不是另一套算法
  var w83 = p83.weapons[0];
  var real83 = w83.damage(p83);
  var cd83 = w83.cooldown(p83);
  assert(st83html.indexOf('</span><span class="v">' + real83.toFixed(2) + '</span>') >= 0,
         '面板伤害 = WeaponInstance.damage 的真实值（' + real83.toFixed(2) + '）');
  assert(st83html.indexOf('<span>单次暴击</span><span class="v">' +
         (real83 * p83.stats.critMult).toFixed(2) + '</span>') >= 0,
         '面板单次暴击 = 伤害 × critMult（' + (real83 * p83.stats.critMult).toFixed(2) +
         '，critMult=' + p83.stats.critMult + '）');
  assert(st83html.indexOf('DPS ' + (real83 / cd83).toFixed(2) + '</span>') >= 0,
         '面板 DPS = 伤害 / 冷却（' + (real83 / cd83).toFixed(2) + '）');

  // 等级成长是面板要解释清楚的事：Lv.1 → Lv.4 本体伤害 ×2.5
  var lo83 = new Game.WeaponInstance('pistol', 1).damage(p83);
  var hi83 = new Game.WeaponInstance('pistol', MAXLVL80).damage(p83);
  assert(Math.abs(hi83 / lo83 - 2.5) < 1e-9,
         'Lv.1→Lv.' + MAXLVL80 + ' 本体伤害 ×2.5（' + lo83.toFixed(1) + ' → ' + hi83.toFixed(1) + '）');

  var st84 = Game.Systems.createState('campaign', 'swordsman', 65);
  assert(Game.UI.renderStatsHTML(st84).indexOf('还没有道具') >= 0, '无道具时显示占位文案');

  // —— 选卡卡片里不再塞入口按钮（面板常驻右侧，不用点开）
  Game.UI.renderLevelUp([{ kind: 'weaponUpgrade', data: {} }]);
  var lu85 = document.getElementById('levelup').innerHTML;
  assert(lu85.indexOf('最高 ' + MAXLVL80 + ' 星') >= 0, '武器强化说明的上限跟随常量');
  assert(lu85.indexOf('查看角色面板') < 0, '选卡卡片里不再放「查看角色面板」按钮');

  // —— 常驻侧栏：内容画进侧栏即可，不切界面、不冻结世界
  var st86 = Game.Systems.createState('campaign', 'swordsman', 66);
  st86.screen = 'PLAYING';
  Game.state = st86;
  var uiBefore = Game.uiScreen;
  Game.UI.renderStats(st86);
  assert(document.getElementById('stats').innerHTML.indexOf('人物面板') >= 0,
         '面板内容已渲染进侧栏');
  assert(st86.screen === 'PLAYING', '看面板不冻结世界');
  assert(Game.uiScreen === uiBefore, '渲染面板不切换界面状态（不需要点开）');

  // —— 四种对局界面下面板都在（选卡时尤其重要：不必关掉卡片看数据）
  ['PLAYING', 'LEVEL_UP', 'SHOP', 'PAUSED'].forEach(function (scr) {
    Game.UI.showScreen(scr);
    var cn = document.getElementById('stats').className;
    assert(cn.indexOf('stats-side') >= 0 && cn.indexOf('hidden') < 0,
           scr + ' 下人物面板常驻可见');
  });
  ['MENU', 'GAME_OVER', 'VICTORY'].forEach(function (scr) {
    Game.UI.showScreen(scr);
    assert(document.getElementById('stats').className.indexOf('hidden') >= 0,
           scr + ' 下人物面板收起');
  });

  // —— 收起/展开把手
  Game.UI.showScreen('PLAYING');
  Game.UI.toggleStatsFold();
  assert(document.getElementById('stats').className.indexOf('folded') >= 0, '点把手后侧栏收起');
  assert(document.getElementById('stats-fold').textContent === '▶', '把手箭头跟着翻向另一边');
  Game.UI.toggleStatsFold();
  var cn86 = document.getElementById('stats').className;
  assert(cn86.indexOf('folded') < 0 && cn86.indexOf('hidden') < 0, '再点一次展开，且仍然可见');

  // —— 相机给面板让位：挡住多少就让多少，收起来要还给玩家
  var v8 = Game.Renderer.view;
  Game.UI._updatePanelInset();
  assert(Math.abs(Game.Renderer.sideInset - 262 / v8.scale) < 1e-9,
         '展开时相机让出的宽度 = 面板宽度（逻辑 ' + Game.Renderer.sideInset.toFixed(0) + '）');
  Game.UI.toggleStatsFold();
  assert(Game.Renderer.sideInset === 26, '收起时相机只让出 26px 窄条，画面还给玩家');
  Game.UI.toggleStatsFold();

  var camSave = { x: Game.Renderer.camera.x, y: Game.Renderer.camera.y };
  Game.Renderer.view = { w: 1200, h: 720, scale: 1, dpr: 1 };
  Game.Renderer.setViewInset(300);
  Game.Renderer.updateCamera({ x: 900, y: 360 });
  assert(Math.abs((900 - Game.Renderer.camera.x) - (1200 - 300) / 2) < 1e-9,
         '让位后角色落在可视区中央，不会被面板挡住');
  Game.Renderer.setViewInset(0);
  Game.Renderer.updateCamera({ x: 900, y: 360 });
  assert(Math.abs((900 - Game.Renderer.camera.x) - 600) < 1e-9,
         '面板宽度为 0 时相机行为与旧版完全一致');
  Game.Renderer.view = v8;
  Game.Renderer.camera.x = camSave.x;
  Game.Renderer.camera.y = camSave.y;

  // —— 内容没变就别重建：面板每帧都被 updateHUD 调，全量重建会打断玩家滚动
  var st87 = Game.Systems.createState('campaign', 'swordsman', 67);
  Game.UI.renderStats(st87);
  var sigA = document.getElementById('stats').innerHTML;
  assert(Game.UI.renderStats(st87) === false, '内容没变时跳过重建（返回 false）');
  st87.player.stats.hp -= 10;
  assert(Game.UI.renderStats(st87) === true, '血量变了就重建');
  assert(document.getElementById('stats').innerHTML !== sigA, '重建后面板内容已更新');

  // —— 常驻面板刷新不会动到选卡卡片
  var st88 = Game.Systems.createState('campaign', 'archer', 68);
  Game.Systems.rollLevelUpChoices(st88);
  st88.screen = 'LEVEL_UP';
  Game.state = st88;
  Game.UI.renderLevelUp(st88.levelUpChoices);
  var before88 = document.getElementById('levelup').innerHTML;
  Game.UI.showScreen('LEVEL_UP');
  Game.UI.renderStats(st88);
  assert(document.getElementById('levelup').innerHTML === before88,
         '常驻面板刷新后三选一原样保留（内容完全一致）');

  // —— 暂停面板也不再需要入口按钮
  var st89 = Game.Systems.createState('campaign', 'swordsman', 69);
  st89.screen = 'PAUSED';
  Game.state = st89;
  Game.UI.renderPause();
  assert(document.getElementById('pause').innerHTML.indexOf('查看角色面板') < 0,
         '暂停面板不再放「查看角色面板」按钮');

} catch (e) {
  assert(false, '职业姿态/新角色异常: ' + e.stack);
}

/* ============================================================
 * ㉖ 每波不重卡 / 加量 / 回血卡百分比化+降权 / 背景音乐 / 前期金币
 * ============================================================ */
console.log('\n== ㉖ 每波不重卡 + 加量 + 回血卡改造 + 背景音乐 + 前期金币 ==');
try {
  // ---- 1. 卡片 key：升级池 {kind,data} 与商店 {type,itemId} 必须算成同一个 ----
  assert(Game.Systems.cardKey({ kind: 'item', data: { itemId: 'heart' } }) ===
         Game.Systems.cardKey({ type: 'item', itemId: 'heart' }),
         '升级池与商店的同一张卡算同一个 key（跨界面才能去重）');
  assert(Game.Systems.cardKey({ kind: 'weapon', data: { weaponId: 'pistol' } }) ===
         Game.Systems.cardKey({ type: 'weapon', weaponId: 'pistol' }),
         '武器卡在两种形状下同 key');

  // ---- 2. 同一次三选一内不重复；同一波连续多次三选一也不重卡 ----
  var dupInOffer = 0, dupInWave = 0, N90 = 300;
  for (var t90 = 0; t90 < N90; t90++) {
    var s90 = Game.Systems.createState('campaign', 'swordsman', 200000 + t90);
    Game.Systems.startWave(s90, 3);
    var seen90 = [];
    for (var r90 = 0; r90 < 5; r90++) {
      var cs90 = Game.Systems.rollLevelUpChoices(s90);
      var local90 = [];
      for (var a90 = 0; a90 < cs90.length; a90++) {
        var k90 = Game.Systems.cardKey(cs90[a90]);
        if (local90.indexOf(k90) >= 0) dupInOffer++;
        local90.push(k90);
        if (seen90.indexOf(k90) >= 0) dupInWave++;
        seen90.push(k90);
      }
    }
  }
  assert(dupInOffer === 0, '同一次三选一里无重复卡（' + N90 + ' 轮 × 5 次抽取）');
  assert(dupInWave === 0, '同一波连续 5 次三选一也不重卡（' + N90 + ' 轮）');

  // ---- 3. 商店 4 格不重复，且不与本波升级卡撞 ----
  var dupShop = 0, crossSeen = 0;
  for (var t91 = 0; t91 < 300; t91++) {
    var s91 = Game.Systems.createState('campaign', 'archer', 210000 + t91);
    Game.Systems.startWave(s91, 2);
    var ups91 = Game.Systems.rollLevelUpChoices(s91);
    var upKeys91 = ups91.map(function (c) { return Game.Systems.cardKey(c); });
    Game.Systems.openShop(s91);
    var ks91 = [];
    for (var b91 = 0; b91 < s91.shop.items.length; b91++) {
      var kk91 = Game.Systems.cardKey(s91.shop.items[b91]);
      if (ks91.indexOf(kk91) >= 0) dupShop++;
      if (upKeys91.indexOf(kk91) >= 0) crossSeen++;
      ks91.push(kk91);
    }
  }
  assert(dupShop === 0, '同一次商店 4 格无重复卡（300 轮）');
  assert(crossSeen === 0, '商店不与本波升级三选一撞卡（300 轮 × 4 格）');

  // ---- 4. 连续刷新后 4 格仍不重复 ----
  // 商店候选池总共才 12 道具 + 2 武器 = 14 张，刷新 3 次以上必然抽干、
  // 只能开始重复，所以这里只验池子还没抽干的次数（抽干时的行为见下面的断言）。
  var dupRefresh = 0;
  for (var t92 = 0; t92 < 200; t92++) {
    var s92 = Game.Systems.createState('campaign', 'swordsman', 250000 + t92);
    s92.player.materials = 1e9;
    Game.Systems.startWave(s92, 3);
    Game.Systems.openShop(s92);
    for (var r92 = 0; r92 < 2; r92++) {
      Game.Systems.refreshShop(s92);
      var ks92 = [];
      for (var b92 = 0; b92 < s92.shop.items.length; b92++) {
        var k92 = Game.Systems.cardKey(s92.shop.items[b92]);
        if (ks92.indexOf(k92) >= 0) dupRefresh++;
        ks92.push(k92);
      }
    }
  }
  assert(dupRefresh === 0, '连续刷新后 4 格仍无重复卡（200 轮 × 2 次刷新）');

  // 池子真的抽干时也要有话说：4 格永远填满，不出现空槽
  var emptySlot92 = 0;
  for (var tR = 0; tR < 50; tR++) {
    var sR = Game.Systems.createState('campaign', 'swordsman', 270000 + tR);
    sR.player.materials = 1e9;
    Game.Systems.startWave(sR, 3);
    Game.Systems.openShop(sR);
    for (var rR = 0; rR < 8; rR++) {
      Game.Systems.refreshShop(sR);
      for (var bR = 0; bR < sR.shop.items.length; bR++) {
        var itR = sR.shop.items[bR];
        if (!itR || !itR.type || typeof itR.price !== 'number') emptySlot92++;
      }
    }
  }
  assert(emptySlot92 === 0, '候选池抽干时 4 格仍然填满（不出现空槽）');

  // ---- 5. 换波重置：上一波出过的卡下一波能再出 ----
  var s93 = Game.Systems.createState('campaign', 'swordsman', 215000);
  Game.Systems.startWave(s93, 1);
  Game.Systems.rollLevelUpChoices(s93);
  assert(s93.waveSeen.length > 0, '本波抽过的卡被登记（' + s93.waveSeen.length + ' 张）');
  Game.Systems.startWave(s93, 2);
  assert(s93.waveSeen.length === 0, '换波清空记录，同一张卡下一波能再出');

  // ---- 6. 候选池被抽干时仍然凑满 3 张（Boss 奖励池总共才 6 张）----
  var short94 = 0;
  for (var t94 = 0; t94 < 200; t94++) {
    var s94 = Game.Systems.createState('campaign', 'swordsman', 220000 + t94);
    for (var r94 = 0; r94 < 10; r94++) {
      if (Game.Systems.bossRewardChoices(s94).length !== 3) short94++;
    }
  }
  assert(short94 === 0, 'Boss 奖励池抽干时仍凑满 3 张（200 轮 × 10 次，缺张 ' + short94 + ' 次）');

  // ---- 7. 回血道具改成按最大生命百分比 ----
  assert(Game.CONST.HEAL_ITEM_WEIGHT === 0.15, '回血卡权重系数集中在 CONST');
  var healIds95 = [];
  for (var i95 in Game.ITEMS) if (Game.ITEMS[i95].healing) healIds95.push(i95);
  assert(healIds95.length === 4, '4 件回血道具被标记（' + healIds95.length + '）');
  assert(Game.ITEMS.lifeluck.stat.lifeOnHitPct === 0.012 &&
         typeof Game.ITEMS.lifeluck.stat.lifeOnHit === 'undefined',
         '生机之种改成按最大生命百分比');
  assert(Game.ITEMS.deathbell.stat.lifeOnKillPct === 0.03 &&
         typeof Game.ITEMS.deathbell.stat.lifeOnKill === 'undefined',
         '夺命金铃改成按最大生命百分比');
  assert(/最大生命/.test(Game.ITEMS.lifeluck.desc) && /最大生命/.test(Game.ITEMS.deathbell.desc),
         '道具文案跟着改成百分比');

  var p96 = new Game.Player('swordsman');
  p96.applyItem('lifeluck', 1);
  assert(Math.abs(p96.healForHit() - p96.stats.maxHp * 0.012) < 1e-9,
         '命中回血 = 最大生命 × 1.2%');
  var p97 = new Game.Player('swordsman');
  p97.applyItem('deathbell', 1);
  assert(Math.abs(p97.healForKill() - p97.stats.maxHp * 0.03) < 1e-9,
         '击杀回血 = 最大生命 × 3%');
  var hp97 = p97.stats.maxHp;
  p97.applyUpgrade({ maxHp: 40 });
  assert(Math.abs(p97.healForKill() - (hp97 + 40) * 0.03) < 1e-9,
         '最大生命涨了回血量跟着涨（固定点数做不到）');
  // 老存档里残留的固定点数仍生效 —— 改表不该让玩家白买
  var p98 = new Game.Player('swordsman');
  p98.stats.lifeOnHit = 2; p98.stats.lifeOnKill = 5;
  assert(p98.healForHit() === 2 && p98.healForKill() === 5,
         '老存档里固定的命中/击杀回血仍生效');

  // ---- 8. 近战与远程两条命中路径都走这套取数 ----
  var s99 = Game.Systems.createState('campaign', 'swordsman', 230000);
  s99.player.applyItem('lifeluck', 1);
  s99.player.applyItem('deathbell', 1);
  var wp99 = s99.player.weapons[0];
  var e99 = atWeapon(wp99, s99.player, 30, 'bat', 1);
  s99.enemies.push(e99);
  var calls99 = [];
  s99.player.heal = function (v) { calls99.push(v); return 0; };
  wp99.cooldownRemaining = 0;
  wp99.update(0.016, s99.player, s99);
  assert(calls99.length === 2,
         '一次近战命中触发命中回血 + 击杀回血（' + calls99.length + ' 次）');
  assert(Math.abs(calls99[0] - s99.player.stats.maxHp * 0.012) < 1e-9 &&
         Math.abs(calls99[1] - s99.player.stats.maxHp * 0.03) < 1e-9,
         '近战路径按最大生命百分比回血（' + calls99[0].toFixed(2) + ' / ' + calls99[1].toFixed(2) + '）');

  var s100 = Game.Systems.createState('campaign', 'swordsman', 305000);
  s100.player.applyItem('lifeluck', 1);
  s100.player.applyItem('deathbell', 1);
  var e100 = new Game.Enemy('bat', s100.player.x + 200, s100.player.y, 1);
  s100.enemies.push(e100);
  s100.projectiles.push(new Game.Projectile({
    x: e100.x, y: e100.y, vx: 0, vy: 0, radius: 5, damage: 50, crit: false,
    fromPlayer: true, pierce: 0, life: 1, color: '#fff', type: 'bullet',
    knockback: 0, owner: s100.player,
  }));
  var calls100 = [];
  s100.player.heal = function (v) { calls100.push(v); return 0; };
  Game.Systems.updateProjectiles(s100, 0.016);
  assert(calls100.length === 2 &&
         Math.abs(calls100[0] - s100.player.stats.maxHp * 0.012) < 1e-9 &&
         Math.abs(calls100[1] - s100.player.stats.maxHp * 0.03) < 1e-9,
         '远程弹道路径同样按最大生命百分比回血');

  // ---- 9. 面板上显示成百分比 ----
  var s101 = Game.Systems.createState('campaign', 'swordsman', 306000);
  s101.player.applyItem('lifeluck', 1);
  s101.player.applyItem('deathbell', 1);
  var html101 = Game.UI.renderStatsHTML(s101);
  assert(html101.indexOf('1.2% 最大生命') >= 0, '面板显示命中回血百分比');
  assert(html101.indexOf('3% 最大生命') >= 0, '面板显示击杀回血百分比');
  assert(!/回血<\/span><span class="v">[^<]*\/ 次<\/span>/.test(html101),
         '百分比生效时不再显示固定的「/ 次」');

  // ---- 10. 回血卡降权；healBuild 角色不降 ----
  function healShare(charId, n102, rolls102) {
    var heals102 = 0, total102 = 0;
    for (var t102 = 0; t102 < n102; t102++) {
      var s102 = Game.Systems.createState('campaign', charId, 260000 + t102);
      for (var r102 = 0; r102 < rolls102; r102++) {
        var cs102 = Game.Systems.rollLevelUpChoices(s102);
        for (var a102 = 0; a102 < cs102.length; a102++) {
          if (cs102[a102].kind !== 'item') continue;
          total102++;
          if (Game.ITEMS[cs102[a102].data.itemId].healing) heals102++;
        }
      }
    }
    return { heals: heals102, total: total102 };
  }
  // 每次只抽一次：抽多了去重会把普通道具过滤光，回血卡的相对占比反而回升
  var share103 = healShare('swordsman', 500, 1);
  var share104 = healShare('assassin', 500, 1);
  assert(share103.heals / share103.total < 0.15,
         '非续航角色回血卡占比 ' + (share103.heals / share103.total * 100).toFixed(1) +
         '%（' + share103.heals + '/' + share103.total + '，等权应为 33.3%）');
  assert(share104.heals / share104.total > share103.heals / share103.total + 0.08,
         'healBuild 角色（掠影）拿满权，回血卡占比 ' +
         (share104.heals / share104.total * 100).toFixed(1) + '%，明显高于普通角色');

  // healBuild 标记在三个续航角色上
  var healChars105 = ['assassin', 'nun', 'ascetic'].filter(function (id) {
    var c105 = null, chars105 = Game.CHARACTERS;
    for (var i105 = 0; i105 < chars105.length; i105++) if (chars105[i105].id === id) c105 = chars105[i105];
    return !!(c105 && c105.healBuild);
  });
  assert(healChars105.length === 3, '三个续航角色都标了 healBuild（' + healChars105.length + '）');

  // ---- 11. 存档回环：本波记录 + 新属性键 ----
  var s106 = Game.Systems.createState('campaign', 'swordsman', 300000);
  Game.Systems.startWave(s106, 4);
  Game.Systems.rollLevelUpChoices(s106);
  s106.player.applyItem('lifeluck', 2);
  var rt106 = Game.Systems.deserialize(Game.Systems.serialize(s106));
  assert(JSON.stringify(rt106.waveSeen) === JSON.stringify(s106.waveSeen),
         '本波已出过的卡随存档往返');
  assert(rt106.player.stats.lifeOnHitPct === s106.player.stats.lifeOnHitPct &&
         rt106.player.stats.lifeOnKillPct === s106.player.stats.lifeOnKillPct,
         '百分比回血属性随存档往返');
  assert(rt106.player.healForHit() === s106.player.healForHit(), '读档后回血量不变');

  // ---- 12. 怪量：对上一版预算（16+8w）逐波不许回落 ----
  function countWith(budgetFn, intervalFn, wave107) {
    var dur107 = Game.Systems.waveDuration(wave107);
    var bud107 = budgetFn(wave107), t107 = 0.5, c107 = 0;
    if (Game.Systems.isBossWave(wave107)) bud107 = Math.max(10, Math.floor(bud107 * 0.6));
    while (c107 < bud107 && t107 < dur107) {
      c107++; t107 += intervalFn(wave107);
      if (t107 < 0.1) t107 = 0.1;
    }
    return c107;
  }
  var drop107 = [];
  for (var w107 = 1; w107 <= 20; w107++) {
    if (countWith(function (w) { return 22 + w * 10; }, function (w) { return 0.5 - Math.min(0.26, w * 0.01); }, w107) <
        countWith(function (w) { return 16 + w * 8; }, function (w) { return 0.55 - Math.min(0.3, w * 0.01); }, w107)) {
      drop107.push(w107);
    }
  }
  assert(drop107.length === 0, '1~20 波怪量对上一版（16+8w）零回落（少量波次: ' + (drop107.join(',') || '无') + '）');
  assert(countWith(function (w) { return 22 + w * 10; }, function (w) { return 0.5 - Math.min(0.26, w * 0.01); }, 1) >=
         countWith(function (w) { return 16 + w * 8; }, function (w) { return 0.55 - Math.min(0.3, w * 0.01); }, 1) * 1.3,
         '第 1 波怪量 +33% 以上（' +
         countWith(function (w) { return 16 + w * 8; }, function (w) { return 0.55 - Math.min(0.3, w * 0.01); }, 1) +
         ' → ' + countWith(function (w) { return 22 + w * 10; }, function (w) { return 0.5 - Math.min(0.26, w * 0.01); }, 1) + '）');

  // ---- 13. 前期金币：第 1 波期望材料够买稀有 + 普通各一件 ----
  assert(Game.DROP.matChance === 0.8, '材料掉落率提到 0.8');
  var sch108 = Game.Systems.buildSpawnSchedule({ seed: 777, wave: 1 }, 1);
  var expMat108 = 0;
  for (var i108 = 0; i108 < sch108.length; i108++) {
    expMat108 += Math.ceil(Game.ENEMIES[sch108[i108].type].material * Game.DROP.matMult) *
                 Game.DROP.matChance;
  }
  var need108 = Game.Systems.priceFor('rare', 1) + Game.Systems.priceFor('common', 1);
  assert(expMat108 >= need108,
         '第 1 波期望材料 ' + expMat108.toFixed(0) + ' ≥ 稀有 ' + Game.Systems.priceFor('rare', 1) +
         ' + 普通 ' + Game.Systems.priceFor('common', 1) + '，首轮买得起装备');

  // ---- 14. 背景音乐 ----
  assert(Game.Audio.isMusicEnabled() === true, '背景音乐默认开');
  Game.Audio.setMusicEnabled(false);
  assert(Game.Audio.isMusicEnabled() === false, '能关掉背景音乐');
  Game.Audio.setMusicEnabled(true);
  assert(Game.Audio.isMusicEnabled() === true, '能重新打开背景音乐');
  Game.Audio.unlock();   // 无 AudioContext 环境下必须安全返回
  assert(true, '无 AudioContext 时 unlock / startMusic 不抛异常');

  assert(Game.settings.music === true, '设置默认开启背景音乐');
  assert(Game.Audio.isMusicEnabled() === Game.settings.music, '设置与音频模块一致');
  Game.Game.toggleMusic();
  assert(Game.settings.music === false && Game.Audio.isMusicEnabled() === false,
         'toggleMusic 翻转设置并同步音频模块');
  Game.Game.toggleMusic();
  assert(Game.settings.music === true && Game.Audio.isMusicEnabled() === true, '再翻一次回来');

  Game.Game.openSettings();
  var setHtml109 = document.getElementById('settings').innerHTML;
  assert(setHtml109.indexOf('背景音乐') >= 0, '设置面板有背景音乐开关');
  assert(setHtml109.indexOf('Game.Game.toggleMusic') >= 0, '背景音乐开关绑定了 toggleMusic');
  Game.Game.toggleMusic();                 // 关掉
  Game.Game.openSettings();                // 重画，面板应如实显示「关」
  var setHtml110 = document.getElementById('settings').innerHTML;
  assert(/背景音乐：关/.test(setHtml110), '关掉后设置面板如实显示「关」');
  Game.Game.toggleMusic();                 // 翻回来，别影响后面的断言
  Game.Game.openSettings();
  assert(/背景音乐：开/.test(document.getElementById('settings').innerHTML),
         '打开时设置面板显示「开」');

  // 音效开关与背景音乐互不牵连
  Game.Audio.setEnabled(false);
  assert(Game.Audio.isEnabled() === false && Game.Audio.isMusicEnabled() === true,
         '关音效不影响背景音乐开关');
  Game.Audio.setEnabled(true);

  // 老存档缺 music 字段时不会把背景音乐悄悄关掉
  var saved110 = Game.settings;
  Game.settings = { sound: true, vibrate: true, quality: 'high' };   // 老存档形状
  Game.Game._applySettings();
  assert(Game.Audio.isMusicEnabled() === true, '老存档没有 music 字段时背景音乐仍然开');
  Game.settings = saved110;
} catch (e) {
  assert(false, '每波不重卡/加量/回血卡改造异常: ' + e.stack);
}

/* ============================================================
 * ㉗ 环绕武器：多把武器各自挂轨、自主攻击 + 远程降伤 / 近战加范围
 * ============================================================ */
console.log('\n== ㉗ 环绕武器 + 远程降伤 + 近战加范围 ==');
try {
  var K = Game.CONST;

  // ---- 1. 调参开关就位，且 WEAPONS 表本体未被改动（冻结区保持原样）----
  assert(K.WEAPON_ORBIT_R === 62 && Math.abs(K.WEAPON_ORBIT_OFFSET - (-Math.PI / 2)) < 1e-9,
         '布置半径/基准角就位（R=' + K.WEAPON_ORBIT_R + ' / 第一把在玩家正上方）');
  assert(K.WEAPON_ORBIT_SPEED === undefined,
         '不再有轨道转速：武器固定在等分角上，不转圈');
  assert(K.RANGED_DMG_SCALE === 0.6 && K.MELEE_RANGE_SCALE === 1.25,
         '远程伤害 ×0.6 / 近战范围 ×1.25 两个开关就位');
  assert(Game.WEAPONS.pistol.damage === 10 && Game.WEAPONS.iron_sword.range === 66,
         'WEAPONS 表本体数值未被改动（系数在 WeaponInstance 里应用，不是改表）');

  var pl201 = new Game.Player('swordsman');
  var pistol201 = Game.createWeapon('pistol', 1);
  var sword201 = Game.createWeapon('iron_sword', 1);
  var moon201 = Game.createWeapon('moon_sword', 1);
  assert(Math.abs(pistol201.damage(pl201) - 10 * 0.6) < 1e-9, '手枪伤害被压到 10×0.6=6');
  assert(Math.abs(sword201.damage(pl201) - 14) < 1e-9, '铁剑伤害不受远程系数影响（仍 14）');
  assert(Math.abs(sword201.range() - 66 * 1.25) < 1e-9, '铁剑范围 66 → 82.5');
  assert(Math.abs(moon201.range() - 86 * 1.25) < 1e-9, '赤月斩范围 86 → 107.5');
  assert(Math.abs(pistol201.damage(pl201) - 6) < 1e-9 &&
         Math.abs(Game.createWeapon('pistol', 3).damage(pl201) - 6 * 2) < 1e-9,
         '远程系数与等级成长叠乘（Lv.3 手枪 6×2=12）');

  // ---- 2. 轨道公式：均分、越界安全、武器数变化会重新均分 ----
  assert(typeof Game.orbitSlot === 'function', 'Game.orbitSlot 是逻辑与渲染共用的唯一角度公式');
  assert(Game.orbitSlot(0, 0) === 0 && Game.orbitSlot(0, 5) === 0 && Game.orbitSlot(-1, 0) === 0,
         '武器数 ≤0 时角度退化为 0（不会越界，也不会除零）');
  // 相邻角度差要走 wrap：orbitSlot 把角度压回 [-π, π]，跨 ±π 的相邻槽
  // 直接相减会读成 -2π，而实际上它们是紧挨着的。
  // 角度现在是纯确定式（不取 performance.now），所以容差可以收到浮点极限。
  var wrapDiff = function (a, b) {
    var d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  var ang202 = [];
  for (var k202 = 0; k202 < 4; k202++) ang202.push(Game.orbitSlot(4, k202));
  var even202 = true;
  for (var k202b = 1; k202b < 4; k202b++) {
    if (Math.abs(wrapDiff(ang202[k202b], ang202[k202b - 1]) - Math.PI * 2 / 4) > 1e-9) even202 = false;
  }
  assert(even202, '4 把武器在布置圈上均分（相邻夹角 = 2π/4）');
  // 返回值必须在 [-π, π] 内：angDiff 拿去做 (a-b)%2π 时，角度越大 double 精度丢得越狠，
  // 一旦返回 2π 量级的值，索敌就永远「背对」敌人，一刀砍不出去
  var rng202 = true;
  for (var k202c = 0; k202c < 8; k202c++) {
    var v202 = Game.orbitSlot(k202c + 1, 0);
    if (v202 < -Math.PI - 1e-9 || v202 > Math.PI + 1e-9) rng202 = false;
  }
  assert(rng202, 'orbitSlot 返回值归一化到 [-π, π]（角度差取模的前提）');
  // 单把武器固定在基准角上，位置落在半径 R 的圈上，不会叠在玩家身上
  var one202 = Game.createWeapon('pistol', 1, 0);
  var host202 = { weapons: [one202], x: 100, y: 100 };
  var pt202 = one202.posAt(host202);
  assert(Math.abs(Game.util.dist(pt202.x, pt202.y, 100, 100) - K.WEAPON_ORBIT_R) < 0.001,
         '单把武器同样挂在半径 ' + K.WEAPON_ORBIT_R + ' 的布置圈上');
  assert(Math.abs(pt202.a - K.WEAPON_ORBIT_OFFSET) < 1e-9,
         '唯一一把武器停在基准角上（不转圈，也没有多余相位）');
  // 4 把时槽 1 在 π/2、6 把时在 π/3，位移 π/6。
  assert(Math.abs(Math.abs(wrapDiff(Game.orbitSlot(6, 1), Game.orbitSlot(4, 1))) - Math.PI / 6) < 1e-9,
         '武器数变化会重新均分整条圈（4 把 → 6 把，第 1 槽位移 π/6）');

  // ---- 3. 6 把武器互不重叠、且都挂在同一圈上 ----
  var s203 = Game.Systems.createState('campaign', 'swordsman', 777001);
  var pl203 = s203.player;
  for (var i203 = 1; i203 < K.MAX_WEAPONS; i203++) pl203.weapons.push(Game.createWeapon('pistol', 1, i203));
  Game.Systems.normalizeSlots(pl203);
  var pts203 = pl203.weapons.map(function (w) { return w.posAt(pl203); });
  assert(pts203.every(function (pt) {
    return Math.abs(Game.util.dist(pt.x, pt.y, pl203.x, pl203.y) - K.WEAPON_ORBIT_R) < 0.001;
  }), '每把武器都挂在半径 ' + K.WEAPON_ORBIT_R + ' 的同一圈上');
  var apart203 = true, minGap203 = Infinity;
  for (var a203 = 0; a203 < pts203.length; a203++)
    for (var b203 = a203 + 1; b203 < pts203.length; b203++) {
      var g203 = Game.util.dist(pts203[a203].x, pts203[a203].y, pts203[b203].x, pts203[b203].y);
      if (g203 < minGap203) minGap203 = g203;
      if (g203 < 40) apart203 = false;
    }
  assert(apart203, '6 把武器在轨道上互不重叠（最近两把间距 ' + minGap203.toFixed(0) + 'px）');

  // ---- 4. 命中范围是「以玩家为圆心的扇形」，扇形宽 = 360° / 武器数 ----
  function atSide(owner, w, dist, phiDeg) {
    var pp = w.posAt(owner);
    var ca = Math.cos(pp.a + phiDeg * Math.PI / 180), sa = Math.sin(pp.a + phiDeg * Math.PI / 180);
    return new Game.Enemy('zombie', owner.x + ca * dist, owner.y + sa * dist, 1);
  }
  var s204 = Game.Systems.createState('campaign', 'swordsman', 777002);
  var pl204 = s204.player;
  s204.enemies.length = 0; s204.projectiles.length = 0;
  var sw204 = pl204.weapons[0];
  assert(Math.abs(sw204.halfArc(pl204) - Math.PI) < 1e-9,
         '一把武器负责全场 360°（半角 180°）');

  var far204 = atWeapon(sw204, pl204, 90, 'zombie', 1);   // 距玩家 90px
  far204.hp = 1e9;
  s204.enemies.push(far204);
  sw204.cooldownRemaining = 0;
  sw204.update(0.016, pl204, s204);
  assert(far204.hp < 1e9, '径向 90px 的敌人被命中（原射程 66 差 24px，靠 ×1.25 补上）');

  // 武器正后方（原「玩家身后」）的敌人现在打得着 —— 360° 覆盖就是为修这个
  var back204 = atSide(pl204, sw204, 90, 180);
  back204.hp = 1e9;
  s204.enemies.length = 0;
  s204.enemies.push(back204);
  sw204.cooldownRemaining = 0;
  sw204.update(0.016, pl204, s204);
  assert(back204.hp < 1e9, '武器正后方的敌人也打得着：一把武器覆盖全场 360°');

  // 内环：贴着玩家、落在布置圈（半径 62）之内的敌人打得着。
  // 索敌圆心是玩家而不是武器 —— 以武器为圆心时这类敌人全在武器背后，内环永远打不到。
  var hug204 = atSide(pl204, sw204, 12, 0);
  hug204.hp = 1e9;
  s204.enemies.length = 0;
  s204.enemies.push(hug204);
  sw204.cooldownRemaining = 0;
  sw204.update(0.016, pl204, s204);
  assert(hug204.hp < 1e9, '贴着玩家（布置圈之内）的敌人打得着（内环不再是死角）');

  // 扇形里没有敌人就不空挥
  s204.enemies.length = 0;
  var swBefore204 = sw204.swingTime;
  sw204.cooldownRemaining = 0;
  sw204.update(0.016, pl204, s204);
  assert(Math.abs(sw204.swingTime - (swBefore204 + 0.016)) < 1e-9,
         '扇形里没有敌人就不空挥（余韵计时没被重置）');

  // 扇形宽度真的随武器数收窄：两把各 180°，边界在 ±90°
  var s204b = Game.Systems.createState('campaign', 'swordsman', 777009);
  var pl204b = s204b.player;
  s204b.enemies.length = 0; s204b.projectiles.length = 0;
  pl204b.weapons.push(Game.createWeapon('pistol', 1, 1));
  Game.Systems.normalizeSlots(pl204b);
  var sw204b = pl204b.weapons[0];
  assert(Math.abs(sw204b.halfArc(pl204b) - Math.PI / 2) < 1e-9,
         '两把武器各负责 180°（半角 90°）');
  var sideIn204 = atSide(pl204b, sw204b, 95, 50);
  sideIn204.hp = 1e9;
  s204b.enemies.length = 0; s204b.enemies.push(sideIn204);
  sw204b.cooldownRemaining = 0;
  sw204b.update(0.016, pl204b, s204b);
  assert(sideIn204.hp < 1e9, '偏 50° 的敌人还在 90° 半角内，被命中');
  var sideOut204 = atSide(pl204b, sw204b, 95, 110);
  sideOut204.hp = 1e9;
  s204b.enemies.length = 0; s204b.enemies.push(sideOut204);
  sw204b.cooldownRemaining = 0;
  sw204b.update(0.016, pl204b, s204b);
  assert(sideOut204.hp === 1e9, '偏 110° 的敌人出这把武器的扇形，打不着');

  // ---- 5. 击退方向从玩家指向敌人，不是从武器位置 ----
  var s205 = Game.Systems.createState('campaign', 'swordsman', 777003);
  var pl205 = s205.player;
  s205.enemies.length = 0; s205.projectiles.length = 0;
  var sw205 = pl205.weapons[0];
  // 偏移 25° 摆敌人：若击退从武器位置算，方向会偏成另一个角，点积对不上 60
  var kb205 = atSide(pl205, sw205, 95, 25);
  kb205.hp = 1e9;
  s205.enemies.push(kb205);
  sw205.cooldownRemaining = 0;
  sw205.update(0.016, pl205, s205);
  var dx205 = kb205.x - pl205.x, dy205 = kb205.y - pl205.y;
  var dl205 = Math.sqrt(dx205 * dx205 + dy205 * dy205);
  var kdot205 = (kb205.knockbackX * dx205 + kb205.knockbackY * dy205) / dl205;
  assert(Math.abs(kdot205 - 60) < 0.01,
         '击退方向从玩家指向敌人（沿该方向的点积 = knockback 60，实得 ' + kdot205.toFixed(2) + '）');

  // ---- 6. 只有主武器驱动玩家身上的动作与音效 ----
  var n206 = 0;
  var origHit206 = Game.Audio.hit;
  var origShoot206 = Game.Audio.shoot;
  Game.Audio.hit = function () { n206++; };
  Game.Audio.shoot = function () { n206++; };
  var s206 = Game.Systems.createState('campaign', 'swordsman', 777004);
  var pl206 = s206.player;
  s206.enemies.length = 0; s206.projectiles.length = 0;
  pl206.playAttack = function () { n206++; };
  var sub206 = new Game.WeaponInstance('moon_sword', 1, 1);   // 副武器
  pl206.weapons.push(sub206);
  s206.enemies.push(atWeapon(sub206, pl206, 40, 'zombie', 1));
  sub206.cooldownRemaining = 0;
  sub206.update(0.016, pl206, s206);
  assert(n206 === 0, '副武器出手不打断玩家：不触发玩家动作、不播打击音（触发 ' + n206 + ' 次）');
  n206 = 0;
  var s206b = Game.Systems.createState('campaign', 'swordsman', 777005);
  var pl206b = s206b.player;
  pl206b.playAttack = function () { n206++; };
  s206b.enemies.length = 0;
  s206b.enemies.push(atWeapon(pl206b.weapons[0], pl206b, 40, 'zombie', 1));
  pl206b.weapons[0].cooldownRemaining = 0;
  pl206b.weapons[0].update(0.016, pl206b, s206b);
  assert(n206 >= 1, '主武器出手仍触发玩家下劈动作（' + n206 + ' 次）');
  Game.Audio.hit = origHit206;
  Game.Audio.shoot = origShoot206;

  // ---- 7. 多把武器各自打自己的目标，不是只有一把在动 ----
  var s207 = Game.Systems.createState('campaign', 'swordsman', 777006);
  var pl207 = s207.player;
  s207.enemies.length = 0; s207.projectiles.length = 0;
  pl207.weapons.push(Game.createWeapon('moon_sword', 1, 1));
  pl207.weapons.push(Game.createWeapon('pistol', 1, 2));
  Game.Systems.normalizeSlots(pl207);
  pl207.weapons.forEach(function (w, i) {
    var t = atWeapon(w, pl207, 40, i === 2 ? 'wizard' : 'zombie', 1);
    t.hp = 1e9;
    s207.enemies.push(t);
  });
  pl207.weapons.forEach(function (w) { w.cooldownRemaining = 0; });
  var dealt207 = 0;
  pl207.weapons.forEach(function (w) {
    var b = pl207.damageDealt;
    w.update(0.016, pl207, s207);
    dealt207 += pl207.damageDealt - b;
  });
  assert(dealt207 > 0, '多把武器累计造成伤害（' + dealt207.toFixed(1) + '）');
  assert(s207.enemies[0].hp < 1e9 && s207.enemies[1].hp < 1e9,
         '两把近战武器各自打到了自己的敌人');
  assert(s207.projectiles.length === 1, '远程副武器发射了自己的子弹（' + s207.projectiles.length + ' 发）');
  assert(pl207.weapons.every(function (w) { return w.swingTime < 0.05; }),
         '每把武器各自记录了出手时刻（渲染用来画出手余韵）');

  // ---- 8. 挤掉旧武器后槽位重排，轨道不会歪 ----
  var s208 = Game.Systems.createState('campaign', 'swordsman', 777007);
  var pl208 = s208.player;
  for (var i208 = 1; i208 < K.MAX_WEAPONS; i208++) pl208.weapons.push(Game.createWeapon('pistol', 1, i208));
  Game.Systems.normalizeSlots(pl208);
  assert(pl208.weapons.length === K.MAX_WEAPONS, '武器槽塞满');
  var oldest208 = pl208.weapons[0].defId;
  Game.Systems.applyChoice(s208, { kind: 'weapon', data: { weaponId: 'moon_sword' } });
  assert(pl208.weapons.length === K.MAX_WEAPONS, '槽位上限不变');
  assert(pl208.weapons.filter(function (w) { return w.defId === oldest208; }).length === 0,
         '最旧的武器被挤掉（' + oldest208 + '）');
  var slots208 = pl208.weapons.map(function (w) { return w.slot; }).join(',');
  assert(slots208 === '0,1,2,3,4,5', '挤掉后槽位重排成 0..' + (K.MAX_WEAPONS - 1) + '（' + slots208 + '）');
  // 重排后 6 把仍然互不重叠
  var pts208 = pl208.weapons.map(function (w) { return w.posAt(pl208); });
  var apart208 = true;
  for (var a208 = 0; a208 < pts208.length; a208++)
    for (var b208 = a208 + 1; b208 < pts208.length; b208++)
      if (Game.util.dist(pts208[a208].x, pts208[a208].y, pts208[b208].x, pts208[b208].y) < 40) apart208 = false;
  assert(apart208, '重排后 6 把武器仍然互不重叠');

  // ---- 9. 存档回环：槽位由数组下标重建，老存档（无 slot 字段）也不会歪 ----
  var s209 = Game.Systems.createState('campaign', 'swordsman', 777008);
  var pl209 = s209.player;
  pl209.weapons.push(Game.createWeapon('moon_sword', 3, 1));
  pl209.weapons.push(Game.createWeapon('jade_crossbow', 2, 2));
  Game.Systems.normalizeSlots(pl209);
  var ids209 = pl209.weapons.map(function (w) { return w.defId; }).join(',');
  var lvls209 = pl209.weapons.map(function (w) { return w.level; }).join(',');
  var obj209 = Game.Systems.serialize(s209);
  var gotSlots = obj209.player.weapons.filter(function (w) { return 'slot' in w; }).length;
  assert(gotSlots === 0, '存档里不写 slot（下标就是唯一可信来源）');
  var s209b = Game.Systems.deserialize(obj209);
  var got209 = s209b.player.weapons.map(function (w) { return w.slot; }).join(',');
  assert(got209 === '0,1,2', '存档回环后槽位按数组下标重建（' + got209 + '）');
  assert(s209b.player.weapons.map(function (w) { return w.defId; }).join(',') === ids209,
         '武器顺序不变（' + ids209 + '）');
  assert(s209b.player.weapons.map(function (w) { return w.level; }).join(',') === lvls209,
         '武器等级不变（' + lvls209 + '）');

  // ---- 10. 面板如实显示系数，分解式对得上 ----
  var s210x = Game.Systems.createState('campaign', 'archer', 777009);
  var w210a = Game.createWeapon('pistol', 1, 0);
  var w210b = Game.createWeapon('iron_sword', 1, 1);
  s210x.player.weapons = [w210a, w210b];
  var html210 = Game.UI.renderStatsHTML(s210x);
  assert(html210.indexOf('× 远程 0.6') >= 0, '面板写出远程系数（本体 10 × 远程 0.6 才等于压过之后的伤害）');
  assert(html210.indexOf('射程 82.5') >= 0, '面板显示近战有效射程（已含 ×1.25，不是表上的 66）');
  assert(html210.indexOf('>' + w210a.damage(s210x.player).toFixed(2) + '<') >= 0,
         '远程伤害栏的数字等于 WeaponInstance.damage() 算出的实际值');
  assert(html210.indexOf('>' + w210b.damage(s210x.player).toFixed(2) + '<') >= 0,
         '近战伤害栏的数字等于 WeaponInstance.damage()，不受远程系数影响');

  // ---- 11. 渲染：每把武器画出自己的卫星，且不崩 ----
  var s211 = Game.Systems.createState('campaign', 'swordsman', 777010);
  var pl211 = s211.player;
  pl211.weapons.push(Game.createWeapon('moon_sword', 2, 1));
  pl211.weapons.push(Game.createWeapon('jade_crossbow', 3, 2));
  Game.Systems.normalizeSlots(pl211);
  assert(typeof Game.Renderer._drawOrbitWeapons === 'function', '渲染器有环绕武器绘制入口');
  pl211.weapons.forEach(function (w) {
    w.update(0.016, pl211, s211);   // 让逻辑先算好本帧位置
    w.swingTime = 1;                // 移出挥砍余韵窗口，光晕半径固定为 11 便于断言
  });
  var ctx211 = Game.Renderer.ctx;
  var arcs211 = [];
  var origArc211 = ctx211.arc;
  ctx211.arc = function () { arcs211.push([].slice.call(arguments)); };
  Game.Renderer.render(s211, 0.016);
  ctx211.arc = origArc211;
  // ⚠ 卫星必须画在「玩家局部坐标」里：_drawPlayer 已经 ctx.translate(p.x, p.y)，
  // 原点就是玩家中心。画绝对坐标 w.x/w.y 会把卫星搬到世界坐标「玩家 + 武器」，
  // 飞到镜头外 —— 真机上只剩刀光特效、看不到武器，读成「攻击延迟」。
  var satRings211 = arcs211.filter(function (a) {
    if (Math.abs(a[2] - 11) > 0.5) return false;
    for (var q211 = 0; q211 < pl211.weapons.length; q211++) {
      var wq = pl211.weapons[q211];
      var lx = wq.x - pl211.x, ly = wq.y - pl211.y;
      if (Math.abs(a[0] - lx) < 1 && Math.abs(a[1] - ly) < 1) return true;
    }
    return false;
  });
  assert(satRings211.length === pl211.weapons.length,
         '每把环绕武器都画出了自己的光晕圈（' + satRings211.length + ' 圈 / ' +
         pl211.weapons.length + ' 把武器）');
  var onOrbit211 = satRings211.length === pl211.weapons.length &&
    satRings211.every(function (a) {
      return Math.abs(Math.sqrt(a[0] * a[0] + a[1] * a[1]) - K.WEAPON_ORBIT_R) < 1;
    });
  assert(onOrbit211, '卫星画在距玩家中心 ' + K.WEAPON_ORBIT_R +
         ' 的局部坐标上（画成绝对坐标会飞到镜头外，只剩特效）');
  // 不能退化成「画在玩家身上」：至少一把卫星离原点有明显距离
  assert(satRings211.some(function (a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1]) > K.WEAPON_ORBIT_R * 0.9;
  }), '卫星确实挂在轨道上，不是叠在玩家身上');

  // 朝向：剑尖/箭头必须沿径向朝外（剑柄朝玩家），近战远程都一样。
  // 追变换矩阵把「武器局部空间的上」映射到世界方向再断言 —— 只盯 rotate 的角度值
  // 得先理解「武器在局部空间朝哪」才作数，断言写反会顺着 bug 一起变绿。
  // 卫星笔画的唯一特征是 scale 0.62（玩家身体与怪物都是 1.0），拿它筛。
  var mx211 = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  var stk211 = [];
  var fills211 = [];
  var tr211 = function (n) {
    mx211 = {
      a: mx211.a * n.a + mx211.c * n.b, b: mx211.b * n.a + mx211.d * n.b,
      c: mx211.a * n.c + mx211.c * n.d, d: mx211.b * n.c + mx211.d * n.d,
      e: mx211.a * n.e + mx211.c * n.f + mx211.e,
      f: mx211.b * n.e + mx211.d * n.f + mx211.f,
    };
  };
  var o211 = {};
  ['save', 'restore', 'translate', 'rotate', 'scale', 'fill'].forEach(function (m) {
    o211[m] = ctx211[m];
  });
  ctx211.save = function () {
    stk211.push({ a: mx211.a, b: mx211.b, c: mx211.c, d: mx211.d, e: mx211.e, f: mx211.f });
  };
  ctx211.restore = function () { if (stk211.length) mx211 = stk211.pop(); };
  ctx211.translate = function (x, y) { tr211({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); };
  ctx211.rotate = function (t) {
    tr211({ a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t), e: 0, f: 0 });
  };
  ctx211.scale = function (x, y) { tr211({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); };
  ctx211.fill = function () {
    fills211.push({ a: mx211.a, b: mx211.b, c: mx211.c, d: mx211.d });
  };
  Game.Renderer.render(s211, 0.016);
  ['save', 'restore', 'translate', 'rotate', 'scale', 'fill'].forEach(function (m) {
    ctx211[m] = o211[m];
  });
  // 局部 (0,-1)（剑尖/箭头那一端）经矩阵后的世界方向 = (−c, −d)
  var orbitFills211 = fills211.filter(function (f) {
    return Math.abs(Math.sqrt(f.a * f.a + f.c * f.c) - 0.62) < 0.01;
  });
  assert(orbitFills211.length >= pl211.weapons.length,
         '3 把卫星武器的本体笔画都被采到（' + orbitFills211.length + ' 笔 / ' +
         pl211.weapons.length + ' 把）');
  var facingIn211 = [];
  orbitFills211.forEach(function (f) {
    var dx = -f.c, dy = -f.d;
    var dl = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= dl; dy /= dl;
    var match = pl211.weapons.some(function (w) {
      return Math.abs(dx - Math.cos(w.aimAngle)) < 0.02 && Math.abs(dy - Math.sin(w.aimAngle)) < 0.02;
    });
    if (!match) facingIn211.push('(' + dx.toFixed(2) + ', ' + dy.toFixed(2) + ')');
  });
  assert(facingIn211.length === 0,
         '卫星武器沿径向朝外、柄端朝玩家（有 ' + facingIn211.length +
         ' 处背离：' + (facingIn211.join(' ') || '无') + '）');

  // 没跑过 update 的武器没有位置，卫星要跳过而不是画半截
  var s212 = Game.Systems.createState('campaign', 'swordsman', 777011);
  s212.enemies.length = 0; s212.projectiles.length = 0;
  Game.Renderer.render(s212, 0.016);
  assert(true, '武器还没算过位置时渲染无异常（卫星跳过）');

  // ---- 12. 刀光和真实命中范围要对得上：同圆心（玩家）、同扇形宽 ----
  var slash213 = null;
  var origSlash213 = Game.FX.slash;
  Game.FX.slash = function (x, y, angle, range, color, arc) {
    slash213 = { x: x, y: y, angle: angle, range: range, color: color, arc: arc };
  };
  var s213 = Game.Systems.createState('campaign', 'swordsman', 777012);
  var pl213 = s213.player;
  pl213.weapons.push(Game.createWeapon('moon_sword', 1, 1));
  Game.Systems.normalizeSlots(pl213);
  s213.enemies.length = 0;
  var wm213 = pl213.weapons[1];
  s213.enemies.push(atWeapon(wm213, pl213, 40, 'zombie', 1));
  wm213.cooldownRemaining = 0;
  wm213.update(0.016, pl213, s213);
  Game.FX.slash = origSlash213;
  assert(slash213 && Math.abs(slash213.arc - Math.PI) < 1e-9,
         '刀光扇形 = 360°/武器数（2 把各 180°），不是表里那个已作废的 arc 字段');
  assert(slash213 &&
         Math.abs(slash213.range - Game.WEAPONS.moon_sword.range * K.MELEE_RANGE_SCALE) < 1e-9,
         '刀光半径用有效射程（已含 ×' + K.MELEE_RANGE_SCALE + '）');
  // 刀光从玩家身上发出 —— 索敌圆心是玩家，特效必须和真实命中范围同圆心，
  // 否则又是一次「特效和武器对不上」：卫星只是「这块扇形归我」的标记。
  assert(slash213 &&
         Math.abs(slash213.x - pl213.x) < 0.001 && Math.abs(slash213.y - pl213.y) < 0.001,
         '刀光从玩家身上发出（索敌圆心是玩家，特效与命中范围同圆心）');
  // 固定朝外打：刀光朝向 = 剑身朝向 = 轨道径向，不再临时转向敌人
  assert(Math.abs(slash213.angle - wm213.aimAngle) < 1e-9,
         '刀光朝向 = 武器自己的朝外角度（和剑身同向，不临时转向敌人）');
  assert(Math.abs(wm213.aimAngle - Game.util.angleTo(pl213.x, pl213.y, wm213.x, wm213.y)) < 1e-6,
         '武器 aimAngle 是「玩家指向武器」的朝外方向（剑身与刀光都沿它）');

  // 没出手的武器也照样朝外站好：朝向只由轨道决定，不记出手方向
  var s214 = Game.Systems.createState('campaign', 'swordsman', 777013);
  var pl214 = s214.player;
  s214.enemies.length = 0;
  var w214 = pl214.weapons[0];
  var swings214 = 0;
  Game.FX.slash = function () { swings214++; };
  w214.update(0.016, pl214, s214);   // 无敌人，不出手
  Game.FX.slash = origSlash213;
  assert(Math.abs(w214.aimAngle - Game.util.angleTo(pl214.x, pl214.y, w214.x, w214.y)) < 1e-6,
         '没出手的武器朝向仍由轨道决定（恒定朝外，不再记录出手朝向）');
  assert(w214.swingTime > 0 && swings214 === 0,
         '扇形里没有敌人就空转：只累积余韵计时，不挥砍');

  // ---- 13. 远程朝目标出膛，不沿径向固定往外打 ----
  // 目标是扇形里离玩家最近的敌人，可能落在内环（布置圈之内）。固定朝外的话
  // 子弹会从敌人背后飞走，所以远程单独朝目标算角度。
  var s215 = Game.Systems.createState('campaign', 'swordsman', 777014);
  var pl215 = s215.player;
  s215.enemies.length = 0; s215.projectiles.length = 0;
  pl215.weapons.length = 0;   // 只留一把远程，排除副武器干扰
  pl215.weapons.push(Game.createWeapon('pistol', 1, 0));
  Game.Systems.normalizeSlots(pl215);
  var wp215 = pl215.weapons[0];
  var pw215 = wp215.posAt(pl215);
  var pa215 = pw215.a;                       // 武器的固定角
  var ea215 = pa215 + 60 * Math.PI / 180;    // 目标摆在它的 90° 半角内
  var e215 = new Game.Enemy('zombie', pl215.x + Math.cos(ea215) * 40,
                            pl215.y + Math.sin(ea215) * 40, 1);
  e215.hp = 1e9;
  s215.enemies.push(e215);
  wp215.cooldownRemaining = 0;
  wp215.update(0.016, pl215, s215);
  var bp215 = s215.projectiles[0];
  assert(bp215, '远程武器朝内环目标出了一发子弹（' + s215.projectiles.length + ' 发）');
  var bvx = bp215.vx, bvy = bp215.vy;
  var bl215 = Math.sqrt(bvx * bvx + bvy * bvy) || 1;
  var toTgt215 = Game.util.angleTo(wp215.x, wp215.y, e215.x, e215.y);
  var dot215 = (bvx / bl215) * Math.cos(toTgt215) + (bvy / bl215) * Math.sin(toTgt215);
  assert(Math.abs(dot215 - 1) < 1e-6,
         '远程朝目标出膛（与目标方向的点积 1.00，实得 ' + dot215.toFixed(4) + '）');
  // 自检：这条断言不是空断言 —— 换成「沿径向朝外」的旧行为，速度向量对不上 1
  var outDot215 = (bvx / bl215) * Math.cos(pa215) + (bvy / bl215) * Math.sin(pa215);
  assert(Math.abs(outDot215 - 1) > 0.1,
         '（自检）「沿径向朝外」的旧行为在这里对不上（点积 ' + outDot215.toFixed(4) +
         '，与 1 差 ' + (1 - outDot215).toFixed(4) + '）');
  // 出膛点离武器的距离要等于 player.radius + 6 —— 太近会卡在枪口里，太远有肉眼可见的延迟
  var mx215 = bp215.x - wp215.x, my215 = bp215.y - wp215.y;
  assert(Math.abs(Math.sqrt(mx215 * mx215 + my215 * my215) - (pl215.radius + 6)) < 0.01,
         '子弹从武器前方 player.radius+6 处出膛（' +
         Math.sqrt(mx215 * mx215 + my215 * my215).toFixed(1) + '）');
} catch (e) {
  assert(false, '环绕武器/调参异常: ' + e.stack);
}

/* ---------------- 汇总 ---------------- */
console.log('\n================ 测试结果 ================');
console.log('通过: ' + passed + '  失败: ' + failed);
process.exit(failed > 0 ? 1 : 0);
