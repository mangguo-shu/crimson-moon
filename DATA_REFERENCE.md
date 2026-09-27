# 赤月猎场 · 数据字典

全部静态数据集中在 [js/config.js](js/config.js)（唯一配置源）。本文件按表分类列出所有条目与字段，
加新角色 / 武器 / 怪 / 道具 / 卡时对着改即可。数值截至 BUILD `v260926.9`。

---

## 目录

| 章 | 内容 | 条目数 | 所在行 |
|---|---|---|---|
| [1](#1-角色) | 角色 + 字段说明 | 11 | config.js:88 |
| [2](#2-角色被动) | 被动技能 + 5 个挂点 | 11 | config.js:363 |
| [3](#3-武器) | 武器 | 10 | config.js:516 |
| [4](#4-敌人) | 小怪 + Boss | 10 | config.js:551 |
| [5](#5-稀有度) | 稀有度 | 4 | config.js:78 |
| [6](#6-道具) | 被动道具 | 17 | config.js:669 |
| [7](#7-属性卡) | 属性强化卡 | 11 | config.js:694 |
| [8](#8-卡三选一--商店卡) | 卡的四种 kind + 三个出货口 | — | systems.js |
| [9](#9-全局常量与调参系数) | CONST | 20 | config.js:14 |
| [10](#10-掉落调参) | DROP | 9 | config.js:654 |
| [11](#11-公式表) | 波次 / 成长 / 定价 / 伤害算式 | — | 各处 |
| [12](#12-属性键) | 可写进 stat 的属性键 | 12 | entities.js:109 |
| [13](#13-存档与图鉴) | 存档 key / 图鉴 / 纪录 | — | storage.js |
| [14](#14-派生层加新内容必查) | 加了数据还要补的地方 | — | 6 个文件 |
| [15](#15-加新内容检查清单) | 按「加什么」列的清单 | — | — |

---

## 1. 角色

`Game.CHARACTERS`，数组。**字段**：

```
id, name, category, desc,
passive: { id, name, desc },
baseHp, speed, damage, attackSpeed, critChance, critMult, armor,
startWeapon,          // WEAPONS 的 id
body,                 // BODY_GROUPS 的姿态键（4 选 1，决定剪影）
colors: { skin, cloth, cloth2, hair, accent },
healBuild: true       // 可选。续航流：回血卡在商店/升级池不降权
```

姿态分组 `Game.BODY_GROUPS`（config.js:342）：`swordsman 剑客 / archer 弓手 / monk 武僧 / brawler 力士`。

| id | 名称 | 定位 | 被动 | HP | 移速 | 伤害 | 攻速 | 暴击 | 暴伤 | 护甲 | 起始武器 | 姿态 | 续航流 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| swordsman | 流浪剑客 | 敏捷近战 | 连击 | 100 | 220 | 1.00 | 1.00 | 5% | 1.50 | 0 | iron_sword | swordsman | |
| archer | 青木弓手 | 暴击远程 | 穿杨 | 90 | 232 | 0.95 | 1.10 | 16% | 2.00 | 0 | wood_bow | archer | |
| monk | 玄铁武僧 | 坚韧近战 | 金刚 | 140 | 185 | 0.90 | 0.90 | 4% | 1.50 | 12 | temple_staff | monk | |
| brawler | 赤岩力士 | 爆发近战 | 铁骨 | 125 | 205 | 1.15 | 0.85 | 6% | 1.50 | 4 | warhammer | brawler | |
| assassin | 疾风刺客 | 吸血近战 | 掠影 | 95 | 245 | 0.92 | 1.15 | 9% | 1.60 | 0 | iron_sword | swordsman | ✓ |
| guard | 铁卫武人 | 格挡近战 | 格挡 | 135 | 195 | 1.00 | 0.95 | 5% | 1.50 | 10 | iron_sword | swordsman | |
| crossbowman | 裂石弩手 | 叠暴远程 | 疾风 | 92 | 225 | 1.00 | 1.05 | 12% | 1.90 | 0 | heavy_crossbow | archer | |
| ranger | 寒江射手 | 稳定远程 | 贯甲 | 88 | 238 | 1.05 | 1.00 | 7% | 1.60 | 0 | wood_bow | archer | |
| nun | 慈心尼师 | 续航近战 | 回春 | 130 | 200 | 0.85 | 0.95 | 4% | 1.50 | 6 | temple_staff | monk | ✓ |
| ascetic | 苦行僧 | 苦修近战 | 禅心 | 145 | 180 | 0.95 | 0.85 | 4% | 1.50 | 14 | temple_staff | monk | ✓ |
| brute | 狂岩巨擘 | 狂战近战 | 狂战 | 160 | 170 | 1.25 | 0.75 | 5% | 1.60 | 8 | warhammer | brawler | |

- `damage` 是**武器伤害倍率**，不是基础伤害。最终伤害见 [11](#11-公式表)。
- 11 个角色只占 4 套剪影，靠 `colors` 配色区分。刺客/护卫共用剑客姿态，弩手/射手共用弓手姿态。
- **起始武器按身份配**（2026-09-27，用户「目前全是剑和枪不符合人物身份」）：
  之前 11 个角色只有 `iron_sword` / `pistol` 两种开局武器，弓手拿手枪、武僧拿铁剑。
  现在同组角色共用一把身份武器 —— 修行者（武僧/尼师/苦行僧）共用锡杖、
  力量型（力士/巨擘）共用战斧、远程各拿各的弓弩；剑客/刺客/铁卫共用铁剑。
  **手枪不再有任何角色开局**（它是唯一一把「谁的武器都不是」的通用件，仍从池里出）。
  改 `startWeapon` 只影响**新开局**：存档里存的是 `defId` 字符串，读档照旧解析。

---

## 2. 角色被动

`Game.PASSIVES`，对象。`passive.id` 必须和这里的键**同名**，否则被动只是显示文字、进游戏无效。
派发器 `Game.invokePassive(player, hook, a, b)`（config.js:505）。

**可用挂点**（`player` 恒为首参）：

| 挂点 | 签名 | 返回 | 用途 |
|---|---|---|---|
| `onHit` | `(player, {enemy, dmg, crit, weapon})` | 最终伤害 | 增伤 / 条件增伤 |
| `onDamageTaken` | `(player, raw)` | 减免后的伤害 | 减伤 / 格挡（返回 0 = 完全挡下） |
| `onKill` | `(player, enemy, state)` | — | 吸血 / 叠 buff |
| `onWaveStart` | `(player, state, wave)` | — | 开局护盾 |
| `perTick` | `(player, state, dt)` | — | 缓慢回血 |

| id | 名称 | 挂点 | 效果 |
|---|---|---|---|
| combo | 连击 | onHit | 连续命中**同一目标**每层 +5%，上限 6 层；换目标清零 |
| chuanYang | 穿杨 | onHit | 暴击命中再追加 35% |
| jingKang | 金刚 | onDamageTaken + onWaveStart | 承伤 ×0.82；每波开局护盾 = maxHp × 25% |
| tieGu | 铁骨 | onHit | 生命 < 50% 时伤害 ×1.35 |
| lueYing | 掠影 | onKill | 每次击杀回 4 点生命 |
| geDang | 格挡 | onDamageTaken | 15% 概率完全格挡（不吃无敌帧） |
| jiFeng | 疾风 | onKill | 暴击率 +2%/层，上限 5 层；写进 stats 会进存档 |
| guanJia | 贯甲 | onHit | 非暴击伤害 ×1.25（穿杨的镜像） |
| huiChun | 回春 | perTick | 每 2 秒回 1 点（静音，只留绿粒子） |
| chanXin | 禅心 | onDamageTaken | 受击回所受伤害 30% |
| kuangZhan | 狂战 | onKill | 伤害 +3%/层，上限 10 层 |

---

## 3. 武器

`Game.WEAPONS`，对象。**字段**：

```
id, name,
type: 'melee' | 'ranged',
star,             // 初始星级
cooldown, damage,
range,            // 近战射程
arc,              // 挥砍弧度（★ 已作废，只留数据；横扫宽度由 CONST.WEAPON_ARC 决定，
                  //   突刺武器连扇形都没有 —— 龙胆枪的走廊宽度按射程比例算，见下）
pierce,           // 穿透数
projectileSpeed,  // 远程弹速，近战填 0
knockback, color, desc,
exclusive: true   // 可选。Boss 专属：只从 Boss 奖励出，普通池与商店自动跳过
```

| id | 名称 | 类型 | 星 | CD | 伤害 | 射程 | 穿透 | 弹速 | 击退 | 专属 |
|---|---|---|---|---|---|---|---|---|---|---|
| iron_sword | 铁剑 | melee | 1 | 0.70 | 14 | 66 | 1 | — | 60 | |
| spear | 龙胆枪 | melee | 1 | 0.85 | 20 | 130 | 4 | — | 90 | |
| pistol | 手枪 | ranged | 1 | 0.55 | 10 | — | 0 | 620 | 20 | |
| wood_bow | 青木弓 | ranged | 1 | 0.62 | 11 | — | 0 | 580 | 20 | |
| heavy_crossbow | 贯石弩 | ranged | 1 | 0.95 | 22 | — | 4 | 520 | 10 | |
| warhammer | 碎岩战斧 | melee | 1 | 1.10 | 26 | 50 | 1 | — | 170 | |
| temple_staff | 玄铁锡杖 | melee | 1 | 0.82 | 16 | 86 | 1 | — | 90 | |
| moon_sword | 赤月斩 | melee | 3 | 0.50 | 30 | 86 | 3 | — | 140 | ✓ |
| jade_crossbow | 青玉连弩 | ranged | 3 | 0.34 | 9 | — | 2 | 780 | 10 | ✓ |
| blood_scythe | 血月镰 | melee | 3 | 0.58 | 28 | 100 | 1 | — | 120 | ✓ |

- `Game.BOSS_EXCLUSIVE_CHANCE = 0.45`：Boss 奖励里出现专属武器的概率。
- 武器等级倍率 `def.damage × (1 + 0.5 × (level - 1))`，上限 `MAX_WEAPON_LEVEL = 4`。
  **`star` 只用于图鉴标签显示**（`Codex` 的 `★★★`），开局武器一律 `createWeapon(id, 1, 0)`
  从 1 级起 —— 3 星专属的强度来自 `damage` 本体，不是星级。
- **DPS 标尺**（`damage / cooldown`，远程已含 ×`RANGED_DMG_SCALE`）：
  1 星近战对标龙胆枪 23.5、1 星远程对标手枪 10.9。新 1 星武器不超过对标值的 1.3 倍
  （`test/smoke.js` 有断言守着），越级的强度留给 3 星专属。
- **横扫武器的 `pierce` 不作数**：`_meleeAttack` 循环整圈敌人、没有贯穿上限，
  只有 `_thrustAttack` 和远程弹体读 `pierce`。所以横扫武器一律填 `1`（铁剑的口径），
  填别的值就是又造一条「表里躺着但不生效」。
  ⚠ **遗留**：`moon_sword.pierce = 3` 是这条规则确立前留下的值，**不生效**，别按它算。
- 弹体造型**不在表里**，按武器 id 派生：`weapons.js PROJ_SHAPE`。
  `pistol → bullet`，`jade_crossbow` / `wood_bow` / `heavy_crossbow` → `arrow`。
  没登记的远程武器回落 `bullet`。
- 近战**出手方式也不在表里**，按武器 id 派生：`weapons.js MELEE_STYLE`。
  `spear → _thrustAttack`（突刺走廊），没登记 = `_meleeAttack` 横扫扇形。
  走廊半宽 = 有效射程 × `THRUST_HALF`（0.12），是模块本地常量，同样不进表。
  想给别的武器加招式（回旋、横扫、突刺），在这张表登记一行再写一个 `_xxxAttack` 即可，
  签名统一 `(owner, state, aim, claimed)`。
- 环绕卫星的**图标造型也不在表里**，按武器 id 派生：`renderer.js ORBIT_ICON`。每把武器一套：
  `iron_sword → _drawSword`、`spear → _drawSpear`、`moon_sword → _drawGreatsword`、
  `pistol → _drawPistol`、`wood_bow → _drawBow`、`warhammer → _drawHammer`、
  `temple_staff → _drawStaff`、`blood_scythe → _drawScythe`。
  **`jade_crossbow` 和 `heavy_crossbow` 共用 `_drawCrossbow`**，只靠 `color` 分 —— 它本来就是弩，
  换个造型就是假的。漏登记**不报错**，静默回落到 type 默认（近战画剑 / 远程画弩）——
  龙胆枪就这样顶着剑的造型出场过一整个阶段。
  新图标一律用普通描边 + 高光，**不加 `lighter` 发光**（2026-09-27 之后定下的方向）。
- 出手**动作**按武器 id 派生：`renderer.js STRIKE_PROFILE` 给每把武器一套相位占比
  （`windup` 起手后撤 / `strike` 前推 / `hold` 扎住 / `bow` 路径侧向鼓弧），
  缺省回落 `STRIKE_DEFAULT`。波形是「先微幅往后撤 → 前推（ease-out，末端速度归零
  = 扎住了）→ 扎住 → 慢慢收回」，起止都精确落回静止位，前后帧不跳。
  持枪时长 `SWING_DUR_MELEE = 0.42` / `SWING_DUR_RANGED = 0.22`，都在渲染侧本地，
  不进 CONST —— 纯表现参数，逻辑层的冷却不受影响。
  峰值相位 = `windup + strike`，**各武器不一样**，所以测试按窗口采样而不钉死时间。
- 出手**位移**已经不按 id 派生 —— `renderer.js` 里没有 `LUNGE_AMT` 那张表了。近战武器
  整把从轨道布置点**插值到最远处**再收回来，落点距离 = `WeaponInstance.swingRange`。
  这个字段由 `weapons.js` 在近战出手瞬间写成 `this.range()`（已含 ×`MELEE_RANGE_SCALE`），
  和 `swingAim` 同源 —— 判定与画面用同一个数。
  图标缩放恒为 `0.62`：**「弹出去」只靠位置变，不靠画大**。远程武器不弹
  （`swingRange` 只在近战分支记）。
  **光晕已删**（用户 2026-09-27「移除白色光晕」）：原来每把武器外那圈 11px 的脉动环
  走 `lighter` 叠加，武器本色被洗成白斑。现在只剩**强化圈**（Lv2 起每级一圈），
  仍钉在轨道布置点上 —— 那是「这把武器几星」的标记，跟着图标飞走就看不清。
  拖影也改成普通半透明（不用 `lighter`），读起来是运动模糊而不是发光。
- 近战特效只剩横扫 `FX.slash`（扇形，宽 = `WEAPON_ARC`）。**`FX.thrust` 已下线** ——
  原来那条枪线（武器色辉光 + `#fff6d8` 鎏金亮芯 + 白枪尖点）就是被点名的白色特效。
  突刺改由环绕卫星自己演（`STRIKE_PROFILE` 推出去、扎住、收回），
  **枪尖那一点光**挂在 `_drawSpear` 的 `fire` 上（鎏金小菱形，武器本体长度的 8%）。
  `FX.slash` 也去掉了 `#fff6d8` 亮芯，只剩武器本色。
  刀光仍从玩家身上发出 —— 特效和命中范围必须同圆心。
- 远程伤害 ×0.6、近战射程 ×1.25 —— 走 CONST 系数，表本体不动。

---

## 4. 敌人

`Game.ENEMIES`，对象。**字段**：

```
id, name,
behavior: 'chase' | 'flyer' | 'shooter' | 'boss',
hp, speed, damage, radius,
xp, material, attackCd,
color, color2, color3,
projectileSpeed,   // 远程怪 / 会喷弹的 Boss
boss: true,        // ★ 认 Boss 身份的唯一依据
attack: 'fan'|'charge'|'ring'|'spiral',  // Boss 套路，见 entities.js:432 BOSS_ATK_METHOD
dashSpeed,         // 冲撞型 Boss 的冲撞速度
counter: 0.15      // 反伤比例（坦克），被命中时反弹该次伤害
```

### 4.1 小怪（6）

| id | 名称 | 行为 | HP | 移速 | 伤害 | 半径 | 经验 | 材料 | 攻CD | 特殊 |
|---|---|---|---|---|---|---|---|---|---|---|
| zombie | 跳尸 | chase | 20 | 70 | 8 | 15 | 1 | 1 | 0.9 | |
| bat | 蝠妖 | flyer | 12 | 128 | 6 | 11 | 1 | 1 | 0.7 | |
| wizard | 邪修道人 | shooter | 30 | 62 | 10 | 15 | 2 | 2 | 2.2 | 弹速 240 |
| golem | 石甲力士 | chase | 200 | 48 | 14 | 24 | 3 | 3 | 1.3 | 反伤 0.15 |
| bulwark | 铁壁武卒 | chase | 360 | 38 | 10 | 23 | 4 | 4 | 1.7 | 反伤 0.25 |
| bruiser | 铁拳力士 | chase | 150 | 66 | 20 | 20 | 3 | 3 | 0.85 | 反伤 0.08 |

三个坦克（golem/bulwark/bruiser）**只在 21 波起刷**，前 20 波权重为 0，闯关构成不受影响。

### 4.2 Boss（4）

`Game.BOSSES = ['boss', 'boss_brute', 'boss_mage', 'boss_spider']`（config.js:649）
出场：第 10 波 `[0]`、第 20 波 `[1]`……按 `floor(wave/10)` 取模循环。`'boss'` 必须留首位（旧存档引用）。

| id | 名称 | 套路 | HP | 移速 | 伤害 | 半径 | 经验 | 材料 | 攻CD | 弹速/冲撞 |
|---|---|---|---|---|---|---|---|---|---|---|
| boss | 赤月年兽 | fan 扇形弹幕 + 召唤 | 600 | 55 | 16 | 42 | 30 | 40 | 1.4 | 200 |
| boss_brute | 蛮荒冲兽 | charge 蓄力预警 + 冲撞 | 700 | 46 | 22 | 44 | 34 | 44 | 2.1 | 冲撞 620 |
| boss_mage | 血月咒使 | ring 360° 环绕弹排 | 540 | 50 | 15 | 34 | 32 | 42 | 2.0 | 210 |
| boss_spider | 天罗蛛后 | spiral 连续螺旋弹幕 | 660 | 58 | 14 | 38 | 36 | 46 | 0.85 | 190 |

血量刻意压在 540~700：**600 是赤月年兽，真机校准过的标尺**，新 Boss 拿它对齐。
别堆到 900+ —— 波次成长已 ×4 以上，再叠第一波就打不穿。

配色三色：`color` 主体 / `color2` 暗部 / `color3` 高亮（反伤怪读 `color3` 画反光）。

---

## 5. 稀有度

`Game.RARITY`（config.js:78）。CSS 里对应 `.r-common / .r-rare / .r-epic / .r-legend`。

| key | 名称 | 主色 | 定价基线 | 在用条目数 |
|---|---|---|---|---|
| common | 普通 | `#d8d8d8` | 15 | 道具 3 · 卡 3 |
| rare | 稀有 | `#4fa3ff` | 35 | 道具 6 · 卡 3 |
| epic | 史诗 | `#b06bff` | 55 | 道具 7 · 卡 5 |
| legend | 传奇 | `#ffcf5e` | 85 | 道具 1 · 卡 0 |

商店里的武器和「武器强化」卡固定按 `rare` 定价。

---

## 6. 道具

`Game.ITEMS`，对象。被动、可叠加。**字段**：

```
id, name, rarity, desc,
stat: { ... }      // 见 [12](#12-属性键)
healing: true      // 可选。回血类：商店/升级池按 CONST.HEAL_ITEM_WEIGHT 降权，
                   // 但 healBuild 角色（刺客/尼师/苦行僧）不降
```

| id | 名称 | 稀有度 | 效果 | stat | 回血类 |
|---|---|---|---|---|---|
| heart | 生命之心 | common | 最大生命 +15 | `maxHp: 15` | |
| boots | 疾风之靴 | common | 移动速度 +8% | `speed: 0.08` | |
| blade | 锋锐磨石 | rare | 伤害 +15% | `damage: 0.15` | |
| trigger | 轻灵扳机 | rare | 攻击速度 +12% | `attackSpeed: 0.12` | |
| armorplate | 铁甲片 | rare | 护甲 +2 | `armor: 2` | |
| critical | 致命宝石 | epic | 暴击率 +10% | `critChance: 0.10` | |
| herbal | 回春药草 | common | 治疗效果 +8% | `healingPower: 0.08` | ✓ |
| vampiric | 噬魂之牙 | rare | 造成伤害的 1% 化为生命 | `lifesteal: 0.01` | ✓ |
| shieldcharm | 玄武纹章 | rare | 护盾上限 +25 | `shieldMax: 25` | |
| lifeluck | 生机之种 | rare | 每次命中回复最大生命 0.3% | `lifeOnHitPct: 0.003` | ✓ |
| critemerald | 破军翠玉 | epic | 暴击伤害 +15% | `critMult: 0.15` | |
| deathbell | 夺命金铃 | epic | 每次击杀回复最大生命 0.5% | `lifeOnKillPct: 0.005` | ✓ |
| bloodmoon_heart | 赤月之心 | **legend** | 造成伤害的 3% 化为生命 | `lifesteal: 0.03` | ✓ |
| war_god_bracer | 战神护腕 | epic | 伤害 +12%，攻击速度 +8% | `damage: 0.12, attackSpeed: 0.08` | |
| shadow_cloak | 疾影披风 | epic | 移动速度 +12%，暴击率 +5% | `speed: 0.12, critChance: 0.05` | |
| bulwark_core | 玄武核心 | epic | 最大生命 +30，护甲 +3 | `maxHp: 30, armor: 3` | |
| greedy_fang | 贪狼之牙 | epic | 命中回最大生命 0.4%，伤害的 0.8% 化生命 | `lifeOnHitPct: 0.004, lifesteal: 0.008` | ✓ |

**`desc` 是写死文案** —— 改 `stat` 必须同步改 `desc`，否则面板写的和实际不一样。
回血四项被砍过两轮（2026-09-26），基线是「每次事件回复最大生命的 0.x%」。

---

## 7. 属性卡

`Game.UPGRADES`，数组。**字段**：`type: 'stat', rarity, label, desc, apply: { ... }`

| 名称 | 稀有度 | 效果 | apply |
|---|---|---|---|
| 生命强化 | common | 最大生命 +20 | `maxHp: 20` |
| 敏捷脚步 | common | 移动速度 +6% | `speed: 0.06` |
| 力量训练 | common | 伤害 +10% | `damage: 0.10` |
| 迅捷出手 | rare | 攻击速度 +10% | `attackSpeed: 0.10` |
| 致命直觉 | rare | 暴击率 +8% | `critChance: 0.08` |
| 厚实护甲 | rare | 护甲 +2 | `armor: 2` |
| 血气旺盛 | epic | 最大生命 +35 | `maxHp: 35` |
| 迅影步伐 | epic | 移动速度 +12% | `speed: 0.12` |
| 狂暴之刃 | epic | 伤害 +18% | `damage: 0.18` |
| 疾风连击 | epic | 攻击速度 +18% | `attackSpeed: 0.18` |
| 战神之躯 | epic | 护甲 +4 | `armor: 4` |

即时回血卡（急救包）**已下线** —— 治疗只来自角色被动与吸血，不由一张卡瞬间补齐。

---

## 8. 卡（三选一 / 商店卡）

卡不是独立表，是四种 **kind**，由三个出货口临时组装：

| kind | 来源表 | 名字取自 | 说明 |
|---|---|---|---|
| `upgrade` | `Game.UPGRADES` | `label` | 属性强化 |
| `item` | `Game.ITEMS` | `name` | 被动道具 |
| `weapon` | `Game.WEAPONS` | `name` | 新武器（槽位满时不出现） |
| `weaponUpgrade` | — | 固定「武器强化」 | 通用卡，随机强化一把武器到最高 4 星；**没有自己的 id** |

### 三个出货口

| 出货口 | 位置 | 构成 |
|---|---|---|
| 升级三选一 | `systems.js:466 rollLevelUpChoices` | 全部属性卡（现 11）+ 全部道具（现 17）+（槽位未满）全部非专属武器（现 7）/（满）武器强化 |
| Boss 战利品 | `systems.js:500 bossRewardChoices` | **只收 epic/legend** + 武器强化 + 普通武器 + 按 45% 概率塞 1 把专属武器 |
| 商店（固定 4 格） | `systems.js:636 rollShopItem` | 道具 50% / 武器 50%，道具按件均分、武器按把均分 |

**通用规则**：
- 回血道具按 `HEAL_ITEM_WEIGHT = 0.08` 降权，`healBuild` 角色拿满权。
- **每波去重**：`state.waveSeen` 记录本波出过的卡，抽干才放行。
- 商店卡可**锁定**（沿用上一波的卡，不再重抽）。
- 商店武器固定 `rarity: 'rare'` 定价；`weaponUpgrade` 也是 `rare`。
- **三个出货口都不给死卡**：全部武器满星时不出「武器强化」（扣钱没效果比今天没有这张卡糟）。

---

## 9. 全局常量与调参系数

`Game.CONST`（config.js:14）：

| 键 | 值 | 含义 |
|---|---|---|
| `BUILD` | `v260926.9` | 版本戳，画在画布右下角 |
| `LOGICAL_W / LOGICAL_H` | 1280 / 720 | 参考逻辑视口 |
| `WORLD_W / WORLD_H` | 2400 / 1800 | 地图世界尺寸 |
| `MAX_WEAPONS` | 6 | 武器槽上限 |
| `MAX_WEAPON_LEVEL` | 4 | 武器最高星 |
| `WEAPON_ORBIT_R` | 62 | 武器环绕轨道半径 |
| `WEAPON_ORBIT_SPEED` | 0.25 | 轨道转速 rad/s（整圈 25s） |
| `WEAPON_ORBIT_OFFSET` | -π/2 | 第一把武器基准角 |
| `WEAPON_ARC` | π/3 | 挥砍扇形宽度（360°/6，只决定刀光宽度，**不管索敌**） |
| `RANGED_DMG_SCALE` | 0.5 | 远程伤害 ×0.5（0.6 → 0.5，「还要再削」） |
| `MELEE_DMG_SCALE` | 0.8 | 近战伤害 ×0.8（新增：近战从没被压过一档，环绕后它能打到身后） |
| `MELEE_RANGE_SCALE` | 1.25 | 近战射程 ×1.25 |
| `MAX_ALIVE_ENEMIES` | 28 | 同屏活怪上限（波次不清场之后必须有；改前峰值 38） |
| `ENEMY_HP_K1` | 0.15 | 敌人血量线性项，见下 |
| `ENEMY_HP_K2` | 0.007 | 敌人血量二次项系数 |
| `ENEMY_DMG_K1` | 0.16 | 敌人伤害线性项 |
| `SHIELD_REGEN_SCALE` | 0 | 护盾**不自动回充**。代码路径保留（`heal()` 的过量治疗仍会转护盾），系数置 0 而不是删分支 |
| `PARTICLE_LOW / MID / HIGH` | 200 / 500 / 800 | 分档粒子上限 |
| `LOW_HP_RATIO` | 0.3 | 濒死阈值 |
| `HEAL_ITEM_WEIGHT` | 0.08 | 回血道具相对权重（0.28 → 0.15 → 0.08） |

国风调色板 `Game.PALETTE`（config.js:60）：outline / stone / stone2 / mortar / moss / moss2 / wood / woodDark / tile / lantern / gold / paper / jade / sky。

---

## 10. 掉落调参

`Game.DROP`（config.js:654）—— 各怪 `xp`/`material` 本体冻结，倍数统一加在这里：

| 键 | 值 | 含义 |
|---|---|---|
| `xpMult` | 2.0 | 经验倍数 |
| `matMult` | 2.5 | 材料倍数 |
| `matChance` | 0.8 | 材料掉落概率 |
| `chestChance` | 0.035 | 普通怪掉箱子的概率 |
| `chestHealPct` | 0.12 | 回血箱回复**最大生命的 12%** |
| `chestMagnetChance` | 0.35 | 掉箱子时是吸铁石的概率（否则是回血） |
| `bossChests` | `['heal', 'magnet']` | Boss 固定给的箱子 |
| `bossChestHealMult` | 2 | Boss 回血箱是小怪的两倍 |
| `pickupSpeed` | 620 | 掉落物飞向玩家的初速 |

---

## 11. 公式表

| 公式 | 表达式 | 位置 |
|---|---|---|
| 波次时长 | `min(45, 20 + (wave - 1))`，Boss 波再 +45 | systems.js:56 |
| 波次刷怪预算 | `22 + wave × 10`，Boss 波 ×0.6（下限 10） | systems.js:82 |
| 刷新间隔 | `0.5 - min(0.26, wave × 0.01)` | systems.js:98 |
| Boss 波判定 | `wave % 10 === 0` | systems.js:62 |
| 巫师权重 | `0.07 + min(0.13, wave × 0.01)`；蝠妖固定 0.3；余下是跳尸 | systems.js:129 |
| 坦克权重 | `wave ≥ 21` 时 `min(0.14, 0.08 + (wave-21) × 0.002)` | systems.js:124 |
| 敌人成长 | HP `×(1 + K1(w-1) + K2(w-1)²)`，伤害 `×(1 + K1'(w-1))`，移速 `×min(1.6, 1 + 0.02(w-1))`（K1=0.15 / K2=0.007 / K1'=0.16） | entities.js 构造函数 |
| 敌人血量参考 | 跳尸 w1 / w10 / w20 / w40 = 20 / 58 / 128 / 350（改前 20/52/88/160）。**二次项是必须的**：玩家输出按乘法涨（等级×1.5/级、卡、暴击、多把武器），纯线性追不上 | entities.js 构造函数 |
| 武器伤害 | `def.damage × (1 + 0.5 × (level - 1)) × 类型系数 × stats.damage`（类型系数：远程 `RANGED_DMG_SCALE`、其余 `MELEE_DMG_SCALE`） | weapons.js:77 `damage()` |
| 商店定价 | `基线 + wave × 2`，下限 5；基线 common 15 / rare 35 / epic 55 / legend 85 | systems.js `priceFor` |
| 反伤 | 被命中时反弹**该次伤害**的 `counter`，走 `Player.takeDamage`（吃护甲/护盾/无敌帧） | entities.js |
| 挡伤 | `护甲 / (护甲 + 30)`，上限 80% | entities.js `takeDamage` |
| 治疗 | `amount × stats.healingPower`，过量治疗转护盾 | entities.js:134 |

---

## 12. 属性键

可写进 `ITEMS.stat` / `UPGRADES.apply` 的键，由 `Player._applyStatDelta`（entities.js:109）识别。

| 键 | 类型 | 用在哪 |
|---|---|---|
| `maxHp` | 绝对值 | 生命之心、生命强化、血气旺盛 |
| `speed` | 百分比 | 疾风之靴、敏捷脚步 |
| `damage` | 百分比 | 锋锐磨石、力量训练 |
| `attackSpeed` | 百分比 | 轻灵扳机、迅捷出手 |
| `critChance` | 百分比 | 致命宝石、致命直觉 |
| `critMult` | 百分比 | 破军翠玉 |
| `armor` | 绝对值 | 铁甲片、厚实护甲 |
| `healingPower` | 百分比 | 回春药草 |
| `lifesteal` | 百分比 | 噬魂之牙 |
| `shieldMax` | 绝对值 | 玄武纹章 |
| `lifeOnHitPct` | 最大生命比例 | 生机之种 |
| `lifeOnKillPct` | 最大生命比例 | 夺命金铃 |

下限钳制：`speed ≥ 80`，`attackSpeed ≥ 0.4`。
`lifeOnHit` / `lifeOnKill` 两个键**代码支持但没有任何道具用**（用的是带 `Pct` 的版本）。

---

## 13. 存档与图鉴

| 存档 key | 内容 | 位置 |
|---|---|---|
| `campaign_v1` | 闯关存档（20 波通关 → 转无尽） | storage.js:38 |
| `endless_v1` | 无尽存档 | storage.js:39 |
| `profile_v1` | 全局档案 + 纪录榜 | storage.js:40 |
| `settings_v1` | 设置 | storage.js:53 |
| `codex_v1` | 图鉴收录（lifetime 进度，`deleteSave` **不动它**） | storage.js:42 |

- 游戏模式：`campaign`（20 波）/ `endless`（无尽），`Game.pendingMode` 在角色选择后写入。
- 图鉴 `js/codex.js`：5 栏（英雄 / 怪物 / BOSS / 装备 / 卡组），共 **60 条**（11 角色 + 6 怪 + 4 Boss + 10 武器 + 29 张卡）。总数是 `Codex.total()` 运行时从 config 表累加的，**没有写死在 codex.js 里**；写死的是 `test/smoke.js` 的断言（装备栏条目数 + 总数 + 两处 UI 进度文案 `全部收录 x / 60`）。记「见过」不记「拥有」。
- 纪录榜 `js/records.js`：`TOP_N = 10`。
- **随机数一律走 `state.rng`**（`Game.mulberry32`，config.js:708）。刷新计划用 `hashSeed(seed + ':' + wave)` 绑定的独立 RNG，保证读档一致。用裸 `Math.random()` 会让存档不可复现。`pickBossType` 是纯查表，不消耗随机流。

---

## 14. 派生层（加新内容必查）

`config.js` 之外的**派生代码**。加了新数据不补这些地方，会静默失效：

| 模块 | 位置 | 干什么 |
|---|---|---|
| systems.js:75 | `buildSpawnSchedule` | 刷新计划 |
| systems.js:117 | `pickEnemyType` | 怪种权重（**新怪不进来不会刷**） |
| systems.js:137 | `pickTankType` | 坦克品种按波次切换 |
| systems.js:62/68 | `isBossWave` / `pickBossType` | Boss 波与轮换 |
| entities.js:432 | `BOSS_ATK_METHOD` | Boss 套路 → 方法名映射，**新套路必须登记**（缺省回落 `fan`） |
| entities.js:460 起 | `_bossAtkFan/Charge/Ring/Spiral` | 各套路实现 |
| weapons.js `PROJ_SHAPE` | 弹体造型按武器 id 派生，**漏登记回落 `bullet`**（弓/弩必须登记成 `arrow`） |
| weapons.js `MELEE_STYLE` | 近战出手方式按武器 id 派生，**漏登记 = 走横扫**（想要突刺/回旋必须登记） |
| weapons.js `THRUST_HALF` | 突刺走廊半宽比例（模块本地常量，不在表里） |
| renderer.js `ORBIT_ICON` | 环绕卫星图标按武器 id 派生（**漏登记静默回落剑/弩**）。
  同类武器可以共用一个绘制函数（`jade_crossbow` 与 `heavy_crossbow` 都走 `_drawCrossbow`），只靠 `color` 分 |
| renderer.js `_drawXxx` | 上面那些绘制函数的本体。新写一个要注意：图标由多个 `fill()` 组成，
  必须**朝前伸**（局部 -y 端比 +y 端长），否则玩家看到的是柄朝前 |
| `CHARACTERS.startWeapon` | 跨表引用 `WEAPONS` 的 id：必须存在、**必须非 `exclusive`**（专属只走 Boss 奖励）。
  读档存的是 `defId` 字符串，所以改 `startWeapon` 只影响新开局，旧存档不受影响 |
| renderer.js `STRIKE_PROFILE` | 出手**动作**按武器 id 派生（windup/strike/hold/bow 四个相位占比），
  **漏登记回落 `STRIKE_DEFAULT`**（通用挥砍，不鼓弧） |
| weapons.js `swingRange` | 近战出手瞬间记下的有效射程（`this.range()`），卫星图标弹到的落点距离；
  **渲染侧不重算 `def.range × MELEE_RANGE_SCALE`**，和 `swingAim` 同源 |
| renderer.js `_drawOrbitWeapons` 里的 `pose()` | 图标位置按 `STRIKE_PROFILE` 的波形从轨道布置点插值到 `swingRange`（近战），
  远程不动；`bow > 0` 时路径中段向侧向鼓弧（枪要直、刀要弯） |
| renderer.js `SWING_DUR_MELEE` / `SWING_DUR_RANGED` | 持枪时长（0.42 / 0.22s），渲染侧本地，**不进 CONST** |
| renderer.js `_drawEffects` | 特效 `switch(f.type)`：`slash`（横扫）、`muzzle`（枪口焰）。
  **`thrust` 分支已删** —— 突刺不再有特效线，改由卫星自己演 |
| renderer.js:507 | `R._PLAYER_BODY` | 4 套姿态绘制 |
| renderer.js:1001 | `_drawEnemy` 的 `switch(e.type)` | **新怪不加 case 会画成跳尸** |
| renderer.js | `FOOT_Y` | 各怪的脚底支点（缺省 `FOOT_Y_DEFAULT`） |
| codex.js:36/37 | `BEHAVIOR` / `ATTACK` 中文标签 | 图鉴显示用，**故意不加进冻结的 ENEMIES 表** |
| ui.js | `renderLevelUp` / `renderShop` | 卡片 `kind` 分流 |
| ui.js:~289 | 伤害分解式（右列 dmg 必须等于左列连乘） | 近战走 `MELEE_DMG_SCALE`、远程走 `RANGED_DMG_SCALE`，
  **两个系数都得写进分解式** —— 漏一个就会写出「14 × 1 × 1 = 14」而右边显示 11.2 |
| weapons.js `damage()` | 伤害总系数：`type === 'ranged'` 走 `RANGED_DMG_SCALE`，否则 `MELEE_DMG_SCALE`。
  **新武器不填 `type` 就吃近战系数**（不是免削） |
| systems.js:54 | `state.uidBase` | 造 state 时记下 `Enemy._uid` 的会话累积值，撤边位置靠 `uid - uidBase` 派生。
  `Enemy._uid` 是会话全局自增，不扣基准的话同一存档在不同会话会退到不同的边 |
| systems.js:196/212 | `_hash01` / `retreatSurvivors` | 波末把残怪撤到地图外边缘。**刻意不碰 `state.rng`**：
  `buildSpawnSchedule` 吃 `state.rng` 排刷怪表，多消费一次随机数整局排程就会漂 |
| systems.js:302 | `endWaveCleanup` | 波末清理：只留「活着的非 Boss 怪」，清死的、清 Boss、清敌人弹、保留玩家弹。
  名字和语义相反（不是 clearEnemies），调用点 4 处 |
| systems.js:234-244 | 刷怪循环里的 `MAX_ALIVE_ENEMIES` 上限 | 到上限就 `break` 停手、**不跳过也不丢弃**，
  `spawnIndex` 卡住，腾出空位接着刷 —— 所以一波的总预算没变，只是同屏封顶 |
| systems.js:639 | `anyWeaponUpgradable` | 三个出货口（升级三选一 / Boss 奖励 / 商店）共用的「还有没有武器可升」判定。
  **满星时三个池子都不能再出任何武器卡**，否则选了等于空过一轮升级 |

---

## 15. 加新内容检查清单

**加角色**（复用已有剪影，算配置）
1. `CHARACTERS` 加一条
2. `PASSIVES` 注册同名 `id` 的挂点（不写 = 被动只是显示文字）
3. `body` 填 4 组之一，`startWeapon` 填已有武器 id

**加新职业剪影**（第 5 组）
上面 3 条 + `BODY_GROUPS` 加键 + `renderer._PLAYER_BODY` 写一套 `torso/headwear/limbs`

**加敌人**
1. `ENEMIES` 加一条
2. `renderer._drawEnemy` 加 `case` + 写 `_drawXxx`
3. `FOOT_Y` 加一行
4. `systems.js` `pickEnemyType` 加权重

**加 Boss**
1. `ENEMIES` 加 `boss: true, attack: 'xxx'`
2. `entities.js` `BOSS_ATK_METHOD` 登记 `attack`
3. 写 `_bossAtkXxx`
4. `renderer` 加 draw + `switch` case
5. **push 进 `Game.BOSSES`** —— 只写进 ENEMIES 不会被刷出来，`pickBossType` 只查 BOSSES 表

**加武器**
1. `WEAPONS` 加一条（记得带 `color` —— 刀光/枪线特效 `renderer.js` 和弹体颜色都读它，缺了画成 `undefined`）。
   **数值别越级**：1 星武器 DPS 不超过同类型现有最强的 1.3 倍（`test/smoke.js` 守着这条），
   越级的强度留给 3 星专属。
   **横扫武器的 `pierce` 一律填 1**（`_meleeAttack` 不读它，填别的就是死数据，见第 3 章）。
2. 远程弹补 `weapons.js PROJ_SHAPE`（弓和弩是 `arrow`，不是 `bullet`）
3. **`renderer.js ORBIT_ICON` 登记图标 + 写 `_drawXxx`**（漏了不报错，会静默顶着剑或弩的造型出场）。
   绘制函数必须**朝前伸**（局部 -y 端比 +y 端长），有断言守着；
   同类武器可以共用一个绘制函数只靠颜色分。不加 `lighter` 发光。
4. **不是横扫就补 `weapons.js MELEE_STYLE`**，写一个 `_xxxAttack`（签名
   `(owner, state, aim, claimed)`）。**不用为它写 `FX.xxx` 特效** —— 突刺那条枪线
   已经下线了（第 3 章），动作由环绕卫星自己演，枪尖那一点光挂在 `_drawSpear` 的
   `fire` 参数上。走廊的宽度不画出来：被扎中的怪自己会闪白掉血字。
5. **想要和默认不同的出手节奏就补 `renderer.js STRIKE_PROFILE` 一行**（windup/strike/hold/bow）。
   不补也行 —— 回落 `STRIKE_DEFAULT`（通用挥砍波形，不鼓弧）。
   枪要「直着扎出去、扎住、慢慢收回」就把 `bow` 留 0；刀要「划一道弧」就给 0.10~0.13。
   图标前推**不用登记任何东西** —— 它自动从轨道弹到 `swingRange`（近战分支里写下的
   有效射程，见第 3 章那条），横扫和突刺一视同仁
6. 专属加 `exclusive: true`（三个出货口会自动跳过，只走 Boss 奖励）。
   **专属武器不能当 `CHARACTERS.startWeapon`** —— 它是 Boss 战利品，不是开局装备

`commonWeaponIds()` 只排除 `exclusive`，非专属武器自动进升级池 + 商店 + Boss 奖励。
商店武器权重是 `0.5 / 武器数` —— **多一把非专属武器会摊薄所有武器在商店的出现率**，
加武器等于在调这个隐性的期望值。现非专属 7 把 → 每把 7.1%，2026-09-26 之前是 3 把 → 16.7%。
专属武器不摊薄（走 Boss 奖励的 45% 位），所以**想加武器又不想稀释普通池，就标 `exclusive`**。

**加道具**：`ITEMS` 加一条即可，三个出货口自动收录。**`desc` 与 `stat` 同步改**。

**加属性卡**：`UPGRADES` 加一条即可。注意 `bossRewardChoices` 只收 `epic/legend`。

**改完跑 `npm test`** —— 基线 1021 + 10 全绿。哪张表漏了登记点会立刻红。

---

## 数值冻结约定

`WEAPONS` / `ENEMIES` / `UPGRADES` 本体**冻结**，改前先确认。合法调参层：

- `CONST` 具名系数（`RANGED_DMG_SCALE` / `MELEE_RANGE_SCALE` / `SHIELD_REGEN_SCALE` / `WEAPON_ARC` / `WEAPON_ORBIT_*` / `HEAL_ITEM_WEIGHT`）
- `Game.DROP`
- `systems.js` 的 `buildSpawnSchedule` / `pickEnemyType` / `priceFor`
- `ITEMS` **不在冻结范围**

前提：**没有界面在显示那个原始值**。ITEMS 的 `desc` 是写死文案，有文案就只能整条改 `stat` + `desc`。

**冻结约束的是「改已有条目的数值」，不是「加新条目」。** 表本体新增是另一回事，要单独授权
（2026-09-26 那批武器/道具/卡就是明确授权的新增）。而且 `ITEMS` 一直不在冻结范围。
判据：如果改动会让某个已经在跑的存档或界面出现不一致，那就是调参，得走系数层；
如果只是一个全新的、此前不存在的条目，那就是扩展。
