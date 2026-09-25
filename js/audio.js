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
   * 四个慢速和弦循环（Am7 → Fmaj7 → Cmaj7 → G6），sine 垫音 + 低八度三角波
   * 低音 + 五声音阶上的偶发高光音。MUSIC_VOL 刻意压得很低 —— 背景音乐压过
   * 战斗音效就不叫背景了。
   *
   * 自动播放策略：AudioContext 必须在用户手势后才算 running，所以 startMusic
   * 由 unlock() 触发；上下文挂起时（切后台）定时器自己退让，回来自己续上。
   */
  var MUSIC_VOL = 0.06;     // 单个音符峰值，调这里就能整体变响/变轻
  var CHORD_SEC = 5;        // 每个和弦 5 秒，整段 20 秒循环
  var CHORDS = [
    [45, 60, 67],   // Am7   A2 C4 G4
    [41, 57, 64],   // Fmaj7 F2 A3 E4
    [48, 64, 71],   // Cmaj7 C3 E4 B4
    [43, 59, 62],   // G6    G2 B3 D4
  ];
  var SPARKLE = [69, 72, 74, 76, 79];   // 五声音阶 A4 C5 D5 E5 G5
  var musicOn = true;
  var musicTimer = null;
  var musicStep = 0;

  function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /** 排一个慢起慢落的和弦垫音；dur 长于 CHORD_SEC，让相邻和弦交叠不露缝 */
  function scheduleChord(chord, t, dur) {
    for (var i = 0; i < chord.length; i++) {
      var f = midiFreq(chord[i]);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(MUSIC_VOL, t + dur * 0.45);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(musicGain);
      o.start(t); o.stop(t + dur + 0.05);
      // 低八度三角波做低音支点，垫音不会飘在空里
      var b = ctx.createOscillator(), bg = ctx.createGain();
      b.type = 'triangle';
      b.frequency.setValueAtTime(f / 2, t);
      bg.gain.setValueAtTime(0, t);
      bg.gain.linearRampToValueAtTime(MUSIC_VOL * 0.4, t + dur * 0.5);
      bg.gain.linearRampToValueAtTime(0, t + dur);
      b.connect(bg); bg.connect(musicGain);
      b.start(t); b.stop(t + dur + 0.05);
    }
  }

  function scheduleSparkle(t) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(midiFreq(SPARKLE[Math.floor(Math.random() * SPARKLE.length)]), t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(MUSIC_VOL * 0.5, t + 0.4);
    g.gain.linearRampToValueAtTime(0, t + 2.2);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 2.25);
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
    var t = ctx.currentTime + 0.08;
    scheduleChord(CHORDS[musicStep % CHORDS.length], t, CHORD_SEC * 1.6);
    if (musicStep % 2 === 1) scheduleSparkle(t + 1.2);
    musicStep++;
    musicTimer = window.setTimeout(musicTick, (CHORD_SEC - 0.08) * 1000);
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
