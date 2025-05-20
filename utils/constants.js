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
export const EVASIVE_PRE_COMBAT_ESCAPE_CHANCE = 0.4; // 40%

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
