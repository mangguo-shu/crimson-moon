/* ============================================================
 * test/preview-check.js —— 校验 preview.html 的构造逻辑
 * preview.html 里的内联脚本无法被 smoke.js 覆盖，这里用同一套
 * DOM/Canvas stub 复现它的对象构造 + 渲染调用，确保预览页不报错。
 * 预览页改动后必须同步这里，否则校验的是一个已不存在的页面。
 *
 * 运行：node test/preview-check.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'js');
const ORDER = ['config.js', 'entities.js', 'weapons.js', 'renderer.js'];

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

/* ---------------- stub ---------------- */
function makeCtxStub() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 42 });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient;
      if (key === 'canvas') return null;
      if (typeof target[key] !== 'undefined') return target[key];
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function makeElement(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, children: [], innerHTML: '', textContent: '',
    width: 0, height: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {},
    getContext() { return makeCtxStub(); },
  };
}

const gameCanvas = makeElement('canvas');
global.window = global;
Object.defineProperty(global, 'navigator', { value: { maxTouchPoints: 0, userAgent: 'node' }, configurable: true });
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.innerWidth = 1280;
global.innerHeight = 1200;
Object.defineProperty(global, 'devicePixelRatio', { value: 2, configurable: true });
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.document = {
  hidden: false, readyState: 'complete',
  body: { appendChild() {} },
  getElementById(id) { return id === 'game' ? gameCanvas : makeElement('div'); },
  createElement(tag) { return makeElement(tag); },
  addEventListener() {},
};

/* ---------------- 加载模块 ---------------- */
console.log('== 加载预览页依赖 ==');
for (const f of ORDER) {
  try {
    vm.runInThisContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), { filename: f });
    console.log('  ✓ 加载 ' + f);
  } catch (e) {
    console.error('  ✗ 加载失败 ' + f + ': ' + e.stack);
    failed++;
  }
}

const Game = global.Game;
const R = Game.Renderer;

/* ---------------- 复现 preview.html 的构造逻辑 ---------------- */
console.log('\n== 预览页构造 ==');
try {
  R.init(gameCanvas);
  R.setQuality('high');
  const VIEW_W = 1280, VIEW_H = 1200;
  R.view = { w: VIEW_W, h: VIEW_H, scale: 1, dpr: 2 };
  R.camera.x = 300; R.camera.y = 260;
  const CX = R.camera.x, CY = R.camera.y;
  const UP = -Math.PI / 2, RIGHT = 0, DOWN = Math.PI / 2, LEFT = Math.PI;
  assert(R.view.w === 1280 && R.view.h === 1200, '固定 1280x1200 逻辑视口');

  function mkPlayer(lx, ly, opts) {
    const p = new Game.Player('swordsman');
    p.x = CX + lx; p.y = CY + ly;
    p.facing = UP;
    p.weapons = [new Game.WeaponInstance('iron_sword', 1)];
    for (const k in (opts || {})) p[k] = opts[k];
    return p;
  }
  function mkEnemy(type, lx, ly, facing, hpRatio) {
    const e = new Game.Enemy(type, CX + lx, CY + ly, 1);
    e.facing = facing;
    if (hpRatio !== undefined) e.hp = e.maxHp * hpRatio;
    return e;
  }

  // 第 1 行：主角三态
  const playerIdle = mkPlayer(150, 130, { moving: false });
  const playerWalk = mkPlayer(400, 130, { moving: true, walkTime: 0 });
  const playerHurt = mkPlayer(650, 130, { moving: false, hitFlashTimer: 0.2 });
  assert(playerIdle.weapons[0].def.color !== undefined, '玩家持铁剑（取 def.color 供绘制）');

  // 第 2 行：四种怪物，朝向各不相同（覆盖镜像/不镜像两种分支）
  const enemies = [
    mkEnemy('zombie', 150, 340, UP,    0.55),
    mkEnemy('bat',    400, 340, RIGHT, 0.35),
    mkEnemy('wizard', 650, 340, LEFT,  0.70),
    mkEnemy('boss',   950, 340, DOWN,  undefined),
  ];
  assert(enemies.length === 4, '四种怪物构造成功（含朝左/朝右的镜像对照）');

  // 第 3、4 行：攻击动作演示
  const demos = [];
  function addDemo(ent, kind) {
    ent.playAttack(kind);
    demos.push({ e: ent, kind: kind });
    return ent;
  }
  const atkMelee  = addDemo(mkPlayer(150, 620, { facing: RIGHT }), 'melee');
  const atkRanged = addDemo(mkPlayer(400, 620, { facing: LEFT }),  'ranged');
  const demos3 = [
    addDemo(mkEnemy('zombie', 700, 620, RIGHT, 0.5), 'lunge'),
    addDemo(mkEnemy('bat',    950, 620, LEFT,  0.5), 'dive'),
  ];
  const demos4 = [
    addDemo(mkEnemy('wizard', 250, 880, UP, 0.6), 'cast'),
    addDemo(mkEnemy('boss',   780, 880, UP, undefined), 'boss'),
  ];
  const demoEnemies = demos3.concat(demos4);
  assert(demos.length === 6, '六种攻击演示全部挂载（2 主角 + 4 怪物）');
  assert(demoEnemies.length === 4, '怪物攻击演示分组正确');

  // 第 5 行：掉落物与投射物
  const projectiles = [
    new Game.Projectile({ x: CX + 700, y: CY + 1100, vx: 100, vy: 0, radius: 6,
      damage: 5, fromPlayer: true, color: '#ffd76e', type: 'bullet' }),
    new Game.Projectile({ x: CX + 950, y: CY + 1100, vx: 100, vy: 0, radius: 7,
      damage: 5, fromPlayer: false, color: '#c48aff', type: 'spell' }),
  ];
  projectiles[0].angle = 0;

  const pickups = [
    new Game.Pickup('xp', 3, CX + 200, CY + 1100),
    new Game.Pickup('material', 2, CX + 400, CY + 1100),
  ];

  const state = {
    player: playerIdle, enemies: enemies, projectiles: projectiles,
    pickups: pickups, elapsed: 0, screen: 'PLAYING',
  };

  // 标签绘制（preview.html 用 measureText / fillRect / fillText）
  const ctx = R.ctx;
  ctx.font = '600 15px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText('主角 · 下劈（近战）').width + 16;
  assert(typeof w === 'number' && w > 0, 'measureText 可用（标签底框宽度）');

  // 三种玩家状态各渲染（含受击闪白 / 行走 / 待机呼吸分支）
  state.player = playerIdle; R.render(state, 0.016);
  state.player = playerWalk; playerWalk.walkTime = 0.6; R.render(state, 0.016);
  state.player = playerHurt; R.render(state, 0.016);
  state.player = playerIdle;
  assert(true, '主角 待机/行走/受击闪白 三态渲染无异常');

  // 补画演示主角（preview.html 的 drawExtraPlayer）
  function drawExtraPlayer(p) {
    ctx.save();
    ctx.translate(-R.camera.x, -R.camera.y);
    ctx.fillStyle = 'rgba(48,36,24,0.22)';
    R._ellipse(ctx, p.x, p.y + 12, 14, 5); // 与 renderer 的 FOOT_Y.player 对齐
    R._drawPlayer(ctx, p);
    ctx.restore();
  }

  // 连续帧（推进粒子、特效与攻击动作循环重播）
  for (let i = 0; i < 40; i++) {
    playerWalk.walkTime += 0.016;
    for (const e of enemies) e.animTime += 0.016;
    for (const e of demoEnemies) e.animTime += 0.016;
    for (const pk of pickups) pk.bob += 0.016 * 4;
    for (const D of demos) {
      D.e.tickAttackAnim(0.016);
      if (!D.e.attackAnim) D.e.playAttack(D.kind);
    }
    R.render(state, 0.016);
    drawExtraPlayer(atkMelee);
    drawExtraPlayer(atkRanged);
  }
  assert(true, '连续 40 帧渲染 + 攻击动作循环重播无异常');
  assert(demos.every(D => D.e.attackAnim !== null), '攻击动作演示持续重播（无中断）');
  assert(!!R.ground && R.ground.width > 0, '地面纹理已生成（宽 ' + R.ground.width + '）');
} catch (e) {
  assert(false, '预览页构造异常: ' + e.stack);
}

console.log('\n================ 结果 ================');
console.log('通过: ' + passed + '  失败: ' + failed);
process.exit(failed > 0 ? 1 : 0);
