// camellia-plugin/apps/handlers/mercenaryHandler.js

/**
 * @file 佣兵系统相关逻辑处理器。
 * @description 处理佣兵招募、列表查看、详情查看等功能。
 */

import { getPlayerData, savePlayerData, getMercenaries, mercenaryImagePath } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import * as constants from '../../utils/constants.js'; // Import all constants for easier access
import path from 'path';
import fs from 'fs';

/** Helper: Get current date in YYYY-MM-DD format */
function getCurrentDateString() {
    // ... (保持不变)
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
 * @returns {object|null} 选中的佣兵对象，如果无法选择则返回 null。
 */
function getRandomMercenaryByProbability(playerData, minRarityPity = 0) {
    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) return null;

    // 十连的稀有度保底优先于5星概率提升
    if (minRarityPity > 0) {
        const candidatesPoolPity = mercenaries.filter(m => m.rarity >= minRarityPity);
        if (candidatesPoolPity.length > 0) {
            return candidatesPoolPity[Math.floor(Math.random() * candidatesPoolPity.length)];
        }
        // 如果没有符合minRarityPity的，则回退到正常概率池（不太可能发生，除非数据配置有问题）
        logger.warn(`[MercenaryHandler] No mercenaries found with minRarityPity ${minRarityPity}. Falling back to standard pool with 5-star pity.`);
    }

    // 应用5星保底的额外概率
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

        if (sumProbNon5StarBase > 0) { // Avoid division by zero if only 5-stars exist or base 5-star prob is 1
            const remainingProbSpaceNew = Math.max(0, 1.0 - effective5StarProb); // Ensure non-negative
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
        // Normalize probabilities to sum to 1.0 due to potential floating point issues
        let currentSum = 0;
        Object.values(modifiedProbabilities).forEach(p => currentSum +=p);
        if(currentSum > 0 && Math.abs(currentSum - 1.0) > 1e-9) { // Check if sum is significantly different from 1
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
            logger.warn(`[MercenaryHandler] chosenRarity was null after loop, falling back to highest available rarity ${chosenRarity}. Random: ${randomNumber}, Cumul: ${cumulativeProbability}`);
        } else {
            logger.error("[MercenaryHandler] Could not determine chosenRarity and no rarities defined in probability map.");
            return mercenaries.length > 0 ? mercenaries[Math.floor(Math.random() * mercenaries.length)] : null;
        }
    }

    const finalCandidates = mercenaries.filter(m => m.rarity === chosenRarity);
    if (finalCandidates.length > 0) {
        return finalCandidates[Math.floor(Math.random() * finalCandidates.length)];
    } else {
        logger.warn(`[MercenaryHandler] Rarity ${chosenRarity} (potentially affected by pity) has no recruitable mercenaries. Falling back to any mercenary.`);
        return mercenaries.length > 0 ? mercenaries[Math.floor(Math.random() * mercenaries.length)] : null;
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

    // Ensure fields exist
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
        } else { // At max evolution level
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
    } else { // New mercenary
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

    // 更新5星保底计数器
    if (recruitedMercDef.rarity === 5) {
        playerData.pityCounter5Star = 0;
        playerData.current5StarBonusRate = 0.0;
        message += " (✨✨✨✨✨)"; // 标记获得5星
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
    const recruitedMercDef = getRandomMercenaryByProbability(playerData);

    if (!recruitedMercDef) {
        await savePlayerData(userId, playerData);
        return e.reply("招募信号受到严重干扰，未能成功连接到佣兵网络。资金已消耗。");
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
 * @returns {object} { playerDataUpdated: object, forwardContentItems: Array<string|object>, error?: string }
 */
async function _performTenRecruits(playerDataInput) {
    let currentPlayerData = JSON.parse(JSON.stringify(playerDataInput));

    const mercenariesData = getMercenaries();
    if (!mercenariesData || mercenariesData.length === 0) {
        return { error: "佣兵数据库异常，暂无法招募。请联系管理员。" };
    }

    const finalResultsDefinitions = []; // Store the actual merc definitions recruited
    let resultsForMessage = []; // Store messages and image objects for forwardMsg
    let hasGuaranteed3Star = false; // For 10-pull 3-star pity

    for (let i = 0; i < 10; i++) {
        const recruitedMercDef = getRandomMercenaryByProbability(currentPlayerData);

        if (recruitedMercDef) {
            finalResultsDefinitions.push(recruitedMercDef); // Store the actual definition
            if (recruitedMercDef.rarity >= constants.TEN_PULL_GUARANTEE_MIN_RARITY) {
                hasGuaranteed3Star = true;
            }
            // Process acquisition and update currentPlayerData immediately for next pull
            const acquisitionResult = processMercenaryAcquisition(currentPlayerData, recruitedMercDef);
            currentPlayerData = acquisitionResult.playerData;
            resultsForMessage.push({ mercDef: recruitedMercDef, message: acquisitionResult.message, unlockedSkill: acquisitionResult.unlockedSkillDescription });
        } else {
            finalResultsDefinitions.push(null); // Mark failed pull
            // Even if a pull fails, it should count towards pity
            currentPlayerData.pityCounter5Star = (currentPlayerData.pityCounter5Star || 0) + 1;
            if (currentPlayerData.pityCounter5Star > constants.PITY_5STAR_THRESHOLD) {
                currentPlayerData.current5StarBonusRate = (currentPlayerData.current5StarBonusRate || 0.0) + constants.PITY_5STAR_RATE_INCREMENT;
                currentPlayerData.current5StarBonusRate = Math.min(currentPlayerData.current5StarBonusRate, 0.95);
            }
            resultsForMessage.push({ mercDef: null, message: "招募信号干扰，此次招募失败。", unlockedSkill: null });
        }
    }

    // Handle 10-pull 3-star pity if necessary
    let tenPullPityTriggeredMsg = "";
    if (!hasGuaranteed3Star) {
        tenPullPityTriggeredMsg = "✨ 十连保底机制已触发！本次招募至少包含一名三星以上佣兵。 ✨";
        let replacementIndex = -1;
        let lowestRarityFound = 99; // Start with a high number

        // Find the lowest actual rarity non-null mercenary to replace
        for (let i = 0; i < finalResultsDefinitions.length; i++) {
            if (finalResultsDefinitions[i] && finalResultsDefinitions[i].rarity < lowestRarityFound) {
                lowestRarityFound = finalResultsDefinitions[i].rarity;
                replacementIndex = i;
            }
        }
        // If all pulls failed or were already high rarity, replace the first one
        if (replacementIndex === -1) replacementIndex = 0;

        // Temporarily "undo" the pity count for the merc being replaced
        const replacedMercDefOriginal = finalResultsDefinitions[replacementIndex];
        if (replacedMercDefOriginal && replacedMercDefOriginal.rarity < 5) {
            currentPlayerData.pityCounter5Star--; // It was incremented for this pull
            if (currentPlayerData.pityCounter5Star > constants.PITY_5STAR_THRESHOLD -1) { // Check if it was the one that triggered rate increase
                // This part is complex; simpler to just let the new pull re-evaluate pity
            }
        } else if (replacedMercDefOriginal && replacedMercDefOriginal.rarity === 5) {
            // If we are replacing a 5-star (highly unlikely with lowestRarity logic), pity was reset.
            // This situation needs careful thought, but lowestRarity logic should prevent it.
        } else if (replacedMercDefOriginal === null) { // If replacing a failed pull
            currentPlayerData.pityCounter5Star--; // It was incremented for this null pull
        }


        const guaranteed3StarMercDef = getRandomMercenaryByProbability(currentPlayerData, constants.TEN_PULL_GUARANTEE_MIN_RARITY);

        if (guaranteed3StarMercDef) {
            finalResultsDefinitions[replacementIndex] = guaranteed3StarMercDef; // Update the actual definition
            // Re-process acquisition for this specific slot with the new merc and update currentPlayerData
            const acquisitionResultPity = processMercenaryAcquisition(currentPlayerData, guaranteed3StarMercDef);
            currentPlayerData = acquisitionResultPity.playerData;
            // Update the message for this slot
            resultsForMessage[replacementIndex] = { mercDef: guaranteed3StarMercDef, message: acquisitionResultPity.message, unlockedSkill: acquisitionResultPity.unlockedSkillDescription };
        } else {
            logger.error("[MercenaryHandler] 10-pull pity: Could not find a guaranteed 3-star+ mercenary.");
            tenPullPityTriggeredMsg = ""; // Pity failed
        }
    }

    // Construct forward message content from resultsForMessage
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

    const recruitOutcome = await _performTenRecruits(playerData);
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

    const recruitOutcome = await _performTenRecruits(playerData);
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


// ... (handleListPlayerMercenaries, handleViewMercenaryDetail, handleEvolveMercenary 保持不变，但它们内部显示pity信息的部分已在之前版本添加) ...
// 为了完整性，这里也提供这些函数的更新版本，确保它们能显示保底信息

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

    if (actualMercNodesCount === 0 && !madeChangesToPlayerData) { // Should be caught by initial check or above block
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