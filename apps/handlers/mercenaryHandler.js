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
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 根据概率表随机选择一个佣兵。
 * @returns {object|null} 选中的佣兵对象，如果无法选择则返回 null。
 */
function getRandomMercenaryByProbability(minRarity = 0) {
    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) return null;

    let candidatesPool = mercenaries;
    if (minRarity > 0) {
        candidatesPool = mercenaries.filter(m => m.rarity >= minRarity);
        if (candidatesPool.length === 0) {
            logger.warn(`[MercenaryHandler] No mercenaries found with minRarity ${minRarity}. Falling back to all mercenaries.`);
            candidatesPool = mercenaries;
        }
    }

    // If a specific minimum rarity is requested (typically for pity), directly pick from that pool
    if (minRarity > 0 && candidatesPool.length > 0) {
        return candidatesPool[Math.floor(Math.random() * candidatesPool.length)];
    }

    // Standard probability-based selection
    const randomNumber = Math.random();
    let cumulativeProbability = 0;
    let chosenRarity = null;

    const sortedRarities = Object.keys(constants.MERCENARY_RARITY_PROBABILITY)
        .map(r => parseInt(r, 10))
        .sort((a, b) => a - b);

    for (const rarityVal of sortedRarities) {
        cumulativeProbability += constants.MERCENARY_RARITY_PROBABILITY[rarityVal];
        if (randomNumber < cumulativeProbability) {
            chosenRarity = rarityVal;
            break;
        }
    }

    if (chosenRarity === null && sortedRarities.length > 0) { // Fallback if something went wrong
        chosenRarity = sortedRarities[0]; // Default to lowest defined rarity
    } else if (chosenRarity === null){
        logger.error("[MercenaryHandler] Could not determine chosenRarity and no rarities defined in probability map.");
        return mercenaries.length > 0 ? mercenaries[Math.floor(Math.random() * mercenaries.length)] : null; // Absolute fallback
    }


    const candidates = mercenaries.filter(m => m.rarity === chosenRarity);
    if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    } else {
        // Fallback if no mercenary of the chosen rarity exists (should not happen with good data)
        logger.warn(`[MercenaryHandler] 稀有度 ${chosenRarity} 没有可招募的佣兵，将从所有佣兵中随机选择。`);
        return mercenaries.length > 0 ? mercenaries[Math.floor(Math.random() * mercenaries.length)] : null;
    }
}

/**
 * 处理单个佣兵的获取逻辑，包括进阶和满级奖励。
 * @param {object} playerData - 玩家数据对象。
 * @param {object} recruitedMercDef - 招募到的佣兵定义。
 * @returns {{
 *  playerData: object,
 *  message: string,
 *  isNew: boolean,
 *  evolvedTo: number | null, // null if new or max level converted
 *  gotMaxLevelReward: boolean, // True if max level merc was converted to resources
 *  rewardAmount: number, // Value of gold or seeds if converted
 *  rewardType: 'gold' | 'seeds' | null, // Type of reward if converted
 *  unlockedSkillDescription: string | null
 * }} 处理结果。
 */
function processMercenaryAcquisition(playerData, recruitedMercDef) {
    let message = "";
    let isNew = true;
    let evolvedTo = null;
    let gotMaxLevelReward = false;
    let rewardAmount = 0;
    let rewardType = null;
    let unlockedSkillDescription = null;

    playerData.seedsOfLight = playerData.seedsOfLight || 0; // Ensure initialization

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
            // Check if 3-star or higher for Seeds of Light
            if (recruitedMercDef.rarity >= 3 && constants.SEED_OF_LIGHT_GAIN_ON_DUPLICATE[recruitedMercDef.rarity]) {
                const seedsFromDupe = constants.SEED_OF_LIGHT_GAIN_ON_DUPLICATE[recruitedMercDef.rarity];
                playerData.seedsOfLight += seedsFromDupe;
                rewardAmount = seedsFromDupe;
                rewardType = 'seeds';
                message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已达最高进阶，转化为 ${seedsFromDupe} 光之种。`;
            } else {
                // For 1-2 star max level duplicates, or if SEED_OF_LIGHT_GAIN_ON_DUPLICATE is not defined for a rarity
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
            evolutionLevel: 1, // Initial evolution level
        });
        evolvedTo = 1; // Represents initial level for a new merc
        message = `新招募！获得佣兵：${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)})！`;
        const firstSkill = recruitedMercDef.skills.find(s => s.levelRequired === 1);
        if (firstSkill) {
            unlockedSkillDescription = firstSkill.description;
            message += `\n初始技能：${unlockedSkillDescription}`;
        }
    }

    return { playerData, message, isNew, evolvedTo, gotMaxLevelReward, rewardAmount, rewardType, unlockedSkillDescription };
}


export async function handleRecruitMercenary(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    if (playerData.funds < constants.MERCENARY_RECRUIT_COST) {
        return e.reply(`资金不足！随机招募需要 ${constants.MERCENARY_RECRUIT_COST} 资金，您当前持有 ${playerData.funds}。`);
    }

    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) {
        return e.reply("佣兵数据库异常，暂无法招募。请联系管理员。");
    }

    playerData.funds -= constants.MERCENARY_RECRUIT_COST;
    const recruitedMercDef = getRandomMercenaryByProbability();

    if (!recruitedMercDef) {
        // Should not happen if mercenaries list is not empty, but as a safeguard
        await savePlayerData(userId, playerData); // Save funds deduction
        return e.reply("招募信号受到严重干扰，未能成功连接到佣兵网络。资金已消耗。");
    }

    const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);
    await savePlayerData(userId, playerData); // Save changes from acquisition

    const singleRecruitContent = [
        `--- 随机招募结果 ---`,
        acquisitionResult.message, // This message now includes skill unlocks or conversion info
        `剩余资金: ${playerData.funds}`,
        `当前光之种: ${playerData.seedsOfLight || 0}`
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

    // For single recruit, default forceSeparateTextNodes = false is usually fine.
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
 * @param {object} playerData - Player's data.
 * @returns {object} { playerDataUpdated: object, forwardContentItems: Array<string|object> }
 */
async function _performTenRecruits(playerDataInput) {
    let playerData = JSON.parse(JSON.stringify(playerDataInput)); // Work on a mutable copy

    const mercenariesData = getMercenaries();
    if (!mercenariesData || mercenariesData.length === 0) {
        return { error: "佣兵数据库异常，暂无法招募。请联系管理员。" };
    }

    const resultsDefinitions = []; // Store recruited mercenary definitions
    let hasGuaranteedMerc = false;

    for (let i = 0; i < 10; i++) {
        const mercDef = getRandomMercenaryByProbability();
        if (mercDef) {
            resultsDefinitions.push(mercDef);
            if (mercDef.rarity >= constants.TEN_PULL_GUARANTEE_MIN_RARITY) {
                hasGuaranteedMerc = true;
            }
        } else {
            resultsDefinitions.push(null); // Mark a failed pull
        }
    }

    let pityTriggered = false;
    if (!hasGuaranteedMerc) {
        pityTriggered = true;
        let replacementIndex = -1;
        let lowestRarityFound = 99;
        let lowestRarityIndex = -1;

        // Find the lowest rarity actual merc to replace
        for (let i = 0; i < resultsDefinitions.length; i++) {
            if (resultsDefinitions[i] && resultsDefinitions[i].rarity < lowestRarityFound) {
                lowestRarityFound = resultsDefinitions[i].rarity;
                lowestRarityIndex = i;
            }
        }
        replacementIndex = lowestRarityIndex !== -1 ? lowestRarityIndex : 0; // Fallback to first slot if all were null or high rarity

        const guaranteedMercDef = getRandomMercenaryByProbability(constants.TEN_PULL_GUARANTEE_MIN_RARITY);
        if (guaranteedMercDef) {
            resultsDefinitions[replacementIndex] = guaranteedMercDef;
        } else {
            logger.error("[MercenaryHandler] Pity system: Could not find a guaranteed mercenary. This should not happen.");
            pityTriggered = false; // Pity failed to apply
        }
    }

    const forwardContentItems = [];
    if (pityTriggered) {
        forwardContentItems.push("✨ 保底机制已触发！本次招募至少包含一名三星以上佣兵。 ✨");
    }

    for (let i = 0; i < resultsDefinitions.length; i++) {
        const recruitedMercDef = resultsDefinitions[i];
        let mercResultText = "";

        if (!recruitedMercDef) {
            mercResultText = `${i + 1}. 招募信号干扰，此次招募失败。`;
            forwardContentItems.push(mercResultText);
            continue;
        }

        const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);
        playerData = acquisitionResult.playerData; // Continuously update playerData

        mercResultText = `${i + 1}. ${acquisitionResult.message.split('\n')[0]}`; // Main line
        if (acquisitionResult.unlockedSkillDescription) {
            mercResultText += ` (解锁: ${acquisitionResult.unlockedSkillDescription.substring(0,15)}...)`;
        } else if (acquisitionResult.gotMaxLevelReward) {
            // The message from processMercenaryAcquisition already contains conversion details
            // e.g. "...转化为 X 光之种" or "...转化为 Y 资金"
            // So, we just use its first line.
        }


        forwardContentItems.push(mercResultText);

        if (recruitedMercDef.rarity >= 4 && recruitedMercDef.imageUrl) {
            const imageFullPath = path.join(mercenaryImagePath, recruitedMercDef.imageUrl);
            if (fs.existsSync(imageFullPath)) {
                forwardContentItems.push({ type: 'image', file: recruitedMercDef.imageUrl });
            } else {
                forwardContentItems.push(`[佣兵 ${recruitedMercDef.name} 图片 ${recruitedMercDef.imageUrl} 加载失败]`);
                logger.warn(`[MercenaryHandler] 十连招募高星图片：文件未找到: ${imageFullPath}`);
            }
        }
    }
    return { playerDataUpdated: playerData, forwardContentItems };
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

    const recruitOutcome = await _performTenRecruits(playerData); // Pass current playerData
    if (recruitOutcome.error) {
        playerData.funds += cost; // Refund on error
        await savePlayerData(userId, playerData);
        return e.reply(recruitOutcome.error);
    }

    playerData = recruitOutcome.playerDataUpdated; // Get the updated player data

    const finalForwardContent = [
        `--- ${nickname} 的十连招募报告 (消耗 ${cost} 资金) ---`,
        ...recruitOutcome.forwardContentItems,
        `\n--- 招募结束 ---\n剩余资金: ${playerData.funds}\n当前光之种: ${playerData.seedsOfLight || 0}`
    ];

    await savePlayerData(userId, playerData);

    // For ten-pulls, forceSeparateTextNodes: true makes each merc result (and image) a separate node.
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

    const recruitOutcome = await _performTenRecruits(playerData); // Pass current playerData
    if (recruitOutcome.error) {
        return e.reply(recruitOutcome.error); // No refund needed as it's free
    }

    playerData = recruitOutcome.playerDataUpdated; // Get the updated player data
    playerData.lastFreeTenPullDate = todayStr;

    const finalForwardContent = [
        `--- ${nickname} 的每日免费十连招募报告 ---`,
        ...recruitOutcome.forwardContentItems,
        `\n--- 招募结束 ---\n当前资金: ${playerData.funds}\n当前光之种: ${playerData.seedsOfLight || 0}`
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
        return e.reply("您尚未拥有任何佣兵。快去 #随机招募 吧！\n使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。");
    }

    const allMercenariesDefs = getMercenaries();
    const forwardContentItems = [];

    forwardContentItems.push(`--- ${playerData.nickname} 的佣兵档案摘要 ---\n(光之种: ${playerData.seedsOfLight || 0})`);

    let mercenaryCounter = 1;
    const validMercenariesForSave = []; // Used to reconstruct playerData.mercenaries if changes occur
    let madeChangesToPlayerData = false;
    let additionalMessagesForFooter = [];
    let actualMercNodesCount = 0;

    // Sort player's mercenaries by rarity (desc) then by level (desc) for consistent display and 序号
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

        if (actualMercNodesCount === 0) { // All mercenaries were invalid and removed
            let replyMsg = `所有佣兵数据均已失效并清理。您现在没有佣兵了，请尝试 #随机招募。\n`;
            replyMsg += `(光之种: ${playerData.seedsOfLight || 0})\n`;
            replyMsg += `使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。`;
            if (additionalMessagesForFooter.length > 0) {
                replyMsg += "\n\n" + additionalMessagesForFooter.join("\n");
            }
            return e.reply(replyMsg);
        }
        // If some were invalid but some remain, add a general system tip to the forward message
        forwardContentItems.push("[系统提示] 部分失效佣兵数据已自动清理。");
    }

    // This case should ideally be caught by the initial check or the one above if all mercs became invalid.
    if (actualMercNodesCount === 0 && !madeChangesToPlayerData) {
        return e.reply(`您当前没有有效的佣兵。 (光之种: ${playerData.seedsOfLight || 0})\n使用 #查看佣兵 <序号/名称> 获取佣兵详细信息。\n使用 #进阶 <序号/名称> 消耗光之种提升佣兵。`);
    }

    let footerTexts = [];
    footerTexts.push("使用 #查看佣兵 <序号/名称> 查看指定佣兵的详细信息及图片。");
    footerTexts.push("使用 #进阶 <序号/名称> 消耗光之种提升佣兵。");

    if (additionalMessagesForFooter.length > 0) {
        forwardContentItems.push(...additionalMessagesForFooter); // Add as separate nodes
    }
    forwardContentItems.push(...footerTexts); // Add footers as separate nodes

    const forwardMsg = await makeForwardMsgWithContent(forwardContentItems, "佣兵列表摘要", true); // forceSeparateTextNodes = true
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const fallbackText = forwardContentItems.filter(item => typeof item === 'string').join('\n\n'); // Add more spacing for fallback
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
        return e.reply("您尚未拥有任何佣兵。");
    }

    const arg = e.msg.replace(/^#(查看佣兵|查看)\s*/, "").trim();

    if (!arg) {
        let listMsg = `您拥有以下佣兵 (光之种: ${playerData.seedsOfLight || 0})，请输入序号或名称查看详情 (例: #查看佣兵 1 或 #查看佣兵 佣兵名称):\n`;
        let counter = 1;
        // Sort mercenaries by rarity (desc) then by level (desc) for nicer display in selection prompt
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

    // Create a consistently ordered list for序号 lookup
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
    } else { // Search by name
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

    // Add evolution cost info
    if (targetOwnedMerc.evolutionLevel < constants.MERCENARY_MAX_EVOLUTION_LEVEL) {
        const costToEvolve = constants.MERCENARY_EVOLUTION_COST_SEED_OF_LIGHT[targetMercDef.rarity];
        mercInfoText += `\n\n【进阶信息】\n下次进阶至 ${targetOwnedMerc.evolutionLevel + 1}级 需要 ${costToEvolve} 光之种。\n(您当前拥有 ${playerData.seedsOfLight || 0} 光之种)`;
        mercInfoText += `\n使用 #进阶 ${targetMercDef.name} 进行提升。`;
    } else {
        mercInfoText += `\n\n【进阶信息】\n该佣兵已达到最高进阶等级。`;
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

    // For merc detail, default forceSeparateTextNodes = false is good (combines text parts)
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

    // Consistent list for序号 lookup (same as in view detail)
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

    // Perform evolution
    playerData.seedsOfLight -= evolutionCost;
    targetOwnedMerc.evolutionLevel++;

    let replyMessage = `✨ 进阶成功！✨\n佣兵 ${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)}) 等级提升至 ${targetOwnedMerc.evolutionLevel}级！`;
    replyMessage += `\n消耗 ${evolutionCost} 光之种，剩余 ${playerData.seedsOfLight} 光之种。`;

    // Check for newly unlocked skill
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