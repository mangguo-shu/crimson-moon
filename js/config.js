/* ============================================================
 * config.js —— 全局命名空间 + 静态配置数据 + 工具函数
 * 本文件是第一个加载的脚本，负责初始化 window.Game 命名空间。
 * 后续所有脚本都往 Game 上挂载自己的模块。
 * ============================================================ */
(function () {
  'use strict';

  // 统一命名空间：普通 script 标签按序加载，共享 window.Game。
  // 不使用 ES Module（import/export 在 file:// 协议下会被 CORS 拦截）。
  var Game = window.Game = window.Game || {};

  /* ---------------- 常量 ---------------- */
  Game.CONST = {
    LOGICAL_W: 1280,      // 参考逻辑宽
    LOGICAL_H: 720,       // 固定逻辑高（横屏基准），实际可见宽度随屏幕比例扩展
    WORLD_W: 2400,        // 地图世界宽（大于屏幕，相机跟随）
    WORLD_H: 1800,
    MAX_WEAPONS: 6,       // 最大武器槽数
    PARTICLE_LOW: 200,    // 低画质粒子上限
    PARTICLE_MID: 500,
    PARTICLE_HIGH: 800,
    LOW_HP_RATIO: 0.3,    // 濒死阈值 30%
  };

  /* ---------------- 国风调色板 ---------------- */
  // 2D 国产动漫（青砖庭院）风格：明亮暖色 + 统一赛璐璐描边。
  Game.PALETTE = {
    outline:  '#2a2118',   // 统一描边色（动漫赛璐璐轮廓）
    stone:    '#8f8776',   // 青砖底色
    stone2:   '#9c9482',   // 青砖亮面
    mortar:   '#5d5648',   // 砖缝
    moss:     '#5f7d46',   // 苔藓
    moss2:    '#48602f',   // 深苔
    wood:     '#8a6a45',   // 木质
    woodDark: '#5c452c',   // 木质暗部
    tile:     '#4a4a52',   // 瓦片
    lantern:  '#c8352f',   // 灯笼朱红
    gold:     '#ffcf5e',   // 鎏金
    paper:    '#e8dfc0',   // 符纸
    jade:     '#4fbfa0',   // 青玉（灵气）
    sky:      '#2e2820',   // 世界外背景（暖褐，非纯黑）
  };

  /* ---------------- 稀有度 ---------------- */
  Game.RARITY = {
    common:  { key: 'common', name: '普通', color: '#d8d8d8', glow: 'rgba(216,216,216,0.2)' },
    rare:    { key: 'rare',   name: '稀有', color: '#4fa3ff', glow: 'rgba(79,163,255,0.4)' },
    epic:    { key: 'epic',   name: '史诗', color: '#b06bff', glow: 'rgba(176,107,255,0.5)' },
    legend:  { key: 'legend', name: '传奇', color: '#ffcf5e', glow: 'rgba(255,207,94,0.6)' },
  };

  /* ---------------- 角色 ---------------- */
  // MVP 先实现 1 个角色；结构已为后续 11 个角色预留字段。
  // baseDamage 为武器伤害倍率基准；attackSpeed 为攻速倍率。
  Game.CHARACTERS = [
    {
      id: 'swordsman',
      name: '流浪剑客',
      category: '敏捷近战',
      desc: '在赤月下流浪的剑客，手中铁剑永不生锈。',
      passive: '连击：连续命中同一目标叠加伤害，最高 +30%。',
      // 基础属性
      baseHp: 100,
      speed: 220,
      damage: 1.0,
      attackSpeed: 1.0,
      critChance: 0.05,
      critMult: 1.5,
      armor: 0,
      startWeapon: 'iron_sword',
      // 程序化绘制配色（国风）：青衫 + 月白内衬 + 朱红束带
      colors: { skin: '#f2d3ac', cloth: '#3f6b8a', cloth2: '#e6e0cf', hair: '#241d2e', accent: '#c8352f' },
    },
  ];

  /* ---------------- 武器 ---------------- */
  // type: melee(近战挥砍) / ranged(远程投射物)
  // 星级合成留到后续轮次，MVP 先用 level 表示等级（升级伤害）。
  Game.WEAPONS = {
    iron_sword: {
      id: 'iron_sword', name: '铁剑', type: 'melee', star: 1,
      cooldown: 0.7, damage: 14, range: 66, arc: Math.PI * 0.75, // 挥砍弧度
      pierce: 1, projectileSpeed: 0, knockback: 60,
      color: '#cfe0ea', desc: '近战挥砍，弧形刀光。',
    },
    pistol: {
      id: 'pistol', name: '手枪', type: 'ranged', star: 1,
      cooldown: 0.55, damage: 10, range: 0, arc: 0,
      pierce: 0, projectileSpeed: 620, knockback: 20,
      color: '#ffd76e', desc: '远程射击，单发子弹。',
    },
  };

  /* ---------------- 敌人 ---------------- */
  // behavior: chase(追踪近战) / flyer(快速飞行近战) / shooter(远程) / boss
  Game.ENEMIES = {
    zombie: {
      id: 'zombie', name: '跳尸', behavior: 'chase',
      hp: 20, speed: 70, damage: 8, radius: 15,
      xp: 1, material: 1, attackCd: 0.9,
      color: '#3d4d85', color2: '#e8dfc0', color3: '#1a1a20',
    },
    bat: {
      id: 'bat', name: '蝠妖', behavior: 'flyer',
      hp: 12, speed: 128, damage: 6, radius: 11,
      xp: 1, material: 1, attackCd: 0.7,
      color: '#8a3a4a', color2: '#5a1f2e', color3: '#fdfaf0',
    },
    wizard: {
      id: 'wizard', name: '邪修道人', behavior: 'shooter',
      hp: 30, speed: 62, damage: 10, radius: 15,
      xp: 2, material: 2, attackCd: 2.2,
      color: '#4a3a7a', color2: '#e8dfc0', color3: '#8a6a3a',
      projectileSpeed: 240,
    },
    boss: {
      id: 'boss', name: '赤月年兽', behavior: 'boss',
      hp: 600, speed: 55, damage: 16, radius: 42,
      xp: 30, material: 40, attackCd: 1.4,
      color: '#c8382f', color2: '#5a1018', color3: '#ffcf5e',
      projectileSpeed: 200,
    },
  };

  /* ---------------- 道具（被动，可叠加） ---------------- */
  // MVP 提供少量被动道具，用于商店与升级池。
  Game.ITEMS = {
    heart:      { id: 'heart',      name: '生命之心', rarity: 'common', desc: '最大生命 +15',        stat: { maxHp: 15 } },
    boots:      { id: 'boots',      name: '疾风之靴', rarity: 'common', desc: '移动速度 +8%',        stat: { speed: 0.08 } },
    blade:      { id: 'blade',      name: '锋锐磨石', rarity: 'rare',   desc: '伤害 +15%',           stat: { damage: 0.15 } },
    trigger:    { id: 'trigger',    name: '轻灵扳机', rarity: 'rare',   desc: '攻击速度 +12%',        stat: { attackSpeed: 0.12 } },
    armorplate: { id: 'armorplate', name: '铁甲片',   rarity: 'rare',   desc: '护甲 +2',             stat: { armor: 2 } },
    critical:   { id: 'critical',   name: '致命宝石', rarity: 'epic',   desc: '暴击率 +10%',         stat: { critChance: 0.10 } },
  };

  /* ---------------- 升级属性选项池 ---------------- */
  Game.UPGRADES = [
    { type: 'stat', rarity: 'common', label: '生命强化',   desc: '最大生命 +20',            apply: { maxHp: 20 } },
    { type: 'stat', rarity: 'common', label: '敏捷脚步',   desc: '移动速度 +6%',            apply: { speed: 0.06 } },
    { type: 'stat', rarity: 'common', label: '力量训练',   desc: '伤害 +10%',               apply: { damage: 0.10 } },
    { type: 'stat', rarity: 'rare',   label: '迅捷出手',   desc: '攻击速度 +10%',           apply: { attackSpeed: 0.10 } },
    { type: 'stat', rarity: 'rare',   label: '致命直觉',   desc: '暴击率 +8%',              apply: { critChance: 0.08 } },
    { type: 'stat', rarity: 'rare',   label: '厚实护甲',   desc: '护甲 +2',                 apply: { armor: 2 } },
    { type: 'stat', rarity: 'epic',   label: '血气旺盛',   desc: '最大生命 +35',            apply: { maxHp: 35 } },
    { type: 'heal', rarity: 'common', label: '急救',       desc: '立即恢复 30 点生命',      apply: { heal: 30 } },
    { type: 'heal', rarity: 'rare',   label: '大急救包',   desc: '立即恢复 60 点生命',      apply: { heal: 60 } },
  ];

  /* ---------------- 随机数（可复现，用于存档一致性） ---------------- */
  // mulberry32：输入 32 位种子，返回 0~1 伪随机数发生器。
  Game.mulberry32 = function (seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // 用任意字符串派生 32 位种子
  Game.hashSeed = function (str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  /* ---------------- 通用工具 ---------------- */
  Game.util = {
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    dist: function (x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      return Math.sqrt(dx * dx + dy * dy);
    },
    dist2: function (x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      return dx * dx + dy * dy;
    },
    angleTo: function (x1, y1, x2, y2) { return Math.atan2(y2 - y1, x2 - x1); },
    rand: function (rng, a, b) { return a + rng() * (b - a); },
    randInt: function (rng, a, b) { return Math.floor(a + rng() * (b - a + 1)); },
    choice: function (rng, arr) { return arr[Math.floor(rng() * arr.length)]; },
    // 圆周上的点
    onCircle: function (cx, cy, r, angle) { return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }; },
    // 格式化秒为 mm:ss
    fmtTime: function (s) {
      s = Math.max(0, Math.floor(s));
      var m = Math.floor(s / 60), sec = s % 60;
      return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
    },
  };
})();
