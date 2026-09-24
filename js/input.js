/* ============================================================
 * input.js —— 统一输入接口
 * 桌面端：WASD / 方向键移动；空格暂停；F5 存 / F9 读；~ 调试面板。
 * 安卓端：左下虚拟摇杆（动态位置 + 死区 + 平滑归位）；多点触控。
 * 自动检测设备类型切换输入方式。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var JOYSTICK_RADIUS = 60;   // 摇杆底盘半径（逻辑单位）
  var DEAD_ZONE = 0.10;        // 死区比例

  Game.Input = {
    touchMode: false,
    keys: {},                  // 按下的键
    // 虚拟摇杆状态
    joystick: {
      active: false,
      baseX: 0, baseY: 0,      // 底盘中心（动态生成）
      headX: 0, headY: 0,      // 摇杆头当前显示位置
      pointerId: -1,
      visible: false,
    },
    // 由 game.js 挂载的动作回调（避免 input 直接耦合 UI）
    actions: {
      pause: null, save: null, load: null, debug: null,
    },

    /** 初始化事件监听 */
    init: function (canvas) {
      this.touchMode = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
      var self = this;

      // ---------- 键盘 ----------
      window.addEventListener('keydown', function (e) {
        self.keys[e.code] = true;
        // 阻止方向键 / 空格滚动页面
        if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].indexOf(e.code) >= 0) {
          e.preventDefault();
        }
        self._handleKey(e.code, true);
      });
      window.addEventListener('keyup', function (e) {
        self.keys[e.code] = false;
        self._handleKey(e.code, false);
      });

      // ---------- 触摸（摇杆） ----------
      if (canvas && canvas.addEventListener) {
        canvas.addEventListener('touchstart', function (e) { self._onTouchStart(e); }, { passive: false });
        canvas.addEventListener('touchmove',  function (e) { self._onTouchMove(e); },  { passive: false });
        canvas.addEventListener('touchend',   function (e) { self._onTouchEnd(e); },   { passive: false });
        canvas.addEventListener('touchcancel',function (e) { self._onTouchEnd(e); },   { passive: false });
      }
      console.log('[Input] 初始化完成 touchMode=' + this.touchMode);
    },

    // 处理按键动作（松开才触发某些一次性动作，避免长按重复）
    _handleKey: function (code, down) {
      if (down) {
        if (code === 'Space') { if (this.actions.pause) this.actions.pause(); }
        if (code === 'F5') { if (this.actions.save) this.actions.save(); }
        if (code === 'F9') { if (this.actions.load) this.actions.load(); }
        if (code === 'Backquote') { if (this.actions.debug) this.actions.debug(); }
      }
    },

    // 将客户端坐标换算为逻辑坐标（由 game.js 的 Game.view 提供换算）
    _clientToLogical: function (clientX, clientY) {
      if (Game.viewToLogical) return Game.viewToLogical(clientX, clientY);
      // 兜底：按 720 高比例
      var scale = window.innerHeight / Game.CONST.LOGICAL_H;
      var w = window.innerWidth / scale;
      return { x: (clientX) / scale - (w - Game.CONST.LOGICAL_W) / 2, y: clientY / scale };
    },

    _onTouchStart: function (e) {
      e.preventDefault();
      var self = this;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var p = this._clientToLogical(t.clientX, t.clientY);
        // 屏幕内任意触点都能生成摇杆 —— 安卓上不必只碰左半屏。
        // 旧实现限制 p.x < 视口宽的一半，右半屏触摸完全无响应。
        // 同一时刻只允许一个摇杆：多点触控时忽略第二个指头。
        if (!this.joystick.active) {
          var j = this.joystick;
          j.active = true;
          j.visible = true;
          j.pointerId = t.identifier;
          j.baseX = p.x; j.baseY = p.y;
          j.headX = p.x; j.headY = p.y;
          break;
        }
      }
    },

    _onTouchMove: function (e) {
      e.preventDefault();
      var j = this.joystick;
      if (!j.active) return;
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== j.pointerId) continue;
        var p = this._clientToLogical(t.clientX, t.clientY);
        var dx = p.x - j.baseX, dy = p.y - j.baseY;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > JOYSTICK_RADIUS) { dx = dx / d * JOYSTICK_RADIUS; dy = dy / d * JOYSTICK_RADIUS; }
        j.headX = j.baseX + dx;
        j.headY = j.baseY + dy;
        break;
      }
    },

    _onTouchEnd: function (e) {
      e.preventDefault();
      var j = this.joystick;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === j.pointerId) {
          j.active = false;
          j.pointerId = -1; // 保留 head 位置用于平滑归位
          break;
        }
      }
    },

    /** 摇杆平滑归位（每帧调用） */
    update: function (dt) {
      var j = this.joystick;
      if (!j.active && j.visible) {
        var k = 1 - Math.pow(0.001, dt); // 平滑系数
        j.headX += (j.baseX - j.headX) * k;
        j.headY += (j.baseY - j.headY) * k;
        if (Math.abs(j.headX - j.baseX) < 1 && Math.abs(j.headY - j.baseY) < 1) {
          j.headX = j.baseX; j.headY = j.baseY;
          j.visible = false;
        }
      }
    },

    /** 获取移动向量（归一化，含死区）。优先摇杆，其次键盘。 */
    getMove: function () {
      var j = this.joystick;
      var x = 0, y = 0;
      if (j.active) {
        var dx = j.headX - j.baseX, dy = j.headY - j.baseY;
        var mag = Math.sqrt(dx * dx + dy * dy) / JOYSTICK_RADIUS;
        if (mag > DEAD_ZONE) {
          var nx = dx / (JOYSTICK_RADIUS), ny = dy / (JOYSTICK_RADIUS);
          var m = Math.sqrt(nx * nx + ny * ny);
          if (m > 1) { nx /= m; ny /= m; }
          // 死区映射：把 DEAD_ZONE~1 映射到 0~1
          var scaled = (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
          x = nx * scaled; y = ny * scaled;
        }
        return { x: x, y: y };
      }
      // 键盘
      if (this.keys['KeyW'] || this.keys['ArrowUp']) y -= 1;
      if (this.keys['KeyS'] || this.keys['ArrowDown']) y += 1;
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) x -= 1;
      if (this.keys['KeyD'] || this.keys['ArrowRight']) x += 1;
      if (x !== 0 || y !== 0) {
        var m2 = Math.sqrt(x * x + y * y);
        x /= m2; y /= m2;
      }
      return { x: x, y: y };
    },
  };
})();
