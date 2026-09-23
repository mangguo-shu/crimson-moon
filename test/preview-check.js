/* ============================================================
 * test/preview-check.js —— 校验 preview.html 的构造逻辑
 * preview.html 里的内联脚本无法被 smoke.js 覆盖，这里用同一套
 * DOM/Canvas stub 复现它的对象构造 + 渲染调用，确保预览页不报错。
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
global.innerHeight = 720;
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
  R.view = { w: 1280, h: 720, scale: 1, dpr: 2 };
  R.camera.x = 300; R.camera.y = 260;
  const CX = R.camera.x, CY = R.camera.y;
  assert(R.view.w === 1280 && R.view.h === 720, '固定 1280x720 逻辑视口');

  function mkPlayer(lx, ly, opts) {
    const p = new Game.Player('swordsman');
    p.x = CX + lx; p.y = CY + ly;
    p.facing = -Math.PI / 2;
    p.weapons = [new Game.WeaponInstance('iron_sword', 1)];
    for (const k in (opts || {})) p[k] = opts[k];
    return p;
  }

  const playerIdle = mkPlayer(150, 150, { moving: false });
  const playerWalk = mkPlayer(400, 150, { moving: true, walkTime: 0 });
  const playerHurt = mkPlayer(650, 150, { moving: false, hitFlashTimer: 0.2 });
  assert(playerIdle.weapons[0].def.color !== undefined, '玩家持铁剑（取 def.color 供绘制）');

  const enemies = [
    new Game.Enemy('zombie', CX + 150, CY + 400, 1),
    new Game.Enemy('bat',    CX + 400, CY + 400, 1),
    new Game.Enemy('wizard', CX + 650, CY + 400, 1),
    new Game.Enemy('boss',   CX + 950, CY + 400, 1),
  ];
  enemies[0].hp = enemies[0].maxHp * 0.55;
  enemies[1].hp = enemies[1].maxHp * 0.35;
  enemies[2].hp = enemies[2].maxHp * 0.7;
  for (const e of enemies) e.facing = -Math.PI / 2;
  assert(enemies.length === 4, '四种怪物构造成功');

  const projectiles = [
    new Game.Projectile({ x: CX + 150, y: CY + 620, vx: 100, vy: 0, radius: 6,
      damage: 5, fromPlayer: true, color: '#ffd76e', type: 'bullet' }),
    new Game.Projectile({ x: CX + 400, y: CY + 620, vx: 100, vy: 0, radius: 7,
      damage: 5, fromPlayer: false, color: '#c48aff', type: 'spell' }),
  ];
  projectiles[0].angle = 0;

  const pickups = [
    new Game.Pickup('xp', 3, CX + 650, CY + 620),
    new Game.Pickup('material', 2, CX + 900, CY + 620),
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
  const w = ctx.measureText('主角 · 待机（呼吸）').width + 16;
  assert(typeof w === 'number' && w > 0, 'measureText 可用（标签底框宽度）');

  // 三种玩家状态各渲染（含受击闪白 / 行走 / 待机呼吸分支）
  state.player = playerIdle; R.render(state, 0.016);
  state.player = playerWalk; playerWalk.walkTime = 0.6; R.render(state, 0.016);
  state.player = playerHurt; R.render(state, 0.016);
  state.player = playerIdle;
  assert(true, '主角 待机/行走/受击闪白 三态渲染无异常');

  // 连续帧（推进粒子与特效）
  for (let i = 0; i < 10; i++) {
    playerWalk.walkTime += 0.016;
    for (const e of enemies) e.animTime += 0.016;
    for (const pk of pickups) pk.bob += 0.016 * 4;
    R.render(state, 0.016);
  }
  assert(true, '连续 10 帧渲染无异常');
  assert(!!R.ground && R.ground.width > 0, '地面纹理已生成（宽 ' + R.ground.width + '）');
} catch (e) {
  assert(false, '预览页构造异常: ' + e.stack);
}

console.log('\n================ 结果 ================');
console.log('通过: ' + passed + '  失败: ' + failed);
process.exit(failed > 0 ? 1 : 0);
