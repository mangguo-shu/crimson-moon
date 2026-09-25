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
    MAX_WEAPON_LEVEL: 4,  // 武器最高强化等级（面板显示 Lv.3/4 用；数值未变，只是从字面量提出来）
    // —— 环绕轨道：多把武器挂在玩家身边，各自按槽位序号均分角度 ——
    WEAPON_ORBIT_R: 62,        // 轨道半径。取玩家半径(14)到首个敌人接触距离之间
    WEAPON_ORBIT_SPEED: 0.25,  // 轨道转速 rad/s，慢一点才有「跟随」而不是「旋转木马」
    // 武器固定朝外打，只找「朝外扇形」里的敌人。近战扇形就是它自己的 arc（冻结值），
    // 远程没有 arc（表里是 0），单独给一个，取和铁剑一样的 135° 让手感一致。
    RANGED_FIRE_ARC: Math.PI * 0.75,
    // —— 本次调参的两个开关（用户点名「下调远程伤害」「近战加大范围」）——
    // 都放在乘法系数上而不是改 WEAPONS 表：武器本体数值仍是冻结区，
    // 调手感只动这里，面板与武器走同一个 WeaponInstance.damage/range 算式不会漂移。
    RANGED_DMG_SCALE: 0.6,     // 远程伤害 ×0.6（手枪 10→6、连弩 9→5.4）
    MELEE_RANGE_SCALE: 1.25,   // 近战范围 ×1.25（铁剑 66→82.5、赤月斩 86→107.5）
    PARTICLE_LOW: 200,    // 低画质粒子上限
    PARTICLE_MID: 500,
    PARTICLE_HIGH: 800,
    LOW_HP_RATIO: 0.3,    // 濒死阈值 30%
    HEAL_ITEM_WEIGHT: 0.15, // 回血道具在商店/升级池里的相对权重（续航流角色不降权）
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
      passive: {
        id: 'combo',
        name: '连击',
        desc: '连续命中同一目标伤害 +5%，叠满 6 层共 +30%。',
      },
      // 基础属性
      baseHp: 100,
      speed: 220,
      damage: 1.0,
      attackSpeed: 1.0,
      critChance: 0.05,
      critMult: 1.5,
      armor: 0,
      startWeapon: 'iron_sword',
      // 姿态（renderer 的 _PLAYER_BODY 按此分流）。老角色没有这个字段时按
      // swordsman 处理，所以这里显式写出只是为了让四个职业对齐。
      body: 'swordsman',
      // 程序化绘制配色（国风）：青衫 + 月白内衬 + 朱红束带
      colors: { skin: '#f2d3ac', cloth: '#3f6b8a', cloth2: '#e6e0cf', hair: '#241d2e', accent: '#c8352f' },
    },
    {
      id: 'archer',
      name: '青木弓手',
      category: '暴击远程',
      desc: '在青木林里讨生活的射手，箭无虚发。',
      passive: {
        id: 'chuanYang',
        name: '穿杨',
        desc: '暴击命中额外追加 35% 伤害。',
      },
      baseHp: 90,
      speed: 232,
      damage: 0.95,
      attackSpeed: 1.1,
      critChance: 0.16,
      critMult: 2.0,
      armor: 0,
      startWeapon: 'pistol',
      body: 'archer',
      // 劲装 + 束发带 + 斗笠翎羽；配色偏林野青
      colors: { skin: '#f0d0a8', cloth: '#4f7a52', cloth2: '#e2ecd2', hair: '#2a2318', accent: '#c8352f' },
    },
    {
      id: 'monk',
      name: '玄铁武僧',
      category: '坚韧近战',
      desc: '古刹里打熬出来的武僧，一身硬气。',
      passive: {
        id: 'jingKang',
        name: '金刚',
        desc: '承受伤害 -18%；每波开始时获得最大生命 25% 的护盾。',
      },
      baseHp: 140,
      speed: 185,
      damage: 0.9,
      attackSpeed: 0.9,
      critChance: 0.04,
      critMult: 1.5,
      armor: 12,
      startWeapon: 'iron_sword',
      body: 'monk',
      // 素色僧袍 + 光头戒疤；accent 是鎏金，供念珠 / 戒疤 / 护腕共用
      colors: { skin: '#e8c49a', cloth: '#565e6a', cloth2: '#e8dfc0', hair: '#3a2a20', accent: '#ffcf5e' },
    },
    {
      id: 'brawler',
      name: '赤岩力士',
      category: '爆发近战',
      desc: '赤岩山里讨生活的力士，越打越来劲。',
      passive: {
        id: 'tieGu',
        name: '铁骨',
        desc: '生命低于 50% 时伤害 +35%。',
      },
      baseHp: 125,
      speed: 205,
      damage: 1.15,
      attackSpeed: 0.85,
      critChance: 0.06,
      critMult: 1.5,
      armor: 4,
      startWeapon: 'iron_sword',
      body: 'brawler',
      // 重甲 + 束发额带；配色偏赤岩红
      colors: { skin: '#e2b88a', cloth: '#8a3a2e', cloth2: '#d8c8b0', hair: '#2a1a14', accent: '#ffcf5e' },
    },
    {
      id: 'assassin',
      healBuild: true,   // 续航流：回血卡是核心件，商店/升级池不给他降权
      name: '疾风刺客',
      category: '吸血近战',
      desc: '刀快得看不清影子，砍完就走。',
      passive: {
        id: 'lueYing',
        name: '掠影',
        desc: '每次击杀回复 4 点生命。',
      },
      baseHp: 95,
      speed: 245,
      damage: 0.92,
      attackSpeed: 1.15,
      critChance: 0.09,
      critMult: 1.6,
      armor: 0,
      startWeapon: 'iron_sword',
      body: 'swordsman',
      // 深青黑劲装 + 青玉护腕；和流浪剑客共用剑客姿态，靠配色分开
      colors: { skin: '#f0cfa8', cloth: '#2e3a4e', cloth2: '#b8c8d8', hair: '#181420', accent: '#4fbfa0' },
    },
    {
      id: 'guard',
      name: '铁卫武人',
      category: '格挡近战',
      desc: '军中提刀的武人，一身铁甲硬抗。',
      passive: {
        id: 'geDang',
        name: '格挡',
        desc: '受到攻击时 15% 概率完全格挡。',
      },
      baseHp: 135,
      speed: 195,
      damage: 1.0,
      attackSpeed: 0.95,
      critChance: 0.05,
      critMult: 1.5,
      armor: 10,
      startWeapon: 'iron_sword',
      body: 'swordsman',
      // 玄铁甲 + 鎏金饰边
      colors: { skin: '#e8c49a', cloth: '#5a6470', cloth2: '#dcd4c4', hair: '#2a2a2e', accent: '#ffcf5e' },
    },
    {
      id: 'crossbowman',
      name: '裂石弩手',
      category: '叠暴远程',
      desc: '一弩能崩碎石岩，越攒越准。',
      passive: {
        id: 'jiFeng',
        name: '疾风',
        desc: '每次击杀暴击率 +2%，最多 5 层。',
      },
      baseHp: 92,
      speed: 225,
      damage: 1.0,
      attackSpeed: 1.05,
      critChance: 0.12,
      critMult: 1.9,
      armor: 0,
      startWeapon: 'pistol',
      body: 'archer',
      // 岩褐皮甲 + 朱红箭袋
      colors: { skin: '#eecba2', cloth: '#7a5a3a', cloth2: '#e8dfc0', hair: '#2a1f18', accent: '#c8352f' },
    },
    {
      id: 'ranger',
      name: '寒江射手',
      category: '稳定远程',
      desc: '寒江孤舟上的射手，每一箭都打得稳。',
      passive: {
        id: 'guanJia',
        name: '贯甲',
        desc: '非暴击命中伤害 +25%。',
      },
      baseHp: 88,
      speed: 238,
      damage: 1.05,
      attackSpeed: 1.0,
      critChance: 0.07,
      critMult: 1.6,
      armor: 0,
      startWeapon: 'pistol',
      body: 'archer',
      // 冰青斗篷，和青木弓手拉开色相
      colors: { skin: '#f0d0a8', cloth: '#4f7d8c', cloth2: '#e2eef2', hair: '#22303a', accent: '#4fbfa0' },
    },
    {
      id: 'nun',
      healBuild: true,   // 续航流：回血卡是核心件，商店/升级池不给他降权
      name: '慈心尼师',
      category: '续航近战',
      desc: '青灯古佛旁的尼师，慢火养人。',
      passive: {
        id: 'huiChun',
        name: '回春',
        desc: '每 2 秒回复 1 点生命。',
      },
      baseHp: 130,
      speed: 200,
      damage: 0.85,
      attackSpeed: 0.95,
      critChance: 0.04,
      critMult: 1.5,
      armor: 6,
      startWeapon: 'iron_sword',
      body: 'monk',
      // 缂褐僧衣 + 朱红念珠
      colors: { skin: '#f0cfa8', cloth: '#8a7a5a', cloth2: '#e8dfc0', hair: '#3a2a20', accent: '#c8352f' },
    },
    {
      id: 'ascetic',
      healBuild: true,   // 续航流：回血卡是核心件，商店/升级池不给他降权
      name: '苦行僧',
      category: '苦修近战',
      desc: '苦修多年，肉身已近金刚不坏。',
      passive: {
        id: 'chanXin',
        name: '禅心',
        desc: '受击时回复所受伤害的 30%。',
      },
      baseHp: 145,
      speed: 180,
      damage: 0.95,
      attackSpeed: 0.85,
      critChance: 0.04,
      critMult: 1.5,
      armor: 14,
      startWeapon: 'iron_sword',
      body: 'monk',
      // 枯褐粗布 + 石青饰带
      colors: { skin: '#e2b88a', cloth: '#6a5a48', cloth2: '#d8d0c0', hair: '#3a2a20', accent: '#8fd0e8' },
    },
    {
      id: 'brute',
      name: '狂岩巨擘',
      category: '狂战近战',
      desc: '赤岩深处的大力士，越打越疯。',
      passive: {
        id: 'kuangZhan',
        name: '狂战',
        desc: '每次击杀伤害 +3%，最多 10 层。',
      },
      baseHp: 160,
      speed: 170,
      damage: 1.25,
      attackSpeed: 0.75,
      critChance: 0.05,
      critMult: 1.6,
      armor: 8,
      startWeapon: 'iron_sword',
      body: 'brawler',
      // 赤岩深红重甲 + 焰色饰边
      colors: { skin: '#dfa878', cloth: '#7a2f26', cloth2: '#c8b8a0', hair: '#201410', accent: '#ff7a5c' },
    },
  ];

  /* ---------------- 姿态分组 ---------------- */
  // 姿态即职业：角色选择界面按此分组显示，同一组的角色共用一套剪影，
  // 靠配色 / 武器 / 特效区分（renderer 的 _PLAYER_BODY 按 body 分流绘制）。
  Game.BODY_GROUPS = {
    swordsman: '剑客',
    archer: '弓手',
    monk: '武僧',
    brawler: '力士',
  };

  /* ---------------- 角色被动 ----------------
   * 被动 = 声明式配置 + 挂点回调。
   * 之前 passive 只是显示用字符串，进游戏后没有任何逻辑读取它 —— 角色选择界面
   * 写着「连击 +30%」但实际完全无效。现在按下面两步给新角色加被动：
   * 1. CHARACTERS 里写 passive: { id, name, desc }
   * 2. 在下面注册同名 id 的挂点（用不到就少写几个）
   *
   * 可用挂点（player 恒为首参，返回值按挂点约定）：
   *   onHit(player, info)        → 返回最终伤害。info = { enemy, dmg, crit, weapon }
   *   onDamageTaken(player, raw) → 返回减免后的伤害
   *   onKill(player, enemy, state) → 击杀结算时（可用于吸血/叠 buff）
   *   onWaveStart(player, state) → 每波开始时（可用于开局护盾）
   *   perTick(player, state, dt) → 每帧（可用于缓慢回血）
   */
  Game.PASSIVES = {
    // 连击：连续命中同一目标每层 +5%，最高 6 层。
    // 换个目标就清零 —— 换怪频繁所以叠不满，但追杀同一只时收益明显。
    combo: {
      name: '连击',
      desc: '连续命中同一目标伤害 +5%，叠满 6 层共 +30%。',
      onHit: function (player, info) {
        var st = player.passiveState, MAX = 6;
        if (!st.lastUid || st.lastUid !== info.enemy.uid) {
          st.lastUid = info.enemy.uid;
          st.stacks = 0;
        }
        var mult = 1 + Math.min(MAX, st.stacks) * 0.05;
        st.stacks = Math.min(MAX, st.stacks + 1);
        return info.dmg * mult;
      },
    },

    // 穿杨（青木弓手）：暴击命中再追加 35%，叠在武器 critMult 之上。
    // 与「连击」的分工：连击靠反复打同一目标叠层，穿杨是纯粹的爆发流，
    // 不吃叠层、不挑目标，换来更高的暴击率（见 CHARACTERS 里的 critChance）。
    chuanYang: {
      name: '穿杨',
      desc: '暴击命中额外追加 35% 伤害。',
      onHit: function (player, info) {
        return info.crit ? info.dmg * 1.35 : info.dmg;
      },
    },

    // 金刚（玄铁武僧）：承伤减免 + 每波开局护盾。
    // 护盾上限随生命成长，与护盾回复（systems.js 的 +2/秒）共用一条上限，
    // 所以这里只在下限时抬高上限，不直接改玩家的永久上限。
    jingKang: {
      name: '金刚',
      desc: '承受伤害 -18%；每波开始时获得最大生命 25% 的护盾。',
      onDamageTaken: function (player, raw) { return raw * 0.82; },
      onWaveStart: function (player, state, wave) {
        var s = player.stats;
        var v = Math.round(s.maxHp * 0.25);
        if (s.shieldMax < v) s.shieldMax = v;
        s.shield = Math.min(s.shieldMax, s.shield + v);
      },
    },

    // 铁骨（赤岩力士）：残血反扑。血量低于一半时伤害放大 —— 高风险高回报，
    // 不打残血就是白板角色。
    tieGu: {
      name: '铁骨',
      desc: '生命低于 50% 时伤害 +35%。',
      onHit: function (player, info) {
        var s = player.stats;
        return (s.hp / s.maxHp) < 0.5 ? info.dmg * 1.35 : info.dmg;
      },
    },

    // 掠影（疾风刺客）：击杀回血。打不出击杀就喝不到血 —— 纯输出换续航，
    // 和「回春」的恒定小回血形成对比：一个是节奏型、一个是保底型。
    lueYing: {
      name: '掠影',
      desc: '每次击杀回复 4 点生命。',
      onKill: function (player, enemy, state) {
        player.heal(4, { audio: false });
      },
    },

    // 格挡（铁卫武人）：受击时 15% 概率完全挡下。返回 0 让
    // Player.takeDamage 走「格挡成立」分支：不扣血、不闪白、不播痛音、
    // 也不占无敌帧（挡下一击不该换来额外的无敌时间）。
    geDang: {
      name: '格挡',
      desc: '受到攻击时 15% 概率完全格挡。',
      onDamageTaken: function (player, raw) {
        return Math.random() < 0.15 ? 0 : raw;
      },
    },

    // 疾风（裂石弩手）：击杀叠暴击率，永久成长，上限 5 层 ×2% = +10%。
    // 直接写 stats.critChance，所以会进存档；读档不会重复累加。
    jiFeng: {
      name: '疾风',
      desc: '每次击杀暴击率 +2%，最多 5 层。',
      onKill: function (player, enemy, state) {
        var st = player.passiveState;
        var MAX = 5;
        if ((st.critStacks || 0) >= MAX) return;
        st.critStacks = (st.critStacks || 0) + 1;
        player.stats.critChance += 0.02;
      },
    },

    // 贯甲（寒江射手）：非暴击伤害 +25%。与「穿杨」是一对镜像 ——
    // 穿杨放大暴击、贯甲放大平砍，一个吃波动一个吃稳定。
    guanJia: {
      name: '贯甲',
      desc: '非暴击命中伤害 +25%。',
      onHit: function (player, info) {
        return info.crit ? info.dmg : info.dmg * 1.25;
      },
    },

    // 回春（慈心尼师）：每 2 秒回 1 点。慢但恒定，用来拉长战线。
    // 静音：每 2 秒响一次治疗音太吵，只留绿色粒子当提示。
    huiChun: {
      name: '回春',
      desc: '每 2 秒回复 1 点生命。',
      perTick: function (player, state, dt) {
        var st = player.passiveState;
        st.regenAcc = (st.regenAcc || 0) + dt;
        while (st.regenAcc >= 2) {
          st.regenAcc -= 2;
          if (player.stats.hp < player.stats.maxHp) player.heal(1, { audio: false });
        }
      },
    },

    // 禅心（苦行僧）：按所受伤害回血。挨得越多喝得越多，硬抗流的续航。
    // heal 不会回调 takeDamage，没有递归风险。
    chanXin: {
      name: '禅心',
      desc: '受击时回复所受伤害的 30%。',
      onDamageTaken: function (player, raw) {
        if (raw > 0) player.heal(raw * 0.3, { audio: false });
        return raw;
      },
    },

    // 狂战（狂岩巨擘）：击杀叠伤害，永久成长，上限 10 层 ×3% = +30%。
    // stats.damage 是武器伤害倍率，直接写进去即生效且进存档。
    kuangZhan: {
      name: '狂战',
      desc: '每次击杀伤害 +3%，最多 10 层。',
      onKill: function (player, enemy, state) {
        var st = player.passiveState;
        var MAX = 10;
        if ((st.dmgStacks || 0) >= MAX) return;
        st.dmgStacks = (st.dmgStacks || 0) + 1;
        player.stats.damage += 0.03;
      },
    },
  };

  /** 派发角色被动挂点。无被动或该被动没定义此挂点时返回 undefined。 */
  Game.invokePassive = function (player, hook, a, b) {
    var def = player && player.passive;
    if (!def || !def.id) return undefined;
    var reg = Game.PASSIVES[def.id];
    if (!reg || !reg[hook]) return undefined;
    return reg[hook](player, a, b);
  };

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
    // —— Boss 专属武器 —— exclusive: true
    // 只从 Boss 战奖励产出（见 Systems.bossRewardChoices），
    // 普通升级池与商店都必须跳过这类武器。
    moon_sword: {
      id: 'moon_sword', name: '赤月斩', type: 'melee', star: 3, exclusive: true,
      cooldown: 0.5, damage: 30, range: 86, arc: Math.PI * 0.95,
      pierce: 3, projectileSpeed: 0, knockback: 140,
      color: '#ff7a5c', desc: '赤月之力凝成的巨剑，横扫面前一切。',
    },
    jade_crossbow: {
      id: 'jade_crossbow', name: '青玉连弩', type: 'ranged', star: 3, exclusive: true,
      cooldown: 0.34, damage: 9, range: 0, arc: 0,
      pierce: 2, projectileSpeed: 780, knockback: 10,
      color: '#4fbfa0', desc: '青玉驱动连发弩箭，穿透目标。',
    },
  };

  // Boss 战奖励里出现专属武器的概率
  Game.BOSS_EXCLUSIVE_CHANCE = 0.45;

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

    /* ---------------- 反伤系（坦克） ----------------
     * counter：被命中时按此比例把该次伤害反弹给攻击者（走 Player.takeDamage，
     * 所以同样吃护甲 / 护盾 / 无敌帧）。旧怪没有这个字段 = 0，行为完全不变。
     *
     * 只配置给这三个新增单位，且只在 21 波起（无限模式）刷新 —— 见 systems.js
     * 的 pickEnemyType：wave <= 20 时权重为 0，闯关前 20 波的构成不受影响。
     * 波次成长系数见 entities.js：21 波时 hp ×4.6、伤害 ×3.4、移速 ×1.4，
     * 下面三个的反伤比例是按这个量级定的，别单独调高了。
     */
    golem: {
      id: 'golem', name: '石甲力士', behavior: 'chase',
      hp: 200, speed: 48, damage: 14, radius: 24,
      xp: 3, material: 3, attackCd: 1.3,
      counter: 0.15,
      color: '#7a8290', color2: '#3f434d', color3: '#8fd0e8',
    },
    bulwark: {
      id: 'bulwark', name: '铁壁武卒', behavior: 'chase',
      hp: 360, speed: 38, damage: 10, radius: 23,
      xp: 4, material: 4, attackCd: 1.7,
      counter: 0.25,
      color: '#5d6f7d', color2: '#2b333d', color3: '#6fe3c1',
    },
    bruiser: {
      id: 'bruiser', name: '铁拳力士', behavior: 'chase',
      hp: 150, speed: 66, damage: 20, radius: 20,
      xp: 3, material: 3, attackCd: 0.85,
      counter: 0.08,
      color: '#a05a3a', color2: '#4a2418', color3: '#ffd27a',
    },
  };

  /* ---------------- 掉落调参（2026-09-24 起集中在这里调） ----------------
   * 各怪的 xp / material 本体数值冻结不动，倍数在这一处统一加：
   * 改掉落手感只动这里，不用去翻 ENEMIES 表。 */
  Game.DROP = {
    xpMult: 2.0,        // 经验倍数
    matMult: 2.5,       // 材料倍数
    matChance: 0.8,     // 材料掉落概率（0.6→0.8：第 1 波材料要从 ~39 提到 ~80，否则首轮买不起一件装备）
    chestChance: 0.035, // 普通怪掉箱子的概率
    chestHeal: 30,      // 回血箱回复量
    chestMagnetChance: 0.35, // 掉箱子时其中是吸铁石的概率（否则是回血）
    bossChests: ['heal', 'magnet'],  // Boss 固定给的箱子
    bossChestHealMult: 2,  // Boss 回血箱是小怪的两倍 —— 打过 Boss 该有份补偿
    pickupSpeed: 620,   // 被吸起后飞向玩家的初速（px/s）
  };

  /* ---------------- 道具（被动，可叠加） ---------------- */
  // MVP 提供少量被动道具，用于商店与升级池。
  Game.ITEMS = {
    heart:      { id: 'heart',      name: '生命之心', rarity: 'common', desc: '最大生命 +15',            stat: { maxHp: 15 } },
    boots:      { id: 'boots',      name: '疾风之靴', rarity: 'common', desc: '移动速度 +8%',            stat: { speed: 0.08 } },
    blade:      { id: 'blade',      name: '锋锐磨石', rarity: 'rare',   desc: '伤害 +15%',               stat: { damage: 0.15 } },
    trigger:    { id: 'trigger',    name: '轻灵扳机', rarity: 'rare',   desc: '攻击速度 +12%',           stat: { attackSpeed: 0.12 } },
    armorplate: { id: 'armorplate', name: '铁甲片',   rarity: 'rare',   desc: '护甲 +2',                 stat: { armor: 2 } },
    critical:   { id: 'critical',   name: '致命宝石', rarity: 'epic',   desc: '暴击率 +10%',             stat: { critChance: 0.10 } },
    // 下面 6 件补的是此前根本买不到的数值 —— _applyStatDelta 早就支持这些键，
    // 只是没有道具用过（暴击伤害 / 护盾 / 吸血 / 击杀回血 / 治疗强度全都没入口）。
    // healing:true 的四件是续航来源：商店/升级池按 CONST.HEAL_ITEM_WEIGHT 降权，
    // healBuild 角色（掠影/回春/禅心）不受降权。
    herbal:     { id: 'herbal',     name: '回春药草', rarity: 'common', desc: '治疗效果 +25%',           stat: { healingPower: 0.25 }, healing: true },
    vampiric:   { id: 'vampiric',   name: '噬魂之牙', rarity: 'rare',   desc: '造成伤害的 5% 化为生命',   stat: { lifesteal: 0.05 }, healing: true },
    shieldcharm:{ id: 'shieldcharm', name: '玄武纹章', rarity: 'rare',   desc: '护盾上限 +25',            stat: { shieldMax: 25 } },
    lifeluck:   { id: 'lifeluck',   name: '生机之种', rarity: 'rare',   desc: '每次命中回复最大生命 1.2%', stat: { lifeOnHitPct: 0.012 }, healing: true },
    critemerald:{ id: 'critemerald', name: '破军翠玉', rarity: 'epic',   desc: '暴击伤害 +15%',           stat: { critMult: 0.15 } },
    deathbell:  { id: 'deathbell',  name: '夺命金铃', rarity: 'epic',   desc: '每次击杀回复最大生命 3%',  stat: { lifeOnKillPct: 0.03 }, healing: true },
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
  ];
  // 即时回血卡（急救 / 大急救包）已于 2026-09-24 下线：治疗只来自角色被动与吸血，
  // 不该由一张卡瞬间补齐。商店里那张「急救包」也一并移除（见 systems.js rollShopItem）。

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
    /** 扫掠圆碰撞：线段 (x0,y0)→(x1,y1) 是否穿过以 (cx,cy) 为圆心、r 为半径的圆。
     *  按「本帧起点→本帧终点」整条轨迹判定，而不只判终点。单步位移比判定半径大时
     *  （低帧率 + 780px/s 的连弩，一步可走 50 多像素越过 20px 半径），逐帧点检测会
     *  整只跳过敌人。线段含终点，所以命中集严格覆盖旧的点检测 —— 只会多命中，不会漏。
     *  零长线段（本帧没动）自然退化成原点检测。 */
    sweptHit: function (x0, y0, x1, y1, cx, cy, r) {
      var sx = x1 - x0, sy = y1 - y0;
      var len2 = sx * sx + sy * sy;
      var t = len2 > 0 ? ((cx - x0) * sx + (cy - y0) * sy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var dx = cx - (x0 + sx * t), dy = cy - (y0 + sy * t);
      return dx * dx + dy * dy <= r * r;
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
