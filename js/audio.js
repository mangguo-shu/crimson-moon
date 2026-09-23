/* ============================================================
 * audio.js —— 轻量程序化音效（无外部素材）
 * 使用 WebAudio 振荡器生成简单音效，避免依赖任何受版权保护的音频文件。
 * 后续轮次可替换为更丰富的合成音色。可静音。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var ctx = null;
  var masterGain = null;
  var enabled = true;

  function ensureCtx() {
    if (ctx) return true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);
      return true;
    } catch (e) { return false; }
  }

  // 播放一个短音：type 波形，freq 起止频率，dur 时长，vol 音量
  function tone(type, f0, f1, dur, vol) {
    if (!enabled || !ensureCtx()) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = type;
      var t = ctx.currentTime;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(masterGain);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }

  Game.Audio = {
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; },
    // 首次用户交互时解锁音频（浏览器自动播放策略）
    unlock: function () { ensureCtx(); if (ctx && ctx.state === 'suspended') ctx.resume(); },
    shoot: function () { tone('square', 900, 400, 0.06, 0.12); },
    hit: function () { tone('triangle', 300, 120, 0.08, 0.2); },
    hurt: function () { tone('sawtooth', 180, 70, 0.15, 0.3); },
    pickup: function () { tone('sine', 500, 900, 0.08, 0.18); },
    levelup: function () { tone('sine', 400, 1200, 0.35, 0.25); tone('sine', 600, 1600, 0.4, 0.15); },
    buy: function () { tone('square', 700, 1100, 0.08, 0.2); },
    wave: function () { tone('sawtooth', 150, 300, 0.4, 0.22); },
    boss: function () { tone('sawtooth', 80, 200, 0.7, 0.35); tone('sine', 60, 120, 0.8, 0.3); },
    heal: function () { tone('sine', 600, 1000, 0.15, 0.2); },
  };
})();
