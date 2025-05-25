// camellia-plugin/utils/constants.js

/**
 * @file 存储游戏插件中使用的常量。
 * @description 这个文件包含了游戏逻辑、策略、消息长度限制等多种常量。
 */

// 各种行动策略及其对应的战斗和搜寻概率
export const STRATEGY_PROBABILITY = {
    '猛攻': { fight: 0.8, search: 0.2 }, // 猛攻策略：80%战斗，20%搜寻
    '均衡': { fight: 0.5, search: 0.5 }, // 均衡策略：50%战斗，50%搜寻
    '避战': { fight: 0.2, search: 0.8 }  // 避战策略：20%战斗，80%搜寻
};

// 有效的策略名称列表
export const VALID_STRATEGIES = Object.keys(STRATEGY_PROBABILITY);

// 单条消息的最大长度限制
export const MAX_MESSAGE_LENGTH = 350;

// 避战策略在战斗前成功逃脱的概率
export const EVASIVE_PRE_COMBAT_ESCAPE_CHANCE = 0.8; // 40%

// 战败后无伤逃脱的概率
export const POST_COMBAT_ESCAPE_UNHARMED_CHANCE = 0.15; // 15%

// 战败后负伤逃脱的概率
export const POST_COMBAT_ESCAPE_WOUNDED_CHANCE = 0.35; // 35%

// 默认的后备物品名称，当搜寻失败时可能使用
export const DEFAULT_FALLBACK_ITEM_NAME = "应急口粮棒";

// 初始武器名称 (不可出售、不可被夺走)
export const INITIAL_WEAPON_NAME = "制式警棍";

export const QUEUE_CHECK_INTERVAL = 60 * 1000; // 单位是毫秒，这里代表60秒（1分钟）

export const DEFAULT_NPC_FILL_DELAY_MINUTES = 5;

export const INJURY_LEVELS = {
    light: { name: '轻伤', cost: 15 },
    medium: { name: '一般伤', cost: 50 },
    heavy: { name: '重伤', cost: 100 },
    none: { name: '无伤', cost: 0 }
};

// --- 新增佣兵与竞技场常量 ---

// 佣兵招募费用
export const MERCENARY_RECRUIT_COST = 200; // 单次招募费用
export const MERCENARY_RECRUIT_TEN_COST = 1900; // 十连招募费用 (可选，如果打折)

// 佣兵最大进阶等级
export const MERCENARY_MAX_EVOLUTION_LEVEL = 5;

// 佣兵满级后重复获得奖励
export const MERCENARY_MAX_LEVEL_DUPLICATE_REWARD = 1000; // 金币

// 佣兵招募概率 (星级: 概率) - 总和应为 1
export const MERCENARY_RARITY_PROBABILITY = {
    1: 0.20, // 60%
    2: 0.45, // 25%
    3: 0.30, // 10%
    4: 0.04, // 4%
    5: 0.01  // 1%
};

// 竞技场队伍最大佣兵数量
export const ARENA_TEAM_SIZE = 5;

// 竞技场胜利奖励范围
export const ARENA_WIN_REWARD_MIN = 10;
export const ARENA_WIN_REWARD_MAX = 2000;

// 竞技场第三方AI API端点
export const ARENA_AI_API_ENDPOINT = "api2.aigcbest.top/v1/chat/completions"; // 请替换为实际的OpenAI兼容API端点
export const ARENA_AI_MODEL_NAME = "gemini-2.5-pro-preview-03-25"; // 或你使用的模型

export const ARENA_BATTLE_MIN_TURNS = 3;
export const ARENA_BATTLE_MAX_TURNS = 5;

export const TEN_PULL_GUARANTEE_MIN_RARITY = 3;
// --- 光之种系统常量 ---
/**
 * 重复获得已满级佣兵时，根据稀有度（3星及以上）获得的光之种数量
 * @type {Object<number, number>} 格式: { Rarity: SeedsGained }
 */
export const SEED_OF_LIGHT_GAIN_ON_DUPLICATE = {
    3: 1,
    4: 10,
    5: 50
};

export const MERCENARY_MAX_LEVEL_DUPLICATE_REWARD_LOW_RARITY = 50;
/**
 * 佣兵进阶消耗的光之种数量，基于佣兵的【基础稀有度】
 * @type {Object<number, number>} 格式: { Rarity: CostPerEvolution }
 */
export const MERCENARY_EVOLUTION_COST_SEED_OF_LIGHT = {
    1: 1,
    2: 1,
    3: 10,
    4: 50,
    5: 150
};
export const PITY_5STAR_THRESHOLD = 60;
// 超过阈值后，每次招募额外增加的5星概率
export const PITY_5STAR_RATE_INCREMENT = 0.02;
export const SEED_SHOP_REFRESH_HOUR_UTC = 0; // UTC时间的0点刷新，可根据需要调整为服务器本地时间的特定小时

export const SEED_SHOP_CONFIG = {
    slots: [
        { rarity: 5, count: 1, price: 200 },
        { rarity: 4, count: 2, price: 100 },
        { rarity: 3, count: 3, price: 50 }
    ]
};
export const MERCENARY_UP_RECRUIT_COST = 200;
export const MERCENARY_UP_RECRUIT_TEN_COST = 1900;
export const AI_ARENA_COOLDOWN_MINUTES = 10;
// 用于在 dataManager 中定义文件名
export const DAILY_SEED_SHOP_FILE_NAME = 'dailySeedShop.json';
export const UP_POOL_FILE_NAME = 'upMercenaryPool.json';