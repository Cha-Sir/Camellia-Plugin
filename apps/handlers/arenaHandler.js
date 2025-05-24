// camellia-plugin/apps/handlers/arenaHandler.js

/**
 * @file 竞技场系统相关逻辑处理器。
 */

import { getPlayerData, savePlayerData, getMercenaries } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    ARENA_TEAM_SIZE,
    ARENA_WIN_REWARD_MIN,
    ARENA_WIN_REWARD_MAX,
    ARENA_AI_API_ENDPOINT,
    ARENA_AI_MODEL_NAME, ARENA_BATTLE_MIN_TURNS, ARENA_BATTLE_MAX_TURNS
} from '../../utils/constants.js';
// 导入 node-fetch (如果尚未安装，请运行 npm install node-fetch@2 --save 或 yarn add node-fetch@2)
// 对于 ESM，需要 import fetch from 'node-fetch';
// 但Yunzai是基于CommonJS的，其内部可能有自己的HTTP客户端或允许直接使用require
// 为简单起见，这里使用动态导入，或者你可以在你的Yunzai环境中找到推荐的HTTP请求方式
// 如果你的Yunzai环境是纯ESM且支持顶层await，可以直接 import fetch from 'node-fetch';
// 否则，可能需要一个辅助函数或确保你的package.json type不是module
let fetch;
try {
    fetch = (await import('node-fetch')).default;
} catch (err) {
    logger.error('[ArenaHandler] 未能加载 node-fetch。竞技场AI对战功能将不可用。请确保已安装 node-fetch (npm i node-fetch@2)。');
}

// 定义新的API端点和你的API Key
const CUSTOM_AI_API_ENDPOINT = "https://api2.aigcbest.top/v1/chat/completions"; // 假设其路径与OpenAI兼容
const CUSTOM_AI_API_KEY = "sk-1VPFgLrJ952VJQNc19Dd7678B4D74fAeAfFdFd8a0f31A3C7";


const arenaQueue = []; // { userId: string, nickname: string, team: object[], groupId: string, e: object }

/**
 * 处理 #佣兵配队 指令。
 * 格式: #佣兵配队 佣兵名1,佣兵名2,佣兵名3,佣兵名4,佣兵名5
 * (为了简化，这里假设佣兵名是唯一的，或者用户输入的是ID。实际应用中可能需要更复杂的匹配)
 * 当前实现：通过玩家拥有的佣兵列表中的索引来选择。
 * 例如: #佣兵配队 1,3,5,2,4 (使用佣兵列表中第1,3,5,2,4个佣兵)
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleSetArenaTeam(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法配置队伍。");
    if (!playerData.mercenaries || playerData.mercenaries.length < ARENA_TEAM_SIZE) {
        return e.reply(`您的佣兵数量不足 ${ARENA_TEAM_SIZE} 名，无法组成竞技场队伍。请先 #随机招募 更多佣兵。`);
    }

    const teamSelection = e.msg.replace(/^#佣兵配队\s*/, "").trim();
    const selectedIndices = teamSelection.split(/[,，\s]+/).map(s => parseInt(s.trim(), 10) -1); // 用户输入1代表第0个

    if (selectedIndices.length !== ARENA_TEAM_SIZE) {
        return e.reply(`队伍配置错误！您需要选择 ${ARENA_TEAM_SIZE} 名佣兵。请使用您佣兵列表中的序号，用逗号隔开，例如：#佣兵配队 1,2,3,4,5`);
    }

    const newTeamMercenaryIds = [];
    const allMercenariesDefs = getMercenaries();
    const playerOwnedMercsWithDetails = playerData.mercenaries.map(owned => {
        const def = allMercenariesDefs.find(m => m.id === owned.mercenaryId);
        return { ...owned, def };
    }).filter(m => m.def); // 过滤掉可能找不到定义的佣兵

    const chosenTeamNames = [];
    const uniqueCheck = new Set();

    for (const index of selectedIndices) {
        if (isNaN(index) || index < 0 || index >= playerOwnedMercsWithDetails.length) {
            return e.reply(`输入的选择序号 "${index + 1}" 无效。请使用 #佣兵列表 查看您的佣兵及其序号。`);
        }
        const selectedMerc = playerOwnedMercsWithDetails[index];
        if (uniqueCheck.has(selectedMerc.mercenaryId)) {
            return e.reply(`队伍中不能包含重复的佣兵。佣兵 "${selectedMerc.def.name}" 被选择了多次。`);
        }
        uniqueCheck.add(selectedMerc.mercenaryId);
        newTeamMercenaryIds.push(selectedMerc.mercenaryId);
        chosenTeamNames.push(selectedMerc.def.name);
    }

    playerData.arenaTeam = newTeamMercenaryIds;
    await savePlayerData(userId, playerData);

    e.reply(`竞技场队伍已更新！\n当前队伍：${chosenTeamNames.join('、 ')}\n请使用 #加入竞技场 开始匹配！`);
    return true;
}

/**
 * 处理 #加入竞技场 指令。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleJoinArena(e, pluginInstance) {
    const userId = e.user_id;
    const rawNickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`; // 使用原始昵称
    const { playerData } = await pluginInstance.getPlayer(userId, rawNickname);

    if (!playerData) return e.reply("身份验证失败，无法加入竞技场。");

    if (!playerData.arenaTeam || playerData.arenaTeam.length !== ARENA_TEAM_SIZE) {
        return e.reply(`您尚未配置完整的竞技场队伍 (${ARENA_TEAM_SIZE}名佣兵)。请使用 #佣兵配队 进行设置。`);
    }

    if (arenaQueue.find(p => p.userId === userId)) {
        return e.reply("您已在竞技场队列中，请耐心等待匹配。");
    }

    const allMercenariesDefs = getMercenaries();
    const currentTeamDetails = [];
    for (const mercId of playerData.arenaTeam) {
        const ownedMerc = playerData.mercenaries.find(m => m.mercenaryId === mercId);
        const mercDef = allMercenariesDefs.find(m => m.id === mercId);
        if (!ownedMerc || !mercDef) {
            return e.reply(`您的竞技场队伍中包含无效或已不存在的佣兵 (${mercId})。请重新使用 #佣兵配队 设置。`);
        }
        currentTeamDetails.push({ ...mercDef, evolutionLevel: ownedMerc.evolutionLevel });
    }

    // 使用处理过的昵称（包含称号）
    const participantNickname = playerData.activeTitle ? `【${playerData.activeTitle}】${playerData.nickname}` : playerData.nickname;

    arenaQueue.push({
        userId: userId,
        nickname: participantNickname, // 使用包含称号的昵称
        team: currentTeamDetails,
        groupId: e.group_id, // 保存当前玩家的群组ID
        e: e
    });

    e.reply(`${participantNickname} 已加入竞技场队列，等待其他挑战者...`);
    logger.info(`[ArenaHandler] 玩家 ${participantNickname} (ID: ${userId}) 加入竞技场队列。当前队列人数: ${arenaQueue.length}`);

    if (arenaQueue.length >= 2) {
        const player1Entry = arenaQueue.shift();
        const player2Entry = arenaQueue.shift();
        logger.info(`[ArenaHandler] 匹配成功: ${player1Entry.nickname} vs ${player2Entry.nickname}`);

        // --- 修改匹配成功消息发送逻辑 ---
        const msgToP1 = `匹配成功！您的对手是 ${player2Entry.nickname}。战斗即将开始...`;
        const msgToP2 = `匹配成功！您的对手是 ${player1Entry.nickname}。战斗即将开始...`;

        const sentToGroupForMatchNotification = new Set();

        // 发送给玩家1
        if (player1Entry.groupId && global.Bot?.pickGroup(player1Entry.groupId)) {
            try {
                await global.Bot.pickGroup(player1Entry.groupId).sendMsg(msgToP1);
                sentToGroupForMatchNotification.add(player1Entry.groupId);
            } catch (err) {
                logger.error(`[ArenaHandler] Error sending match notification to P1's group ${player1Entry.groupId}:`, err);
            }
        } else if (player1Entry.e) { // 私聊
            try {
                await player1Entry.e.reply(msgToP1);
            } catch (err) {
                logger.error(`[ArenaHandler] Error replying match notification to P1 (user: ${player1Entry.userId}):`, err);
            }
        }

        // 发送给玩家2，仅当其群组与P1不同或P2是私聊且P1也是私聊（或P1的群发送失败）
        if (player2Entry.groupId && !sentToGroupForMatchNotification.has(player2Entry.groupId) && global.Bot?.pickGroup(player2Entry.groupId)) {
            // 如果P2的群组ID不同于P1的，或者P1没有群组ID (P1是私聊)
            try {
                await global.Bot.pickGroup(player2Entry.groupId).sendMsg(msgToP2);
                // sentToGroupForMatchNotification.add(player2Entry.groupId); // 也可以在这里添加，但主要用于避免对同一群组发两条内容几乎一样的消息
            } catch (err) {
                logger.error(`[ArenaHandler] Error sending match notification to P2's group ${player2Entry.groupId}:`, err);
            }
        } else if (player2Entry.e && (!player2Entry.groupId || !sentToGroupForMatchNotification.has(player2Entry.groupId))) {
            // 如果P2是私聊，或者P2的群组ID与P1的不同（或者P1没有群组ID），并且P2的群未收到过通知
            if (!player2Entry.groupId || (player2Entry.groupId !== player1Entry.groupId)) {
                try {
                    await player2Entry.e.reply(msgToP2);
                } catch (err) {
                    logger.error(`[ArenaHandler] Error replying match notification to P2 (user: ${player2Entry.userId}):`, err);
                }
            } else if (player2Entry.groupId && player2Entry.groupId === player1Entry.groupId) {
                logger.debug(`[ArenaHandler] Match notification for P2 skipped, same group as P1: ${player1Entry.groupId}`);
            }
        }
        // --- 匹配成功消息发送逻辑结束 ---

        await processArenaBattle(player1Entry, player2Entry, pluginInstance);
    }
    return true;
}

/**
 * 处理 #退出竞技场队列 指令
 * @param {object} e - Yunzai事件对象
 * @param {object} pluginInstance - 插件实例
 */
export async function handleLeaveArenaQueue(e, pluginInstance) {
    const userId = e.user_id;
    const playerIndex = arenaQueue.findIndex(p => p.userId === userId);

    if (playerIndex === -1) {
        return e.reply("您当前不在竞技场队列中。");
    }

    const playerEntry = arenaQueue.splice(playerIndex, 1)[0];
    logger.info(`[ArenaHandler] 玩家 ${playerEntry.nickname} (ID: ${userId}) 已退出竞技场队列。`);
    e.reply(`${playerEntry.nickname} 已成功退出竞技场队列。`);
    return true;
}


/**
 * 处理竞技场战斗，与AI交互并结算。
 * @param {object} player1 - 玩家1的信息 { userId, nickname, team, groupId, e }
 * @param {object} player2 - 玩家2的信息 { userId, nickname, team, groupId, e }
 * @param {object} pluginInstance - 插件主类的实例。
 */
async function processArenaBattle(player1, player2, pluginInstance) {
    if (!fetch) {
        const errorMsg = "竞技场战斗模块配置错误（无法加载HTTP请求库），战斗无法进行。请联系管理员。";
        sendArenaMessageToBoth(player1, player2, errorMsg, "竞技场错误");
        return;
    }

    const prepareTeamPrompt = (playerInfo) => { // Renamed for clarity
        let teamPrompt = `${playerInfo.nickname}的队伍：\n`;
        playerInfo.team.forEach(merc => {
            teamPrompt += `- ${merc.name} (稀有度: ${"★".repeat(merc.rarity)}, 进阶等级: ${merc.evolutionLevel})\n`;
            teamPrompt += `  简介: ${merc.description}\n`;
            teamPrompt += `  已解锁技能:\n`;
            merc.skills.filter(s => s.levelRequired <= merc.evolutionLevel).forEach(skill => {
                teamPrompt += `    * ${skill.description}\n`;
            });
        });
        return teamPrompt;
    };

    const player1PromptInfo = prepareTeamPrompt(player1); // Renamed for clarity
    const player2PromptInfo = prepareTeamPrompt(player2); // Renamed for clarity

    const minTurns = ARENA_BATTLE_MIN_TURNS || 3;
    const maxTurns = ARENA_BATTLE_MAX_TURNS || 5;

    const fullPrompt = `以下是两位指挥官在竞技场的佣兵队伍配置。
注意每个角色都是一个独特的角色，你不应该仅仅模拟出战斗过程，还有生动形象地体现角色的特征，甚至可以生成对白等
一般来说，星级越高，进阶等级越高的角色越强，请你依据此来判断战斗双方的强弱，当然也可以包含一些随机性
请模拟一场精彩的战斗，战斗过程应包含 ${minTurns} 到 ${maxTurns} 个回合。
每个角色的名字前都应该用【⭐】标记出他的稀有度，技能也需要用【】包裹。如【5⭐】埃德加使用了技能【火球术】
请严格以JSON格式返回你的回答，JSON对象必须包含以下两个键：
1.  "combatTurns": 一个JSON数组，数组中的每个元素都是一个字符串，代表一个回合的详细战斗描述。数组长度应在 ${minTurns} 到 ${maxTurns} 之间。
2.  "resultLog": 一个字符串，简洁明了地指出胜利者，例如 "指挥官 ${player1.nickname} 胜利！" 或 "指挥官 ${player2.nickname} 胜利！"。

指挥官 ${player1.nickname}的队伍信息：
${player1PromptInfo}

指挥官 ${player2.nickname}的队伍信息：
${player2PromptInfo}

现在，开始模拟战斗并按要求格式输出结果。
`;

    const requestBody = {
        model: ARENA_AI_MODEL_NAME,
        messages: [
            { role: "system", content: `你是一个第三人称小说转述者。你的任务是根据双方的角色佣兵配置，生成一场包含 ${minTurns} 到 ${maxTurns} 个回合的生动战斗描述，并判定胜负。结果必须以指定的JSON格式输出，包含 "combatTurns" (一个回合描述字符串的数组) 和 "resultLog" (一个胜负结果字符串)。` },
            { role: "user", content: fullPrompt }
        ],
        response_format: { type: "json_object" } // 确保模型支持此参数
    };

    let aiResponseData;
    try {
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI API request timed out after 300 seconds')), 300000)
        );
        const fetchPromise = fetch(`https://${ARENA_AI_API_ENDPOINT}`, { // 确保是 https
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CUSTOM_AI_API_KEY || 'YOUR_API_KEY_HERE'}`
            },
            body: JSON.stringify(requestBody)
        });

        logger.debug('[ArenaHandler] Sending request to AI API with body:', JSON.stringify(requestBody, null, 2).substring(0, 500) + "..."); // 截断过长的日志

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        if (!response.ok) {
            const errorBody = await response.text();
            logger.error(`[ArenaHandler] AI API request failed with status ${response.status}: ${errorBody}`);
            throw new Error(`AI API请求失败，状态码: ${response.status}. 详情: ${errorBody.substring(0, 100)}`);
        }
        const rawJsonResponse = await response.json(); // 这是外层OpenAI API的JSON响应
        logger.debug('[ArenaHandler] Received raw AI response:', JSON.stringify(rawJsonResponse, null, 2));

        if (!rawJsonResponse.choices || !rawJsonResponse.choices[0] || !rawJsonResponse.choices[0].message || !rawJsonResponse.choices[0].message.content) {
            throw new Error('AI返回的数据格式不符合预期 (缺少 choices[0].message.content)');
        }

        // 解析 message.content 中字符串化的JSON
        if (!rawJsonResponse.choices || !rawJsonResponse.choices[0] || !rawJsonResponse.choices[0].message || !rawJsonResponse.choices[0].message.content) {
            throw new Error('AI返回的数据格式不符合预期 (缺少 choices[0].message.content)');
        }

        let jsonString = rawJsonResponse.choices[0].message.content;
        logger.debug('[ArenaHandler] Received AI message.content (raw):', jsonString);

        // 尝试移除Markdown代码块标记
        // 有些模型会返回 ```json\n{...}\n``` 或 ```\n{...}\n```
        const match = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match && match[1]) {
            jsonString = match[1];
            logger.debug('[ArenaHandler] Stripped Markdown, using content:', jsonString);
        } else {
            // 如果没有找到Markdown块，可能是纯JSON，或者仍然有问题，先trim一下
            jsonString = jsonString.trim();
            logger.debug('[ArenaHandler] No Markdown block detected, using trimmed content:', jsonString);
        }

        try {
            aiResponseData = JSON.parse(jsonString);
        } catch (parseError) {
            logger.error('[ArenaHandler] Failed to parse JSON even after attempting cleanup:', parseError);
            logger.error('[ArenaHandler] Content that failed to parse:', jsonString.substring(0, 500) + (jsonString.length > 500 ? "..." : "")); // Log a snippet
            throw new Error(`AI返回的内容无法解析为JSON: ${parseError.message}. 内容片段: ${jsonString.substring(0, 100)}...`);
        }

        logger.debug('[ArenaHandler] Parsed AI battle data:', JSON.stringify(aiResponseData, null, 2));


        if (!Array.isArray(aiResponseData.combatTurns) || typeof aiResponseData.resultLog !== 'string') {
            throw new Error('AI返回的JSON内容不符合预期 (combatTurns应为数组, resultLog应为字符串)');
        }

        if (!Array.isArray(aiResponseData.combatTurns) || typeof aiResponseData.resultLog !== 'string') {
            throw new Error('AI返回的JSON内容不符合预期 (combatTurns应为数组, resultLog应为字符串)');
        }
        if (aiResponseData.combatTurns.length < minTurns || aiResponseData.combatTurns.length > maxTurns) {
            logger.warn(`[ArenaHandler] AI返回的回合数 (${aiResponseData.combatTurns.length}) 超出预期范围 (${minTurns}-${maxTurns})。仍将使用。`);
        }

    } catch (error) {
        logger.error('[ArenaHandler] 与AI交互或解析响应时发生错误:', error);
        sendArenaMessageToBoth(player1, player2, `竞技场战斗模拟失败: ${error.message}。双方均不扣除/获得奖励。`, "战斗模拟异常");
        return;
    }

    // 处理战斗结果和奖励
    let winnerEntry = null;
    let loserEntry = null;
    const combatTurns = aiResponseData.combatTurns || ["AI未能提供详细战斗回合记录。"];
    const resultLog = aiResponseData.resultLog || "AI未能判定胜负。";

    if (resultLog.toLowerCase().includes(player1.nickname.toLowerCase())) { // 不区分大小写匹配
        winnerEntry = player1;
        loserEntry = player2;
    } else if (resultLog.toLowerCase().includes(player2.nickname.toLowerCase())) { // 不区分大小写匹配
        winnerEntry = player2;
        loserEntry = player1;
    }

    const settlementContent = []; // 用于构建转发消息的数组
    settlementContent.push("--- 竞技场战报 ---");
    settlementContent.push("【战斗过程】:");

    // 将每个战斗回合作为转发消息的一个独立节点
    combatTurns.forEach((turnDescription, index) => {
        settlementContent.push(`\n--- 回合 ${index + 1} ---`);
        settlementContent.push(turnDescription);
    });

    settlementContent.push("\n--- 【战斗结果】 ---");
    settlementContent.push(resultLog);

    const rewardAmount = Math.floor(Math.random() * (ARENA_WIN_REWARD_MAX - ARENA_WIN_REWARD_MIN + 1)) + ARENA_WIN_REWARD_MIN;

    if (winnerEntry && loserEntry) {
        const { playerData: winnerData } = await pluginInstance.getPlayer(winnerEntry.userId);
        const { playerData: loserData } = await pluginInstance.getPlayer(loserEntry.userId);

        if (winnerData) {
            winnerData.funds += rewardAmount;
            await savePlayerData(winnerEntry.userId, winnerData);
            settlementContent.push(`\n恭喜 ${winnerEntry.nickname} 获得胜利！奖励 ${rewardAmount} 资金！`);
            settlementContent.push(`${winnerEntry.nickname} 当前资金: ${winnerData.funds}`);
        } else {
            settlementContent.push(`\n${winnerEntry.nickname} 获得胜利！但无法同步其资金奖励 (玩家数据获取失败)。`);
        }

        if (loserData) {
            const penalty = rewardAmount; // 失败者惩罚等同于胜者奖励
            loserData.funds = Math.max(0, loserData.funds - penalty); // 资金不能为负
            await savePlayerData(loserEntry.userId, loserData);
            settlementContent.push(`\n很遗憾，${loserEntry.nickname} 本场失利。损失 ${penalty} 资金。`);
            settlementContent.push(`${loserEntry.nickname} 当前资金: ${loserData.funds}`);
        } else {
            settlementContent.push(`\n${loserEntry.nickname} 本场失利。无法同步其资金惩罚 (玩家数据获取失败)。`);
        }

    } else {
        settlementContent.push("\n本场战斗结果未明确或为平局，无资金奖惩。");
    }

    sendArenaMessageToBothWithForward(player1, player2, settlementContent, "竞技场结算");
}
/**
 * 向竞技场双方发送普通消息。
 */
function sendArenaMessageToBoth(player1, player2, message, title = "竞技场通知") {
    const fullMessage = `${title ? `[${title}] ` : ''}${message}`;

    if (player1.groupId && player1.groupId === player2.groupId) {
        // 双方在同一群组
        if (global.Bot?.pickGroup(player1.groupId)) {
            logger.debug(`[ArenaHandler] Sending single message to common group ${player1.groupId}`);
            global.Bot.pickGroup(player1.groupId).sendMsg(fullMessage).catch(err => logger.error(`Error sending to common group ${player1.groupId}:`, err));
        } else if (player1.e) { // Fallback to player1's event if group picking fails
            logger.debug(`[ArenaHandler] Fallback: Sending single message via player1's event to common group`);
            player1.e.reply(fullMessage).catch(err => logger.error(`Error replying via player1's event:`, err));
        }
    } else {
        // 双方在不同群组或至少一方没有群组ID (理论上加入竞技场时应该有)
        if (player1.groupId && global.Bot?.pickGroup(player1.groupId)) {
            logger.debug(`[ArenaHandler] Sending message to player1's group ${player1.groupId}`);
            global.Bot.pickGroup(player1.groupId).sendMsg(fullMessage).catch(err => logger.error(`Error sending to player1's group ${player1.groupId}:`, err));
        } else if (player1.e) { // Fallback for player1
            logger.debug(`[ArenaHandler] Fallback: Sending message via player1's event`);
            player1.e.reply(fullMessage).catch(err => logger.error(`Error replying via player1's event:`, err));
        }

        if (player2.groupId && global.Bot?.pickGroup(player2.groupId)) {
            logger.debug(`[ArenaHandler] Sending message to player2's group ${player2.groupId}`);
            global.Bot.pickGroup(player2.groupId).sendMsg(fullMessage).catch(err => logger.error(`Error sending to player2's group ${player2.groupId}:`, err));
        } else if (player2.e) { // Fallback for player2
            logger.debug(`[ArenaHandler] Fallback: Sending message via player2's event`);
            player2.e.reply(fullMessage).catch(err => logger.error(`Error replying via player2's event:`, err));
        }
    }
}

/**
 * 向竞技场双方发送转发消息。
 * 如果双方在同一群组，则只发送一次。
 */
async function sendArenaMessageToBothWithForward(player1, player2, contentArray, title = "竞技场情报") {
    const forwardMsg = await makeForwardMsgWithContent(contentArray, title);
    if (!forwardMsg) {
        // Fallback if forward message creation fails
        logger.warn(`[ArenaHandler] Failed to create forward message for title: ${title}. Sending plain text fallback.`);
        const fallbackText = contentArray.filter(item => typeof item === 'string').join('\n');
        sendArenaMessageToBoth(player1, player2, fallbackText.substring(0, 1000) + (fallbackText.length > 1000 ? "\n...(消息过长)" : ""), title);
        return;
    }

    if (player1.groupId && player1.groupId === player2.groupId) {
        // 双方在同一群组
        if (global.Bot?.pickGroup(player1.groupId)) {
            logger.debug(`[ArenaHandler] Sending single forward message to common group ${player1.groupId}`);
            global.Bot.pickGroup(player1.groupId).sendMsg(forwardMsg).catch(err => logger.error(`Error sending forward msg to common group ${player1.groupId}:`, err));
        } else if (player1.e) {
            logger.debug(`[ArenaHandler] Fallback: Sending single forward message via player1's event to common group`);
            player1.e.reply(forwardMsg).catch(err => logger.error(`Error replying forward msg via player1's event:`, err));
        }
    } else {
        // 双方在不同群组
        if (player1.groupId && global.Bot?.pickGroup(player1.groupId)) {
            logger.debug(`[ArenaHandler] Sending forward message to player1's group ${player1.groupId}`);
            global.Bot.pickGroup(player1.groupId).sendMsg(forwardMsg).catch(err => logger.error(`Error sending forward msg to player1's group ${player1.groupId}:`, err));
        } else if (player1.e) {
            logger.debug(`[ArenaHandler] Fallback: Sending forward message via player1's event`);
            player1.e.reply(forwardMsg).catch(err => logger.error(`Error replying forward msg via player1's event:`, err));
        }

        if (player2.groupId && global.Bot?.pickGroup(player2.groupId)) {
            logger.debug(`[ArenaHandler] Sending forward message to player2's group ${player2.groupId}`);
            global.Bot.pickGroup(player2.groupId).sendMsg(forwardMsg).catch(err => logger.error(`Error sending forward msg to player2's group ${player2.groupId}:`, err));
        } else if (player2.e) {
            logger.debug(`[ArenaHandler] Fallback: Sending forward message via player2's event`);
            player2.e.reply(forwardMsg).catch(err => logger.error(`Error replying forward msg via player2's event:`, err));
        }
    }
}