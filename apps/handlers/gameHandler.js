// camellia-plugin/apps/handlers/gameHandler.js

import { getItems, getWeapons, getMaps, getPublicItems, getPlayerData, savePlayerData, getNpcs } from '../../utils/dataManager.js';
import { calculateCombatPowerWithPassives, determineBattleOutcome } from '../../utils/combatHelper.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    STRATEGY_PROBABILITY,
    DEFAULT_FALLBACK_ITEM_NAME,
    INITIAL_WEAPON_NAME,
    POST_COMBAT_ESCAPE_UNHARMED_CHANCE,
    POST_COMBAT_ESCAPE_WOUNDED_CHANCE
} from '../../utils/constants.js';

const gamePools = {};
const playerQueueStatus = {};
const QUEUE_CHECK_INTERVAL = 60 * 1000; // 1分钟检查一次队列
const DEFAULT_NPC_FILL_DELAY_MINUTES = 5;
const PLUGIN_NAME = '都市迷踪（搜打撤）'; // Define plugin name as a constant

let queueCheckIntervalId = null; // Variable to hold the interval ID

/**
 * Helper function to get the display name for a player or NPC, including their title.
 * @param {object} playerInGame - The player object from the game pool.
 * @returns {string} The formatted nickname with title if applicable.
 */
function getFormattedNickname(playerInGame) {
    if (!playerInGame) return "未知参与者";
    if (playerInGame.isNpc) {
        return playerInGame.nickname; // NPC nicknames are pre-formatted with title
    }
    // For real players
    if (playerInGame.activeTitle && playerInGame.activeTitle.trim() !== "") {
        return `【${playerInGame.activeTitle}】${playerInGame.nickname}`;
    }
    return playerInGame.nickname;
}


/**
 * Attempts to find the plugin instance.
 * @returns {object|null} The plugin instance or null if not found.
 */
function getPluginInstance() {
    let pInstance = null;
    if (global.Bot && global.Bot.plugins && typeof global.Bot.plugins === 'object' && !Array.isArray(global.Bot.plugins)) {
        for (const key in global.Bot.plugins) {
            if (global.Bot.plugins[key] && global.Bot.plugins[key].name === PLUGIN_NAME && typeof global.Bot.plugins[key].getPlayer === 'function') {
                pInstance = global.Bot.plugins[key];
                break;
            }
        }
    }
    if (!pInstance && global.Bot && global.Bot.plugins && Array.isArray(global.Bot.plugins)) {
        pInstance = global.Bot.plugins.find(p => p && p.name === PLUGIN_NAME && typeof p.getPlayer === 'function');
    }
    if (!pInstance && global.plugins && typeof global.plugins === 'object' && !Array.isArray(global.plugins)) {
        for (const key in global.plugins) {
            if (global.plugins[key] && global.plugins[key].name === PLUGIN_NAME && typeof global.plugins[key].getPlayer === 'function') {
                pInstance = global.plugins[key];
                break;
            }
        }
    }
    if (!pInstance && global.plugins && Array.isArray(global.plugins)) {
        pInstance = global.plugins.find(p => p && p.name === PLUGIN_NAME && typeof p.getPlayer === 'function');
    }
    return pInstance;
}

/**
 * Initializes timed tasks for the game handler, like checking and filling queues.
 */
export function initializeGameHandlerTimedTasks() {
    if (queueCheckIntervalId) {
        clearInterval(queueCheckIntervalId); // Clear existing interval if any
        logger.info('[GameHandler] Cleared existing queue check interval.');
    }
    queueCheckIntervalId = setInterval(() => {
        checkAndFillQueuesWithNpcs();
    }, QUEUE_CHECK_INTERVAL);
    logger.info(`[GameHandler] Timed task for checking NPC queues initialized. Interval: ${QUEUE_CHECK_INTERVAL / 1000}s.`);
}

/**
 * Stops timed tasks for the game handler.
 */
export function stopGameHandlerTimedTasks() {
    if (queueCheckIntervalId) {
        clearInterval(queueCheckIntervalId);
        queueCheckIntervalId = null;
        logger.info('[GameHandler] Stopped queue check interval.');
    }
}


async function checkAndFillQueuesWithNpcs() {
    const currentTime = Date.now();
    const allNpcDefs = getNpcs();
    const allWeaponDefs = getWeapons();
    const pluginInstance = getPluginInstance();

    if (!pluginInstance && Object.values(gamePools).some(pool => pool.status === 'waiting' && pool.players.some(p => !p.isNpc))) {
        logger.error(`[GameHandler - QueueFiller] 关键错误: 无法找到插件实例。涉及真实玩家的NPC填充和自动开始游戏功能将失败。`);
    }

    for (const mapName in gamePools) {
        const pool = gamePools[mapName];
        if (pool.status === 'waiting' && pool.players.length > 0 && pool.players.length < pool.mapInfo.playerCapacity) {
            const queueTime = pool.queueStartTime || currentTime;
            const delayMinutes = pool.mapInfo.npcFillDelayMinutes || DEFAULT_NPC_FILL_DELAY_MINUTES;

            if ((currentTime - queueTime) > delayMinutes * 60 * 1000) {
                logger.info(`[GameHandler] 地图 "${mapName}" 队列等待超时，尝试用NPC填充。`);
                const neededNpcs = pool.mapInfo.playerCapacity - pool.players.length;
                const availableNpcIdsOnMap = pool.mapInfo.availableNpcIds || [];
                let spawnedNpcCount = 0;
                const tempPlayerForNotification = pool.players.find(p => !p.isNpc);

                if (availableNpcIdsOnMap.length > 0 && neededNpcs > 0) {
                    for (let i = 0; i < neededNpcs; i++) {
                        if (spawnedNpcCount >= (pool.mapInfo.maxNpcsToSpawn || availableNpcIdsOnMap.length)) break;
                        const randomNpcId = availableNpcIdsOnMap[Math.floor(Math.random() * availableNpcIdsOnMap.length)];
                        const npcDef = allNpcDefs.find(n => n.id === randomNpcId);
                        if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition.id === npcDef.id)) {
                            const npcPlayerObject = createNpcPlayerObject(npcDef, allWeaponDefs, false);
                            pool.players.push(npcPlayerObject);
                            logger.info(`[GameHandler] NPC "${getFormattedNickname(npcPlayerObject)}" 因超时已加入地图 "${mapName}"。`);
                            spawnedNpcCount++;
                        }
                    }
                }

                let timeoutSpawnedNpcNames = pool.players
                    .filter(p => p.isNpc && !p.justSpawnedRandomly)
                    .slice(-spawnedNpcCount)
                    .map(n => getFormattedNickname(n));

                if (spawnedNpcCount > 0) {
                    pool.gameProcessLog.push(`[系统提示] 由于等待超时，${spawnedNpcCount}名NPC调查员(${timeoutSpawnedNpcNames.join('、 ')})已加入队伍！`);
                }

                if (pool.players.length >= pool.mapInfo.playerCapacity) {
                    if (pluginInstance || pool.players.every(p => p.isNpc)) {
                        if (spawnedNpcCount > 0 && tempPlayerForNotification && tempPlayerForNotification.groupId && global.Bot && global.Bot.pickGroup) {
                            const groupToNotify = global.Bot.pickGroup(tempPlayerForNotification.groupId);
                            if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                                let immediateMsg = `[${mapName}] 探索队伍已满员！`;
                                if (timeoutSpawnedNpcNames.length > 0) {
                                    immediateMsg += ` 由 ${timeoutSpawnedNpcNames.join('、 ')} 等自动填充。即将开始探索...`;
                                } else {
                                    immediateMsg += ` 即将开始探索...`;
                                }
                                await groupToNotify.sendMsg(immediateMsg).catch(err => logger.error(`[GameHandler] Error sending timeout NPC fill message: ${err}`));
                            }
                        }
                        await processGameInstance(mapName, pluginInstance);
                    } else {
                        logger.error(`[GameHandler] 无法启动地图 "${mapName}" 的游戏 (NPC超时填充后)，因为缺少插件实例且队列中有真实玩家。`);
                        if (tempPlayerForNotification && tempPlayerForNotification.groupId && global.Bot && global.Bot.pickGroup) {
                            const groupToNotify = global.Bot.pickGroup(tempPlayerForNotification.groupId);
                            if (groupToNotify) await groupToNotify.sendMsg(`[${mapName}] 探索启动失败：系统组件错误，无法自动开始。请尝试重新加入或联系管理员。`).catch(e => {});
                        }
                    }
                }
            }
        }
    }
}

function createNpcPlayerObject(npcDef, allWeaponDefs, spawnedByRandomEvent = false) {
    let npcWeaponResolved = null;
    if (typeof npcDef.weapon === 'string') {
        npcWeaponResolved = allWeaponDefs.find(w => w.name === npcDef.weapon) ||
            { name: npcDef.weapon, baseCombatPower: 50, passive: "无", passiveType: "none", rarity: "普通", description: "未知装备 (来自NPC定义)" };
    } else if (typeof npcDef.weapon === 'object' && npcDef.weapon.name) {
        const globalWeaponMatch = allWeaponDefs.find(w => w.name === npcDef.weapon.name);
        if (globalWeaponMatch) {
            npcWeaponResolved = {
                ...globalWeaponMatch,
                baseCombatPower: npcDef.weapon.baseCombatPower || globalWeaponMatch.baseCombatPower,
                passive: npcDef.weapon.passive || globalWeaponMatch.passive,
                passiveType: npcDef.weapon.passiveType || globalWeaponMatch.passiveType,
                passiveValue: npcDef.weapon.passiveValue !== undefined ? npcDef.weapon.passiveValue : globalWeaponMatch.passiveValue,
                passiveDescription: npcDef.weapon.passiveDescription || globalWeaponMatch.passiveDescription,
                rarity: npcDef.weapon.rarity || globalWeaponMatch.rarity
            };
        } else {
            npcWeaponResolved = { ...npcDef.weapon };
        }
    } else {
        npcWeaponResolved = { name: "特殊制式装备", baseCombatPower: npcDef.baseCombatPower || 50, passive: "标准型号", passiveType: "none", rarity: "特殊", description: "NPC专属标准装备"};
    }
    npcWeaponResolved.baseCombatPower = npcWeaponResolved.baseCombatPower || npcDef.baseCombatPower || 0;
    npcWeaponResolved.passive = npcWeaponResolved.passive || "无";
    npcWeaponResolved.passiveType = npcWeaponResolved.passiveType || "none";
    npcWeaponResolved.rarity = npcWeaponResolved.rarity || "普通";
    if (npcDef.weapon && npcDef.weapon.passiveValue !== undefined && npcWeaponResolved.passiveValue === undefined) {
        npcWeaponResolved.passiveValue = JSON.parse(JSON.stringify(npcDef.weapon.passiveValue));
    }

    return {
        userId: `npc-${npcDef.id}-${Date.now()}${Math.floor(Math.random()*1000)}`,
        nickname: `【${npcDef.title}】${npcDef.name}`, // NPC nickname is already formatted
        isNpc: true,
        npcDefinition: JSON.parse(JSON.stringify(npcDef)),
        weapon: JSON.parse(JSON.stringify(npcWeaponResolved)),
        strategy: npcDef.strategy || (npcDef.hostility === 'hostile' ? '猛攻' : '均衡'),
        currentItems: [],
        foundWeaponsInGame: [],
        temporaryFunds: 0,
        status: 'active',
        actionsTaken: 0,
        groupId: null,
        initialHeldWeapons: npcWeaponResolved ? [npcWeaponResolved.name] : [],
        hostility: npcDef.hostility,
        combatPassive: npcDef.combatPassive ? JSON.parse(JSON.stringify(npcDef.combatPassive)) : null,
        uniqueLoot: npcDef.uniqueLoot ? JSON.parse(JSON.stringify(npcDef.uniqueLoot)) : [],
        justSpawnedRandomly: spawnedByRandomEvent
        // No activeTitle for NPCs, their title is part of their base nickname
    };
}

export async function handleEnterMap(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const groupId = e.group_id;
    const rawNickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`; // Base nickname
    const pluginInstance = pluginInstanceFromApp || getPluginInstance();

    if (!pluginInstance) {
        logger.error(`[GameHandler - handleEnterMap] CRITICAL: 无法找到插件实例。无法处理玩家 ${userId} 进入地图的请求。`);
        return e.reply("系统核心组件通讯失败，无法处理您的请求，请联系管理员。");
    }
    if (playerQueueStatus[userId]) {
        return e.reply(`您已在地图 "${playerQueueStatus[userId]}" 的待命队列中。请先使用 #退出队列。`);
    }
    const match = e.msg.match(/^#进入地图\s*([^\s]+|\d+)\s*武器\s*([^\s]+)\s*策略\s*([^\s]+)$/);
    if (!match) return false;
    const mapIdentifier = match[1];
    const weaponName = match[2];
    const strategy = match[3];
    const maps = getMaps();
    if (!maps || maps.length === 0) return e.reply("错误：地图数据模块异常，无法加载区域信息。");
    let selectedMap = null;
    const mapNumber = parseInt(mapIdentifier, 10);
    if (!isNaN(mapNumber) && mapNumber > 0 && mapNumber <= maps.length) {
        selectedMap = maps[mapNumber - 1];
    } else {
        selectedMap = maps.find(m => m.name === mapIdentifier);
    }
    if (!selectedMap) return e.reply(`未知的区域坐标或编号: "${mapIdentifier}"。请使用 #地图列表 查看可用区域。`);
    const mapName = selectedMap.name;
    if (!selectedMap.itemPool || typeof selectedMap.itemPool !== 'object' || Object.keys(selectedMap.itemPool).length === 0) {
        return e.reply(`错误：区域 "${mapName}" 物资信息配置不完整 (itemPool)，暂时无法进入。`);
    }
    if (!selectedMap.refreshRate || typeof selectedMap.refreshRate !== 'object' || Object.keys(selectedMap.refreshRate).length === 0) {
        return e.reply(`错误：区域 "${mapName}" 物资刷新率配置不完整 (refreshRate)，暂时无法进入。`);
    }
    const { playerData } = await pluginInstance.getPlayer(userId, rawNickname); // Use rawNickname to get/create player data
    if (!playerData) return e.reply("抱歉，您的身份识别出现错误，无法同步档案。");

    // Construct the display name using playerData for the join message
    const playerDisplayNameForJoin = playerData.activeTitle ? `【${playerData.activeTitle}】${playerData.nickname}` : playerData.nickname;


    if (playerData.funds < selectedMap.entryFee) {
        return e.reply(`“信息费”不足！进入 "${mapName}" 需要 ${selectedMap.entryFee} “资金”，您目前持有 ${playerData.funds}。`);
    }
    const allPlayerWeapons = getWeapons();
    const selectedWeaponDef = allPlayerWeapons.find(w => w.name === weaponName);
    if (!selectedWeaponDef) return e.reply(`未知的装备型号: "${weaponName}"。请使用 #武器列表 查看可用装备。`);
    if (!playerData.heldWeapons || !playerData.heldWeapons.includes(weaponName)) return e.reply(`您未持有装备 "${weaponName}"。请检查 #我的信息。`);
    if (selectedWeaponDef.baseCombatPower < selectedMap.limitCombatPower) {
        return e.reply(`您的装备 "${weaponName}" (威胁评估 ${selectedWeaponDef.baseCombatPower}) 未达到区域 "${mapName}" 的最低安全等级 (${selectedMap.limitCombatPower})。`);
    }
    if (!gamePools[mapName]) {
        gamePools[mapName] = {
            players: [], mapInfo: { ...selectedMap }, gameProcessLog: [], settlementLog: [],
            status: 'waiting', playerGroupIds: {}, queueStartTime: Date.now(), npcsSpawnedThisInstance: false
        };
    }
    const pool = gamePools[mapName];
    if (pool.status === 'in_progress') return e.reply(`"${mapName}" 的探索任务正在进行中，请稍后再试。`);
    if (pool.players.length >= selectedMap.playerCapacity) return e.reply(`"${mapName}" 的待命队列已满 (${pool.players.length}/${selectedMap.playerCapacity})。`);

    playerData.funds -= selectedMap.entryFee; // Deduct fee
    await savePlayerData(userId, playerData); // Save after deducting fee

    // Create player object for the game pool
    const playerInGame = {
        userId: userId,
        nickname: playerData.nickname, // Store base nickname
        activeTitle: playerData.activeTitle, // Store active title
        isNpc: false,
        weapon: JSON.parse(JSON.stringify(selectedWeaponDef)),
        strategy: strategy,
        currentItems: [],
        foundWeaponsInGame: [],
        temporaryFunds: 0,
        status: 'active',
        actionsTaken: 0,
        groupId: groupId,
        initialHeldWeapons: [...playerData.heldWeapons]
    };
    pool.players.push(playerInGame);
    pool.playerGroupIds[userId] = groupId;
    playerQueueStatus[userId] = mapName;

    e.reply(`${getFormattedNickname(playerInGame)} 已装备 "${weaponName}" (策略: ${strategy}) 进入 "${mapName}" 待命队列 (${pool.players.filter(p=>!p.isNpc).length}/${selectedMap.playerCapacity} 真人玩家)。`);

    let gameStartedByThisJoin = false;
    if (pool.players.length < selectedMap.playerCapacity && !pool.npcsSpawnedThisInstance && selectedMap.npcSpawnChance > 0 && Math.random() < selectedMap.npcSpawnChance) {
        const allNpcDefs = getNpcs();
        const allWeaponDefsForNpcs = getWeapons();
        const availableNpcIdsOnMap = selectedMap.availableNpcIds || [];
        let numNpcsToTrySpawn = selectedMap.maxNpcsToSpawnOnJoin || 1;
        let spawnedThisCheck = 0;
        if (availableNpcIdsOnMap.length > 0 && numNpcsToTrySpawn > 0) {
            if (pool.gameProcessLog.length === 0) {
                pool.gameProcessLog.push(`[系统提示] 侦测到异常活动，区域内似乎存在其他实体...`);
            }
            for (let i = 0; i < numNpcsToTrySpawn && pool.players.length < selectedMap.playerCapacity; i++) {
                const randomNpcId = availableNpcIdsOnMap[Math.floor(Math.random() * availableNpcIdsOnMap.length)];
                const npcDef = allNpcDefs.find(n => n.id === randomNpcId);
                if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition.id === npcDef.id)) {
                    const npcPlayerObject = createNpcPlayerObject(npcDef, allWeaponDefsForNpcs, true);
                    pool.players.push(npcPlayerObject);
                    logger.info(`[GameHandler] NPC ${getFormattedNickname(npcPlayerObject)} 因随机刷新加入地图 "${mapName}"。`);
                    spawnedThisCheck++;
                }
            }
            if (spawnedThisCheck > 0) {
                pool.npcsSpawnedThisInstance = true;
                const newlySpawnedNpcNames = pool.players.filter(p => p.isNpc && p.justSpawnedRandomly).map(n => getFormattedNickname(n)).join('、 ');
                if (newlySpawnedNpcNames) {
                    gameStartedByThisJoin = pool.players.length === selectedMap.playerCapacity;
                    const immediateSpawnNotification = `[系统警报] ${mapName}: ${newlySpawnedNpcNames} 已闯入区域${gameStartedByThisJoin ? "，探索队伍满员，遭遇战即将爆发！" : "，并加入了待命队列..."}`;
                    await e.reply(immediateSpawnNotification).catch(err => logger.error(`[GameHandler] Error sending immediate NPC spawn message: ${err}`));
                }
            }
        }
    }
    if (pool.players.length === selectedMap.playerCapacity) {
        pool.players.forEach(p => { if (p.isNpc) p.justSpawnedRandomly = false; });
        await processGameInstance(mapName, pluginInstance);
    }
    return true;
}

export async function handleLeaveQueue(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const pluginInstance = pluginInstanceFromApp || getPluginInstance();
    if (!pluginInstance) {
        logger.error(`[GameHandler - handleLeaveQueue] CRITICAL: 无法找到插件实例。玩家 ${userId} 退出队列请求失败。`);
        return e.reply("系统核心组件通讯失败，无法处理您的请求，请联系管理员。");
    }
    if (!playerQueueStatus[userId]) return e.reply("您当前不在任何地图的待命队列中。");
    const mapName = playerQueueStatus[userId];
    const pool = gamePools[mapName];
    if (!pool || pool.status === 'in_progress') {
        delete playerQueueStatus[userId];
        return e.reply(`"${mapName}" 的探索任务已开始或队列信息异常，无法退出。`);
    }
    const playerIndex = pool.players.findIndex(p => p.userId === userId && !p.isNpc);
    if (playerIndex === -1) {
        delete playerQueueStatus[userId];
        return e.reply(`在 "${mapName}" 的队列中未找到您的记录。`);
    }
    const { playerData } = await pluginInstance.getPlayer(userId); // Get player data for refund
    const playerInGame = pool.players[playerIndex]; // Get the player object from the pool to display name

    if (playerData && pool.mapInfo.entryFee > 0) {
        playerData.funds += pool.mapInfo.entryFee;
        await savePlayerData(userId, playerData);
        e.reply(`${getFormattedNickname(playerInGame)} 已从 "${mapName}" 队列退出，返还入场费 ${pool.mapInfo.entryFee} 资金。`);
    } else {
        e.reply(`${getFormattedNickname(playerInGame)} 已从 "${mapName}" 队列退出。`);
    }
    pool.players.splice(playerIndex, 1);
    delete playerQueueStatus[userId];
    delete pool.playerGroupIds[userId];
    if (pool.players.filter(p => !p.isNpc).length === 0 && !pool.npcsSpawnedThisInstance) {
        pool.queueStartTime = Date.now();
        logger.info(`[GameHandler] Queue for "${mapName}" is now empty of real players, timer reset.`);
    }
    return true;
}

export async function handleViewQueues(e, pluginInstanceFromApp) {
    let replyMsg = "--- 当前地图待命队列 ---";
    let hasQueues = false;
    for (const mapName in gamePools) {
        const pool = gamePools[mapName];
        if (pool.status === 'waiting' && pool.players.length > 0) {
            hasQueues = true;
            const realPlayers = pool.players.filter(p => !p.isNpc);
            const npcsInQueue = pool.players.filter(p => p.isNpc);
            replyMsg += `\n[${mapName}] (${realPlayers.length}真人`;
            if (npcsInQueue.length > 0) replyMsg += ` + ${npcsInQueue.length}NPC`;
            replyMsg += ` / ${pool.mapInfo.playerCapacity}): `;
            if (realPlayers.length > 0) {
                replyMsg += realPlayers.map(p => getFormattedNickname(p)).join('、 ');
            }
            if (npcsInQueue.length > 0) {
                // For NPCs, getFormattedNickname returns their already formatted name.
                replyMsg += (realPlayers.length > 0 ? "; " : "") + "NPCs: " + npcsInQueue.map(n => getFormattedNickname(n)).join('、 ');
            }
        }
    }
    if (!hasQueues) replyMsg = "当前没有地图正在等待调查员。";
    return e.reply(replyMsg);
}

export async function processGameInstance(mapName, pluginInstanceFromApp) {
    const pool = gamePools[mapName];
    const pluginInstance = pluginInstanceFromApp || getPluginInstance();

    if (!pool || pool.status !== 'waiting') {
        logger.warn(`[GameHandler] processGameInstance called for map "${mapName}" which is not in 'waiting' state or doesn't exist. Status: ${pool?.status}`);
        if (pool) delete gamePools[mapName];
        Object.keys(playerQueueStatus).forEach(uid => { if (playerQueueStatus[uid] === mapName) delete playerQueueStatus[uid]; });
        return;
    }
    if (!pluginInstance && pool.players.some(p => !p.isNpc)) {
        logger.error(`[GameHandler - processGameInstance] CRITICAL: 无法找到插件实例。涉及真实玩家的地图 ${mapName} 探索将失败。`);
        const uniqueGroupIdsForError = [...new Set(pool.players.filter(p => !p.isNpc && p.groupId).map(p => p.groupId))];
        for (const groupId of uniqueGroupIdsForError) {
            if (global.Bot && global.Bot.pickGroup) {
                const groupToNotify = global.Bot.pickGroup(groupId);
                if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                    await groupToNotify.sendMsg(`[${mapName}] 探索启动失败：系统核心组件通讯异常。请联系管理员。`).catch(err => logger.error("Error sending critical failure message:", err));
                }
            }
        }
        delete gamePools[mapName];
        pool.players.forEach(p => { if (!p.isNpc) delete playerQueueStatus[p.userId]; });
        return;
    }

    pool.players.forEach(p => {
        if (!p.isNpc && playerQueueStatus[p.userId] === mapName) delete playerQueueStatus[p.userId];
        if (p.isNpc) p.justSpawnedRandomly = false;
    });

    pool.status = 'in_progress';
    pool.gameProcessLog.push(`[区域: ${mapName}] 探索开始！${pool.mapInfo.description || '未知区域...'}`);
    pool.gameProcessLog.push(`参与者 (${pool.players.length}名): ${pool.players.map(p => `${getFormattedNickname(p)}(${p.weapon.name})`).join(', ')}`);

    const allItems = getItems();
    const allWeapons = getWeapons();
    const publicItems = getPublicItems();

    for (let round = 1; round <= 3; round++) {
        pool.gameProcessLog.push(`\n--- 第 ${round} 行动阶段 ---`);
        let activeParticipantsThisRound = pool.players.filter(p => p.status === 'active' && p.actionsTaken < 3);
        if (activeParticipantsThisRound.length === 0) {
            pool.gameProcessLog.push("所有参与者已行动完毕或失去行动能力。");
            break;
        }
        activeParticipantsThisRound.sort(() => Math.random() - 0.5);

        for (const participant of activeParticipantsThisRound) {
            if (participant.status !== 'active' || participant.actionsTaken >= 3) continue;
            const participantDisplayName = getFormattedNickname(participant);
            if (participant.isNpc) {
                pool.gameProcessLog.push(`\n[${participantDisplayName}] (状态: ${participant.status}) 开始行动...`);
                if (participant.hostility === 'hostile' && participant.strategy === '猛攻') {
                    const potentialTargets = pool.players.filter(p => !p.isNpc && p.status === 'active');
                    if (potentialTargets.length > 0) {
                        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 锁定了目标 [${getFormattedNickname(target)}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        await performCombat(participant, target, pool, allWeapons, pluginInstance);
                    } else {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未发现可攻击的玩家目标，转为搜寻。`);
                        await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                    }
                } else {
                    await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                }
            } else {
                const playerInGame = participant;
                const actionRoll = Math.random();
                const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
                let actionType = (actionRoll < playerStrategyProb.fight) ? '遭遇' : '搜寻';
                pool.gameProcessLog.push(`\n[${participantDisplayName}] (策略: ${playerInGame.strategy}, 状态: ${playerInGame.status}) 准备 ${actionType}...`);
                if (actionType === '搜寻') {
                    await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                } else {
                    const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && p.status === 'active');
                    if (potentialTargets.length === 0) {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未侦测到其他活动目标。`);
                        if (playerInGame.strategy === '猛攻') {
                            pool.gameProcessLog.push(`  [${participantDisplayName}] (猛攻策略) 转为强行搜寻！`);
                            await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                        }
                    } else {
                        let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        const targetType = target.isNpc ? "NPC" : "调查员";
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 锁定了${targetType}目标 [${getFormattedNickname(target)}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        await performCombat(playerInGame, target, pool, allWeapons, pluginInstance);
                    }
                }
            }
            participant.actionsTaken++;
            if (participant.status === 'defeated' || participant.status === 'escaped') continue;
        }
        if (pool.players.every(p => p.status !== 'active' || p.actionsTaken >=3)) {
            pool.gameProcessLog.push("所有参与者行动结束。");
            break;
        }
    }
    pool.gameProcessLog.push(`\n--- 区域探索阶段结束 ---`);
    pool.settlementLog.push(`\n--- [区域: ${mapName}] 探索报告 ---`);

    let finalGameProcessLog = pool.gameProcessLog;

    for (const p of pool.players) {
        const displayName = getFormattedNickname(p);
        if (p.isNpc) {
            let npcSummary = `\nNPC: ${displayName}\n  最终状态: `;
            if (p.status === 'defeated') npcSummary += "已被击败";
            else if (p.status === 'escaped') npcSummary += "已脱离";
            else if (p.status === 'active') npcSummary += "行动结束，仍活跃";
            else npcSummary += p.status;
            if (p.currentItems.length > 0 || p.foundWeaponsInGame.length > 0) {
                npcSummary += `\n  持有物品: ${[...p.currentItems.map(i => i.name), ...p.foundWeaponsInGame.map(w=>w)].join('、 ') || '无'}`;
            }
            pool.settlementLog.push(npcSummary);
            continue;
        }
        let playerSummary = `\n调查员: ${displayName} (编号: ...${String(p.userId).slice(-4)})\n  最终状态: `;
        if (p.status === 'defeated') {
            playerSummary += "任务中断，信号消失";
            pool.settlementLog.push(playerSummary + "\n  回收物品: 无\n  获取新装备: 无\n  临时资金: 0 (已遗失)");
            continue;
        } else if (p.status === 'escaped') {
            playerSummary += "成功脱离区域";
        } else {
            playerSummary += p.status === 'wounded' ? "受创撤离" : "任务完成，安全返回";
        }
        let playerStorageData = null;
        if (pluginInstance) {
            const { playerData: fetchedData } = await pluginInstance.getPlayer(p.userId);
            playerStorageData = fetchedData;
        }
        if (!playerStorageData && pluginInstance) {
            logger.error(`[GameHandler] 结算阶段: 调查员 ${displayName} (${p.userId}) 档案同步失败。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：无法同步您的个人档案。");
        }
        let totalValueGainedFromItems = 0;
        let collectiblesGainedThisGame = [];
        let newWeaponsAddedToStorageNames = [];
        let itemsGainedThisGameStrings = [];
        playerSummary += "\n  本次探索收获:";
        const noGains = p.currentItems.length === 0 && p.foundWeaponsInGame.length === 0 && p.temporaryFunds === 0;
        if (noGains && p.status !== 'defeated') playerSummary += " 无实质收获";
        p.currentItems.forEach(item => {
            if (item.type === 'collectible' || item.rarity === '收藏品') {
                if (playerStorageData && !playerStorageData.collectibles.find(c => c.name === item.name)) {
                    playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price });
                }
                collectiblesGainedThisGame.push(`${item.name}(${item.rarity})`);
            } else {
                itemsGainedThisGameStrings.push(`${item.name}(${item.rarity}, 价值 ${item.price || 0}资金)`);
                totalValueGainedFromItems += (item.price || 0);
            }
        });
        p.foundWeaponsInGame.forEach(weaponName => {
            if (weaponName === INITIAL_WEAPON_NAME) return;
            if (playerStorageData && !playerStorageData.heldWeapons.includes(weaponName)) {
                playerStorageData.heldWeapons.push(weaponName);
                newWeaponsAddedToStorageNames.push(weaponName);
            } else if (!playerStorageData && !newWeaponsAddedToStorageNames.includes(weaponName)) {
                newWeaponsAddedToStorageNames.push(weaponName);
            }
        });
        if (itemsGainedThisGameStrings.length > 0) playerSummary += `\n    - 回收物资: ${itemsGainedThisGameStrings.join('、 ')} (已自动折算为资金)`;
        if (newWeaponsAddedToStorageNames.length > 0) {
            const weaponDetails = newWeaponsAddedToStorageNames.map(name => {
                const weaponDef = allWeapons.find(w => w.name === name);
                return `${name}(${weaponDef?.rarity || '未知'})`;
            });
            playerSummary += `\n    - 获取新装备: ${weaponDetails.join('、 ')} ${playerStorageData ? '(已存入装备库)' : '(临时获取)'}`;
        }
        if (collectiblesGainedThisGame.length > 0) playerSummary += `\n    - 获取“收藏品”: ${collectiblesGainedThisGame.join('、 ')} ${playerStorageData ? '(已存入个人收藏)' : '(临时获取)'}`;
        playerSummary += `\n  资金变化: +${totalValueGainedFromItems} (来自物资回收) +${p.temporaryFunds} (来自临时资金)`;
        if (playerStorageData) {
            playerStorageData.funds += totalValueGainedFromItems + p.temporaryFunds;
            playerSummary += `\n  当前总资金: ${playerStorageData.funds}`;
        } else {
            playerSummary += `\n  (未同步至永久资金)`;
        }
        if (p.status === 'wounded') playerSummary += `\n  警告: 您的状态不稳定，建议尽快进行休整！`;
        pool.settlementLog.push(playerSummary);
        if (playerStorageData && pluginInstance) await savePlayerData(p.userId, playerStorageData);
    }

    const uniqueGroupIds = [...new Set(pool.players.filter(p => !p.isNpc && p.groupId).map(p => p.groupId))];
    for (const groupId of uniqueGroupIds) {
        if (global.Bot && typeof global.Bot.pickGroup === 'function') {
            const groupToNotify = global.Bot.pickGroup(groupId);
            if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                if (finalGameProcessLog.length > 0) {
                    const gameProcessForwardMsg = await makeForwardMsgWithContent(finalGameProcessLog, `探索行动记录: ${mapName}`);
                    if (gameProcessForwardMsg) await groupToNotify.sendMsg(gameProcessForwardMsg).catch(err => logger.error(`Error sending game process log: ${err}`));
                }
                if (pool.settlementLog.length > 0) {
                    const settlementForwardMsg = await makeForwardMsgWithContent(pool.settlementLog, `探索结算报告: ${mapName}`);
                    if (settlementForwardMsg) await groupToNotify.sendMsg(settlementForwardMsg).catch(err => logger.error(`Error sending settlement log: ${err}`));
                }
            }
        }
    }
    delete gamePools[mapName];
    logger.info(`[GameHandler] 探索任务于区域 "${mapName}" 已结束并清理。`);
}
async function performCombat(attacker, defender, pool, allWeapons, pluginInstance) {
    const attackerDisplayName = getFormattedNickname(attacker);
    const defenderDisplayName = getFormattedNickname(defender);

    if (!pluginInstance && ( (!attacker.isNpc && attacker.status !== 'defeated') || (!defender.isNpc && defender.status !== 'defeated') ) ) {
        logger.error(`[GameHandler - performCombat] CRITICAL: pluginInstance is undefined. Combat involving players cannot reliably save data changes for map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战斗模块遭遇严重错误，玩家数据可能无法正确处理。`);
    }
    if (attacker.isNpc && attacker.npcDefinition?.dialogue) {
        const dialogueKey = attacker.npcDefinition.dialogue.onEngage ? 'onEngage' : 'onEncounter';
        if (attacker.npcDefinition.dialogue[dialogueKey]) pool.gameProcessLog.push(`  🗣️ [${attackerDisplayName}]: "${attacker.npcDefinition.dialogue[dialogueKey]}"`);
    }
    if (defender.isNpc && defender.npcDefinition?.dialogue && defender.userId !== attacker.userId) {
        const dialogueKey = defender.npcDefinition.dialogue.onEngage ? 'onEngage' : 'onEncounter';
        if (defender.npcDefinition.dialogue[dialogueKey]) pool.gameProcessLog.push(`  🗣️ [${defenderDisplayName}]: "${defender.npcDefinition.dialogue[dialogueKey]}"`);
    }
    if (defender.isNpc && defender.combatPassive?.type === 'master_escape' && defender.status === 'active') {
        const npcWeaponPower = defender.weapon?.baseCombatPower || 0;
        const attackerWeaponPower = attacker.weapon?.baseCombatPower || 0;
        const powerRatioThreshold = defender.combatPassive.details?.powerRatioThreshold || 0.7;
        if (npcWeaponPower < attackerWeaponPower * powerRatioThreshold) {
            const escapeChance = defender.combatPassive.details?.escapeChance || 0.75;
            if (Math.random() < escapeChance) {
                defender.status = 'escaped';
                pool.gameProcessLog.push(`  [${defenderDisplayName}] (${defender.combatPassive.name || '逃跑大师'}) 感知到巨大威胁，瞬间消失在阴影中，成功脱离战斗！`);
                if (defender.npcDefinition?.dialogue?.onEscape) pool.gameProcessLog.push(`  🗣️ [${defenderDisplayName}]: "${defender.npcDefinition.dialogue.onEscape}"`);
                return;
            } else {
                pool.gameProcessLog.push(`  [${defenderDisplayName}] (${defender.combatPassive.name || '逃跑大师'}) 试图脱离，但被 [${attackerDisplayName}] 缠住！`);
            }
        }
    }
    const combatResult = calculateCombatPowerWithPassives(attacker, defender, allWeapons);
    // Add display names to combat calculation logs if they are not already formatted by passiveEffects.js
    // For example, if passiveEffects.js logs "攻击方 (AttackerNickname - Weapon)", we might not need to change that part,
    // but subsequent logs from performCombat should use getFormattedNickname.
    // The current passiveEffects.js already uses attacker.nickname and defender.nickname which would be formatted if they are NPCs.
    // For players, if passiveEffects needs the title, it would need the activeTitle passed or the player object.
    // For simplicity here, assuming passiveEffects.js logs are okay or will be updated separately if needed.
    // We will ensure logs *generated directly in performCombat* use the formatted name.
    combatResult.log.forEach(log => pool.gameProcessLog.push(`  ${log}`)); // These logs come from passiveEffects

    const outcome = determineBattleOutcome(combatResult.attackerFinalPower, combatResult.defenderFinalPower, combatResult.successRateModifier, combatResult);
    let winner = outcome.attackerWins ? attacker : defender;
    let loser = outcome.attackerWins ? defender : attacker;
    const winnerDisplayName = getFormattedNickname(winner);
    const loserDisplayName = getFormattedNickname(loser);

    pool.gameProcessLog.push(`  冲突结果: [${winnerDisplayName}] 占据上风! (判定细节: ${outcome.detail})`);

    if (loser.status === 'active' || loser.status === 'wounded') {
        if (loser.status === 'wounded' && !combatResult.loserIgnoresWounded) {
            loser.status = 'defeated';
            if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayName}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
            pool.gameProcessLog.push(`  [${loserDisplayName}] 已受重创，不敌对手，被迫退出探索！`);
            if (pluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
            else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);
        } else if (loser.status !== 'defeated' && loser.status !== 'escaped') {
            let escUnharmed = POST_COMBAT_ESCAPE_UNHARMED_CHANCE, escWounded = POST_COMBAT_ESCAPE_WOUNDED_CHANCE;
            if (loser.weapon?.passiveType === 'escape_boost_post_combat') {
                const boost = loser.weapon.passiveValue || 0; escUnharmed += boost; escWounded += boost;
                pool.gameProcessLog.push(`  [${loserDisplayName}] 的装备 (${loser.weapon.name}) 触发特性 [${loser.weapon.passive || '紧急脱离'}]，尝试增加逃脱几率！`);
            }
            const escRoll = Math.random();
            if (escRoll < escUnharmed) {
                pool.gameProcessLog.push(`  [${loserDisplayName}] 反应迅速，在混乱中成功撤退！未损失物资。`);
                if (loser.isNpc) { loser.status = 'escaped'; if (loser.npcDefinition?.dialogue?.onEscape) pool.gameProcessLog.push(`  🗣️ [${loserDisplayName}]: "${loser.npcDefinition.dialogue.onEscape}"`); }
                else loser.status = 'escaped';
            } else if (escRoll < escUnharmed + escWounded) {
                if (!combatResult.loserIgnoresWounded) { loser.status = 'wounded'; pool.gameProcessLog.push(`  [${loserDisplayName}] 冲突失利，受到创伤！但成功保留当前物资并暂时后撤。`); }
                else pool.gameProcessLog.push(`  [${loserDisplayName}] 的装备特性使其在受创时仍能保持行动力！冲突失利，但成功保留当前物资并暂时后撤。`);
            } else {
                loser.status = 'defeated';
                if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayName}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
                pool.gameProcessLog.push(`  [${loserDisplayName}] 未能成功脱离，被 [${winnerDisplayName}] 击倒！`);
                if (pluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
                else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);
            }
        }
    }
}

async function performSearchAction(playerInGame, pool, allItems, allWeapons, publicItemsPool, gameLogArray, pluginInstance) {
    const itemsToObtainCount = Math.floor(Math.random() * 2) + 1;
    let foundItemsMsgParts = [];
    const mapInfo = pool.mapInfo;
    const candidatePool = [];
    const playerDisplayName = getFormattedNickname(playerInGame);

    if (mapInfo.itemPool) {
        for (const rarityKey in mapInfo.itemPool) {
            if (mapInfo.itemPool[rarityKey]) {
                mapInfo.itemPool[rarityKey].forEach(itemEntry => {
                    candidatePool.push({ identifier: itemEntry, rarity: rarityKey, source: 'map' });
                });
            }
        }
    }
    if (publicItemsPool && publicItemsPool.length > 0) {
        publicItemsPool.forEach(publicItemDef => {
            candidatePool.push({ identifier: publicItemDef.name, rarity: publicItemDef.rarity || "普通", source: 'public', fullDef: publicItemDef });
        });
    }
    if (candidatePool.length === 0) {
        gameLogArray.push(`  [${playerDisplayName}] 仔细搜寻，但此地似乎已被搜刮殆尽，未发现任何可用物资。`);
        return;
    }
    for (let i = 0; i < itemsToObtainCount; i++) {
        let chosenItemDef = null, itemType = 'item', selectedRaritySlot = "普通";
        const rarityRoll = Math.random(); let cumulativeProb = 0;
        const mapRefreshRarities = Object.keys(mapInfo.refreshRate || {});
        if (mapRefreshRarities.length === 0) {
            logger.warn(`[GameHandler] Map "${mapInfo.name}" has no refreshRate. Defaulting common.`);
            const commonCand = candidatePool.filter(c => c.rarity === "普通");
            if (commonCand.length > 0) {
                const rComCand = commonCand[Math.floor(Math.random() * commonCand.length)];
                if (rComCand.source === 'public') chosenItemDef = rComCand.fullDef;
                else if (typeof rComCand.identifier === 'string') chosenItemDef = allItems.find(it => it.name === rComCand.identifier && it.rarity === "普通");
                else if (typeof rComCand.identifier === 'object' && rComCand.identifier.type === 'weapon') chosenItemDef = allWeapons.find(w => w.name === rComCand.identifier.name && w.rarity === "普通");
                if (chosenItemDef) itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item');
            }
        } else {
            for (const rarity of mapRefreshRarities) {
                cumulativeProb += (mapInfo.refreshRate[rarity] || 0);
                if (rarityRoll < cumulativeProb) { selectedRaritySlot = rarity; break; }
            }
        }
        if (!mapInfo.refreshRate[selectedRaritySlot] && mapRefreshRarities.length > 0) selectedRaritySlot = mapRefreshRarities.sort((a,b) => (mapInfo.refreshRate[b] || 0) - (mapInfo.refreshRate[a] || 0))[0] || mapRefreshRarities[0];
        const itemsOfSelectedRarity = candidatePool.filter(c => c.rarity === selectedRaritySlot);
        if (itemsOfSelectedRarity.length > 0) {
            const chosenCandidate = itemsOfSelectedRarity[Math.floor(Math.random() * itemsOfSelectedRarity.length)];
            if (chosenCandidate.source === 'public') chosenItemDef = chosenCandidate.fullDef;
            else {
                const mapId = chosenCandidate.identifier;
                if (typeof mapId === 'string') chosenItemDef = allItems.find(it => it.name === mapId && it.rarity === chosenCandidate.rarity);
                else if (typeof mapId === 'object' && mapId.type === 'weapon') chosenItemDef = allWeapons.find(w => w.name === mapId.name && w.rarity === chosenCandidate.rarity);
            }
            if (chosenItemDef) itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item');
        }
        if (!chosenItemDef) {
            const fallbackCand = candidatePool.filter(c => c.rarity === "普通");
            if (fallbackCand.length > 0) {
                const cFallCand = fallbackCand[Math.floor(Math.random() * fallbackCand.length)];
                if (cFallCand.source === 'public') chosenItemDef = cFallCand.fullDef;
                else if (typeof cFallCand.identifier === 'string') chosenItemDef = allItems.find(it => it.name === cFallCand.identifier && it.rarity === "普通");
                else if (typeof cFallCand.identifier === 'object' && cFallCand.identifier.type === 'weapon') chosenItemDef = allWeapons.find(w => w.name === cFallCand.identifier.name && w.rarity === "普通");
                if (chosenItemDef) itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item');
            }
        }
        if (!chosenItemDef) {
            chosenItemDef = allItems.find(it => it.name === DEFAULT_FALLBACK_ITEM_NAME) || (allItems.length > 0 ? allItems[0] : null);
            if (chosenItemDef) itemType = chosenItemDef.type || 'item';
        }
        if (chosenItemDef) {
            if (itemType === 'weapon') {
                if (chosenItemDef.name === INITIAL_WEAPON_NAME) foundItemsMsgParts.push(`发现了多余的 ${INITIAL_WEAPON_NAME}(初始装备)，已忽略。`);
                else if ((!playerInGame.isNpc && playerInGame.initialHeldWeapons.includes(chosenItemDef.name)) || playerInGame.foundWeaponsInGame.includes(chosenItemDef.name)) {
                    const val = chosenItemDef.price || 0; playerInGame.temporaryFunds += val;
                    foundItemsMsgParts.push(`发现了重复装备: ${chosenItemDef.name}(${chosenItemDef.rarity})，转化为 ${val} 临时资金。`);
                } else {
                    playerInGame.foundWeaponsInGame.push(chosenItemDef.name);
                    foundItemsMsgParts.push(`[装备]: ${chosenItemDef.name}(${chosenItemDef.rarity})`);
                }
            } else {
                const fItemType = chosenItemDef.type || (chosenItemDef.rarity === '收藏品' ? 'collectible' : 'item');
                playerInGame.currentItems.push(JSON.parse(JSON.stringify({...chosenItemDef, type: fItemType })));
                foundItemsMsgParts.push(`${chosenItemDef.name}(${chosenItemDef.rarity})`);
            }
        } else {
            const ultFallback = { name: "不明物质残渣", rarity: "未知", price: 0, type: 'item' };
            playerInGame.currentItems.push(ultFallback);
            foundItemsMsgParts.push(`${ultFallback.name}(${ultFallback.rarity})`);
        }
    }
    if (foundItemsMsgParts.length > 0) gameLogArray.push(`  [${playerDisplayName}] 在废墟中搜寻: ${foundItemsMsgParts.join('、 ')}。`);
    else gameLogArray.push(`  [${playerDisplayName}] 在废墟中仔细搜寻，但似乎一无所获。`);
}

async function transferSpoils(winner, loser, pool, pluginInstance, allWeapons) {
    const winnerDisplayName = getFormattedNickname(winner);
    const loserDisplayName = getFormattedNickname(loser);

    if (!pluginInstance && ((!winner.isNpc && loser.status === 'defeated') || (!loser.isNpc && loser.status === 'defeated'))) {
        logger.error(`[GameHandler - transferSpoils] CRITICAL: pluginInstance is undefined. Spoils transfer for map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战利品处理模块遭遇严重错误。`);
    }
    pool.gameProcessLog.push(`  [${winnerDisplayName}] 开始清点 [${loserDisplayName}] 的遗留物品!`);
    if (loser.currentItems.length > 0) {
        const itemNames = loser.currentItems.map(i => `${i.name}(${i.rarity || i.type})`).join('、 ');
        pool.gameProcessLog.push(`  缴获物资: ${itemNames}。`);
        winner.currentItems.push(...JSON.parse(JSON.stringify(loser.currentItems)));
        loser.currentItems = [];
    }
    if (loser.temporaryFunds > 0) {
        pool.gameProcessLog.push(`  缴获临时资金: ${loser.temporaryFunds}。`);
        winner.temporaryFunds += loser.temporaryFunds; loser.temporaryFunds = 0;
    }
    if (loser.foundWeaponsInGame.length > 0) {
        let lootedNewWpnMsgParts = [], convertedToFundsMsgParts = [];
        for (const wpnName of loser.foundWeaponsInGame) {
            if (wpnName === INITIAL_WEAPON_NAME) continue;
            const wpnDef = allWeapons.find(w => w.name === wpnName);
            if (!wpnDef) { logger.warn(`[GameHandler] transferSpoils: Def for "${wpnName}" not found.`); continue; }
            if ((!winner.isNpc && winner.initialHeldWeapons.includes(wpnName)) || winner.foundWeaponsInGame.includes(wpnName)) {
                const val = wpnDef.price || 0; winner.temporaryFunds += val;
                convertedToFundsMsgParts.push(`${wpnName}(转化为 ${val} 临时资金)`);
            } else {
                winner.foundWeaponsInGame.push(wpnName);
                lootedNewWpnMsgParts.push(`${wpnName}(${wpnDef.rarity})`);
            }
        }
        if (lootedNewWpnMsgParts.length > 0) pool.gameProcessLog.push(`  缴获本局内发现的装备: ${lootedNewWpnMsgParts.join('、 ')}。`);
        if (convertedToFundsMsgParts.length > 0) pool.gameProcessLog.push(`  部分重复装备已转化为资金: ${convertedToFundsMsgParts.join('、 ')}。`);
        loser.foundWeaponsInGame = [];
    }
    if (loser.isNpc && loser.npcDefinition?.uniqueLoot && loser.npcDefinition.uniqueLoot.length > 0) {
        pool.gameProcessLog.push(`  [${winnerDisplayName}] 搜刮了 [${loserDisplayName}] 的特殊遗物...`);
        loser.npcDefinition.uniqueLoot.forEach(lItem => {
            if (Math.random() < lItem.dropChance) {
                const lItemDef = lItem.type === 'weapon' ? allWeapons.find(w => w.name === lItem.name) : lItem;
                if (!lItemDef) { logger.warn(`[GameHandler] NPC ${getFormattedNickname(loser)} unique loot ${lItem.name} def not found.`); return; }
                pool.gameProcessLog.push(`    获得了特殊物品: ${lItemDef.name}(${lItemDef.rarity || lItem.rarity})!`);
                if (lItem.type === 'weapon') {
                    if ((!winner.isNpc && winner.initialHeldWeapons.includes(lItemDef.name)) || winner.foundWeaponsInGame.includes(lItemDef.name)) {
                        const val = lItemDef.price || 50; winner.temporaryFunds += val;
                        pool.gameProcessLog.push(`    (重复装备 ${lItemDef.name} 转化为 ${val} 临时资金)`);
                    } else winner.foundWeaponsInGame.push(lItemDef.name);
                } else winner.currentItems.push(JSON.parse(JSON.stringify({ name: lItemDef.name, rarity: lItemDef.rarity, price: lItemDef.price || 0, type: lItem.type })));
            }
        });
    }
    if (!winner.isNpc && !loser.isNpc && pluginInstance) {
        const { playerData: loserStore } = await pluginInstance.getPlayer(loser.userId);
        const { playerData: winnerStore } = await pluginInstance.getPlayer(winner.userId);
        if (!loserStore || !winnerStore) {
            logger.error(`[GameHandler] transferSpoils (PvP): Failed to get player data for ${loser.userId} or ${winner.userId}.`);
            pool.gameProcessLog.push(`  [系统错误] 处理玩家间装备转移时档案同步失败。`); return;
        }
        const lostWpnName = loser.weapon.name;
        const lostWpnDef = allWeapons.find(w => w.name === lostWpnName);
        if (lostWpnName !== INITIAL_WEAPON_NAME) {
            const wpnIdxLoserStore = loserStore.heldWeapons.indexOf(lostWpnName);
            if (wpnIdxLoserStore > -1) {
                loserStore.heldWeapons.splice(wpnIdxLoserStore, 1);
                pool.gameProcessLog.push(`  [${loserDisplayName}] 永久失去了装备 "${lostWpnName}"！`);
                if (winnerStore.heldWeapons.includes(lostWpnName)) {
                    const val = lostWpnDef?.price || 0; winner.temporaryFunds += val;
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 已拥有同型号装备 "${lostWpnName}"，转化为 ${val} 临时资金。`);
                } else {
                    winnerStore.heldWeapons.push(lostWpnName);
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 永久获得了装备 "${lostWpnName}"！(已存入装备库)`);
                }
                await savePlayerData(loser.userId, loserStore);
                await savePlayerData(winner.userId, winnerStore);
            } else {
                logger.warn(`[GameHandler] transferSpoils (PvP): Loser ${loserDisplayName} using ${lostWpnName} not in storedWeapons.`);
                pool.gameProcessLog.push(`  [警示] ${loserDisplayName} 使用的装备 ${lostWpnName} 未在其档案中，无法常规转移。`);
            }
        }
    }
}

