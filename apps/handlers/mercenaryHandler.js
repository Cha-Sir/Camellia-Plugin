// camellia-plugin/apps/handlers/mercenaryHandler.js

/**
 * @file 佣兵系统相关逻辑处理器。
 * @description 处理佣兵招募、列表查看、详情查看等功能。
 */

import { getPlayerData, savePlayerData, getMercenaries, mercenaryImagePath, getUpMercenaryPool } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import * as constants from '../../utils/constants.js';
import path from 'path';
import fs from 'fs';

/** Helper: Get current date in YYYY-MM-DD format */
function getCurrentDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 根据概率表随机选择一个佣兵，并考虑5星保底机制。
 * @param {object} playerData - 玩家数据，用于获取5星保底的额外概率。
 * @param {number} [minRarityPity=0] - 由于十连保底机制，强制要求的最低稀有度 (0表示不强制)。
 * @param {string[]} [poolMercenaryIds=null] - 可选参数，限定招募池的佣兵ID列表。如果为null或空，则使用全部佣兵。
 * @returns {object|null} 选中的佣兵对象，如果无法选择则返回 null。
 */
function getRandomMercenaryByProbability(playerData, minRarityPity = 0, poolMercenaryIds = null) {
    let sourceMercenaries = getMercenaries();
    if (!sourceMercenaries || sourceMercenaries.length === 0) return null;

    if (poolMercenaryIds && Array.isArray(poolMercenaryIds) && poolMercenaryIds.length > 0) {
        sourceMercenaries = sourceMercenaries.filter(m => poolMercenaryIds.includes(m.id));
        if (sourceMercenaries.length === 0) {
            logger.warn(`[MercenaryHandler] 限定招募池为空或所有限定佣兵ID无效。无法招募。`);
            return null;
        }
    }

    if (minRarityPity > 0) {
        const candidatesPoolPity = sourceMercenaries.filter(m => m.rarity >= minRarityPity);
        if (candidatesPoolPity.length > 0) {
            return candidatesPoolPity[Math.floor(Math.random() * candidatesPoolPity.length)];
        }
        logger.warn(`[MercenaryHandler] 在当前池中未找到稀有度 >= ${minRarityPity} 的佣兵。将回退到当前池的普通概率。`);
    }

    const currentBonus5StarRate = playerData.current5StarBonusRate || 0.0;
    const modifiedProbabilities = { ...constants.MERCENARY_RARITY_PROBABILITY };

    if (currentBonus5StarRate > 0) {
        const base5StarProb = constants.MERCENARY_RARITY_PROBABILITY[5] || 0;
        let effective5StarProb = Math.min(1.0, base5StarProb + currentBonus5StarRate);
        modifiedProbabilities[5] = effective5StarProb;

        let sumProbNon5StarBase = 0;
        for (const r in constants.MERCENARY_RARITY_PROBABILITY) {
            if (parseInt(r, 10) !== 5) {
                sumProbNon5StarBase += (constants.MERCENARY_RARITY_PROBABILITY[r] || 0);
            }
        }

        if (sumProbNon5StarBase > 0) {
            const remainingProbSpaceNew = Math.max(0, 1.0 - effective5StarProb);
            const scaleFactor = remainingProbSpaceNew / sumProbNon5StarBase;
            for (const r in modifiedProbabilities) {
                if (parseInt(r, 10) !== 5) {
                    modifiedProbabilities[r] = (constants.MERCENARY_RARITY_PROBABILITY[r] || 0) * scaleFactor;
                }
            }
        } else {
            for (const r in modifiedProbabilities) {
                if (parseInt(r, 10) !== 5) {
                    modifiedProbabilities[r] = 0;
                }
            }
        }
        let currentSum = 0;
        Object.values(modifiedProbabilities).forEach(p => currentSum +=p);
        if(currentSum > 0 && Math.abs(currentSum - 1.0) > 1e-9) {
            for(const r in modifiedProbabilities) modifiedProbabilities[r] /= currentSum;
        }
    }

    const randomNumber = Math.random();
    let cumulativeProbability = 0;
    let chosenRarity = null;

    const sortedRarities = Object.keys(modifiedProbabilities)
        .map(r => parseInt(r, 10))
        .sort((a, b) => a - b);

    for (const rarityVal of sortedRarities) {
        cumulativeProbability += (modifiedProbabilities[rarityVal] || 0);
        if (randomNumber < cumulativeProbability) {
            chosenRarity = rarityVal;
            break;
        }
    }

    if (chosenRarity === null) {
        if (sortedRarities.length > 0) {
            chosenRarity = sortedRarities[sortedRarities.length -1];
            logger.warn(`[MercenaryHandler] chosenRarity was null, falling back to highest available rarity ${chosenRarity}. Random: ${randomNumber}, Cumul: ${cumulativeProbability}`);
        } else {
            logger.error("[MercenaryHandler] Could not determine chosenRarity, no rarities in probability map.");
            return sourceMercenaries.length > 0 ? sourceMercenaries[Math.floor(Math.random() * sourceMercenaries.length)] : null;
        }
    }

    const finalCandidates = sourceMercenaries.filter(m => m.rarity === chosenRarity);
    if (finalCandidates.length > 0) {
        return finalCandidates[Math.floor(Math.random() * finalCandidates.length)];
    } else {
        logger.warn(`[MercenaryHandler] 在当前池中，稀有度 ${chosenRarity} 没有可招募佣兵。将从当前池随机选择一个。`);
        return sourceMercenaries.length > 0 ? sourceMercenaries[Math.floor(Math.random() * sourceMercenaries.length)] : null;
    }
}


/**
 * 处理单个佣兵的获取逻辑，包括进阶、满级奖励和5星保底计数。
 * @param {object} playerData - 玩家数据对象。
 * @param {object} recruitedMercDef - 招募到的佣兵定义。
 * @returns {{
 *  playerData: object, // 更新后的玩家数据
 *  message: string,
 *  isNew: boolean,
 *  evolvedTo: number | null,
 *  gotMaxLevelReward: boolean,
 *  rewardAmount: number,
 *  rewardType: 'gold' | 'seeds' | null,
 *  unlockedSkillDescription: string | null
 * }} 处理结果。
 */
export function processMercenaryAcquisition(playerData, recruitedMercDef) {
    let message = "";
    let isNew = true;
    let evolvedTo = null;
    let gotMaxLevelReward = false;
    let rewardAmount = 0;
    let rewardType = null;
    let unlockedSkillDescription = null;

    playerData.seedsOfLight = playerData.seedsOfLight || 0;
    playerData.pityCounter5Star = playerData.pityCounter5Star || 0;
    playerData.current5StarBonusRate = playerData.current5StarBonusRate || 0.0;
    playerData.mercenaries = playerData.mercenaries || [];

    const existingMerc = playerData.mercenaries.find(m => m.mercenaryId === recruitedMercDef.id);

    if (existingMerc) {
        isNew = false;
        if (existingMerc.evolutionLevel < constants.MERCENARY_MAX_EVOLUTION_LEVEL) {
            existingMerc.evolutionLevel++;
            evolvedTo = existingMerc.evolutionLevel;
            message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已存在，进阶等级提升至 ${existingMerc.evolutionLevel}级！`;
            const newSkill = recruitedMercDef.skills.find(s => s.levelRequired === existingMerc.evolutionLevel);
            if (newSkill) {
                unlockedSkillDescription = newSkill.description;
                message += `\n解锁新技能：${unlockedSkillDescription}`;
            }
        } else {
            gotMaxLevelReward = true;
            if (recruitedMercDef.rarity >= 3 && constants.SEED_OF_LIGHT_GAIN_ON_DUPLICATE[recruitedMercDef.rarity]) {
                const seedsFromDupe = constants.SEED_OF_LIGHT_GAIN_ON_DUPLICATE[recruitedMercDef.rarity];
                playerData.seedsOfLight += seedsFromDupe;
                rewardAmount = seedsFromDupe;
                rewardType = 'seeds';
                message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已达最高进阶，转化为 ${seedsFromDupe} 光之种。`;
            } else {
                const goldFromDupe = constants.MERCENARY_MAX_LEVEL_DUPLICATE_REWARD_LOW_RARITY;
                playerData.funds += goldFromDupe;
                rewardAmount = goldFromDupe;
                rewardType = 'gold';
                message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已达最高进阶，转化为 ${goldFromDupe} 资金。`;
            }
        }
    } else {
        playerData.mercenaries.push({
            mercenaryId: recruitedMercDef.id,
            evolutionLevel: 1,
        });
        evolvedTo = 1;
        message = `新招募！获得佣兵：${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)})！`;
        const firstSkill = recruitedMercDef.skills.find(s => s.levelRequired === 1);
        if (firstSkill) {
            unlockedSkillDescription = firstSkill.description;
            message += `\n初始技能：${unlockedSkillDescription}`;
        }
    }

    if (recruitedMercDef.rarity === 5) {
        playerData.pityCounter5Star = 0;
        playerData.current5StarBonusRate = 0.0;
        message += " (✨✨✨✨✨)";
    } else {
        playerData.pityCounter5Star++;
        if (playerData.pityCounter5Star > constants.PITY_5STAR_THRESHOLD) {
            playerData.current5StarBonusRate += constants.PITY_5STAR_RATE_INCREMENT;
            playerData.current5StarBonusRate = Math.min(playerData.current5StarBonusRate, 0.95);
        }
    }

    return { playerData, message, isNew, evolvedTo, gotMaxLevelReward, rewardAmount, rewardType, unlockedSkillDescription };
}


export async function handleRecruitMercenary(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    let { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    if (playerData.funds < constants.MERCENARY_RECRUIT_COST) {
        return e.reply(`资金不足！随机招募需要 ${constants.MERCENARY_RECRUIT_COST} 资金，您当前持有 ${playerData.funds}。`);
    }

    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) {
        return e.reply("佣兵数据库异常，暂无法招募。请联系管理员。");
    }

    playerData.funds -= constants.MERCENARY_RECRUIT_COST;
    const recruitedMercDef = getRandomMercenaryByProbability(playerData, 0, null);

    if (!recruitedMercDef) {
        await savePlayerData(userId, playerData);
        return e.reply("招募信号受到严重干扰，未能成功连接到佣兵网络或当前池中无符合条件佣兵。资金已消耗。");
    }

    const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);
    playerData = acquisitionResult.playerData;

    await savePlayerData(userId, playerData);

    const singleRecruitContent = [
        `--- 随机招募结果 ---`,
        acquisitionResult.message,
        `剩余资金: ${playerData.funds}`,
        `当前光之种: ${playerData.seedsOfLight || 0}`,
        `(5星保底计数: ${playerData.pityCounter5Star}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`
    ];

    if (recruitedMercDef.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, recruitedMercDef.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            singleRecruitContent.push({ type: 'image', file: recruitedMercDef.imageUrl });
        } else {
            singleRecruitContent.push(`[图片 ${recruitedMercDef.imageUrl} 加载失败]`);
            logger.warn(`[MercenaryHandler] 招募：图片文件未找到: ${imageFullPath}`);
        }
    }

    const forwardMsg = await makeForwardMsgWithContent(singleRecruitContent, "佣兵招募凭证");
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        let replyText = singleRecruitContent.filter(item => typeof item === 'string').join('\n');
        if (recruitedMercDef.imageUrl && !fs.existsSync(path.join(mercenaryImagePath, recruitedMercDef.imageUrl))) {
            replyText += `\n[图片 ${recruitedMercDef.imageUrl} 加载失败]`;
        }
        await e.reply(replyText);
    }
    return true;
}

/**
 * Internal logic for performing ten recruits with pity.
 * @param {object} playerDataInput - Player's data (will be deep copied and modified).
 * @param {string[]} [poolMercenaryIds=null] - Optional. Array of mercenary IDs to restrict the recruitment pool.
 * @returns {object} { playerDataUpdated: object, forwardContentItems: Array<string|object>, error?: string }
 */
async function _performTenRecruits(playerDataInput, poolMercenaryIds = null) {
    let currentPlayerData = JSON.parse(JSON.stringify(playerDataInput));

    let sourceMercenaries = getMercenaries();
    if (!sourceMercenaries || sourceMercenaries.length === 0) {
        return { error: "佣兵数据库异常，暂无法招募。请联系管理员。" };
    }
    if (poolMercenaryIds && Array.isArray(poolMercenaryIds) && poolMercenaryIds.length > 0) {
        const initialPoolSize = sourceMercenaries.filter(m => poolMercenaryIds.includes(m.id)).length;
        if (initialPoolSize === 0) {
            return { error: "当前UP池中没有可招募的佣兵或UP池配置错误。" };
        }
    }


    const finalResultsDefinitions = [];
    let resultsForMessage = [];
    let hasGuaranteed3Star = false;

    for (let i = 0; i < 10; i++) {
        const recruitedMercDef = getRandomMercenaryByProbability(currentPlayerData, 0, poolMercenaryIds);

        if (recruitedMercDef) {
            finalResultsDefinitions.push(recruitedMercDef);
            if (recruitedMercDef.rarity >= constants.TEN_PULL_GUARANTEE_MIN_RARITY) {
                hasGuaranteed3Star = true;
            }
            const acquisitionResult = processMercenaryAcquisition(currentPlayerData, recruitedMercDef);
            currentPlayerData = acquisitionResult.playerData;
            resultsForMessage.push({ mercDef: recruitedMercDef, message: acquisitionResult.message, unlockedSkill: acquisitionResult.unlockedSkillDescription });
        } else {
            finalResultsDefinitions.push(null);
            currentPlayerData.pityCounter5Star = (currentPlayerData.pityCounter5Star || 0) + 1;
            if (currentPlayerData.pityCounter5Star > constants.PITY_5STAR_THRESHOLD) {
                currentPlayerData.current5StarBonusRate = (currentPlayerData.current5StarBonusRate || 0.0) + constants.PITY_5STAR_RATE_INCREMENT;
                currentPlayerData.current5StarBonusRate = Math.min(currentPlayerData.current5StarBonusRate, 0.95);
            }
            resultsForMessage.push({ mercDef: null, message: "招募信号干扰/池中无符合条件佣兵，此次招募失败。", unlockedSkill: null });
        }
    }

    let tenPullPityTriggeredMsg = "";
    if (!hasGuaranteed3Star) {
        tenPullPityTriggeredMsg = "✨ 十连保底机制已触发！本次招募至少包含一名三星以上佣兵。 ✨";
        let replacementIndex = -1;
        let lowestRarityFound = 99;

        for (let i = 0; i < finalResultsDefinitions.length; i++) {
            if (finalResultsDefinitions[i] && finalResultsDefinitions[i].rarity < lowestRarityFound) {
                lowestRarityFound = finalResultsDefinitions[i].rarity;
                replacementIndex = i;
            }
        }
        if (replacementIndex === -1) replacementIndex = 0;

        const replacedMercDefOriginal = finalResultsDefinitions[replacementIndex];
        if (replacedMercDefOriginal && replacedMercDefOriginal.rarity < 5) {
            currentPlayerData.pityCounter5Star--;
        } else if (replacedMercDefOriginal === null) {
            currentPlayerData.pityCounter5Star--;
        }

        const guaranteed3StarMercDef = getRandomMercenaryByProbability(currentPlayerData, constants.TEN_PULL_GUARANTEE_MIN_RARITY, poolMercenaryIds);

        if (guaranteed3StarMercDef) {
            finalResultsDefinitions[replacementIndex] = guaranteed3StarMercDef;
            const acquisitionResultPity = processMercenaryAcquisition(currentPlayerData, guaranteed3StarMercDef);
            currentPlayerData = acquisitionResultPity.playerData;
            resultsForMessage[replacementIndex] = { mercDef: guaranteed3StarMercDef, message: acquisitionResultPity.message, unlockedSkill: acquisitionResultPity.unlockedSkillDescription };
        } else {
            logger.error("[MercenaryHandler] 10-pull pity: Could not find a guaranteed 3-star+ mercenary from the current pool.");
            tenPullPityTriggeredMsg = "保底尝试失败: 未能从当前池找到三星以上佣兵。";
        }
    }

    const forwardContentItems = [];
    if (tenPullPityTriggeredMsg) {
        forwardContentItems.push(tenPullPityTriggeredMsg);
    }

    resultsForMessage.forEach((result, index) => {
        let mercResultText = `${index + 1}. ${result.message.split('\n')[0]}`;
        if (result.unlockedSkill) {
            mercResultText += ` (解锁: ${result.unlockedSkill.substring(0,15)}...)`;
        }
        forwardContentItems.push(mercResultText);

        if (result.mercDef && result.mercDef.rarity >= 4 && result.mercDef.imageUrl) {
            const imageFullPath = path.join(mercenaryImagePath, result.mercDef.imageUrl);
            if (fs.existsSync(imageFullPath)) {
                forwardContentItems.push({ type: 'image', file: result.mercDef.imageUrl });
            } else {
                forwardContentItems.push(`[佣兵 ${result.mercDef.name} 图片 ${result.mercDef.imageUrl} 加载失败]`);
            }
        }
    });

    return { playerDataUpdated: currentPlayerData, forwardContentItems };
}


export async function handleRecruitMercenaryTenTimes(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    let { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    const cost = constants.MERCENARY_RECRUIT_TEN_COST;
    if (playerData.funds < cost) {
        return e.reply(`资金不足！十连招募需要 ${cost} 资金，您当前持有 ${playerData.funds}。`);
    }
    playerData.funds -= cost;

    const recruitOutcome = await _performTenRecruits(playerData, null);
    if (recruitOutcome.error) {
        playerData.funds += cost;
        await savePlayerData(userId, playerData);
        return e.reply(recruitOutcome.error);
    }

    playerData = recruitOutcome.playerDataUpdated;

    const finalForwardContent = [
        `--- ${nickname} 的十连招募报告 (消耗 ${cost} 资金) ---`,
        ...recruitOutcome.forwardContentItems,
        `\n--- 招募结束 ---\n剩余资金: ${playerData.funds}\n当前光之种: ${playerData.seedsOfLight || 0}`,
        `(5星保底计数: ${playerData.pityCounter5Star}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`
    ];

    await savePlayerData(userId, playerData);

    const forwardMsg = await makeForwardMsgWithContent(finalForwardContent, "十连招募详细报告", false);
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const textOnlyContent = finalForwardContent
            .filter(item => typeof item === 'string')
            .join('\n');
        await e.reply(textOnlyContent.substring(0, 2000) + "\n...(部分结果可能因消息过长未显示，高星图片可能无法展示)");
    }
    return true;
}

export async function handleDailyFreeTenPull(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    let { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行每日招募。");

    const todayStr = getCurrentDateString();
    if (playerData.lastFreeTenPullDate === todayStr) {
        return e.reply(`【${nickname}】您今天已经进行过每日免费十连招募了，请明天再来吧！`);
    }

    const recruitOutcome = await _performTenRecruits(playerData, null);
    if (recruitOutcome.error) {
        return e.reply(recruitOutcome.error);
    }

    playerData = recruitOutcome.playerDataUpdated;
    playerData.lastFreeTenPullDate = todayStr;

    const finalForwardContent = [
        `--- ${nickname} 的每日免费十连招募报告 ---`,
        ...recruitOutcome.forwardContentItems,
        `\n--- 招募结束 ---\n当前资金: ${playerData.funds}\n当前光之种: ${playerData.seedsOfLight || 0}`,
        `(5星保底计数: ${playerData.pityCounter5Star}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`
    ];

    await savePlayerData(userId, playerData);

    const forwardMsg = await makeForwardMsgWithContent(finalForwardContent, "每日免费十连报告", true);
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const textOnlyContent = finalForwardContent
            .filter(item => typeof item === 'string')
            .join('\n');
        await e.reply(textOnlyContent.substring(0, 2000) + "\n...(部分结果可能因消息过长未显示，高星图片可能无法展示)");
    }
    return true;
}


export async function handleListPlayerMercenaries(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法查看佣兵列表。");

    if (!playerData.mercenaries || playerData.mercenaries.length === 0) {
        let replyMsg = "您尚未拥有任何佣兵。快去 #随机招募 吧！\n";
        replyMsg += `(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)\n`;
        replyMsg += "使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。";
        return e.reply(replyMsg);
    }

    const allMercenariesDefs = getMercenaries();
    const forwardContentItems = [];

    forwardContentItems.push(`--- ${playerData.nickname} 的佣兵档案摘要 ---\n(光之种: ${playerData.seedsOfLight || 0})`);
    forwardContentItems.push(`(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)`);


    let mercenaryCounter = 1;
    const validMercenariesForSave = [];
    let madeChangesToPlayerData = false;
    let additionalMessagesForFooter = [];
    let actualMercNodesCount = 0;

    const sortedPlayerMercs = [...playerData.mercenaries].sort((a, b) => {
        const defA = allMercenariesDefs.find(m => m.id === a.mercenaryId);
        const defB = allMercenariesDefs.find(m => m.id === b.mercenaryId);
        if (!defA && !defB) return 0;
        if (!defA) return 1;
        if (!defB) return -1;
        if (defB.rarity !== defA.rarity) return defB.rarity - defA.rarity;
        return b.evolutionLevel - a.evolutionLevel;
    });

    for (const ownedMerc of sortedPlayerMercs) {
        const mercDef = allMercenariesDefs.find(m => m.id === ownedMerc.mercenaryId);
        if (mercDef) {
            validMercenariesForSave.push(ownedMerc);
            let mercEntryText = `${mercenaryCounter}. ${mercDef.name} (${"★".repeat(mercDef.rarity)}) - 进阶: ${ownedMerc.evolutionLevel}/${constants.MERCENARY_MAX_EVOLUTION_LEVEL}\n`;
            mercEntryText += `   简述: ${mercDef.description ? mercDef.description.substring(0, 300) + (mercDef.description.length > 300 ? "..." : "") : '无'}`;
            forwardContentItems.push(mercEntryText);
            mercenaryCounter++;
            actualMercNodesCount++;
        } else {
            logger.warn(`[MercenaryHandler] 玩家 ${userId} 的佣兵 ${ownedMerc.mercenaryId} 定义未找到，将从其档案中移除。`);
            madeChangesToPlayerData = true;
        }
    }

    if (madeChangesToPlayerData) {
        playerData.mercenaries = validMercenariesForSave;
        if (playerData.arenaTeam && playerData.arenaTeam.length > 0) {
            const oldTeamSize = playerData.arenaTeam.length;
            playerData.arenaTeam = playerData.arenaTeam.filter(teamMercId =>
                validMercenariesForSave.some(vm => vm.mercenaryId === teamMercId)
            );
            if (playerData.arenaTeam.length < oldTeamSize) {
                additionalMessagesForFooter.push("[竞技场队伍调整] 由于部分佣兵数据失效，您的竞技场队伍可能已被调整，请使用 #佣兵配队 重新检查。");
            }
        }
        await savePlayerData(userId, playerData);

        if (actualMercNodesCount === 0) {
            let replyMsg = `所有佣兵数据均已失效并清理。您现在没有佣兵了，请尝试 #随机招募。\n`;
            replyMsg += `(光之种: ${playerData.seedsOfLight || 0})\n`;
            replyMsg += `(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)\n`;
            replyMsg += `使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。`;
            if (additionalMessagesForFooter.length > 0) {
                replyMsg += "\n\n" + additionalMessagesForFooter.join("\n");
            }
            return e.reply(replyMsg);
        }
        forwardContentItems.push("[系统提示] 部分失效佣兵数据已自动清理。");
    }

    if (actualMercNodesCount === 0 && !madeChangesToPlayerData) {
        let replyMsg = `您当前没有有效的佣兵。 (光之种: ${playerData.seedsOfLight || 0})\n`;
        replyMsg += `(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)\n`;
        replyMsg += `使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。`;
        return e.reply(replyMsg);
    }

    let footerTexts = [];
    footerTexts.push("使用 #查看佣兵 <序号/名称> 查看指定佣兵的详细信息及图片。");
    footerTexts.push("使用 #进阶 <序号/名称> 消耗光之种提升佣兵。");

    if (additionalMessagesForFooter.length > 0) {
        forwardContentItems.push(...additionalMessagesForFooter);
    }
    forwardContentItems.push(...footerTexts);

    const forwardMsg = await makeForwardMsgWithContent(forwardContentItems, "佣兵列表摘要", true);
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const fallbackText = forwardContentItems.filter(item => typeof item === 'string').join('\n\n');
        await e.reply(fallbackText.substring(0, 2000) + "\n...(部分结果可能因消息过长或转发失败未显示)");
    }
    return true;
}


export async function handleViewMercenaryDetail(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法查看佣兵详情。");

    const allMercenariesDefs = getMercenaries();
    if (!playerData.mercenaries || playerData.mercenaries.length === 0) {
        let replyMsg = "您尚未拥有任何佣兵。\n";
        replyMsg += `(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)`;
        return e.reply(replyMsg);
    }

    const arg = e.msg.replace(/^#(查看佣兵|查看)\s*/, "").trim();

    if (!arg) {
        let listMsg = `您拥有以下佣兵 (光之种: ${playerData.seedsOfLight || 0})，请输入序号或名称查看详情 (例: #查看佣兵 1 或 #查看佣兵 佣兵名称):\n`;
        listMsg += `(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)\n`;
        let counter = 1;
        const sortedPlayerMercs = [...playerData.mercenaries].sort((a, b) => {
            const defA = allMercenariesDefs.find(m => m.id === a.mercenaryId);
            const defB = allMercenariesDefs.find(m => m.id === b.mercenaryId);
            if (!defA || !defB) return 0;
            if (defB.rarity !== defA.rarity) return defB.rarity - defA.rarity;
            return b.evolutionLevel - a.evolutionLevel;
        });

        for (const ownedMerc of sortedPlayerMercs) {
            const mercDef = allMercenariesDefs.find(m => m.id === ownedMerc.mercenaryId);
            if (mercDef) {
                listMsg += `${counter++}. ${mercDef.name} (${"★".repeat(mercDef.rarity)}, Lv.${ownedMerc.evolutionLevel})\n`;
            }
        }
        return e.reply(listMsg);
    }

    let targetOwnedMerc = null;
    let targetMercDef = null;
    const numArg = parseInt(arg, 10);

    const displayOrderMercs = playerData.mercenaries
        .map(owned => ({ owned, def: allMercenariesDefs.find(m => m.id === owned.mercenaryId) }))
        .filter(item => item.def)
        .sort((a, b) => {
            if (b.def.rarity !== a.def.rarity) return b.def.rarity - a.def.rarity;
            return b.owned.evolutionLevel - a.owned.evolutionLevel;
        });


    if (!isNaN(numArg) && numArg > 0 && numArg <= displayOrderMercs.length) {
        targetOwnedMerc = displayOrderMercs[numArg - 1].owned;
        targetMercDef = displayOrderMercs[numArg - 1].def;
    } else {
        for (const item of displayOrderMercs) {
            if (item.def.name.toLowerCase() === arg.toLowerCase()) {
                targetOwnedMerc = item.owned;
                targetMercDef = item.def;
                break;
            }
        }
    }

    if (!targetOwnedMerc || !targetMercDef) {
        return e.reply(`未找到名为 "${arg}" 或序号为 "${arg}" 的佣兵。请使用 #佣兵列表 查看您拥有的佣兵，并使用 #查看佣兵 <序号/名称> 查看详情。`);
    }

    let mercInfoText = `--- 佣兵详情: ${targetMercDef.name} ---\n\n`;
    mercInfoText += `${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)})\n`;
    mercInfoText += `ID: ${targetMercDef.id}\n`;
    mercInfoText += `进阶等级: ${targetOwnedMerc.evolutionLevel}/${constants.MERCENARY_MAX_EVOLUTION_LEVEL}\n\n`;
    mercInfoText += `【简介】\n${targetMercDef.description || '暂无详细描述。'}\n\n`;
    mercInfoText += `【技能列表】`;

    if (targetMercDef.skills && targetMercDef.skills.length > 0) {
        targetMercDef.skills.forEach(skill => {
            if (skill.levelRequired <= targetOwnedMerc.evolutionLevel) {
                mercInfoText += `\n  - (Lv.${skill.levelRequired}解锁) ${skill.description}`;
            } else {
                mercInfoText += `\n  - [未解锁 Lvl.${skill.levelRequired}] ${skill.description}`;
            }
        });
    } else {
        mercInfoText += `\n  该佣兵暂无技能信息。`;
    }

    if (targetOwnedMerc.evolutionLevel < constants.MERCENARY_MAX_EVOLUTION_LEVEL) {
        const costToEvolve = constants.MERCENARY_EVOLUTION_COST_SEED_OF_LIGHT[targetMercDef.rarity];
        mercInfoText += `\n\n【进阶信息】\n下次进阶至 ${targetOwnedMerc.evolutionLevel + 1}级 需要 ${costToEvolve} 光之种。\n(您当前拥有 ${playerData.seedsOfLight || 0} 光之种)`;
        mercInfoText += `\n(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)`;
        mercInfoText += `\n使用 #进阶 ${targetMercDef.name} 进行提升。`;
    } else {
        mercInfoText += `\n\n【进阶信息】\n该佣兵已达到最高进阶等级。`;
        mercInfoText += `\n(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)`;
    }

    const forwardContent = [mercInfoText.trim()];

    if (targetMercDef.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, targetMercDef.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            forwardContent.push({ type: 'image', file: targetMercDef.imageUrl });
        } else {
            forwardContent.push(`\n[图片 ${targetMercDef.imageUrl} 加载失败]`);
            logger.warn(`[MercenaryHandler] 查看佣兵详情：图片文件未找到: ${imageFullPath}`);
        }
    }

    const forwardMsg = await makeForwardMsgWithContent(forwardContent, `佣兵档案 - ${targetMercDef.name}`);
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        let replyText = forwardContent.filter(item => typeof item === 'string').join('\n');
        if (targetMercDef.imageUrl && !fs.existsSync(path.join(mercenaryImagePath, targetMercDef.imageUrl))) {
            replyText += `\n[图片 ${targetMercDef.imageUrl} 加载失败]`;
        }
        await e.reply(replyText);
    }
    return true;
}


export async function handleEvolveMercenary(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进阶佣兵。");

    const allMercenariesDefs = getMercenaries();
    if (!playerData.mercenaries || playerData.mercenaries.length === 0) {
        return e.reply("您尚未拥有任何佣兵，无法进阶。");
    }

    const arg = e.msg.replace(/^#进阶\s*/, "").trim();
    if (!arg) {
        return e.reply("请指定要进阶的佣兵名称或其在 #佣兵列表 中的序号。例如：#进阶 佣兵A 或 #进阶 1");
    }

    let targetOwnedMerc = null;
    let targetMercDef = null;
    const numArg = parseInt(arg, 10);

    const displayOrderMercs = playerData.mercenaries
        .map(owned => ({ owned, def: allMercenariesDefs.find(m => m.id === owned.mercenaryId) }))
        .filter(item => item.def)
        .sort((a, b) => {
            if (b.def.rarity !== a.def.rarity) return b.def.rarity - a.def.rarity;
            return b.owned.evolutionLevel - a.owned.evolutionLevel;
        });

    if (!isNaN(numArg) && numArg > 0 && numArg <= displayOrderMercs.length) {
        targetOwnedMerc = displayOrderMercs[numArg - 1].owned;
        targetMercDef = displayOrderMercs[numArg - 1].def;
    } else {
        for (const item of displayOrderMercs) {
            if (item.def.name.toLowerCase() === arg.toLowerCase()) {
                targetOwnedMerc = item.owned;
                targetMercDef = item.def;
                break;
            }
        }
    }

    if (!targetOwnedMerc || !targetMercDef) {
        return e.reply(`未找到名为 "${arg}" 或序号为 "${arg}" 的佣兵。请使用 #佣兵列表 查看并确认。`);
    }

    if (targetOwnedMerc.evolutionLevel >= constants.MERCENARY_MAX_EVOLUTION_LEVEL) {
        return e.reply(`佣兵 ${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)}) 已达到最高进阶等级 (${constants.MERCENARY_MAX_EVOLUTION_LEVEL}级)，无法继续进阶。`);
    }

    const evolutionCost = constants.MERCENARY_EVOLUTION_COST_SEED_OF_LIGHT[targetMercDef.rarity];
    if (typeof evolutionCost === 'undefined') {
        logger.error(`[MercenaryHandler] 佣兵 ${targetMercDef.name} (稀有度 ${targetMercDef.rarity}) 未定义光之种进阶消耗。`);
        return e.reply(`系统错误：佣兵 ${targetMercDef.name} 的进阶消耗未配置，请联系管理员。`);
    }

    playerData.seedsOfLight = playerData.seedsOfLight || 0;
    if (playerData.seedsOfLight < evolutionCost) {
        return e.reply(`光之种不足！进阶 ${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)}) 至 ${targetOwnedMerc.evolutionLevel + 1}级需要 ${evolutionCost} 光之种，您当前拥有 ${playerData.seedsOfLight}。`);
    }

    playerData.seedsOfLight -= evolutionCost;
    targetOwnedMerc.evolutionLevel++;

    let replyMessage = `✨ 进阶成功！✨\n佣兵 ${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)}) 等级提升至 ${targetOwnedMerc.evolutionLevel}级！`;
    replyMessage += `\n消耗 ${evolutionCost} 光之种，剩余 ${playerData.seedsOfLight} 光之种。`;
    replyMessage += `\n(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${((playerData.current5StarBonusRate || 0) * 100).toFixed(1)}%)`;


    const newSkill = targetMercDef.skills.find(s => s.levelRequired === targetOwnedMerc.evolutionLevel);
    if (newSkill) {
        replyMessage += `\n🔓 解锁新技能：${newSkill.description}`;
    }

    await savePlayerData(userId, playerData);

    const evolutionContent = [replyMessage];
    if (targetMercDef.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, targetMercDef.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            evolutionContent.push({ type: 'image', file: targetMercDef.imageUrl });
        }
    }
    const forwardMsg = await makeForwardMsgWithContent(evolutionContent, "佣兵进阶报告");
    if(forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        await e.reply(evolutionContent.filter(item => typeof item === 'string' || typeof item === 'object' && item.type !== 'image').join('\n'));
    }

    return true;
}

// --- 新增功能 ---

/**
 * 查看当前所有可招募佣兵的卡池信息。
 */
export async function handleViewMercenaryPool(e, pluginInstance) {
    const allMercenaries = getMercenaries();
    if (!allMercenaries || allMercenaries.length === 0) {
        return e.reply("当前佣兵数据库为空，无法查看卡池。");
    }

    const content = [];
    content.push(`--- 卡莫利安佣兵总览 ---`);

    // 处理UP池 (置顶)
    const upPoolIds = getUpMercenaryPool();
    const upMercsGroupedByRarity = {};
    if (upPoolIds && upPoolIds.length > 0) {
        const upMercs = allMercenaries.filter(m => upPoolIds.includes(m.id))
            .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name)); // UP池内部也排序

        if (upMercs.length > 0) {
            content.push(`\n--- 当前UP池佣兵 (招募指令: #UP招募 / #UP十连) ---`);
            upMercs.forEach(merc => {
                if (!upMercsGroupedByRarity[merc.rarity]) {
                    upMercsGroupedByRarity[merc.rarity] = [];
                }
                upMercsGroupedByRarity[merc.rarity].push(`${merc.name} (UP!)`);
            });

            // 按稀有度降序添加到content
            Object.keys(upMercsGroupedByRarity).map(Number).sort((a, b) => b - a).forEach(rarity => {
                let rarityNode = `【${"★".repeat(rarity)} (${rarity}星) - UP池】\n`;
                rarityNode += upMercsGroupedByRarity[rarity].join('、 ');
                content.push(rarityNode);
            });
        } else {
            content.push(`\n--- 当前UP池为空或配置错误 ---`);
        }
    } else {
        content.push(`\n--- 当前无UP池活动 ---`);
    }

    content.push(`\n--- 常驻卡池佣兵 (招募指令: #随机招募 / #随机十连) ---`);
    // 处理常驻池 (排除已在UP池中显示过的，如果UP池佣兵也存在于常驻池的话)
    // 为了简化，这里我们假设UP池是完全独立的，或者如果UP池佣兵也在常驻池，则在常驻池列表中也显示它们（但没有UP标记）
    // 如果要严格区分，需要更复杂的过滤逻辑

    const regularMercsGroupedByRarity = {};
    const sortedAllMercenaries = [...allMercenaries].sort((a, b) => {
        if (b.rarity !== a.rarity) return b.rarity - a.rarity;
        return a.name.localeCompare(b.name);
    });

    for (const merc of sortedAllMercenaries) {
        if (!regularMercsGroupedByRarity[merc.rarity]) {
            regularMercsGroupedByRarity[merc.rarity] = [];
        }
        regularMercsGroupedByRarity[merc.rarity].push(merc.name);
    }

    Object.keys(regularMercsGroupedByRarity).map(Number).sort((a, b) => b - a).forEach(rarity => {
        let rarityNode = `【${"★".repeat(rarity)} (${rarity}星) - 常驻池】\n`;
        rarityNode += regularMercsGroupedByRarity[rarity].join('、 ');
        content.push(rarityNode);
    });


    const forwardMsg = await makeForwardMsgWithContent(content, "佣兵卡池情报", true); // true for forceSeparateTextNodes
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        await e.reply("无法生成佣兵卡池情报，请稍后再试。");
    }
    return true;
}


/**
 * 处理UP池单次招募
 */
export async function handleRecruitMercenaryUP(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    let { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    const upPoolIds = getUpMercenaryPool();
    if (!upPoolIds || upPoolIds.length === 0) {
        return e.reply("当前没有UP招募活动，请关注后续公告。");
    }

    if (playerData.funds < constants.MERCENARY_UP_RECRUIT_COST) {
        return e.reply(`资金不足！UP招募需要 ${constants.MERCENARY_UP_RECRUIT_COST} 资金，您当前持有 ${playerData.funds}。`);
    }

    const allMercenaries = getMercenaries();
    const validUpMercsInPool = allMercenaries.filter(m => upPoolIds.includes(m.id));
    if (validUpMercsInPool.length === 0) {
        return e.reply("UP池配置错误或池中无有效佣兵，暂无法招募。请联系管理员。");
    }


    playerData.funds -= constants.MERCENARY_UP_RECRUIT_COST;
    const recruitedMercDef = getRandomMercenaryByProbability(playerData, 0, upPoolIds);

    if (!recruitedMercDef) {
        await savePlayerData(userId, playerData);
        return e.reply("UP招募信号受到严重干扰，或UP池中当前无符合条件佣兵。资金已消耗。");
    }

    const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);
    playerData = acquisitionResult.playerData;

    await savePlayerData(userId, playerData);

    const singleRecruitContent = [
        `--- UP招募结果 ---`,
        acquisitionResult.message,
        `剩余资金: ${playerData.funds}`,
        `当前光之种: ${playerData.seedsOfLight || 0}`,
        `(5星保底计数: ${playerData.pityCounter5Star}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`
    ];

    if (recruitedMercDef.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, recruitedMercDef.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            singleRecruitContent.push({ type: 'image', file: recruitedMercDef.imageUrl });
        } else {
            singleRecruitContent.push(`[图片 ${recruitedMercDef.imageUrl} 加载失败]`);
        }
    }

    const forwardMsg = await makeForwardMsgWithContent(singleRecruitContent, "UP佣兵招募凭证");
    if (forwardMsg) await e.reply(forwardMsg);
    else await e.reply(singleRecruitContent.filter(item => typeof item === 'string').join('\n'));

    return true;
}

/**
 * 处理UP池十连招募
 */
export async function handleRecruitMercenaryTenTimesUP(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    let { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    const upPoolIds = getUpMercenaryPool();
    if (!upPoolIds || upPoolIds.length === 0) {
        return e.reply("当前没有UP招募活动，请关注后续公告。");
    }

    const allMercenaries = getMercenaries();
    const validUpMercsInPool = allMercenaries.filter(m => upPoolIds.includes(m.id));
    if (validUpMercsInPool.length === 0) {
        return e.reply("UP池配置错误或池中无有效佣兵，暂无法招募。请联系管理员。");
    }

    const cost = constants.MERCENARY_UP_RECRUIT_TEN_COST;
    if (playerData.funds < cost) {
        return e.reply(`资金不足！UP十连招募需要 ${cost} 资金，您当前持有 ${playerData.funds}。`);
    }
    playerData.funds -= cost;

    const recruitOutcome = await _performTenRecruits(playerData, upPoolIds);
    if (recruitOutcome.error) {
        playerData.funds += cost;
        await savePlayerData(userId, playerData);
        return e.reply(recruitOutcome.error);
    }

    playerData = recruitOutcome.playerDataUpdated;

    const finalForwardContent = [
        `--- ${nickname} 的UP十连招募报告 (消耗 ${cost} 资金) ---`,
        ...recruitOutcome.forwardContentItems,
        `\n--- 招募结束 ---\n剩余资金: ${playerData.funds}\n当前光之种: ${playerData.seedsOfLight || 0}`,
        `(5星保底计数: ${playerData.pityCounter5Star}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`
    ];

    await savePlayerData(userId, playerData);

    const forwardMsg = await makeForwardMsgWithContent(finalForwardContent, "UP十连招募详细报告", false);
    if (forwardMsg) await e.reply(forwardMsg);
    else await e.reply(finalForwardContent.filter(item => typeof item === 'string').join('\n'));

    return true;
}