/* ============================================================
 * renderer.js —— 渲染层 + 特效门面（Game.FX）
 * 职责：
 *  - 画布缩放（逻辑高固定 720，宽度随屏幕比例扩展，无黑边无拉伸）
 *  - 相机跟随
 *  - 程序化地面（赤月荒原）
 *  - 分层绘制：地面 → 阴影 → 掉落 → 敌人 → 玩家 → 投射物 → 粒子/特效
 *  - 粒子系统（按画质档位限流）、屏幕震动、闪光、暗角、光晕
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;
  var util = Game.util;
  var CONST = Game.CONST;

  /* ---------------- 国风绘制基建 ---------------- */
  var PAL = Game.PALETTE;
  var OUT = PAL.outline;        // 统一赛璐璐描边色
  var TAU = Math.PI * 2;

  /**
   * 填充 + 可选描边（赛璐璐/动漫轮廓）。
   * 调用前需已 beginPath 并画好路径。
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} fill 填充色（falsy 则只描边）
   * @param {boolean} on  是否描边（低画质关闭以省性能）
   * @param {number} [w]  描边宽度
   */
  function fs(ctx, fill, on, w) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (on) { ctx.strokeStyle = OUT; ctx.lineWidth = w || 1.6; ctx.stroke(); }
  }

  /**
   * 直立化变换：取代原来的整体旋转。
   *
   * 旧做法是 ctx.rotate(facing + PI/2)，角色会跟着朝向整个转过去 ——
   * 向右走时人就是「横躺着」的，既不像站着，影子也对不上脚。
   * 现在改为：永远直立，用左右镜像表达朝向，再绕脚底做一点轻微倾斜，
   * 保留「正朝那边」的动感。朝向数据本身（索敌/挥砍/弹道）完全不受影响。
   *
   * 必须在 ctx.translate(实体位置) 之后调用。
   *
   * @param {number} facing 朝向弧度
   * @param {number} footY  脚底在局部坐标的 y（绕它旋转，保证脚不离开影子）
   * @param {number} [maxLean] 最大倾斜弧度
   * @returns {number} dirX：水平朝向分量（-1 左 / 0 正上正下 / 1 右）
   */
  function upright(ctx, facing, footY, maxLean) {
    var dirX = Math.cos(facing);
    if (dirX < 0) ctx.scale(-1, 1);          // 左右镜像
    var lean = (maxLean === undefined ? 0.12 : maxLean) * Math.abs(dirX);
    if (lean > 0.001) {
      ctx.translate(0, footY);
      ctx.rotate(lean);                       // 镜像后恒为正 = 恒向面朝方向倾
      ctx.translate(0, -footY);
    }
    return dirX;
  }

  /**
   * 脚底在局部坐标的 y —— 直立化的倾斜支点。
   * 影子落点 (_drawShadows) 也从这里取，保证「脚踩在影子上」只有一处事实来源：
   * 早先两边各写各的（影子按 radius*0.6 推），年兽因此浮在影子上面近 15px。
   */
  var FOOT_Y = { player: 12, zombie: 13, bat: 6, wizard: 14, boss: 40,
                 golem: 19, bulwark: 18, bruiser: 16 };
  var FOOT_Y_DEFAULT = 10;

  /**
   * 攻击动作进度。返回 0→1；当前没有攻击动作时返回 -1，
   * 调用方用 `u >= 0` 判断「是否正在出手」。
   */
  function atkU(e) {
    var a = e.attackAnim;
    if (!a) return -1;
    var u = a.t / a.dur;
    return u < 0 ? 0 : (u > 1 ? 1 : u);
  }

  /** 出手脉冲：0 → 1 → 0，用于「前扑/俯冲/拍击」这类一进一出的动作 */
  function pulse(u, k) {
    if (u < 0) return 0;
    return Math.sin(Math.PI * Math.min(1, u * (k || 1.35)));
  }

  var R = {
    canvas: null, ctx: null,
    view: { w: CONST.LOGICAL_W, h: CONST.LOGICAL_H, scale: 1, dpr: 1 },
    camera: { x: 0, y: 0 },
    quality: 'high',            // low / mid / high
    outline: true,              // 赛璐璐描边开关（低画质自动关闭）
    particleCap: CONST.PARTICLE_HIGH,
    particles: [],              // 粒子数组（对象复用）
    effects: [],                // 世界空间特效（刀光/冲击波/枪口）
    shake: 0,
    flashTimer: 0, flashColor: '#fff', flashAlpha: 0.5,
    ground: null,               // 离屏地面纹理
  };

  /* 画质档位 → 粒子上限 */
  var CAPS = { low: CONST.PARTICLE_LOW, mid: CONST.PARTICLE_MID, high: CONST.PARTICLE_HIGH };

  /* ---------------- 初始化 ---------------- */
  R.init = function (canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ground = this._generateGround();
    this._resize();
    var self = this;
    window.addEventListener('resize', function () { self._resize(); });
    console.log('[Renderer] 初始化完成 view=' + Math.round(this.view.w) + 'x' + this.view.h);
  };

  R.setQuality = function (q) {
    this.quality = (CAPS[q] !== undefined) ? q : 'high';
    this.particleCap = CAPS[this.quality];
    this.outline = this.quality !== 'low'; // 低画质关描边（描边会翻倍绘制调用）
    console.log('[Renderer] 画质=' + this.quality + ' 粒子上限=' + this.particleCap + ' 描边=' + this.outline);
  };

  R._resize = function () {
    var sw = window.innerWidth, sh = window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    // 逻辑高固定 720；scale = CSS 像素 / 逻辑单位
    var scale = sh / CONST.LOGICAL_H;
    var lw = sw / scale;
    this.view = { w: lw, h: CONST.LOGICAL_H, scale: scale, dpr: dpr };
    this.canvas.width = Math.round(sw * dpr);
    this.canvas.height = Math.round(sh * dpr);
    this.canvas.style.width = sw + 'px';
    this.canvas.style.height = sh + 'px';
  };

  // 客户端坐标 → 逻辑坐标（供 input 使用）
  Game.viewToLogical = function (cx, cy) {
    return { x: cx / R.view.scale, y: cy / R.view.scale };
  };

  /* ---------------- 相机 ---------------- */
  /* 右侧常驻人物面板挡住的可视宽度（逻辑单位）。ui.js 按面板实际宽度写入；
     相机把这块让出来，否则角色会走到面板底下、面板右边的敌人看不见。
     上限 40%：面板再宽也不该吃掉超过四成画面。 */
  R.sideInset = 0;
  R.setViewInset = function (cssPx) {
    var v = this.view;
    if (!v || !v.scale || cssPx <= 0) { this.sideInset = 0; return; }
    this.sideInset = Math.min(cssPx / v.scale, v.w * 0.4);
  };

  R.updateCamera = function (player) {
    var vw = this.view.w, vh = this.view.h;
    var vx = vw - (this.sideInset || 0);      // 面板左侧的可视宽
    var cx = player.x - vx / 2;               // 角色落在可视区中央
    var cy = player.y - vh / 2;
    if (CONST.WORLD_W > vx) cx = util.clamp(cx, 0, CONST.WORLD_W - vx);
    else cx = (CONST.WORLD_W - vx) / 2;
    if (CONST.WORLD_H > vh) cy = util.clamp(cy, 0, CONST.WORLD_H - vh);
    else cy = (CONST.WORLD_H - vh) / 2;
    this.camera.x = cx;
    this.camera.y = cy;
  };

  /* ---------------- 程序化地面：青砖庭院 ---------------- */
  R._generateGround = function () {
    var rng = Game.mulberry32(Game.hashSeed('crimsonmoon_courtyard_v2'));
    // 半分辨率纹理，绘制时放大 2 倍（省内存；轻微柔化恰好贴合手绘感）
    var gw = CONST.WORLD_W / 2, gh = CONST.WORLD_H / 2;
    var c = document.createElement('canvas');
    c.width = gw; c.height = gh;
    var g = c.getContext('2d');

    // ---- 1) 基底：暖灰石色（明亮，非阴暗） ----
    var grad = g.createLinearGradient(0, 0, gw, gh);
    grad.addColorStop(0, PAL.stone2);
    grad.addColorStop(0.5, PAL.stone);
    grad.addColorStop(1, '#847c6b');
    g.fillStyle = grad;
    g.fillRect(0, 0, gw, gh);

    // ---- 2) 青砖铺装（错缝砖块 + 高光/暗部） ----
    var BW = 56, BH = 30;
    var rows = Math.ceil(gh / BH) + 1;
    for (var ry = 0; ry < rows; ry++) {
      var off = (ry % 2) * (BW / 2);
      for (var bx = -BW; bx < gw + BW; bx += BW) {
        var x = bx + off, y = ry * BH;
        var tone = util.rand(rng, -13, 13);
        g.fillStyle = 'rgb(' + Math.round(143 + tone) + ',' +
                                Math.round(135 + tone) + ',' +
                                Math.round(118 + tone) + ')';
        g.fillRect(x + 1, y + 1, BW - 2, BH - 2);
        // 砖面高光（左上）/ 暗部（右下），制造微立体
        g.fillStyle = 'rgba(255,250,235,0.10)';
        g.fillRect(x + 2, y + 2, BW - 4, 3);
        g.fillStyle = 'rgba(40,32,20,0.13)';
        g.fillRect(x + 2, y + BH - 5, BW - 4, 3);
      }
    }
    // 砖缝
    g.strokeStyle = 'rgba(70,62,48,0.5)';
    g.lineWidth = 2;
    for (var ry2 = 0; ry2 < rows; ry2++) {
      g.beginPath();
      g.moveTo(0, ry2 * BH);
      g.lineTo(gw, ry2 * BH);
      g.stroke();
    }

    // ---- 3) 苔藓斑块 ----
    for (var m = 0; m < 200; m++) {
      var mx = util.rand(rng, 0, gw), my = util.rand(rng, 0, gh);
      var mr = util.rand(rng, 5, 22);
      g.fillStyle = util.rand(rng, 0, 1) < 0.5 ? 'rgba(95,125,70,0.34)' : 'rgba(72,96,47,0.30)';
      g.beginPath();
      g.ellipse(mx, my, mr, mr * util.rand(rng, 0.45, 0.8), util.rand(rng, 0, Math.PI), 0, TAU);
      g.fill();
    }

    // ---- 4) 杂草簇 ----
    for (var k = 0; k < 260; k++) {
      var gx = util.rand(rng, 0, gw), gy = util.rand(rng, 0, gh);
      g.strokeStyle = util.rand(rng, 0, 1) < 0.5 ? 'rgba(110,150,80,0.55)' : 'rgba(80,115,58,0.5)';
      g.lineWidth = 1.2;
      for (var b = 0; b < 3; b++) {
        var ga = -Math.PI / 2 + util.rand(rng, -0.7, 0.7);
        var gl = util.rand(rng, 5, 11);
        g.beginPath();
        g.moveTo(gx, gy);
        g.lineTo(gx + Math.cos(ga) * gl, gy + Math.sin(ga) * gl);
        g.stroke();
      }
    }

    // ---- 5) 中式道具（半分辨率下描边收细，放大后似墨线晕染） ----
    var cx0 = gw / 2, cy0 = gh / 2;   // 玩家出生点，附近留空
    function spot(minR) {
      for (var t = 0; t < 40; t++) {
        var px = util.rand(rng, 80, gw - 80), py = util.rand(rng, 80, gh - 80);
        var ddx = px - cx0, ddy = py - cy0;
        if (ddx * ddx + ddy * ddy >= minR * minR) return { x: px, y: py };
      }
      return { x: util.rand(rng, 80, gw - 80), y: util.rand(rng, 80, gh - 80) };
    }

    // 木箱
    function crate(x, y, s) {
      g.save(); g.translate(x, y); g.rotate(util.rand(rng, -0.15, 0.15)); g.scale(s, s);
      g.fillStyle = 'rgba(30,22,14,0.20)';
      g.beginPath(); g.ellipse(2, 31, 34, 11, 0, 0, TAU); g.fill();
      g.beginPath(); g.rect(-30, -28, 60, 60);
      fs(g, PAL.wood, true, 2.4);
      g.strokeStyle = PAL.woodDark; g.lineWidth = 1.6;
      for (var i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo(-30, -28 + i * 15); g.lineTo(30, -28 + i * 15); g.stroke();
      }
      g.beginPath(); g.rect(-30, -28, 60, 7); fs(g, PAL.woodDark, true, 1.6);
      g.beginPath(); g.rect(-30, 25, 60, 7); fs(g, PAL.woodDark, true, 1.6);
      g.restore();
    }

    // 灯笼
    function lantern(x, y, s) {
      g.save(); g.translate(x, y); g.scale(s, s);
      g.fillStyle = 'rgba(30,22,14,0.20)';
      g.beginPath(); g.ellipse(2, 36, 20, 8, 0, 0, TAU); g.fill();
      g.beginPath(); g.ellipse(0, 0, 20, 26, 0, 0, TAU);
      fs(g, PAL.lantern, true, 2.4);
      g.strokeStyle = PAL.gold; g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(-18, 0); g.lineTo(18, 0); g.stroke();
      g.beginPath(); g.ellipse(0, 0, 9, 26, 0, 0, TAU); g.stroke();
      g.beginPath(); g.rect(-9, -31, 18, 6); fs(g, PAL.gold, true, 1.6);
      g.beginPath(); g.rect(-9, 25, 18, 6); fs(g, PAL.gold, true, 1.6);
      g.strokeStyle = PAL.gold; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 31); g.lineTo(0, 43); g.stroke();
      g.restore();
    }

    // 瓦檐（中式屋瓦一排）
    function roofTile(x, y, w) {
      g.save(); g.translate(x, y);
      var n = Math.max(2, Math.round(w / 20)), tw = w / n;
      for (var i = 0; i < n; i++) {
        var tx = -w / 2 + i * tw;
        g.beginPath();
        g.moveTo(tx, 0);
        g.lineTo(tx + tw, 0);
        g.lineTo(tx + tw, 14);
        g.arc(tx + tw / 2, 14, tw / 2, 0, Math.PI);
        g.closePath();
        fs(g, i % 2 ? '#565660' : PAL.tile, true, 1.8);
      }
      g.restore();
    }

    // 石灯笼
    function stoneLamp(x, y, s) {
      g.save(); g.translate(x, y); g.scale(s, s);
      g.fillStyle = 'rgba(30,22,14,0.20)';
      g.beginPath(); g.ellipse(0, 31, 22, 8, 0, 0, TAU); g.fill();
      g.beginPath(); g.rect(-8, 10, 16, 20); fs(g, '#8a8878', true, 2.2);
      g.beginPath(); g.rect(-14, -6, 28, 18); fs(g, '#8a8878', true, 2.2);
      g.beginPath(); g.moveTo(-20, -6); g.lineTo(0, -24); g.lineTo(20, -6); g.closePath();
      fs(g, '#6e6c5e', true, 2.2);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(255,215,110,0.8)';
      g.beginPath(); g.arc(0, 3, 5, 0, TAU); g.fill();
      g.restore();
      g.restore();
    }

    // 铜钱
    function coin(x, y, s) {
      g.save(); g.translate(x, y); g.rotate(util.rand(rng, 0, TAU)); g.scale(s, s);
      g.beginPath(); g.arc(0, 0, 9, 0, TAU); fs(g, '#d8a94a', true, 1.8);
      g.beginPath(); g.rect(-3, -3, 6, 6); fs(g, '#8a6a2a', true, 1.2);
      g.restore();
    }

    // 符纸
    function talisman(x, y, s) {
      g.save(); g.translate(x, y); g.rotate(util.rand(rng, -0.5, 0.5)); g.scale(s, s);
      g.beginPath(); g.rect(-7, -16, 14, 32); fs(g, PAL.paper, true, 1.8);
      g.strokeStyle = PAL.lantern; g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(0, -11); g.lineTo(0, 11); g.stroke();
      g.beginPath(); g.moveTo(-4, -5); g.lineTo(4, -5); g.stroke();
      g.beginPath(); g.moveTo(-4, 4); g.lineTo(4, 4); g.stroke();
      g.restore();
    }

    // 竹篱
    function fence(x, y, w) {
      g.save(); g.translate(x, y);
      g.strokeStyle = '#a8863f'; g.lineWidth = 3.4; g.lineCap = 'round';
      var n = Math.max(3, Math.round(w / 14));
      for (var i = 0; i <= n; i++) {
        var fx = -w / 2 + i * (w / n);
        g.beginPath(); g.moveTo(fx, -18); g.lineTo(fx, 18); g.stroke();
      }
      g.lineWidth = 2.6;
      g.beginPath(); g.moveTo(-w / 2, -8); g.lineTo(w / 2, -8); g.stroke();
      g.beginPath(); g.moveTo(-w / 2, 8); g.lineTo(w / 2, 8); g.stroke();
      g.restore();
    }

    var sp, i;
    for (i = 0; i < 8; i++) { sp = spot(150); crate(sp.x, sp.y, util.rand(rng, 0.75, 1.25)); }
    for (i = 0; i < 6; i++) { sp = spot(180); lantern(sp.x, sp.y, util.rand(rng, 0.7, 1.1)); }
    for (i = 0; i < 5; i++) { sp = spot(200); roofTile(sp.x, sp.y, util.rand(rng, 70, 130)); }
    for (i = 0; i < 5; i++) { sp = spot(160); stoneLamp(sp.x, sp.y, util.rand(rng, 0.8, 1.15)); }
    for (i = 0; i < 14; i++) { sp = spot(60); coin(sp.x, sp.y, util.rand(rng, 0.8, 1.3)); }
    for (i = 0; i < 10; i++) { sp = spot(60); talisman(sp.x, sp.y, util.rand(rng, 0.8, 1.2)); }
    for (i = 0; i < 5; i++) { sp = spot(220); fence(sp.x, sp.y, util.rand(rng, 90, 170)); }

    return c;
  };

  /* ---------------- 主渲染 ---------------- */
  R.render = function (state, dt) {
    var ctx = this.ctx;
    var v = this.view;
    // 每帧重设变换：逻辑单位 → 设备像素
    ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, 0, 0);

    // 清屏（暖褐色背景，非纯黑）
    ctx.fillStyle = PAL.sky;
    ctx.fillRect(0, 0, v.w, v.h);

    // 震动衰减
    if (this.shake > 0) this.shake *= Math.pow(0.001, dt);
    if (this.shake < 0.05) this.shake = 0;
    var shx = this.shake ? (Math.random() - 0.5) * this.shake * 2 : 0;
    var shy = this.shake ? (Math.random() - 0.5) * this.shake * 2 : 0;

    // 世界空间（相机 + 震动偏移）
    ctx.save();
    ctx.translate(-this.camera.x + shx, -this.camera.y + shy);

    this._drawGround(ctx);
    if (state) {
      // 阴影层
      this._drawShadows(state, ctx);
      // 掉落物
      for (var i = 0; i < state.pickups.length; i++) this._drawPickup(ctx, state.pickups[i]);
      // 敌人
      for (var e = 0; e < state.enemies.length; e++) this._drawEnemy(ctx, state.enemies[e]);
      // 玩家
      if (state.player && state.player.alive) this._drawPlayer(ctx, state.player);
      // 投射物
      for (var p = 0; p < state.projectiles.length; p++) this._drawProjectile(ctx, state.projectiles[p]);
    }
    // 世界空间特效（刀光/冲击波，含光晕）
    this._drawEffects(ctx, dt);
    // 粒子
    this._drawParticles(ctx, dt);

    ctx.restore();

    // 屏幕空间：暗角 + 闪光 + 摇杆
    if (state) this._drawVignette(ctx, state, dt);
    this._drawFlash(ctx, dt);
    if (Game.Input && Game.Input.touchMode) this._drawJoystick(ctx);

    // 更新粒子与特效（逻辑更新放这里即可）
    this._updateParticles(dt);
    this._updateEffects(dt);
  };

  R._drawGround = function (ctx) {
    var cam = this.camera, v = this.view;
    // 世界半分辨率纹理按 2 倍放大绘制可见区域
    var sx = Math.max(0, cam.x) / 2;
    var sy = Math.max(0, cam.y) / 2;
    var sw = Math.min(v.w, CONST.WORLD_W - Math.max(0, cam.x)) / 2;
    var sh = Math.min(v.h, CONST.WORLD_H - Math.max(0, cam.y)) / 2;
    if (sw > 0 && sh > 0) {
      ctx.drawImage(this.ground, sx, sy, sw, sh,
                    Math.max(0, cam.x), Math.max(0, cam.y), sw * 2, sh * 2);
    }
  };

  R._drawShadows = function (state, ctx) {
    // 暖色柔和投影（避免纯黑压暗画面）
    ctx.fillStyle = 'rgba(48,36,24,0.22)';
    var i;
    for (i = 0; i < state.enemies.length; i++) {
      var e = state.enemies[i];
      // 落点取脚底，与 _drawEnemy 的直立支点同源 —— 脚必须踩在影子上
      var fy = FOOT_Y[e.type] === undefined ? FOOT_Y_DEFAULT : FOOT_Y[e.type];
      this._ellipse(ctx, e.x, e.y + fy, e.radius * 0.9, e.radius * 0.35);
    }
    if (state.player && state.player.alive) {
      this._ellipse(ctx, state.player.x, state.player.y + FOOT_Y.player, 14, 5);
    }
  };

  /* ---------------- 玩家绘制（日漫 chibi + 国风服饰） ----------------
   * 四种职业姿态共用一套骨架：脚下光环 / 双腿 / 后臂 / 头骨与脸 / 无敌帧闪烁，
   * 每种姿态只覆盖三块：身体（袍或甲）、头饰（发髻、斗笠、光头、束发）、
   * 前臂与手持物（剑、弩、拳）。
   *
   * swordsman 这三块就是重构前的原始代码，逐行保留 —— 老角色的既有观感
   * 不随本次拆分漂移（test/smoke.js 的「8 方向直立」断言盯的就是它的头）。
   * 配色全部来自 char.colors，是数据驱动的；新增职业只加一段配置。 */

  // 共用的脸：动漫大眼（白底 + 深瞳 + 双高光）+ 眉 + 腮红。四种姿态共用。
  R._drawPlayerFace = function (ctx, c, breathe, tint, O) {
    var ey = -13.4 + breathe;
    ctx.beginPath(); ctx.ellipse(-3.4, ey, 2.3, 2.8, 0, 0, TAU);
    ctx.fillStyle = '#fbf7ee'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(3.4, ey, 2.3, 2.8, 0, 0, TAU);
    ctx.fillStyle = '#fbf7ee'; ctx.fill();
    ctx.fillStyle = '#2a2233';
    ctx.beginPath(); ctx.ellipse(-3.1, ey + 0.3, 1.7, 2.1, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(3.7, ey + 0.3, 1.7, 2.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-3.8, ey - 0.9, 0.75, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(3.0, ey - 0.9, 0.75, 0, TAU); ctx.fill();
    // 眉（位于发际线之下、眼睛之上）
    ctx.strokeStyle = tint(c.hair); ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-5.2, ey - 3.6); ctx.lineTo(-1.8, ey - 4.0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5.2, ey - 3.6); ctx.lineTo(1.8, ey - 4.0); ctx.stroke();
    // 腮红
    ctx.fillStyle = 'rgba(230,120,110,0.26)';
    ctx.beginPath(); ctx.ellipse(-6.3, ey + 2.7, 1.9, 1.2, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6.3, ey + 2.7, 1.9, 1.2, 0, 0, TAU); ctx.fill();
  };

  // 共用的头骨：脸形 → 头饰（各姿态覆盖）→ 脸。头发画在眼睛之前，止于发际线。
  R._drawPlayerHead = function (ctx, pose, c, headDX, headDY, breathe, tint, O) {
    ctx.save();
    ctx.translate(headDX, headDY);
    ctx.beginPath(); ctx.arc(0, -14 + breathe, 9.6, 0, TAU);
    fs(ctx, tint(c.skin), O, 1.8);
    pose.headwear(ctx, c, breathe, tint, O);
    this._drawPlayerFace(ctx, c, breathe, tint, O);
    ctx.restore();
  };

  // 四种职业姿态。torso / headwear / arms 三段签名统一：
  // (ctx, c, breathe, tint, O) —— arms 额外收 p 与 armAng。
  R._PLAYER_BODY = {
    /* ---- 剑客：交领长衫 + 发髻 + 铁剑（原始实现） ---- */
    swordsman: {
      torso: function (ctx, c, br, tint, O) {
        ctx.beginPath(); ctx.ellipse(0, br * 0.4, 9.2, 11.5, 0, 0, TAU);
        fs(ctx, tint(c.cloth), O, 1.8);
        // 交领（右衽）：两道斜襟合成 V 领
        ctx.strokeStyle = tint(c.cloth2); ctx.lineWidth = 3.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-4.5, -6.5); ctx.lineTo(0.5, 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(4.5, -6.5); ctx.lineTo(0.5, 0.5); ctx.stroke();
        // 腰带（朱红）
        ctx.beginPath(); ctx.rect(-8.6, 3, 17.2, 3.4);
        fs(ctx, tint(c.accent), O, 1.2);
        // 披风下摆
        ctx.beginPath();
        ctx.moveTo(-8, 1); ctx.lineTo(-11.5, 10); ctx.lineTo(-5, 9); ctx.closePath();
        fs(ctx, tint(c.cloth2), O, 1.3);
      },
      headwear: function (ctx, c, br, tint, O) {
        // 贴头骨的厚弧带：下缘止于发际线，避免压住眉眼
        ctx.beginPath();
        ctx.arc(0, -14 + br, 9.9, Math.PI * 1.15, Math.PI * 1.85);
        ctx.strokeStyle = tint(c.hair);
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.stroke();
        if (O) {
          // 弧带内外两侧描边，保持动漫轮廓
          ctx.strokeStyle = OUT; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(0, -14 + br, 13.4, Math.PI * 1.17, Math.PI * 1.83); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, -14 + br, 6.4, Math.PI * 1.17, Math.PI * 1.83); ctx.stroke();
        }
        // 刘海（额前碎发，尖端止于眉上，不遮眼）
        ctx.beginPath();
        ctx.moveTo(-7.6, -19.6 + br); ctx.lineTo(-3.6, -17.7 + br); ctx.lineTo(-1.0, -20.3 + br);
        ctx.closePath();
        fs(ctx, tint(c.hair), O, 1.1);
        ctx.beginPath();
        ctx.moveTo(-1.0, -20.3 + br); ctx.lineTo(2.2, -17.5 + br); ctx.lineTo(5.6, -19.9 + br);
        ctx.closePath();
        fs(ctx, tint(c.hair), O, 1.1);
        // 鬓发
        ctx.beginPath(); ctx.ellipse(-9.2, -12.5 + br, 2.4, 6, 0.2, 0, TAU);
        fs(ctx, tint(c.hair), O, 1.2);
        ctx.beginPath(); ctx.ellipse(9.2, -12.5 + br, 2.4, 6, -0.2, 0, TAU);
        fs(ctx, tint(c.hair), O, 1.2);
        // 发髻 + 朱红发带
        ctx.beginPath(); ctx.arc(0, -24 + br, 3.6, 0, TAU);
        fs(ctx, tint(c.hair), O, 1.3);
        ctx.beginPath(); ctx.rect(-4.2, -21.5 + br, 8.4, 1.9);
        fs(ctx, tint(c.accent), O, 1);
      },
      arms: function (ctx, p, c, armAng, tint, O) {
        // 前臂（徒手）：武器已改成环绕轨道的卫星，手上再画一把会和轨道上的
        // 那把重叠，画面读不出来 —— 用户 2026-09-25 明确点名去掉。
        // 手臂仍随攻击动作摆动，当作运功下劈的姿态。
        ctx.save();
        ctx.translate(3, -2); ctx.rotate(armAng); ctx.translate(-3, 2);
        ctx.strokeStyle = tint(c.skin); ctx.lineWidth = 3.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(3, -2); ctx.lineTo(6.5, -9); ctx.stroke();
        ctx.beginPath(); ctx.arc(6.8, -9.6, 2.2, 0, TAU);
        fs(ctx, tint(c.skin), O, 1.2);
        ctx.restore();
      },
    },

    /* ---- 弓手：束腰劲装 + 斗笠翎羽 + 弩 ---- */
    archer: {
      torso: function (ctx, c, br, tint, O) {
        ctx.beginPath(); ctx.ellipse(0, br * 0.4, 8.2, 10.8, 0, 0, TAU);
        fs(ctx, tint(c.cloth), O, 1.8);
        // 斜挎箭囊带
        ctx.strokeStyle = tint(c.accent); ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-7, -7); ctx.lineTo(7, 4); ctx.stroke();
        // 箭囊（身侧露出一角）
        ctx.beginPath(); ctx.rect(5, 0, 4.4, 8);
        fs(ctx, tint(c.accent), O, 1.2);
        // 腰封 + 短下摆
        ctx.beginPath(); ctx.rect(-8, 4, 16, 3);
        fs(ctx, tint(c.cloth2), O, 1.2);
        ctx.beginPath();
        ctx.moveTo(-8, 6.6); ctx.lineTo(-6.2, 11); ctx.lineTo(6.2, 11); ctx.lineTo(8, 6.6);
        ctx.closePath();
        fs(ctx, tint(c.cloth2), O, 1.3);
      },
      headwear: function (ctx, c, br, tint, O) {
        // 束发（后脑厚弧）
        ctx.beginPath();
        ctx.arc(0, -14 + br, 9.9, Math.PI * 1.15, Math.PI * 1.85);
        ctx.strokeStyle = tint(c.hair); ctx.lineWidth = 6.4; ctx.lineCap = 'round';
        ctx.stroke();
        // 束发带
        ctx.beginPath(); ctx.rect(-9.4, -18.2 + br, 18.8, 2.5);
        fs(ctx, tint(c.accent), O, 1.1);
        // 斗笠
        ctx.beginPath();
        ctx.moveTo(-15, -19.4 + br); ctx.quadraticCurveTo(0, -31 + br, 15, -19.4 + br);
        ctx.lineTo(11, -18 + br); ctx.quadraticCurveTo(0, -27.4 + br, -11, -18 + br);
        ctx.closePath();
        fs(ctx, PAL.wood, O, 1.4);
        ctx.strokeStyle = '#5c452c'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-12.4, -20.2 + br);
        ctx.quadraticCurveTo(0, -29.4 + br, 12.4, -20.2 + br); ctx.stroke();
        // 翎羽
        ctx.save();
        ctx.translate(10.5, -22.6 + br); ctx.rotate(-0.5);
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.quadraticCurveTo(3, -7, 1, -13);
        ctx.quadraticCurveTo(-2, -7, 0, 0);
        ctx.closePath();
        fs(ctx, PAL.paper, O, 1.1);
        ctx.restore();
      },
      arms: function (ctx, p, c, armAng, tint, O) {
        // 徒手：弩也挪到环绕轨道上去了，手上不再重复画一把
        ctx.save();
        ctx.translate(3, -2); ctx.rotate(armAng); ctx.translate(-3, 2);
        ctx.strokeStyle = tint(c.skin); ctx.lineWidth = 3.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(3, -2); ctx.lineTo(6.5, -9); ctx.stroke();
        ctx.beginPath(); ctx.arc(6.8, -9.6, 2.2, 0, TAU);
        fs(ctx, tint(c.skin), O, 1.2);
        ctx.restore();
      },
    },

    /* ---- 武僧：素色僧袍 + 念珠 + 光头戒疤 + 徒手出拳 ---- */
    monk: {
      torso: function (ctx, c, br, tint, O) {
        // 宽身僧袍（梯形，下摆外扩）
        ctx.beginPath();
        ctx.moveTo(-11, 12); ctx.lineTo(-8.4, -8); ctx.lineTo(8.4, -8); ctx.lineTo(11, 12);
        ctx.closePath();
        fs(ctx, tint(c.cloth), O, 1.8);
        // 交领
        ctx.strokeStyle = tint(c.cloth2); ctx.lineWidth = 2.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-4, -8); ctx.lineTo(0, -1); ctx.lineTo(4, -8); ctx.stroke();
        // 念珠（垂在胸前）
        ctx.strokeStyle = tint(c.accent); ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(-5, -4); ctx.quadraticCurveTo(0, 6, 5, -4); ctx.stroke();
        ctx.fillStyle = tint(c.accent);
        var beads = [[-4.6, -2], [-3, 1.4], [-1, 3.4], [1, 3.4], [3, 1.4], [4.6, -2]];
        for (var bi = 0; bi < beads.length; bi++) {
          ctx.beginPath(); ctx.arc(beads[bi][0], beads[bi][1], 0.9, 0, TAU); ctx.fill();
        }
        // 腰带
        ctx.beginPath(); ctx.rect(-10.6, 8, 21.2, 3);
        fs(ctx, tint(c.cloth2), O, 1.2);
      },
      headwear: function (ctx, c, br, tint, O) {
        // 光头体积高光
        ctx.beginPath(); ctx.ellipse(-3.2, -19.4 + br, 3.4, 1.7, -0.5, 0, TAU);
        ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.fill();
        // 戒疤（额上六点）
        ctx.fillStyle = tint(c.accent);
        var spots = [[-4.2, -18.8], [-1.4, -18.8], [1.4, -18.8], [4.2, -18.8],
                     [-2.8, -16.1], [2.8, -16.1]];
        for (var si = 0; si < spots.length; si++) {
          ctx.beginPath(); ctx.arc(spots[si][0], spots[si][1] + br, 0.75, 0, TAU); ctx.fill();
        }
        // 僧耳坠
        ctx.strokeStyle = tint(c.accent); ctx.lineWidth = 1; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-9.4, -12 + br); ctx.lineTo(-10.8, -7.6 + br); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(9.4, -12 + br); ctx.lineTo(10.8, -7.6 + br); ctx.stroke();
      },
      arms: function (ctx, p, c, armAng, tint, O) {
        // 徒手出拳：更粗的手臂 + 拳锋鎏金护腕
        ctx.save();
        ctx.translate(3, -2); ctx.rotate(armAng); ctx.translate(-3, 2);
        ctx.strokeStyle = tint(c.skin); ctx.lineWidth = 4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(3, -2); ctx.lineTo(6.5, -9); ctx.stroke();
        ctx.beginPath(); ctx.arc(6.8, -9.6, 2.9, 0, TAU);
        fs(ctx, tint(c.skin), O, 1.3);
        ctx.strokeStyle = tint(c.accent); ctx.lineWidth = 1.7;
        ctx.beginPath(); ctx.arc(6.8, -9.6, 4.1, -0.95, 0.95); ctx.stroke();
        ctx.restore();
      },
    },

    /* ---- 力士：重甲肩甲 + 束发额带 + 巨拳 ---- */
    brawler: {
      torso: function (ctx, c, br, tint, O) {
        ctx.beginPath(); ctx.ellipse(0, br * 0.4, 10.4, 11.6, 0, 0, TAU);
        fs(ctx, tint(c.cloth), O, 1.9);
        // 甲片横纹
        ctx.strokeStyle = tint(c.cloth2); ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(-7.4, -4.5); ctx.lineTo(7.4, -4.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-8.4, 0.6); ctx.lineTo(8.4, 0.6); ctx.stroke();
        // 兽皮带 + 铜扣
        ctx.beginPath(); ctx.rect(-10, 4, 20, 3.6);
        fs(ctx, tint(c.cloth2), O, 1.2);
        ctx.beginPath(); ctx.rect(-2.4, 3.4, 4.8, 4.8);
        fs(ctx, tint(c.accent), O, 1);
        // 肩甲（方块）
        ctx.beginPath(); ctx.rect(-14.4, -10, 8, 7);
        fs(ctx, tint(c.cloth2), O, 1.4);
        ctx.beginPath(); ctx.rect(6.4, -10, 8, 7);
        fs(ctx, tint(c.cloth2), O, 1.4);
      },
      headwear: function (ctx, c, br, tint, O) {
        // 两侧留发（顶心剃光，绑成发冠）
        ctx.beginPath();
        ctx.arc(0, -14 + br, 9.9, Math.PI * 1.2, Math.PI * 1.8);
        ctx.strokeStyle = tint(c.hair); ctx.lineWidth = 5.6; ctx.lineCap = 'round';
        ctx.stroke();
        // 额带
        ctx.beginPath(); ctx.rect(-9.8, -19.4 + br, 19.6, 2.7);
        fs(ctx, tint(c.accent), O, 1.1);
        // 发冠
        ctx.beginPath(); ctx.rect(-3.2, -26.4 + br, 6.4, 4.4);
        fs(ctx, tint(c.cloth2), O, 1.2);
        // 络腮胡
        ctx.strokeStyle = tint(c.hair); ctx.lineWidth = 1.7; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, -12 + br, 8.3, Math.PI * 0.22, Math.PI * 0.78); ctx.stroke();
      },
      arms: function (ctx, p, c, armAng, tint, O) {
        // 巨拳
        ctx.save();
        ctx.translate(3, -2); ctx.rotate(armAng); ctx.translate(-3, 2);
        ctx.strokeStyle = tint(c.skin); ctx.lineWidth = 4.8; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(3, -2); ctx.lineTo(6.4, -9); ctx.stroke();
        ctx.beginPath(); ctx.arc(6.8, -10, 4, 0, TAU);
        fs(ctx, tint(c.skin), O, 1.4);
        ctx.strokeStyle = tint(c.accent); ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.arc(6.8, -10, 5.3, -0.95, 0.95); ctx.stroke();
        ctx.restore();
      },
    },
  };

  R._drawPlayer = function (ctx, p) {
    var c = p.char.colors;
    var O = this.outline;
    var flash = p.hitFlashTimer > 0;
    var counterHit = p.counterFlash > 0;
    var now = performance.now();
    // 反伤闪色优先于受击白闪：青色是「被反弹」的专属信号，不跟普通受击混
    function tint(col) { return counterHit ? '#8fd0e8' : (flash ? '#ffffff' : col); }

    var pose = R._PLAYER_BODY[p.char.body] || R._PLAYER_BODY.swordsman;

    ctx.save();
    ctx.translate(p.x, p.y);

    // 脚下灵气光环（国风·云纹圈，脉动）
    if (this.quality !== 'low') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.30 + Math.sin(now * 0.003) * 0.10;
      ctx.strokeStyle = PAL.jade;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 9, 18, 7, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    // 反伤受击圈（青色向外扩散）：玩家被坦克反弹时的一眼提示
    if (counterHit) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, p.counterFlash / 0.3) * 0.7;
      ctx.strokeStyle = '#8fd0e8';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(0, 9, 22 + (0.3 - p.counterFlash) * 44, 9, 0, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    this._drawOrbitWeapons(ctx, p, now);

    // 直立化：不再随朝向整体旋转（旧做法会让角色「横躺」），改镜像 + 绕脚底微倾
    var dirX = upright(ctx, p.facing, FOOT_Y.player);

    var moving = p.moving;
    var sw = moving ? Math.sin(p.walkTime * 11) : 0;
    var breathe = moving ? 0 : Math.sin(now * 0.0022) * 0.6; // 待机呼吸

    // 头部随朝向微偏：做出「看向那边」的感觉（正上/正下时几乎不动）
    var headDX = dirX * 1.7;
    var headDY = -Math.sin(p.facing) * 1.1;

    // ---- 攻击动作（纯表现，不影响判定） ----
    var atk = p.attackAnim;
    var armAng = 0;      // 前臂 + 手持物：绕肩关节旋转
    var bodyKick = 0;    // 远程后坐：身体向后位移
    var swingLean = 0;   // 挥砍：整体前倾
    if (atk) {
      var u = atk.t / atk.dur;                 // 0 → 1
      if (atk.kind === 'melee') {
        // 0~0.35 抬剑蓄力（负 = 向后上抬）｜0.35~0.62 下劈｜0.62~1 收势
        if (u < 0.35) armAng = -1.2 * (u / 0.35);
        else if (u < 0.62) armAng = -1.2 + 2.6 * ((u - 0.35) / 0.27);
        else armAng = 1.4 * (1 - (u - 0.62) / 0.38);
        swingLean = armAng * 0.10;
      } else {
        // 远程：后坐快速衰减
        bodyKick = (1 - u) * 2.2;
        armAng = (1 - u) * -0.5;
      }
    }
    if (swingLean) {
      ctx.translate(0, 12); ctx.rotate(swingLean); ctx.translate(0, -12);
    }
    if (bodyKick) ctx.translate(-bodyKick, 0);

    // ---- 双腿（裤，行走摆动） ----
    ctx.beginPath(); ctx.ellipse(-4.2, 9 + sw * 3, 3.6, 5, 0, 0, TAU);
    fs(ctx, tint(c.cloth2), O, 1.5);
    ctx.beginPath(); ctx.ellipse(4.2, 9 - sw * 3, 3.6, 5, 0, 0, TAU);
    fs(ctx, tint(c.cloth2), O, 1.5);

    // ---- 后臂（广袖） ----
    ctx.strokeStyle = tint(c.cloth); ctx.lineWidth = 4.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-3, -1); ctx.lineTo(-8, 6 + sw * 1.5); ctx.stroke();

    // ---- 身体 / 前臂与手持物 / 头（按职业姿态覆盖） ----
    pose.torso(ctx, c, breathe, tint, O);
    pose.arms(ctx, p, c, armAng, tint, O);
    this._drawPlayerHead(ctx, pose, c, headDX, headDY, breathe, tint, O);

    ctx.restore();

    // 无敌帧闪烁
    if (p.invincibleTimer > 0) {
      ctx.save();
      ctx.globalAlpha = 0.25 + Math.sin(now * 0.04) * 0.2;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 4, 0, TAU); ctx.fill();
      ctx.restore();
    }
  };

  // 环绕武器卫星：多把武器挂在玩家身边的轨道上，各自出手。
  // 这是「我有多少把武器」在画面里的唯一证据 —— 不画出来，第二把武器就
  // 永远只等于「攻速快了一点」，玩家感知不到。位置直接取 WeaponInstance
  // 本帧算好的 x/y（weapons.js update 时写入），不在这边重算角度，
  // 逻辑在打哪边图标就一定在哪边。
  //
  // ⚠ 坐标系：本方法在 _drawPlayer 的 ctx.translate(p.x, p.y) 之后调用，
  // 原点已经是玩家中心，必须画局部坐标 (w.x - p.x)。直接画 w.x/w.y 会把卫星
  // 搬到世界坐标「玩家 + 武器」的位置，飞到镜头外 —— 玩家只看到刀光特效、
  // 看不到武器，于是读成「攻击延迟」。刀光走 FX 系统是绝对世界坐标，
  // 两者必须落在同一点。
  R._drawOrbitWeapons = function (ctx, p, now) {
    for (var i = 0; i < p.weapons.length; i++) {
      var w = p.weapons[i];
      if (w.x === undefined) continue;   // 首次 update 之前还没算过位置
      var x = w.x - p.x, y = w.y - p.y;  // 世界坐标 → 玩家局部坐标
      // 出手余韵：挥砍瞬间向外刷一道弧光，每把武器都有独立反馈
      var sw = (w.swingTime || 0);
      var swinging = sw >= 0 && sw < 0.22;
      // 剑身永远沿径向朝外，当作「这块扇形归我」的标记；武器固定在等分角上
      // 不转圈，所以不需要临时转向。真正索敌的圆心是玩家（见 weapons.js），
      // 刀光也因此画在玩家身上而不是这里。
      var rot = w.aimAngle;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.30 + Math.sin(now * 0.004 + i * 1.3) * 0.09;
      ctx.strokeStyle = w.def.color;
      ctx.lineWidth = swinging ? 4 : 2.2;
      ctx.beginPath(); ctx.arc(x, y, 11 + (swinging ? 4.5 : 0), 0, TAU); ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.translate(x, y);
      // 武器头朝外：剑尖/箭头在局部空间指 −y，要把它转到径向朝外方向 rot 上。
      // 局部 (0,-1) 经 rotate(θ) 后是 (sinθ, −cosθ)，要等于 (cos rot, sin rot)，
      // 解出 θ = rot + π/2 —— 写成 rot − π/2 会整整差 180°，剑尖指向玩家自己，
      // 用户 2026-09-25 真机指出「剑尖还是朝人物了，需要剑柄朝人物」。
      ctx.rotate(rot + Math.PI / 2);
      ctx.scale(0.62, 0.62);
      if (w.def.type === 'melee') this._drawSword(ctx, 0, 0, w.def.color);
      else this._drawCrossbow(ctx, 0, 0, w.def.color);
      ctx.restore();
      // 强化等级：一圈一圈，Lv1 光晕、Lv2 起每级多一圈
      if (w.level > 1) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = w.def.color;
        ctx.lineWidth = 1.1;
        for (var k = 1; k < w.level; k++) {
          ctx.beginPath(); ctx.arc(x, y, 15 + k * 3.4, 0, TAU); ctx.stroke();
        }
        ctx.restore();
      }
    }
  };

  R._drawSword = function (ctx, hx, hy, color) {
    var O = this.outline;
    ctx.save();
    ctx.translate(hx, hy);   // 已朝向 -y（前），剑尖向前
    // 剑柄（缠绳）
    ctx.beginPath(); ctx.rect(-1.3, -1, 2.6, 6);
    fs(ctx, '#4a3220', O, 1.2);
    // 护手（鎏金）
    ctx.beginPath(); ctx.rect(-4.2, -2.6, 8.4, 2.6);
    fs(ctx, PAL.gold, O, 1.1);
    // 剑身
    ctx.beginPath();
    ctx.moveTo(-2, -3); ctx.lineTo(0, -26); ctx.lineTo(2, -3); ctx.closePath();
    fs(ctx, color, O, 1.3);
    // 剑脊反光
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, -23); ctx.stroke();
    ctx.restore();
  };

  // 弩（弓手手持物）：横置弩身 + 弩弦 + 前指的箭
  R._drawCrossbow = function (ctx, hx, hy, color) {
    var O = this.outline;
    ctx.save();
    ctx.translate(hx, hy);
    // 弩身（横向）
    ctx.beginPath(); ctx.rect(-6.4, -1.4, 12.8, 2.8);
    fs(ctx, PAL.wood, O, 1.2);
    // 弩臂（上下两片弓片）
    ctx.strokeStyle = PAL.woodDark; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-5.4, -1.4); ctx.quadraticCurveTo(-7.6, -3.4, -5.8, -5.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-5.4, 1.4); ctx.quadraticCurveTo(-7.6, 3.4, -5.8, 5.6); ctx.stroke();
    // 弩弦
    ctx.strokeStyle = '#d8d0c0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-5.8, -5.2); ctx.lineTo(0, -1.2); ctx.lineTo(-5.8, 5.2); ctx.stroke();
    // 箭杆 + 箭头（前指 -y）
    ctx.beginPath(); ctx.rect(-0.8, -13, 1.6, 11);
    fs(ctx, color, O, 1);
    ctx.beginPath();
    ctx.moveTo(-2.4, -13); ctx.lineTo(0, -17.4); ctx.lineTo(2.4, -13);
    ctx.closePath();
    fs(ctx, color, O, 1);
    // 箭头反光
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(0, -15.6); ctx.lineTo(0, -13.4); ctx.stroke();
    ctx.restore();
  };
  /* ---------------- 敌人绘制（按类型程序化建模） ---------------- */
  R._drawEnemy = function (ctx, e) {
    var flash = e.hitFlash > 0;
    ctx.save();
    ctx.translate(e.x, e.y);
    // 直立：镜像 + 绕脚底微倾；支点与影子落点同源（见 FOOT_Y 注释）
    var fy = FOOT_Y[e.type] === undefined ? FOOT_Y_DEFAULT : FOOT_Y[e.type];
    upright(ctx, e.facing, fy);
    switch (e.type) {
      case 'zombie': this._drawZombie(ctx, e, flash); break;
      case 'bat': this._drawBat(ctx, e, flash); break;
      case 'wizard': this._drawWizard(ctx, e, flash); break;
      case 'boss': this._drawBoss(ctx, e, flash); break;
      case 'golem': this._drawGolem(ctx, e, flash); break;
      case 'bulwark': this._drawBulwark(ctx, e, flash); break;
      case 'bruiser': this._drawBruiser(ctx, e, flash); break;
      default: this._drawZombie(ctx, e, flash);
    }
    ctx.restore();

    // 血条（非 Boss 且未满血时显示）
    if (!e.isBoss && e.hp < e.maxHp) {
      var w = e.radius * 2;
      ctx.fillStyle = 'rgba(30,20,12,0.55)';
      ctx.fillRect(e.x - w / 2, e.y - e.radius - 10, w, 4);
      ctx.fillStyle = PAL.lantern;
      ctx.fillRect(e.x - w / 2, e.y - e.radius - 10, w * (e.hp / e.maxHp), 4);
    }
    // Boss 血条（鎏金边框）
    if (e.isBoss) {
      var bw = 300;
      var bx = this.camera.x + this.view.w / 2 - bw / 2;
      var by = this.camera.y + 30;
      ctx.fillStyle = 'rgba(30,20,12,0.65)';
      ctx.fillRect(bx, by, bw, 14);
      ctx.fillStyle = PAL.lantern;
      ctx.fillRect(bx + 2, by + 2, (bw - 4) * (e.hp / e.maxHp), 10);
      ctx.strokeStyle = PAL.gold;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, 14);
    }
  };

  // 清朝跳尸：官帽 + 面部符纸 + 前伸双臂 + 跳跃
  R._drawZombie = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var robe = flash ? '#fff' : d.color;
    var paper = flash ? '#fff' : d.color2;
    var hat = flash ? '#fff' : (d.color3 || '#1a1a20');
    var hop = Math.abs(Math.sin(e.animTime * 4.2)) * 3.2;
    var sway = Math.sin(e.animTime * 4.2) * 0.09;
    var lunge = pulse(atkU(e));          // 前扑脉冲（0→1→0）

    ctx.save();
    ctx.translate(0, -hop);
    if (lunge) ctx.scale(1 + lunge * 0.07, 1 + lunge * 0.07); // 向镜头扑近

    // 官服长袍（下摆）
    ctx.beginPath();
    ctx.moveTo(-11, 14); ctx.lineTo(-8, -6); ctx.lineTo(8, -6); ctx.lineTo(11, 14);
    ctx.closePath();
    fs(ctx, robe, O, 1.8);
    // 胸前补子
    ctx.beginPath(); ctx.rect(-4.5, -2, 9, 9);
    fs(ctx, PAL.paper, O, 1.2);

    // 头（青灰尸面）
    ctx.save();
    ctx.rotate(sway);
    ctx.beginPath(); ctx.arc(0, -13, 8.2, 0, TAU);
    fs(ctx, '#b9c4a0', O, 1.7);
    // 面部符纸（黄符遮额）
    ctx.beginPath(); ctx.rect(-5.4, -17.5, 10.8, 7);
    fs(ctx, paper, O, 1.1);
    ctx.strokeStyle = PAL.lantern; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(0, -17); ctx.lineTo(0, -11); ctx.stroke();
    // 官帽：帽檐 + 帽顶 + 红珠
    ctx.beginPath(); ctx.ellipse(0, -19.5, 9.6, 3, 0, 0, TAU);
    fs(ctx, hat, O, 1.4);
    ctx.beginPath(); ctx.ellipse(0, -24, 6.6, 5, 0, 0, TAU);
    fs(ctx, hat, O, 1.4);
    ctx.beginPath(); ctx.arc(0, -28.5, 1.9, 0, TAU);
    fs(ctx, PAL.lantern, O, 1);
    ctx.restore();

    // 前伸双臂：正面视角下「前伸」读作向两侧前方平举 ——
    // 原来的朝正上方伸展在直立后会变成「举手投降」，故改为平举；
    // 出手时手臂向镜头推近 + 手掌放大，用近大远小暗示伸向观众。
    var reach = 1 + lunge * 0.30;
    var handR = 2.4 * (1 + lunge * 0.55);
    var armY = -5 + lunge * 2.5;
    ctx.strokeStyle = robe; ctx.lineWidth = 4.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-5, -3); ctx.lineTo(-10.5 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(5, -3); ctx.lineTo(10.5 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.arc(-10.5 * reach, armY - 0.8, handR, 0, TAU);
    fs(ctx, '#dfe6c8', O, 1.2);
    ctx.beginPath(); ctx.arc(10.5 * reach, armY - 0.8, handR, 0, TAU);
    fs(ctx, '#dfe6c8', O, 1.2);

    ctx.restore();
  };

  // 蝠妖：翼膜 + 翼骨 + 獠牙 + 发光眼
  R._drawBat = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var fur = flash ? '#fff' : d.color;
    var wing = flash ? '#fff' : d.color2;
    var flap = Math.sin(e.animTime * 15);
    var dive = pulse(atkU(e), 1.3);      // 俯冲脉冲（0→1→0）
    var spread = 1 - dive * 0.55;        // 收翼幅度
    var s;

    // 双翼（带翼骨）—— 俯冲时收拢，命中瞬间再张开
    for (s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.scale(s * spread, 1);
      ctx.beginPath();
      ctx.moveTo(2, -1);
      ctx.quadraticCurveTo(11, -8 - flap * 5, 19, -4 - flap * 6);
      ctx.quadraticCurveTo(15, 1, 17, 5);
      ctx.quadraticCurveTo(10, 3, 8, 6);
      ctx.quadraticCurveTo(5, 2, 2, 3);
      ctx.closePath();
      fs(ctx, wing, O, 1.5);
      ctx.strokeStyle = OUT; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(17, -3 - flap * 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(3, 1); ctx.lineTo(15, 3); ctx.stroke();
      ctx.restore();
    }
    // 身体（绒毛）—— 俯冲时略微放大，做出「扑到眼前」的感觉
    var bs = 1 + dive * 0.18;
    ctx.beginPath(); ctx.ellipse(0, 0, 7 * bs, 6.5 * bs, 0, 0, TAU);
    fs(ctx, fur, O, 1.6);
    // 耳朵
    ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(-6.5, -11.5); ctx.lineTo(-1.5, -6); ctx.closePath();
    fs(ctx, fur, O, 1.2);
    ctx.beginPath(); ctx.moveTo(4, -5); ctx.lineTo(6.5, -11.5); ctx.lineTo(1.5, -6); ctx.closePath();
    fs(ctx, fur, O, 1.2);
    // 獠牙
    ctx.beginPath(); ctx.moveTo(-1.8, 3.5); ctx.lineTo(-1.2, 6.8); ctx.lineTo(-0.6, 3.5); ctx.closePath();
    fs(ctx, '#fdfaf0', O, 0.8);
    ctx.beginPath(); ctx.moveTo(1.8, 3.5); ctx.lineTo(1.2, 6.8); ctx.lineTo(0.6, 3.5); ctx.closePath();
    fs(ctx, '#fdfaf0', O, 0.8);
    // 发光眼
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,90,110,' + (0.85 + dive * 0.15) + ')';
    var er = 1.8 * (1 + dive * 0.4);
    ctx.beginPath(); ctx.arc(-2.6, -1, er, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(2.6, -1, er, 0, TAU); ctx.fill();
    ctx.restore();
  };

  // 邪修道人：道袍 + 道冠 + 长须 + 桃木剑 + 悬浮符咒
  R._drawWizard = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var robe = flash ? '#fff' : d.color;
    var paper = flash ? '#fff' : d.color2;
    var wood = flash ? '#fff' : (d.color3 || '#8a6a3a');
    var float = Math.sin(e.animTime * 2.2) * 1.5;
    var cast = pulse(atkU(e), 1.2);      // 施法脉冲（0→1→0）
    var i;

    ctx.save();
    ctx.translate(0, float - cast * 2);  // 施法时微微上浮

    // 道袍（宽摆）
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.quadraticCurveTo(-13, 0, -12, 15);
    ctx.lineTo(12, 15);
    ctx.quadraticCurveTo(13, 0, 0, -10);
    ctx.closePath();
    fs(ctx, robe, O, 1.8);
    // 广袖
    ctx.beginPath(); ctx.ellipse(-10, 2, 4.5, 8, 0.3, 0, TAU); fs(ctx, robe, O, 1.4);
    ctx.beginPath(); ctx.ellipse(10, 2, 4.5, 8, -0.3, 0, TAU); fs(ctx, robe, O, 1.4);
    // 前襟
    ctx.strokeStyle = PAL.paper; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(0, 13); ctx.stroke();

    // 头
    ctx.beginPath(); ctx.arc(0, -12, 7, 0, TAU);
    fs(ctx, '#d8c9a8', O, 1.6);
    // 道冠 / 发髻
    ctx.beginPath(); ctx.arc(0, -18.5, 3.4, 0, TAU);
    fs(ctx, '#2a2233', O, 1.2);
    // 长须
    ctx.beginPath();
    ctx.moveTo(-3, -6); ctx.quadraticCurveTo(0, 5, 3, -6); ctx.closePath();
    fs(ctx, '#e8e4da', O, 1);
    // 发光眼
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(200,150,255,0.9)';
    ctx.beginPath(); ctx.arc(-2.4, -12.5, 1.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(2.4, -12.5, 1.5, 0, TAU); ctx.fill();
    ctx.restore();

    // 桃木剑（施法时高举）
    ctx.save();
    ctx.translate(11, 6 - cast * 4); ctx.rotate(-0.35 - cast * 0.55);
    ctx.beginPath(); ctx.rect(-1, -14, 2, 18); fs(ctx, wood, O, 1.2);
    ctx.beginPath(); ctx.rect(-3, 3, 6, 2.4); fs(ctx, PAL.lantern, O, 1);
    ctx.restore();
    // 剑尖灵光
    if (cast > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(200,150,255,' + (cast * 0.7) + ')';
      ctx.beginPath(); ctx.arc(11 + cast * 4, -6 - cast * 4, 3.5 + cast * 5, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // 悬浮符咒（环绕；施法时向中心聚拢并加速旋转）
    var orbR = 20 - cast * 9;
    var spin = e.animTime * (1.8 + cast * 4);
    for (i = 0; i < 3; i++) {
      var a = spin + i * (TAU / 3);
      ctx.save();
      ctx.translate(Math.cos(a) * orbR, Math.sin(a) * orbR - 4);
      ctx.rotate(a);
      ctx.beginPath(); ctx.rect(-3, -5, 6, 10);
      fs(ctx, paper, O, 1);
      ctx.restore();
    }
    ctx.restore();
  };

  // 赤月年兽：犄角 + 云纹 + 怒目獠牙 + 利爪
  R._drawBoss = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var body = flash ? '#fff' : d.color;
    var dark = flash ? '#fff' : d.color2;
    var gold = d.color3 || PAL.gold;
    var glow = 0.6 + Math.sin(e.animTime * 3) * 0.4; // 原变量名 pulse 会遮蔽同名工具函数，改名
    var slam = pulse(atkU(e), 1.4);      // 拍击脉冲（0→1→0）
    var i, s, k, t, a;

    if (slam) ctx.scale(1 + slam * 0.05, 1 + slam * 0.05); // 拍击时整体前压

    // 暗色内圈（体积感）
    ctx.beginPath(); ctx.ellipse(0, 6, 40, 42, 0, 0, TAU);
    fs(ctx, dark, O, 2.4);
    // 主体
    ctx.beginPath(); ctx.ellipse(0, 0, 34, 36, 0, 0, TAU);
    fs(ctx, body, O, 2.6);
    // 云纹
    ctx.strokeStyle = gold; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(0, i * 15, 22, Math.PI * 0.25, Math.PI * 0.75);
      ctx.stroke();
    }
    // 犄角
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * 16, -24);
      ctx.quadraticCurveTo(s * 26, -40, s * 12, -46);
      ctx.quadraticCurveTo(s * 20, -36, s * 9, -26);
      ctx.closePath();
      fs(ctx, PAL.paper, O, 1.8);
    }
    // 面部
    ctx.beginPath(); ctx.ellipse(0, -6, 20, 15, 0, 0, TAU);
    fs(ctx, dark, O, 1.8);
    // 怒目
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,220,90,' + (0.6 + glow * 0.4) + ')';
    ctx.beginPath(); ctx.ellipse(-9, -8, 5, 4, -0.25, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(9, -8, 5, 4, 0.25, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#1a1010';
    ctx.beginPath(); ctx.ellipse(-9, -8, 1.8, 3.4, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(9, -8, 1.8, 3.4, 0, 0, TAU); ctx.fill();
    // 獠牙
    for (k = -1; k <= 1; k += 2) {
      ctx.beginPath();
      ctx.moveTo(k * 6, 2); ctx.lineTo(k * 3.6, 11.5); ctx.lineTo(k * 1.6, 2);
      ctx.closePath();
      fs(ctx, '#fdfaf0', O, 1);
    }
    // 核心辉光
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,90,70,' + (0.35 + glow * 0.35 + slam * 0.3) + ')';
    ctx.beginPath(); ctx.arc(0, 16, 12 + glow * 4 + slam * 6, 0, TAU); ctx.fill();
    ctx.restore();
    // 利爪（环绕；拍击时向内合拢并加速）
    var clawIn = 32 - slam * 15;
    var clawOut = 46 - slam * 21;
    ctx.strokeStyle = body; ctx.lineWidth = 6; ctx.lineCap = 'round';
    for (t = 0; t < 6; t++) {
      a = e.animTime * (1.6 + slam * 3) + t * (TAU / 6);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * clawIn, Math.sin(a) * clawIn);
      ctx.lineTo(Math.cos(a) * clawOut, Math.sin(a) * clawOut);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(Math.cos(a) * clawOut, Math.sin(a) * clawOut, 3.4, 0, TAU);
      fs(ctx, PAL.paper, O, 1.2);
    }
  };

  /* ---------------- 反伤系（坦克） ----------------
   * 三种坦克共用一条「反伤预警」约定：脚下持续脉动一圈 color3 光晕，
   * 玩家进图就能看出「这只不能硬啃」。被命中反弹时再闪一次亮环（counterFlash）。
   * 反伤数值在 config.js，绘制只读 e.counter / e.def.color3，两者不耦合。 */

  // 反伤预警光晕。fy 为该类型的脚底支点，与 FOOT_Y 保持一致。
  R._drawCounterAura = function (ctx, e, fy) {
    if (!e.counter) return;
    var now = performance.now();
    var c = e.def.color3 || '#8fd0e8';
    var r = e.radius + 7 + Math.sin(now * 0.005) * 2.2;
    var flat = r * 0.38;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.32 + Math.sin(now * 0.005) * 0.12;
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, fy, r, flat, 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.14; ctx.lineWidth = 5.5;
    ctx.beginPath(); ctx.ellipse(0, fy, Math.max(6, r - 4), Math.max(3, flat - 2), 0, 0, TAU); ctx.stroke();
    // 触发时向外扩散一次
    if (e.counterFlash > 0) {
      var t = e.counterFlash / 0.35;
      ctx.globalAlpha = t * 0.85;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(0, fy, r + (1 - t) * 22, flat + (1 - t) * 8, 0, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  };

  // 石甲力士：石块垒成的梯形躯干 + 方块肩甲 + 裂纹石面。慢、厚、稳定反伤。
  R._drawGolem = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var stone  = flash ? '#fff' : d.color;
    var stoneD = flash ? '#fff' : d.color2;
    var rune   = flash ? '#fff' : d.color3;
    var lunge = pulse(atkU(e));
    var step = Math.abs(Math.sin(e.animTime * 2.6)) * 2.2;

    this._drawCounterAura(ctx, e, 19);

    ctx.save();
    ctx.translate(0, -step);
    if (lunge) ctx.scale(1 + lunge * 0.05, 1 + lunge * 0.05);

    // 躯干：石块垒成的梯形，正面刻一道竖向反伤符纹
    ctx.beginPath();
    ctx.moveTo(-15, 19); ctx.lineTo(-12, -10); ctx.lineTo(12, -10); ctx.lineTo(15, 19);
    ctx.closePath();
    fs(ctx, stone, O, 1.8);
    ctx.strokeStyle = stoneD; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(0, 19); ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = rune; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(0, 16);
    ctx.moveTo(-4, -2); ctx.lineTo(4, -2);
    ctx.stroke();
    ctx.restore();

    // 方块肩甲
    ctx.beginPath(); ctx.rect(-19, -13, 10, 11);
    fs(ctx, stoneD, O, 1.6);
    ctx.beginPath(); ctx.rect(9, -13, 10, 11);
    fs(ctx, stoneD, O, 1.6);

    // 头：方形石面 + 裂缝 + 发光眼缝
    ctx.beginPath(); ctx.rect(-8, -26, 16, 13);
    fs(ctx, stone, O, 1.7);
    ctx.strokeStyle = stoneD; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-6, -26); ctx.lineTo(-4, -20); ctx.lineTo(-6, -14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6, -25); ctx.lineTo(5, -19); ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rune;
    ctx.fillRect(-5, -22, 10, 2.4);
    ctx.restore();

    // 粗壮石臂：平举，出手时向镜头推近
    var reach = 1 + lunge * 0.22;
    var fistR = 5.4 * (1 + lunge * 0.5);
    var armY = -1 + lunge * 2;
    ctx.strokeStyle = stone; ctx.lineWidth = 6.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-10, -6); ctx.lineTo(-17 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, -6); ctx.lineTo(17 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.arc(-17 * reach, armY - 1, fistR, 0, TAU);
    fs(ctx, stoneD, O, 1.5);
    ctx.beginPath(); ctx.arc(17 * reach, armY - 1, fistR, 0, TAU);
    fs(ctx, stoneD, O, 1.5);

    ctx.restore();
  };

  // 铁壁武卒：方盾占掉大半身体，只露头与脚。极厚、反伤最高、最笨重。
  R._drawBulwark = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var iron  = flash ? '#fff' : d.color;
    var ironD = flash ? '#fff' : d.color2;
    var rune  = flash ? '#fff' : d.color3;
    var lunge = pulse(atkU(e));
    var step = Math.abs(Math.sin(e.animTime * 2.2)) * 1.6;

    this._drawCounterAura(ctx, e, 18);

    ctx.save();
    ctx.translate(0, -step);

    // 头：铁盔，从盾上方露出
    ctx.beginPath(); ctx.ellipse(0, -30, 8, 7.4, 0, 0, TAU);
    fs(ctx, ironD, O, 1.7);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rune;
    ctx.fillRect(-5, -31.5, 10, 2.2);
    ctx.restore();

    // 肩（盾两侧露出）
    ctx.beginPath(); ctx.rect(-18, -20, 9, 10);
    fs(ctx, ironD, O, 1.5);
    ctx.beginPath(); ctx.rect(9, -20, 9, 10);
    fs(ctx, ironD, O, 1.5);

    // 大方盾：占身前大半，出手时微微前推
    ctx.save();
    ctx.translate(lunge * 3, 0);
    ctx.beginPath();
    ctx.moveTo(-16, -20); ctx.lineTo(16, -20); ctx.lineTo(16, 12);
    ctx.lineTo(0, 18); ctx.lineTo(-16, 12);
    ctx.closePath();
    fs(ctx, iron, O, 2);
    // 盾面铆钉
    ctx.fillStyle = ironD;
    var rivets = [[-10, -14], [0, -14], [10, -14], [-10, 4], [0, 4], [10, 4]];
    for (var i = 0; i < rivets.length; i++) {
      ctx.beginPath(); ctx.arc(rivets[i][0], rivets[i][1], 1.3, 0, TAU); ctx.fill();
    }
    // 盾心反伤符（同心方框）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rune; ctx.lineWidth = 2.2; ctx.globalAlpha = 0.8;
    ctx.strokeRect(-8, -11, 16, 16);
    ctx.globalAlpha = 0.4; ctx.lineWidth = 1.2;
    ctx.strokeRect(-12, -15, 24, 24);
    ctx.restore();
    ctx.restore();

    // 脚（盾下露出）
    ctx.strokeStyle = ironD; ctx.lineWidth = 4.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-7, 15); ctx.lineTo(-8, 19); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(7, 15); ctx.lineTo(8, 19); ctx.stroke();

    ctx.restore();
  };

  // 铁拳力士：赤铜躯干 + 巨拳套。中血较快、反伤低，但接触伤害最高。
  R._drawBruiser = function (ctx, e, flash) {
    var d = e.def, O = this.outline;
    var bronze  = flash ? '#fff' : d.color;
    var bronzeD = flash ? '#fff' : d.color2;
    var glow    = flash ? '#fff' : d.color3;
    var lunge = pulse(atkU(e));
    var step = Math.abs(Math.sin(e.animTime * 3.4)) * 2.6;

    this._drawCounterAura(ctx, e, 16);

    ctx.save();
    ctx.translate(0, -step);

    // 躯干
    ctx.beginPath();
    ctx.moveTo(-11, 16); ctx.lineTo(-10, -8); ctx.lineTo(10, -8); ctx.lineTo(11, 16);
    ctx.closePath();
    fs(ctx, bronze, O, 1.7);
    // 腰带
    ctx.beginPath(); ctx.rect(-11.5, 4, 23, 4);
    fs(ctx, bronzeD, O, 1.2);

    // 头：铜面 + 额带
    ctx.beginPath(); ctx.arc(0, -15, 8.4, 0, TAU);
    fs(ctx, bronzeD, O, 1.7);
    ctx.beginPath(); ctx.rect(-8.6, -19, 17.2, 3.6);
    fs(ctx, bronze, O, 1.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(-5, -13.4, 10, 2.2);
    ctx.restore();

    // 巨拳：平举，出手时向镜头砸近并放大
    var reach = 1 + lunge * 0.26;
    var fistR = 6.6 * (1 + lunge * 0.6);
    var armY = lunge * 2.4;
    ctx.strokeStyle = bronze; ctx.lineWidth = 5.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-8, -5); ctx.lineTo(-16 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, -5); ctx.lineTo(16 * reach, armY); ctx.stroke();
    ctx.beginPath(); ctx.arc(-16 * reach, armY - 1, fistR, 0, TAU);
    fs(ctx, bronzeD, O, 1.8);
    ctx.beginPath(); ctx.arc(16 * reach, armY - 1, fistR, 0, TAU);
    fs(ctx, bronzeD, O, 1.8);
    // 拳锋辉光（反伤标记）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = glow; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(-16 * reach, armY - 1, fistR + 2, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(16 * reach, armY - 1, fistR + 2, 0, TAU); ctx.stroke();
    ctx.restore();

    ctx.restore();
  };

  /* ---------------- 投射物 ---------------- */
  R._drawProjectile = function (ctx, p) {
    // 法术弹 → 旋转符咒（国风）
    if (p.type === 'spell') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(performance.now() * 0.006);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(0, 0, p.radius * 2, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.rect(-4, -6.5, 8, 13);
      fs(ctx, PAL.paper, this.outline, 1.2);
      ctx.strokeStyle = PAL.lantern; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2.5, -1); ctx.lineTo(2.5, -1); ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    // 光晕
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.4;
    ctx.beginPath(); ctx.arc(0, 0, p.radius * 1.8, 0, TAU); ctx.fill();
    ctx.restore();
    // 弹体（带拖尾的胶囊）
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.radius * 1.6, p.radius, 0, 0, TAU);
    ctx.fill();
    // 拖尾
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(-p.radius * 2.4, 0, p.radius * 1.4, p.radius * 0.6, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  /* ---------------- 掉落物（灵气珠 / 铜钱 / 回血箱 / 吸铁石） ---------------- */
  R._drawPickup = function (ctx, pk) {
    var bob = Math.sin(pk.bob) * 3;
    var y = pk.y + bob;
    var O = this.outline;

    // 发光底盘颜色各不同：红箱、青磁铁在满屏绿珠金钱里一眼能认出。
    var glow = pk.type === 'xp' ? 'rgba(110,240,170,0.35)'
      : pk.type === 'material' ? 'rgba(232,182,74,0.30)'
      : pk.type === 'heal' ? 'rgba(255,94,110,0.45)'
      : 'rgba(143,208,232,0.45)';

    if (pk.type === 'xp') {
      // 灵气珠
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(pk.x, y, 9, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(pk.x, y, 5, 0, TAU);
      fs(ctx, '#7eea9a', O, 1.4);
      ctx.beginPath(); ctx.arc(pk.x - 1.6, y - 1.6, 1.5, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
    } else if (pk.type === 'material') {
      // 铜钱
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(pk.x, y, 8, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(pk.x, y);
      ctx.rotate(pk.bob * 0.5);
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU);
      fs(ctx, '#e8b64a', O, 1.4);
      ctx.beginPath(); ctx.rect(-2, -2, 4, 4);
      fs(ctx, '#8a6a2a', O, 1);
      ctx.restore();
    } else if (pk.type === 'heal') {
      // 回血箱：红箱 + 白十字，比珠子大一圈，满屏一扫就找到
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(pk.x, y, 13, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(pk.x, y);
      ctx.beginPath(); ctx.rect(-6, -5, 12, 10);
      fs(ctx, '#c8454f', O, 1.4);
      ctx.fillStyle = '#fff6f0';
      ctx.fillRect(-1.5, -3.5, 3, 7);
      ctx.fillRect(-3.5, -1.5, 7, 3);
      ctx.restore();
    } else {
      // 吸铁石：青色开口朝上的马蹄形，两极白色
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(pk.x, y, 13, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(pk.x, y);
      ctx.lineWidth = 3.4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#8fd0e8';
      ctx.beginPath();
      ctx.arc(0, 0, 5, Math.PI, 0);   // 下半圆：开口朝上的 U
      ctx.stroke();
      ctx.beginPath(); ctx.arc(-5, 0, 1.8, 0, TAU);
      ctx.fillStyle = '#eaf6ff'; ctx.fill();
      ctx.beginPath(); ctx.arc(5, 0, 1.8, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  };

  /* ---------------- 粒子系统 ---------------- */
  R.spawnParticle = function (p) {
    if (this.particles.length >= this.particleCap) {
      // 复用最旧粒子（环形覆盖）
      var idx = this._pIdx = (this._pIdx || 0) % this.particleCap;
      this.particles[idx] = p;
      this._pIdx++;
    } else {
      this.particles.push(p);
    }
  };

  R._updateParticles = function (dt) {
    var arr = this.particles;
    for (var i = arr.length - 1; i >= 0; i--) {
      var p = arr[i];
      p.life -= dt;
      if (p.life <= 0) { arr.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.02, dt);
      p.vy *= Math.pow(0.02, dt);
      if (p.grav) p.vy += p.grav * dt;
      if (p.rot !== undefined) p.rot += (p.vr || 0) * dt;
    }
  };

  R._drawParticles = function (ctx, dt) {
    var arr = this.particles;
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      var a = util.clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a;
      if (p.glow) ctx.globalCompositeOperation = 'lighter';
      switch (p.shape) {
        case 'dot':
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2); ctx.fill();
          break;
        case 'spark':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, p.size * a);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
          ctx.stroke();
          break;
        case 'smoke':
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, Math.PI * 2); ctx.fill();
          break;
        case 'shard':
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(-p.size, -p.size);
          ctx.lineTo(p.size, -p.size * 0.6);
          ctx.lineTo(p.size * 0.4, p.size);
          ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
      }
      if (p.glow) ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  };

  /* ---------------- 世界空间特效 ---------------- */
  R.addEffect = function (fx) { this.effects.push(fx); };
  R._updateEffects = function (dt) {
    var arr = this.effects;
    for (var i = arr.length - 1; i >= 0; i--) {
      arr[i].life -= dt;
      if (arr[i].life <= 0) arr.splice(i, 1);
    }
  };
  R._drawEffects = function (ctx, dt) {
    var arr = this.effects;
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var t = f.life / f.maxLife;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (f.type === 'slash') {
        // 外层辉光（剑气）
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = t * 0.5;
        ctx.lineWidth = 12 * t + 2;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.range * 0.7, f.angle - f.arc / 2, f.angle + f.arc / 2);
        ctx.stroke();
        // 内层亮芯（鎏金）
        ctx.globalAlpha = t;
        ctx.strokeStyle = '#fff6d8';
        ctx.lineWidth = 3.5 * t + 0.8;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.range * 0.7, f.angle - f.arc / 2, f.angle + f.arc / 2);
        ctx.stroke();
      } else if (f.type === 'ring') {
        var r = f.range * (1 - t) + 6;
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = t * 0.8;
        ctx.lineWidth = 4 * t + 0.5;
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, TAU); ctx.stroke();
      } else if (f.type === 'aura') {
        // 升级灵光：外扩金环
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = t * 0.75;
        ctx.lineWidth = 5 * t + 1;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.range * (1 - t * 0.5), 0, TAU); ctx.stroke();
      } else if (f.type === 'talisman') {
        // 符咒飞出（不叠加发光）
        ctx.globalCompositeOperation = 'source-over';
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.angle);
        ctx.globalAlpha = t;
        ctx.beginPath(); ctx.rect(-4, -7, 8, 14);
        ctx.fillStyle = PAL.paper; ctx.fill();
        ctx.strokeStyle = PAL.lantern; ctx.lineWidth = 1.4; ctx.stroke();
        ctx.restore();
      } else if (f.type === 'muzzle') {
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = t;
        ctx.beginPath(); ctx.arc(f.x, f.y, 6 * t + 1, 0, TAU); ctx.fill();
      } else if (f.type === 'dmgtext') {
        // 伤害飘字：不叠加发光，且必须描边才读得清（压在高对比的粒子和暗场上）。
        // 后 25% 生命淡出，前半段全亮，别在数字刚出现时就看不清。
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = t < 0.75 ? 1 : (t - 0.5) / 0.25;
        ctx.font = f.big ? 'bold 22px "Segoe UI","Microsoft YaHei",sans-serif'
                         : 'bold 15px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(f.text, f.x, f.y - (1 - t) * 30);
        ctx.fillStyle = f.big ? PAL.gold : '#ffffff';
        ctx.fillText(f.text, f.x, f.y - (1 - t) * 30);
      }
      ctx.restore();
    }
  };

  /* ---------------- 屏幕空间特效 ---------------- */
  R._drawVignette = function (ctx, state, dt) {
    var p = state.player;
    if (!p) return;
    var ratio = p.stats.hp / p.stats.maxHp;
    if (ratio > CONST.LOW_HP_RATIO) return;
    // 濒死：屏幕边缘红色暗角，脉动
    var intensity = (1 - ratio / CONST.LOW_HP_RATIO);
    var beat = 0.6 + Math.sin(performance.now() * 0.006) * 0.4; // 原名 pulse 会遮蔽同名工具函数
    var v = this.view;
    var g = ctx.createRadialGradient(v.w / 2, v.h / 2, v.h * 0.3, v.w / 2, v.h / 2, v.h * 0.75);
    g.addColorStop(0, 'rgba(180,20,20,0)');
    g.addColorStop(1, 'rgba(180,20,20,' + (0.22 * intensity * beat) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);
  };

  R._drawFlash = function (ctx, dt) {
    if (this.flashTimer <= 0) return;
    this.flashTimer -= dt;
    var a = util.clamp(this.flashTimer / 0.3, 0, 1) * this.flashAlpha;
    var v = this.view;
    ctx.fillStyle = this.flashColor;
    ctx.globalAlpha = a;
    ctx.fillRect(0, 0, v.w, v.h);
    ctx.globalAlpha = 1;
  };

  R._drawJoystick = function (ctx) {
    var j = Game.Input.joystick;
    if (!j.visible) return;
    ctx.save();
    // 底盘
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(j.baseX, j.baseY, 60, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(j.baseX, j.baseY, 60, 0, Math.PI * 2); ctx.stroke();
    // 摇杆头（朱红 + 鎏金边）
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = PAL.lantern;
    ctx.beginPath(); ctx.arc(j.headX, j.headY, 24, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(j.headX, j.headY, 24, 0, TAU); ctx.stroke();
    ctx.restore();
  };

  // 椭圆便捷函数
  R._ellipse = function (ctx, x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  };

  /* ============================================================
   * FX 门面：供实体/系统调用的特效触发接口
   * ============================================================ */
  Game.FX = {
    _dot: function (x, y, n, color, spd, size, glow) {
      if (!R.ctx) return;
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var s = spd * (0.4 + Math.random() * 0.8);
        R.spawnParticle({
          x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          life: 0.3 + Math.random() * 0.4, maxLife: 0.6,
          size: size * (0.5 + Math.random()), color: color, shape: 'dot',
          grav: 40, glow: !!glow,
        });
      }
    },
    blood: function (x, y, n) { this._dot(x, y, n, '#c8352f', 120, 3, false); },
    spark: function (x, y, n) { this._dot(x, y, n, '#ffd76e', 200, 2, true); },
    heal: function (x, y) { this._dot(x, y, 6, '#6fe08a', 60, 3, true); },
    crit: function (x, y) { R.addEffect({ type: 'ring', x: x, y: y, range: 26, color: PAL.gold, life: 0.25, maxLife: 0.25 }); },
    // 伤害飘字：暴击放大字号并鎏金，配合 crit 的金圈。数字即结算伤害。
    damageNumber: function (x, y, amount, crit) {
      R.addEffect({
        type: 'dmgtext', x: x, y: y,
        text: String(Math.round(amount)), crit: !!crit, big: !!crit,
        life: crit ? 0.7 : 0.5, maxLife: crit ? 0.7 : 0.5,
      });
    },
    // arc 必须跟着武器走：赤月斩的扇形是 π*0.95、铁剑只有 π*0.75，
    // 之前硬编码铁剑的弧，赤月斩实际能打到的范围比刀光显示的宽。
    slash: function (x, y, angle, range, color, arc) {
      R.addEffect({ type: 'slash', x: x, y: y, angle: angle, arc: arc || Game.WEAPONS.iron_sword.arc, range: range, color: color, life: 0.16, maxLife: 0.16 });
    },
    muzzle: function (x, y, angle) {
      var p = util.onCircle(x, y, 16, angle);
      R.addEffect({ type: 'muzzle', x: p.x, y: p.y, life: 0.08, maxLife: 0.08 });
    },
    // 升级：金色灵光环 + 上升光点
    levelUp: function (x, y) {
      R.addEffect({ type: 'aura', x: x, y: y, range: 72, color: PAL.gold, life: 0.6, maxLife: 0.6 });
      R.addEffect({ type: 'ring', x: x, y: y, range: 96, color: '#fff6d8', life: 0.5, maxLife: 0.5 });
      for (var i = 0; i < 18; i++) {
        var a = Math.random() * TAU;
        var s = 70 * (0.5 + Math.random());
        R.spawnParticle({
          x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
          life: 0.5 + Math.random() * 0.5, maxLife: 1.0,
          size: 2.6 * (0.6 + Math.random()), color: PAL.gold, shape: 'dot', glow: true,
        });
      }
    },
    // 符咒飞出（施法/命中）
    talisman: function (x, y, angle) {
      R.addEffect({ type: 'talisman', x: x, y: y, angle: angle || 0, life: 0.3, maxLife: 0.3 });
    },
    cast: function (x, y) {
      this._dot(x, y, 4, '#c48aff', 120, 3, true);
      this.talisman(x, y, Math.random() * TAU);
    },
    bossCast: function (x, y) {
      R.addEffect({ type: 'ring', x: x, y: y, range: 120, color: '#ff5e6e', life: 0.5, maxLife: 0.5 });
      this._dot(x, y, 12, '#ff5e6e', 160, 3, true);
    },
    pickup: function (x, y, color) { this._dot(x, y, 2, color, 40, 2, true); },
    shieldBreak: function (x, y) { this._dot(x, y, 6, '#6fb7ff', 120, 3, true); },
    death: function (x, y, isBoss) {
      var n = isBoss ? 40 : 10;
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var s = (isBoss ? 220 : 140) * (0.5 + Math.random());
        R.spawnParticle({
          x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          life: 0.4 + Math.random() * 0.6, maxLife: 1.0,
          size: (isBoss ? 6 : 3.5) * (0.6 + Math.random()), color: '#7a3a2a',
          shape: 'shard', rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12, grav: 120,
        });
      }
      this._dot(x, y, isBoss ? 20 : 6, '#c02020', 160, 3, false);
      if (!isBoss) R.addEffect({ type: 'ring', x: x, y: y, range: 22, color: '#c02020', life: 0.2, maxLife: 0.2 });
    },
    shake: function (m) { if (R.quality !== 'low') R.shake = Math.max(R.shake, m); },
    flash: function (color, alpha) {
      R.flashColor = color || '#fff';
      R.flashAlpha = alpha || 0.5;
      R.flashTimer = 0.3;
    },
    ring: function (x, y, range, color) {
      R.addEffect({ type: 'ring', x: x, y: y, range: range, color: color, life: 0.4, maxLife: 0.4 });
    },
  };

  Game.Renderer = R;
})();
