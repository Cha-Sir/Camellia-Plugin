// camellia-plugin/apps/handlers/mercenaryHandler.js

/**
 * @file 佣兵系统相关逻辑处理器。
 * @description 处理佣兵招募、列表查看、详情查看等功能。
 */

import { getPlayerData, savePlayerData, getMercenaries, mercenaryImagePath } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    MERCENARY_RECRUIT_COST,
    MERCENARY_RECRUIT_TEN_COST,
    MERCENARY_MAX_EVOLUTION_LEVEL,
    MERCENARY_MAX_LEVEL_DUPLICATE_REWARD,
    MERCENARY_RARITY_PROBABILITY
} from '../../utils/constants.js';
import path from 'path'; // 用于处理图片路径
import fs from 'fs'; // 用于检查文件是否存在

/**
 * 根据概率表随机选择一个佣兵。
 * @returns {object|null} 选中的佣兵对象，如果无法选择则返回 null。
 */
function getRandomMercenaryByProbability() {
    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) return null;

    const randomNumber = Math.random();
    let cumulativeProbability = 0;

    let chosenRarity = null;
    for (const rarityKey in MERCENARY_RARITY_PROBABILITY) {
        cumulativeProbability += MERCENARY_RARITY_PROBABILITY[rarityKey];
        if (randomNumber < cumulativeProbability) {
            chosenRarity = parseInt(rarityKey, 10);
            break;
        }
    }

    if (chosenRarity === null) {
        chosenRarity = Math.min(...Object.keys(MERCENARY_RARITY_PROBABILITY).map(r => parseInt(r, 10)));
    }

    const candidates = mercenaries.filter(m => m.rarity === chosenRarity);
    if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    } else {
        logger.warn(`[MercenaryHandler] 稀有度 ${chosenRarity} 没有可招募的佣兵，将从所有佣兵中随机选择。`);
        return mercenaries[Math.floor(Math.random() * mercenaries.length)];
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
 *  evolvedTo: number | null,
 *  gotMaxLevelReward: boolean,
 *  rewardAmount: number,
 *  unlockedSkillDescription: string | null
 * }} 处理结果。
 */
function processMercenaryAcquisition(playerData, recruitedMercDef) {
    let message = "";
    let isNew = true;
    let evolvedTo = null;
    let gotMaxLevelReward = false;
    let rewardAmount = 0;
    let unlockedSkillDescription = null;

    const rarityToDuplicateReward = {
        1: 20, 2: 50, 3: 100, 4: 200, 5: 1000
    };
    // Fallback for MERCENARY_MAX_LEVEL_DUPLICATE_REWARD if it's not specifically tied to rarity
    const defaultMaxLevelReward = MERCENARY_MAX_LEVEL_DUPLICATE_REWARD || 500;


    const existingMerc = playerData.mercenaries.find(m => m.mercenaryId === recruitedMercDef.id);

    if (existingMerc) {
        isNew = false;
        if (existingMerc.evolutionLevel < MERCENARY_MAX_EVOLUTION_LEVEL) {
            existingMerc.evolutionLevel++;
            evolvedTo = existingMerc.evolutionLevel;
            message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已存在，进阶等级提升至 ${existingMerc.evolutionLevel}级！`;
            const newSkill = recruitedMercDef.skills.find(s => s.levelRequired === existingMerc.evolutionLevel);
            if (newSkill) {
                unlockedSkillDescription = newSkill.description;
                message += `\n解锁新技能：${unlockedSkillDescription}`;
            }
        } else {
            rewardAmount = rarityToDuplicateReward[recruitedMercDef.rarity] || defaultMaxLevelReward;
            playerData.funds += rewardAmount;
            gotMaxLevelReward = true;
            message = `佣兵 ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)}) 已达最高进阶等级，转化为 ${rewardAmount} 资金。`;
        }
    } else {
        playerData.mercenaries.push({
            mercenaryId: recruitedMercDef.id,
            evolutionLevel: 1
        });
        evolvedTo = 1;
        message = `新招募！获得佣兵：${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)})！`;
        const firstSkill = recruitedMercDef.skills.find(s => s.levelRequired === 1);
        if (firstSkill) {
            unlockedSkillDescription = firstSkill.description;
            message += `\n初始技能：${unlockedSkillDescription}`;
        }
    }
    return { playerData, message, isNew, evolvedTo, gotMaxLevelReward, rewardAmount, unlockedSkillDescription };
}


/**
 * 处理 #随机招募 指令。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleRecruitMercenary(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    if (playerData.funds < MERCENARY_RECRUIT_COST) {
        return e.reply(`资金不足！随机招募需要 ${MERCENARY_RECRUIT_COST} 资金，您当前持有 ${playerData.funds}。`);
    }

    const mercenaries = getMercenaries();
    if (!mercenaries || mercenaries.length === 0) {
        return e.reply("佣兵数据库异常，暂无法招募。请联系管理员。");
    }

    playerData.funds -= MERCENARY_RECRUIT_COST;
    const recruitedMercDef = getRandomMercenaryByProbability();

    if (!recruitedMercDef) {
        await savePlayerData(userId, playerData);
        return e.reply("招募信号受到干扰，未能成功连接到佣兵网络。资金已消耗。");
    }

    const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);
    await savePlayerData(userId, playerData);

    const forwardContent = [];
    forwardContent.push(`--- 随机招募结果 ---`);
    forwardContent.push(acquisitionResult.message);
    forwardContent.push(`剩余资金: ${playerData.funds}`);

    if (recruitedMercDef.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, recruitedMercDef.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            forwardContent.push({ type: 'image', file: recruitedMercDef.imageUrl });
        } else {
            forwardContent.push(`[图片 ${recruitedMercDef.imageUrl} 加载失败]`);
            logger.warn(`[MercenaryHandler] 招募：图片文件未找到: ${imageFullPath}`);
        }
    }

    const forwardMsg = await makeForwardMsgWithContent(forwardContent, "佣兵招募凭证");
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        await e.reply(forwardContent.filter(item => typeof item === 'string').join('\n'));
    }
    return true;
}

/**
 * 处理 #随机十连 指令。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleRecruitMercenaryTenTimes(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法进行招募。");

    const cost = MERCENARY_RECRUIT_TEN_COST || (MERCENARY_RECRUIT_COST * 9);
    if (playerData.funds < cost) {
        return e.reply(`资金不足！十连招募需要 ${cost} 资金，您当前持有 ${playerData.funds}。`);
    }

    const mercenariesData = getMercenaries();
    if (!mercenariesData || mercenariesData.length === 0) {
        return e.reply("佣兵数据库异常，暂无法招募。请联系管理员。");
    }

    playerData.funds -= cost;

    const forwardContent = [];
    forwardContent.push(`--- ${nickname} 的十连招募报告 (消耗 ${cost} 资金) ---`);
    forwardContent.push(" ");

    let highRarityMercImages = [];
    const detailedResults = [];

    for (let i = 0; i < 10; i++) {
        const recruitedMercDef = getRandomMercenaryByProbability();
        if (!recruitedMercDef) {
            detailedResults.push(`${i + 1}. 招募信号干扰，此次招募失败。`);
            continue;
        }

        const acquisitionResult = processMercenaryAcquisition(playerData, recruitedMercDef);

        let resultString = `${i + 1}. ${recruitedMercDef.name} (${"★".repeat(recruitedMercDef.rarity)})`;
        if (acquisitionResult.isNew) {
            resultString += " (✨新获得)";
            if (acquisitionResult.unlockedSkillDescription) {
                resultString += ` - 初始技能: ${acquisitionResult.unlockedSkillDescription}`;
            }
        } else if (acquisitionResult.evolvedTo) {
            resultString += ` (↗️进阶至 ${acquisitionResult.evolvedTo}级`;
            if (acquisitionResult.unlockedSkillDescription) {
                resultString += ` - 解锁技能: ${acquisitionResult.unlockedSkillDescription}`;
            }
            resultString += ")";
        } else if (acquisitionResult.gotMaxLevelReward) {
            resultString += ` (🔄满阶转化 +${acquisitionResult.rewardAmount}资金)`;
        }
        detailedResults.push(resultString);

        if (recruitedMercDef.rarity >= 4 && recruitedMercDef.imageUrl) {
            const imageFullPath = path.join(mercenaryImagePath, recruitedMercDef.imageUrl);
            if (fs.existsSync(imageFullPath)) {
                if (!highRarityMercImages.some(img => img.imageUrl === recruitedMercDef.imageUrl)) {
                    highRarityMercImages.push({
                        name: recruitedMercDef.name,
                        rarity: recruitedMercDef.rarity,
                        imageUrl: recruitedMercDef.imageUrl
                    });
                }
            } else {
                logger.warn(`[MercenaryHandler] 十连招募：高星图片文件未找到: ${imageFullPath} for ${recruitedMercDef.name}`);
            }
        }
    }

    forwardContent.push(...detailedResults);
    forwardContent.push(" ");

    if (highRarityMercImages.length > 0) {
        forwardContent.push("--- ✨ 本次招募高光时刻 ✨ ---");
        highRarityMercImages.forEach(imgInfo => {
            forwardContent.push(` ${imgInfo.name} (${"★".repeat(imgInfo.rarity)})`);
            forwardContent.push({ type: 'image', file: imgInfo.imageUrl });
            forwardContent.push(" ");
        });
    }

    await savePlayerData(userId, playerData);
    forwardContent.push(`\n--- 招募结束 ---\n剩余资金: ${playerData.funds}`);

    const forwardMsg = await makeForwardMsgWithContent(forwardContent, "十连招募详细报告");
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const textOnlyContent = forwardContent.filter(item => typeof item === 'string');
        await e.reply(textOnlyContent.join('\n').substring(0, 2000) + "\n...(部分结果可能因消息过长未显示，高星图片可能无法展示)");
    }
    return true;
}


/**
 * 处理 #佣兵列表 指令。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleListPlayerMercenaries(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法查看佣兵列表。");

    if (!playerData.mercenaries || playerData.mercenaries.length === 0) {
        return e.reply("您尚未拥有任何佣兵。快去 #随机招募 吧！\n使用 #查看佣兵 可获取更详细的佣兵信息。");
    }

    const allMercenariesDefs = getMercenaries();
    const summaryContent = [`--- ${playerData.nickname} 的佣兵档案摘要 ---`];
    let mercenaryCounter = 1;
    const validMercenaries = [];
    let madeChanges = false;
    let tempMercListText = ""; // Accumulate text for a single forward message node

    for (const ownedMerc of playerData.mercenaries) {
        const mercDef = allMercenariesDefs.find(m => m.id === ownedMerc.mercenaryId);
        if (mercDef) {
            validMercenaries.push(ownedMerc);
            let mercInfo = `${mercenaryCounter}. ${mercDef.name} (${"★".repeat(mercDef.rarity)}) - 进阶: ${ownedMerc.evolutionLevel}/${MERCENARY_MAX_EVOLUTION_LEVEL}\n`;
            mercInfo += `   简述: ${mercDef.description ? mercDef.description.substring(0, 50) + (mercDef.description.length > 50 ? "..." : "") : '无'}\n`; // Shorten description

            tempMercListText += mercInfo + "\n";
            mercenaryCounter++;
        } else {
            logger.warn(`[MercenaryHandler] 玩家 ${userId} 的佣兵 ${ownedMerc.mercenaryId} 定义未找到，将从其档案中移除。`);
            tempMercListText += `[数据同步错误] 侦测到失效佣兵数据 (ID: ${ownedMerc.mercenaryId})，已自动清理。\n\n`;
            madeChanges = true;
        }
    }

    if (tempMercListText) {
        summaryContent.push(tempMercListText.trim());
    }

    if (madeChanges) {
        playerData.mercenaries = validMercenaries;
        if (playerData.arenaTeam && playerData.arenaTeam.length > 0) {
            const oldTeamSize = playerData.arenaTeam.length;
            playerData.arenaTeam = playerData.arenaTeam.filter(teamMercId =>
                validMercenaries.some(vm => vm.mercenaryId === teamMercId)
            );
            if (playerData.arenaTeam.length < oldTeamSize) {
                summaryContent.push("\n[竞技场队伍调整] 由于部分佣兵数据失效，您的竞技场队伍可能已被调整，请使用 #佣兵配队 重新检查。");
            }
        }
        await savePlayerData(userId, playerData);
    }

    summaryContent.push("\n使用 #查看佣兵 <序号/名称> 查看指定佣兵的详细信息及图片。");

    if (mercenaryCounter === 1 && !madeChanges) {
        return e.reply("您当前没有有效的佣兵。可能是数据同步问题，请尝试重新招募。\n使用 #查看佣兵 可获取更详细的佣兵信息。");
    }
    if (mercenaryCounter === 1 && madeChanges) {
        summaryContent.push("\n所有佣兵数据均已失效并清理。您现在没有佣兵了，请尝试 #随机招募。");
    }

    if (summaryContent.length === 1) { // Only title
        return e.reply("处理您的佣兵数据时发生错误或您当前没有佣兵。");
    }

    const forwardMsg = await makeForwardMsgWithContent(summaryContent, "佣兵列表摘要");
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        await e.reply(summaryContent.join('\n').substring(0, 2000) + "\n...(部分结果可能因消息过长未显示)");
    }
    return true;
}


/**
 * 处理 #查看佣兵 [佣兵名/序号] 指令。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleViewMercenaryDetail(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法查看佣兵详情。");

    const allMercenariesDefs = getMercenaries();
    if (!playerData.mercenaries || playerData.mercenaries.length === 0) {
        return e.reply("您尚未拥有任何佣兵。");
    }

    // Get the argument after "#查看佣兵"
    const arg = e.msg.replace(/^#(查看佣兵|查看)\s*/, "").trim();

    if (!arg) {
        // No argument provided, list owned mercenaries with numbers
        let listMsg = `您拥有以下佣兵，请输入序号或名称查看详情 (例: #查看佣兵 1 或 #查看佣兵 佣兵名称):\n`;
        playerData.mercenaries.forEach((ownedMerc, index) => {
            const mercDef = allMercenariesDefs.find(m => m.id === ownedMerc.mercenaryId);
            if (mercDef) {
                listMsg += `${index + 1}. ${mercDef.name} (${"★".repeat(mercDef.rarity)}, Lv.${ownedMerc.evolutionLevel})\n`;
            }
        });
        return e.reply(listMsg);
    }

    let targetOwnedMerc = null;
    let targetMercDef = null;

    const numArg = parseInt(arg, 10);
    if (!isNaN(numArg) && numArg > 0 && numArg <= playerData.mercenaries.length) {
        // Argument is a number (序号)
        targetOwnedMerc = playerData.mercenaries[numArg - 1];
        if (targetOwnedMerc) {
            targetMercDef = allMercenariesDefs.find(m => m.id === targetOwnedMerc.mercenaryId);
        }
    } else {
        // Argument is a name
        for (const ownedMerc of playerData.mercenaries) {
            const mercDef = allMercenariesDefs.find(m => m.id === ownedMerc.mercenaryId);
            if (mercDef && mercDef.name.toLowerCase() === arg.toLowerCase()) {
                targetOwnedMerc = ownedMerc;
                targetMercDef = mercDef;
                break;
            }
        }
    }

    if (!targetOwnedMerc || !targetMercDef) {
        return e.reply(`未找到名为 "${arg}" 或序号为 "${arg}" 的佣兵。请使用 #佣兵列表 查看您拥有的佣兵，并使用 #查看佣兵 <序号/名称> 查看详情。`);
    }

    const forwardContent = [];
    forwardContent.push(`--- 佣兵详情: ${targetMercDef.name} ---`);

    let mercInfo = `\n${targetMercDef.name} (${"★".repeat(targetMercDef.rarity)})`;
    mercInfo += `\n进阶等级: ${targetOwnedMerc.evolutionLevel}/${MERCENARY_MAX_EVOLUTION_LEVEL}`;
    mercInfo += `\n\n【简介】\n${targetMercDef.description || '暂无详细描述。'}`;

    mercInfo += `\n\n【技能列表】`;
    if (targetMercDef.skills && targetMercDef.skills.length > 0) {
        targetMercDef.skills.forEach(skill => {
            if (skill.levelRequired <= targetOwnedMerc.evolutionLevel) {
                mercInfo += `\n  - (Lv.${skill.levelRequired}解锁) ${skill.description}`;
            } else {
                mercInfo += `\n  - [未解锁 Lvl.${skill.levelRequired}] ${skill.description}`;
            }
        });
    } else {
        mercInfo += `\n  该佣兵暂无技能信息。`;
    }
    forwardContent.push(mercInfo);

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
        await e.reply(forwardContent.filter(item => typeof item === 'string').join('\n'));
    }
    return true;
}