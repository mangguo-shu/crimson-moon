/* ============================================================
 * records.js —— 纪录榜（全局档案）
 * 每局结算（通关 / 死亡）时把成绩写进 profile_v1 的 runs 数组。
 * 排序键：到达波次降序 → 同波次伤害降序 → 都相同则新的在前。
 * 只保留 TOP_N 条。
 * 数据读写在本文件，榜单界面的渲染由 ui.js 承担。
 * ============================================================ */
(function () {
  'use strict';
  var Game = window.Game;

  var TOP_N = 10;

  /** 榜单行排序：波次 → 伤害 → 时间（新的在前） */
  function cmp(a, b) {
    if (b.wave !== a.wave) return b.wave - a.wave;
    if (b.damage !== a.damage) return b.damage - a.damage;
    return (b.at || 0) - (a.at || 0);
  }

  Game.Records = {
    TOP_N: TOP_N,

    /** 读榜单。profile_v1 缺失或结构不对时回落空榜，不报错、不覆盖用户数据。 */
    load: function () {
      var prof = Game.Storage.getJSON('profile_v1');
      if (!prof) return { runs: [] };
      if (!prof.runs || !Array.isArray(prof.runs)) return { runs: [] };
      return prof;
    },

    save: function (profile) {
      Game.Storage.setJSON('profile_v1', profile);
    },

    clear: function () {
      Game.Storage.remove('profile_v1');
    },

    /** 从运行中的状态摘取一条成绩。只留展示需要的字段，不带任何存档字段。 */
    toRun: function (state) {
      var p = state.player;
      return {
        mode: state.mode,
        charName: (p.char && p.char.name) || p.name || p.id,
        wave: state.wave,
        kills: state.stats ? state.stats.kills : 0,
        elapsed: Math.round(state.elapsed || 0),
        damage: Math.round(p.damageDealt || 0),
        materials: p.materials,
        level: p.level,
        at: Date.now(),
      };
    },

    /** 插入一条成绩并截断到 TOP_N。返回 { entered, rank }。
     *  rank 只在入榜时给值；不入榜时是 null —— 榜满后被截断的成绩算不出真实名次，
     *  给个假数字反而容易被当成真名次显示出去。 */
    add: function (run) {
      var prof = this.load();
      var better = 0;
      for (var i = 0; i < prof.runs.length; i++) if (cmp(prof.runs[i], run) < 0) better++;
      var rank = better + 1;
      prof.runs.push(run);
      prof.runs.sort(cmp);
      if (prof.runs.length > TOP_N) prof.runs = prof.runs.slice(0, TOP_N);
      this.save(prof);
      return { entered: rank <= TOP_N, rank: rank <= TOP_N ? rank : null };
    },

    /** 当前最好成绩（波次最高），无记录时返回 null */
    best: function () {
      var runs = this.load().runs;
      return runs.length ? runs[0] : null;
    },
  };
})();
