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
  var musicGain = null;
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
      // 音乐单独走一条总线：能整体淡入淡出，不用逐个音符关
      musicGain = ctx.createGain();
      musicGain.gain.value = 1;
      musicGain.connect(masterGain);
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

  /* ---------------- 背景音乐 ----------------
   * 第二版。第一版是慢速大七和弦垫音（Am7/Fmaj7/Cmaj7/G6，5 秒一换、四声部
   * 一直悬着），真机听感太像咖啡馆背景乐，跟猎场的调子不搭。这版换成小调
   * 琶音序列：三角形短音按八分音符排点（快起快落，像拨响的琴弦），下面压
   * 一个正弦低音脉冲，进度 Am → Em → Dm → Am 全小和弦。
   * 区别在质感而不是音量：音符短、有节奏、会走动，而不是四个长音叠在一起。
   *
   * 自动播放策略：AudioContext 必须在用户手势后才算 running，所以 startMusic
   * 由 unlock() 触发；上下文挂起时（切后台）定时器自己退让，回来自己续上。
   */
  var MUSIC_VOL = 0.05;          // 单个音符峰值，调这里就能整体变响/变轻
  var BPM = 92;                  // 慢而稳，不上头
  var STEP = 60 / BPM / 2;       // 一步 = 八分音符 ≈ 0.326 秒
  var STEPS_PER_CHORD = 8;       // 8 步 ≈ 2.6 秒一个和弦，整段 10.4 秒循环
  // Am → Em → Dm → Am：全小和弦，压得住猎场的调子
  var ARP = [
    [57, 60, 64, 69, 72, 69, 64, 60],   // Am   A3 C4 E4 A4 C5
    [52, 55, 59, 64, 67, 64, 59, 55],   // Em   E3 G3 B3 E4 G4
    [50, 53, 57, 62, 65, 62, 57, 53],   // Dm   D3 F3 A3 D4 F4
    [57, 60, 64, 69, 72, 76, 69, 64],   // Am   A3 C4 E4 A4 C5 E5
  ];
  // A3 E3 D3 A3。想压到根音低八度（A2/E2/D2）但那是 110/82/73 Hz，
  // 手机喇叭在 80Hz 以下基本滚掉了，写了也白写。所以低音贴着琶音下沿走，
  // 跟琶音共用根音 —— 波形成分不同（正弦 vs 三角）听起来是加厚，不是打架。
  var BASS = [57, 52, 50, 57];
  var musicOn = true;
  var musicTimer = null;
  var musicStep = 0;      // 累计步数，跨和弦累加

  function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /** 拨弦音色：15ms 快起 + 指数衰减，像被拨响的琴弦而不是长鸣的音色 */
  function pluck(midi, t, dur, vol, type) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(midiFreq(midi), t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function musicTick() {
    musicTimer = null;
    if (!musicOn) return;                      // 关了就不再排队（音效开关不影响音乐）
    if (!ensureCtx() || !musicGain) return;
    if (ctx.state !== 'running') {
      // 挂起（切后台 / 手势前）：退让一秒再试，回来自己续上
      musicTimer = window.setTimeout(musicTick, 1000);
      return;
    }
    var idx = Math.floor(musicStep / STEPS_PER_CHORD) % ARP.length;
    var t0 = ctx.currentTime + 0.08;
    // 一个和弦排满 8 个八分音符；尾音故意留一点交叠，衔接不露缝
    for (var i = 0; i < ARP[idx].length; i++) {
      pluck(ARP[idx][i], t0 + i * STEP, STEP * 1.5, MUSIC_VOL, 'triangle');
    }
    // 低音脉冲只在头一拍，音量略高一点给节奏一个支点
    pluck(BASS[idx], t0, STEP * 3.2, MUSIC_VOL * 1.6, 'sine');
    musicStep += STEPS_PER_CHORD;
    musicTimer = window.setTimeout(musicTick, STEP * STEPS_PER_CHORD * 1000);
  }

  function startMusic() {
    if (!musicOn || musicTimer) return;
    if (!ensureCtx() || !musicGain) return;
    if (ctx.state === 'suspended') ctx.resume();
    try {
      var t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(musicGain.gain.value, t);
      musicGain.gain.linearRampToValueAtTime(1, t + 0.8);   // 淡入，别硬起
    } catch (e) {}
    musicTimer = window.setTimeout(musicTick, 60);
  }

  function stopMusic() {
    if (musicTimer) { window.clearTimeout(musicTimer); musicTimer = null; }
    if (!ctx || !musicGain) return;
    try {
      var t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(musicGain.gain.value, t);
      musicGain.gain.linearRampToValueAtTime(0, t + 0.5);   // 淡出，别硬切
    } catch (e) {}
  }

  Game.Audio = {
    // 只切战斗音效；背景音乐有自己的开关，两条线互不牵连
    setEnabled: function (v) { enabled = !!v; },
    isEnabled: function () { return enabled; },
    setMusicEnabled: function (v) {
      musicOn = !!v;
      if (!v) stopMusic();
      else if (ctx) startMusic();
    },
    isMusicEnabled: function () { return musicOn; },
    // 首次用户交互时解锁音频（浏览器自动播放策略）
    unlock: function () {
      ensureCtx();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      startMusic();
    },
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
