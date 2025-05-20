// camellia-plugin/apps/handlers/gameHandler.js

import { getItems, getWeapons, getMaps, getPublicItems, getPlayerData, savePlayerData, getNpcs } from '../../utils/dataManager.js';
import { calculateCombatPowerWithPassives, determineBattleOutcome } from '../../utils/combatHelper.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    STRATEGY_PROBABILITY,
    DEFAULT_FALLBACK_ITEM_NAME,
    INITIAL_WEAPON_NAME,
    POST_COMBAT_ESCAPE_UNHARMED_CHANCE,
    POST_COMBAT_ESCAPE_WOUNDED_CHANCE,
    QUEUE_CHECK_INTERVAL, // Assuming QUEUE_CHECK_INTERVAL is exported from constants.js
    DEFAULT_NPC_FILL_DELAY_MINUTES // Assuming DEFAULT_NPC_FILL_DELAY_MINUTES is exported
} from '../../utils/constants.js';

const gamePools = {};
const playerQueueStatus = {};
// const QUEUE_CHECK_INTERVAL = 60 * 1000; // Defined in constants.js
// const DEFAULT_NPC_FILL_DELAY_MINUTES = 5; // Defined in constants.js
const PLUGIN_NAME = '都市迷踪（搜打撤）'; // Define plugin name as a constant

let _pluginInstance = null; // Module-scoped variable to store the plugin instance
let queueCheckIntervalHandle = null; // To store the interval ID

/**
 * Attempts to find the plugin instance globally.
 * This serves as a fallback if a direct instance isn't available.
 * @returns {object|null} The plugin instance or null if not found.
 */
function getGlobalPluginInstance() {
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
 * Initializes game handler utilities, stores the plugin instance, and starts the queue checking interval.
 * This function should be called from adventureGameApp.js once the plugin instance is created.
 * @param {object} pluginInstanceFromApp - The main plugin instance.
 */
export function initializeGameHandlerTimedTasks(pluginInstanceFromApp) {
    if (!pluginInstanceFromApp) {
        logger.error('[GameHandler] initializeGameHandlerTimedTasks: Critical error - pluginInstanceFromApp is null. Timed tasks for NPC filling will not start.');
        return;
    }
    _pluginInstance = pluginInstanceFromApp; // Store the instance
    logger.info('[GameHandler] Plugin instance received. Starting timed tasks for NPC queue filling.');

    if (queueCheckIntervalHandle) {
        clearInterval(queueCheckIntervalHandle); // Clear existing interval if any (e.g., during a reload)
    }
    // Start the interval, passing the stored plugin instance to the check function
    queueCheckIntervalHandle = setInterval(() => {
        checkAndFillQueuesWithNpcs(_pluginInstance);
    }, QUEUE_CHECK_INTERVAL);
    logger.info(`[GameHandler] NPC Queue checker interval started.`);
}

// REMOVE or COMMENT OUT the old top-level setInterval:
// setInterval(() => {
//     checkAndFillQueuesWithNpcs(); // This was causing the "instance not found" error
// }, QUEUE_CHECK_INTERVAL);


/**
 * 检查所有等待中的队列，如果超时则用NPC填充并开始游戏。
 * @param {object} currentPluginInstance - The plugin instance passed from the timed task initializer.
 */
async function checkAndFillQueuesWithNpcs(currentPluginInstance) {
    const currentTime = Date.now();
    const allNpcDefs = getNpcs();
    const allWeaponDefs = getWeapons();
    const pluginInstanceToUse = currentPluginInstance || _pluginInstance || getGlobalPluginInstance(); // Prioritize passed, then stored, then global

    if (!pluginInstanceToUse && Object.values(gamePools).some(pool => pool.status === 'waiting' && pool.players.some(p => !p.isNpc))) {
        logger.error(`[GameHandler - QueueFiller] 关键错误: 无法找到插件实例 (even after attempting stored/global). 涉及真实玩家的NPC填充和自动开始游戏功能将失败。`);
        return; // Exit if instance is still missing and real players are involved
    }

    for (const mapName in gamePools) {
        const pool = gamePools[mapName];

        if (pool.status === 'waiting' && pool.players.length > 0 && pool.players.length < pool.mapInfo.playerCapacity) {
            const queueTime = pool.queueStartTime || currentTime;
            // Use DEFAULT_NPC_FILL_DELAY_MINUTES from constants
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
                            logger.info(`[GameHandler] NPC "${npcPlayerObject.nickname}" 因超时已加入地图 "${mapName}"。`);
                            spawnedNpcCount++;
                        }
                    }
                }

                let timeoutSpawnedNpcNames = pool.players
                    .filter(p => p.isNpc && !p.justSpawnedRandomly) // Ensure it's not a randomly spawned one
                    .slice(-spawnedNpcCount) // Get the ones just added by timeout
                    .map(n => n.nickname);

                if (spawnedNpcCount > 0) {
                    pool.gameProcessLog.push(`[系统提示] 由于等待超时，${spawnedNpcCount}名NPC调查员已加入队伍！`);
                }

                if (pool.players.length >= pool.mapInfo.playerCapacity) {
                    // Allow NPC-only games to proceed even if pluginInstanceToUse is null
                    // But if real players are involved, pluginInstanceToUse is critical.
                    if (pluginInstanceToUse || pool.players.every(p => p.isNpc)) {
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
                        // Pass the resolved pluginInstanceToUse
                        await processGameInstance(mapName, pluginInstanceToUse);
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

/**
 * 根据NPC定义创建游戏内NPC玩家对象。
 * @param {object} npcDef - 从 npcs.json 加载的NPC定义。
 * @param {Array<object>} allWeaponDefs - 全局武器定义。
 * @param {boolean} spawnedByRandomEvent - Flag if NPC was spawned by non-timeout mechanism.
 * @returns {object} NPC玩家对象。
 */
function createNpcPlayerObject(npcDef, allWeaponDefs, spawnedByRandomEvent = false) {
    // ... (rest of createNpcPlayerObject function remains the same)
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
        nickname: `【${npcDef.title}】${npcDef.name}`,
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
        justSpawnedRandomly: spawnedByRandomEvent // Important for timeout logic to not misidentify NPCs
    };
}


export async function handleEnterMap(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const groupId = e.group_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;

    // Use the plugin instance passed from the main app file if available, otherwise try the stored one, then global.
    const pluginInstanceToUse = pluginInstanceFromApp || _pluginInstance || getGlobalPluginInstance();

    if (!pluginInstanceToUse) {
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

    // Use the resolved pluginInstanceToUse
    const { playerData } = await pluginInstanceToUse.getPlayer(userId, nickname);
    if (!playerData) return e.reply("抱歉，您的身份识别出现错误，无法同步档案。");

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
            players: [],
            mapInfo: { ...selectedMap },
            gameProcessLog: [],
            settlementLog: [],
            status: 'waiting',
            playerGroupIds: {},
            queueStartTime: Date.now(), // Initialize queueStartTime when pool is created
            npcsSpawnedThisInstance: false
        };
    }
    const pool = gamePools[mapName];

    if (pool.status === 'in_progress') return e.reply(`"${mapName}" 的探索任务正在进行中，请稍后再试。`);
    if (pool.players.length >= selectedMap.playerCapacity) return e.reply(`"${mapName}" 的待命队列已满 (${pool.players.length}/${selectedMap.playerCapacity})。`);

    playerData.funds -= selectedMap.entryFee;
    await savePlayerData(userId, playerData);

    pool.players.push({
        userId: userId,
        nickname: playerData.nickname,
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
    });
    pool.playerGroupIds[userId] = groupId;
    playerQueueStatus[userId] = mapName;

    // If this is the first real player joining an empty or NPC-only queue, reset queueStartTime
    if (pool.players.filter(p => !p.isNpc).length === 1 && pool.players.length === 1) {
        pool.queueStartTime = Date.now();
        logger.info(`[GameHandler] Player ${nickname} is the first to join "${mapName}". Queue timer started/reset.`);
    }


    e.reply(`${playerData.nickname} 已装备 "${weaponName}" (策略: ${strategy}) 进入 "${mapName}" 待命队列 (${pool.players.filter(p=>!p.isNpc).length}/${selectedMap.playerCapacity} 真人玩家)。`);

    let gameStartedByThisJoin = false;
    if (pool.players.length < selectedMap.playerCapacity && !pool.npcsSpawnedThisInstance && selectedMap.npcSpawnChance > 0 && Math.random() < selectedMap.npcSpawnChance) {
        const allNpcDefs = getNpcs();
        const allWeaponDefsForNpcs = getWeapons();
        const availableNpcIdsOnMap = selectedMap.availableNpcIds || [];
        let numNpcsToTrySpawn = selectedMap.maxNpcsToSpawnOnJoin || 1;
        let spawnedThisCheck = 0;

        if (availableNpcIdsOnMap.length > 0 && numNpcsToTrySpawn > 0) {
            if (pool.gameProcessLog.length === 0) { // Only add if log is empty
                pool.gameProcessLog.push(`[系统提示] 侦测到异常活动，区域内似乎存在其他实体...`);
            }
            for (let i = 0; i < numNpcsToTrySpawn && pool.players.length < selectedMap.playerCapacity; i++) {
                const randomNpcId = availableNpcIdsOnMap[Math.floor(Math.random() * availableNpcIdsOnMap.length)];
                const npcDef = allNpcDefs.find(n => n.id === randomNpcId);
                if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition.id === npcDef.id)) {
                    const npcPlayerObject = createNpcPlayerObject(npcDef, allWeaponDefsForNpcs, true); // Mark as randomly spawned
                    pool.players.push(npcPlayerObject);
                    logger.info(`[GameHandler] NPC 【${npcDef.title}】${npcDef.name} 因随机刷新加入地图 "${mapName}"。`);
                    spawnedThisCheck++;
                }
            }

            if (spawnedThisCheck > 0) {
                pool.npcsSpawnedThisInstance = true; // Mark that NPCs have spawned randomly in this queue instance
                const newlySpawnedNpcNames = pool.players
                    .filter(p => p.isNpc && p.justSpawnedRandomly) // Filter by the flag
                    .map(n => n.nickname)
                    .join('、 ');

                if (newlySpawnedNpcNames) {
                    gameStartedByThisJoin = pool.players.length === selectedMap.playerCapacity;
                    const immediateSpawnNotification = `[系统警报] ${mapName}: ${newlySpawnedNpcNames} 已闯入区域${gameStartedByThisJoin ? "，探索队伍满员，遭遇战即将爆发！" : "，并加入了待命队列..."}`;
                    await e.reply(immediateSpawnNotification).catch(err => logger.error(`[GameHandler] Error sending immediate NPC spawn message: ${err}`));
                }
            }
        }
    }

    if (pool.players.length === selectedMap.playerCapacity) {
        pool.players.forEach(p => { if (p.isNpc) p.justSpawnedRandomly = false; }); // Reset flag before game starts
        // Pass the resolved pluginInstanceToUse
        await processGameInstance(mapName, pluginInstanceToUse);
    }
    return true;
}

export async function handleLeaveQueue(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const pluginInstanceToUse = pluginInstanceFromApp || _pluginInstance || getGlobalPluginInstance();

    if (!pluginInstanceToUse) {
        logger.error(`[GameHandler - handleLeaveQueue] CRITICAL: 无法找到插件实例。玩家 ${userId} 退出队列请求失败。`);
        return e.reply("系统核心组件通讯失败，无法处理您的请求，请联系管理员。");
    }
    if (!playerQueueStatus[userId]) return e.reply("您当前不在任何地图的待命队列中。");

    const mapName = playerQueueStatus[userId];
    const pool = gamePools[mapName];

    if (!pool || pool.status === 'in_progress') {
        delete playerQueueStatus[userId]; // Clean up status even if pool is gone or in progress
        return e.reply(`"${mapName}" 的探索任务已开始或队列信息异常，无法退出。`);
    }

    const playerIndex = pool.players.findIndex(p => p.userId === userId && !p.isNpc);
    if (playerIndex === -1) {
        delete playerQueueStatus[userId]; // Clean up status if not found in this specific pool
        return e.reply(`在 "${mapName}" 的队列中未找到您的记录。`);
    }

    // Use resolved pluginInstanceToUse
    const { playerData } = await pluginInstanceToUse.getPlayer(userId);
    if (playerData && pool.mapInfo.entryFee > 0) {
        playerData.funds += pool.mapInfo.entryFee;
        await savePlayerData(userId, playerData);
        e.reply(`已从 "${mapName}" 队列退出，返还入场费 ${pool.mapInfo.entryFee} 资金。`);
    } else {
        e.reply(`已从 "${mapName}" 队列退出。`);
    }

    pool.players.splice(playerIndex, 1);
    delete playerQueueStatus[userId];
    delete pool.playerGroupIds[userId];

    // If the queue becomes empty of real players and no NPCs were randomly spawned (to avoid resetting timer for NPC-only games waiting for timeout)
    if (pool.players.filter(p => !p.isNpc).length === 0 && !pool.npcsSpawnedThisInstance) {
        // If it's truly empty or only contains timeout-spawnable NPCs, reset timer
        // or consider deleting the pool if only NPCs that were *not* from random spawn are left.
        // For now, just reset the timer if no real players.
        pool.queueStartTime = Date.now();
        logger.info(`[GameHandler] Queue for "${mapName}" is now empty of real players, timer reset.`);
    } else if (pool.players.length === 0) {
        // If completely empty, can delete the pool
        // delete gamePools[mapName];
        // logger.info(`[GameHandler] Queue for "${mapName}" is now completely empty and has been cleared.`);
        // For now, we'll let the timeout logic handle empty pools eventually if needed, or rely on map config.
    }
    return true;
}

export async function handleViewQueues(e, pluginInstanceFromApp) { // No pluginInstance needed here usually
    // ... (handleViewQueues function remains the same)
    let replyMsg = "--- 当前地图待命队列 ---";
    let hasQueues = false;

    for (const mapName in gamePools) {
        const pool = gamePools[mapName];
        if (pool.status === 'waiting' && pool.players.length > 0) {
            hasQueues = true;
            const realPlayers = pool.players.filter(p => !p.isNpc);
            const npcsInQueue = pool.players.filter(p => p.isNpc);

            replyMsg += `\n[${mapName}] (${realPlayers.length}真人`;
            if (npcsInQueue.length > 0) {
                replyMsg += ` + ${npcsInQueue.length}NPC`;
            }
            replyMsg += ` / ${pool.mapInfo.playerCapacity}): `;

            if (realPlayers.length > 0) {
                replyMsg += realPlayers.map(p => p.nickname).join('、 ');
            }
            if (npcsInQueue.length > 0) {
                replyMsg += (realPlayers.length > 0 ? "; " : "") + "NPCs: " + npcsInQueue.map(n => n.nickname.split('】')[1] || n.nickname).join('、 ');
            }
        }
    }
    if (!hasQueues) replyMsg = "当前没有地图正在等待调查员。";
    return e.reply(replyMsg);
}


export async function processGameInstance(mapName, pluginInstanceFromCaller) {
    const pool = gamePools[mapName];
    // Prioritize instance passed from caller, then module-scoped, then global lookup
    const pluginInstanceToUse = pluginInstanceFromCaller || _pluginInstance || getGlobalPluginInstance();

    if (!pool || pool.status !== 'waiting') {
        logger.warn(`[GameHandler] processGameInstance called for map "${mapName}" which is not in 'waiting' state or doesn't exist. Status: ${pool?.status}`);
        if (pool) delete gamePools[mapName]; // Clean up if exists but wrong state
        // Clean up player queue status for this map
        Object.keys(playerQueueStatus).forEach(uid => {
            if (playerQueueStatus[uid] === mapName) delete playerQueueStatus[uid];
        });
        return;
    }

    // If real players are involved, pluginInstanceToUse is critical
    if (!pluginInstanceToUse && pool.players.some(p => !p.isNpc)) {
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
        // Clean up the failed game pool
        delete gamePools[mapName];
        pool.players.forEach(p => { if (!p.isNpc) delete playerQueueStatus[p.userId]; });
        return;
    }

    pool.players.forEach(p => {
        if (!p.isNpc && playerQueueStatus[p.userId] === mapName) {
            delete playerQueueStatus[p.userId];
        }
        if (p.isNpc) p.justSpawnedRandomly = false; // Reset this flag as game starts
    });

    pool.status = 'in_progress';
    if (pool.gameProcessLog.length === 0 || !pool.gameProcessLog[0].includes("探索开始")) { // Avoid duplicate start messages
        pool.gameProcessLog.unshift(`[区域: ${mapName}] 探索开始！${pool.mapInfo.description || '未知区域...'}`); // Add to beginning if not present
    }
    pool.gameProcessLog.push(`参与者 (${pool.players.length}名): ${pool.players.map(p => `${p.nickname}(${p.weapon.name})`).join(', ')}`);


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
        activeParticipantsThisRound.sort(() => Math.random() - 0.5); // Shuffle turn order

        for (const participant of activeParticipantsThisRound) {
            if (participant.status !== 'active' || participant.actionsTaken >= 3) continue;

            if (participant.isNpc) {
                pool.gameProcessLog.push(`\n[${participant.nickname}] (状态: ${participant.status}) 开始行动...`);
                if (participant.hostility === 'hostile' && participant.strategy === '猛攻') {
                    const potentialTargets = pool.players.filter(p => !p.isNpc && p.status === 'active');
                    if (potentialTargets.length > 0) {
                        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        pool.gameProcessLog.push(`  [${participant.nickname}] 锁定了目标 [${target.nickname}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        // Pass pluginInstanceToUse to combat
                        await performCombat(participant, target, pool, allWeapons, pluginInstanceToUse);
                    } else {
                        pool.gameProcessLog.push(`  [${participant.nickname}] 未发现可攻击的玩家目标，转为搜寻。`);
                        // Pass pluginInstanceToUse to search
                        await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstanceToUse);
                    }
                } else { // NPC not hostile or not猛攻, perform search
                    // Pass pluginInstanceToUse to search
                    await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstanceToUse);
                }
            } else { // Real player's turn
                const playerInGame = participant;
                const actionRoll = Math.random();
                const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
                let actionType = (actionRoll < playerStrategyProb.fight) ? '遭遇' : '搜寻';
                pool.gameProcessLog.push(`\n[${playerInGame.nickname}] (策略: ${playerInGame.strategy}, 状态: ${playerInGame.status}) 准备 ${actionType}...`);

                if (actionType === '搜寻') {
                    // Pass pluginInstanceToUse to search
                    await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstanceToUse);
                } else { // Action is '遭遇'
                    const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && p.status === 'active');
                    if (potentialTargets.length === 0) {
                        pool.gameProcessLog.push(`  [${playerInGame.nickname}] 未侦测到其他活动目标。`);
                        if (playerInGame.strategy === '猛攻') { // If 猛攻 and no targets, force search
                            pool.gameProcessLog.push(`  [${playerInGame.nickname}] (猛攻策略) 转为强行搜寻！`);
                            // Pass pluginInstanceToUse to search
                            await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstanceToUse);
                        }
                    } else {
                        let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        const targetType = target.isNpc ? "NPC" : "调查员";
                        pool.gameProcessLog.push(`  [${playerInGame.nickname}] 锁定了${targetType}目标 [${target.nickname}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        // Pass pluginInstanceToUse to combat
                        await performCombat(playerInGame, target, pool, allWeapons, pluginInstanceToUse);
                    }
                }
            }
            participant.actionsTaken++;
            // If participant was defeated or escaped during their action, they shouldn't take more actions
            if (participant.status === 'defeated' || participant.status === 'escaped') continue;
        }
        // Check if all participants are done for this round or overall
        if (pool.players.every(p => p.status !== 'active' || p.actionsTaken >=3)) {
            pool.gameProcessLog.push("所有参与者行动结束。");
            break; // End rounds
        }
    }
    pool.gameProcessLog.push(`\n--- 区域探索阶段结束 ---`);

    // --- Settlement Phase ---
    pool.settlementLog.push(`\n--- [区域: ${mapName}] 探索报告 ---`);
    for (const p of pool.players) {
        if (p.isNpc) {
            // ... (NPC settlement log remains largely the same)
            let npcSummary = `\nNPC: ${p.nickname}\n  最终状态: `;
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

        // Real player settlement
        let playerSummary = `\n调查员: ${p.nickname} (编号: ...${String(p.userId).slice(-4)})\n  最终状态: `;
        if (p.status === 'defeated') {
            playerSummary += "任务中断，信号消失";
            pool.settlementLog.push(playerSummary + "\n  回收物品: 无\n  获取新装备: 无\n  临时资金: 0 (已遗失)");
            // No data saving for defeated players' gains
            continue;
        } else if (p.status === 'escaped') {
            playerSummary += "成功脱离区域";
        } else { // active or wounded
            playerSummary += p.status === 'wounded' ? "受创撤离" : "任务完成，安全返回";
        }

        let playerStorageData = null;
        // Only try to get/save player data if pluginInstanceToUse is available
        if (pluginInstanceToUse) {
            const { playerData: fetchedData } = await pluginInstanceToUse.getPlayer(p.userId);
            playerStorageData = fetchedData;
        }

        if (!playerStorageData && pluginInstanceToUse) { // Log error if instance exists but data fetch failed
            logger.error(`[GameHandler] 结算阶段: 调查员 ${p.nickname} (${p.userId}) 档案同步失败。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：无法同步您的个人档案。");
            // Continue to log temporary gains even if storage fails, but don't save them
        }

        let totalValueGainedFromItems = 0;
        let collectiblesGainedThisGame = [];
        let newWeaponsAddedToStorageNames = [];
        let itemsGainedThisGameStrings = [];

        playerSummary += "\n  本次探索收获:";
        const noGains = p.currentItems.length === 0 &&
            p.foundWeaponsInGame.length === 0 &&
            p.temporaryFunds === 0;

        if (noGains && p.status !== 'defeated') { // Check status again, though defeated should have continued
            playerSummary += " 无实质收获";
        }

        // Process items
        p.currentItems.forEach(item => {
            if (item.type === 'collectible' || item.rarity === '收藏品') {
                if (playerStorageData && !playerStorageData.collectibles.find(c => c.name === item.name)) {
                    playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price });
                }
                collectiblesGainedThisGame.push(`${item.name}(${item.rarity})`);
            } else { // Regular items converted to funds
                itemsGainedThisGameStrings.push(`${item.name}(${item.rarity}, 价值 ${item.price || 0}资金)`);
                totalValueGainedFromItems += (item.price || 0);
            }
        });

        // Process found weapons
        p.foundWeaponsInGame.forEach(weaponName => {
            if (weaponName === INITIAL_WEAPON_NAME) return; // Skip initial weapon
            if (playerStorageData && !playerStorageData.heldWeapons.includes(weaponName)) {
                playerStorageData.heldWeapons.push(weaponName);
                newWeaponsAddedToStorageNames.push(weaponName);
            } else if (!playerStorageData && !newWeaponsAddedToStorageNames.includes(weaponName)) { // If no storage, still log as temp gain
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
        if (playerStorageData) { // Only update funds if storage data is available
            playerStorageData.funds += totalValueGainedFromItems + p.temporaryFunds;
            playerSummary += `\n  当前总资金: ${playerStorageData.funds}`;
        } else {
            playerSummary += `\n  (未同步至永久资金)`;
        }

        if (p.status === 'wounded') {
            playerSummary += `\n  警告: 您的状态不稳定，建议尽快进行休整！`;
        }

        pool.settlementLog.push(playerSummary);
        // Save player data if it was successfully fetched and modified
        if (playerStorageData && pluginInstanceToUse) {
            await savePlayerData(p.userId, playerStorageData);
        }
    }

    // Send logs to groups
    const uniqueGroupIds = [...new Set(pool.players.filter(p => !p.isNpc && p.groupId).map(p => p.groupId))];
    for (const groupId of uniqueGroupIds) {
        if (global.Bot && typeof global.Bot.pickGroup === 'function') {
            const groupToNotify = global.Bot.pickGroup(groupId);
            if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                if (pool.gameProcessLog.length > 0) {
                    const gameProcessForwardMsg = await makeForwardMsgWithContent(pool.gameProcessLog, `探索行动记录: ${mapName}`);
                    if (gameProcessForwardMsg) await groupToNotify.sendMsg(gameProcessForwardMsg).catch(err => logger.error(`Error sending game process log: ${err}`));
                }
                if (pool.settlementLog.length > 0) {
                    const settlementForwardMsg = await makeForwardMsgWithContent(pool.settlementLog, `探索结算报告: ${mapName}`);
                    if (settlementForwardMsg) await groupToNotify.sendMsg(settlementForwardMsg).catch(err => logger.error(`Error sending settlement log: ${err}`));
                }
            }
        }
    }
    // Clean up the game pool after processing
    delete gamePools[mapName];
    logger.info(`[GameHandler] 探索任务于区域 "${mapName}" 已结束并清理。`);
}


async function performCombat(attacker, defender, pool, allWeapons, pluginInstanceFromCaller) {
    const pluginInstanceToUse = pluginInstanceFromCaller || _pluginInstance || getGlobalPluginInstance();

    // Check for plugin instance if players are involved and not already defeated/escaped
    if (!pluginInstanceToUse &&
        ( (!attacker.isNpc && attacker.status === 'active') || (!defender.isNpc && defender.status === 'active') )
    ) {
        logger.error(`[GameHandler - performCombat] CRITICAL: pluginInstance is undefined. Combat involving active players cannot reliably save data changes for map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战斗模块遭遇严重错误，玩家数据可能无法正确处理。`);
        // Potentially set both to a neutral state or end combat early if critical
    }

    // ... (rest of performCombat function remains the same, but ensure any calls to pluginInstanceToUse.getPlayer or savePlayerData use pluginInstanceToUse)
    // Make sure to pass pluginInstanceToUse to transferSpoils
    // Example: await transferSpoils(winner, loser, pool, pluginInstanceToUse, allWeapons);

    if (attacker.isNpc && attacker.npcDefinition?.dialogue) {
        const dialogueKey = attacker.npcDefinition.dialogue.onEngage ? 'onEngage' : 'onEncounter';
        if (attacker.npcDefinition.dialogue[dialogueKey]) {
            pool.gameProcessLog.push(`  🗣️ [${attacker.nickname}]: "${attacker.npcDefinition.dialogue[dialogueKey]}"`);
        }
    }
    if (defender.isNpc && defender.npcDefinition?.dialogue && defender.userId !== attacker.userId) { // Avoid self-dialogue if NPC targets self (should not happen)
        const dialogueKey = defender.npcDefinition.dialogue.onEngage ? 'onEngage' : 'onEncounter';
        if (defender.npcDefinition.dialogue[dialogueKey]) {
            pool.gameProcessLog.push(`  🗣️ [${defender.nickname}]: "${defender.npcDefinition.dialogue[dialogueKey]}"`);
        }
    }

    // Master Escape pre-combat check (already present, seems fine)
    if (defender.isNpc && defender.combatPassive?.type === 'master_escape' && defender.status === 'active') {
        // ... (master escape logic)
        // This logic seems fine as it doesn't directly depend on pluginInstance for its check
    }

    const combatResult = calculateCombatPowerWithPassives(attacker, defender, allWeapons);
    combatResult.log.forEach(log => pool.gameProcessLog.push(`  ${log}`));

    const outcome = determineBattleOutcome(combatResult.attackerFinalPower, combatResult.defenderFinalPower, combatResult.successRateModifier, combatResult);
    let winner = outcome.attackerWins ? attacker : defender;
    let loser = outcome.attackerWins ? defender : attacker;

    pool.gameProcessLog.push(`  冲突结果: [${winner.nickname}] 占据上风! (判定细节: ${outcome.detail})`);

    if (loser.status === 'active' || loser.status === 'wounded') { // Only process if loser was not already defeated/escaped
        if (loser.status === 'wounded' && !combatResult.loserIgnoresWounded) { // If already wounded and cannot ignore it
            loser.status = 'defeated';
            if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) {
                pool.gameProcessLog.push(`  🗣️ [${loser.nickname}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
            }
            pool.gameProcessLog.push(`  [${loser.nickname}] 已受重创，不敌对手，被迫退出探索！`);
            // Transfer spoils only if pluginInstance exists (for player data saving) OR winner is NPC (no data saving for NPC winner)
            if (pluginInstanceToUse || winner.isNpc) {
                await transferSpoils(winner, loser, pool, pluginInstanceToUse, allWeapons);
            } else if (!winner.isNpc) { // If winner is player and no instance, log warning
                pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移给玩家 [${winner.nickname}]。`);
            }
        } else if (loser.status !== 'defeated' && loser.status !== 'escaped') { // Not already defeated/escaped
            let escapeChanceUnharmed = POST_COMBAT_ESCAPE_UNHARMED_CHANCE;
            let escapeChanceWounded = POST_COMBAT_ESCAPE_WOUNDED_CHANCE;

            if (loser.weapon?.passiveType === 'escape_boost_post_combat') {
                const boost = loser.weapon.passiveValue || 0; // Ensure passiveValue is a number
                escapeChanceUnharmed += boost;
                escapeChanceWounded += boost;
                pool.gameProcessLog.push(`  [${loser.nickname}] 的装备 (${loser.weapon.name}) 触发特性 [${loser.weapon.passive || '紧急脱离'}]，尝试增加逃脱几率！`);
            }

            const escapeRoll = Math.random();
            if (escapeRoll < escapeChanceUnharmed) {
                pool.gameProcessLog.push(`  [${loser.nickname}] 反应迅速，在混乱中成功撤退！未损失物资。`);
                if (loser.isNpc) {
                    loser.status = 'escaped'; // NPC escapes
                    if (loser.npcDefinition?.dialogue?.onEscape) {
                        pool.gameProcessLog.push(`  🗣️ [${loser.nickname}]: "${loser.npcDefinition.dialogue.onEscape}"`);
                    }
                } else {
                    loser.status = 'escaped'; // Player escapes
                }
            } else if (escapeRoll < escapeChanceUnharmed + escapeChanceWounded) { // Wounded escape
                if (!combatResult.loserIgnoresWounded) { // Check if loser can ignore being wounded
                    loser.status = 'wounded';
                    pool.gameProcessLog.push(`  [${loser.nickname}] 冲突失利，受到创伤！但成功保留当前物资并暂时后撤。`);
                } else { // Loser ignores wound (e.g. due to a passive)
                    pool.gameProcessLog.push(`  [${loser.nickname}] 的装备特性使其在受创时仍能保持行动力！冲突失利，但成功保留当前物资并暂时后撤。`);
                    // Loser remains 'active' or their specific status from passive, not 'wounded'
                }
            } else { // Defeated
                loser.status = 'defeated';
                if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) {
                    pool.gameProcessLog.push(`  🗣️ [${loser.nickname}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
                }
                pool.gameProcessLog.push(`  [${loser.nickname}] 未能成功脱离，被 [${winner.nickname}] 击倒！`);
                if (pluginInstanceToUse || winner.isNpc) {
                    await transferSpoils(winner, loser, pool, pluginInstanceToUse, allWeapons);
                } else if (!winner.isNpc) {
                    pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移给玩家 [${winner.nickname}]。`);
                }
            }
        }
    }
}


export async function performSearchAction(playerInGame, pool, allItems, allWeapons, publicItemsPool, gameLogArray, pluginInstanceFromCaller) {
    // pluginInstance is not strictly needed for search itself unless search has side effects requiring player data saving beyond the game instance
    // For now, it's passed but not used. If future search actions need it, pluginInstanceToUse can be resolved.
    // const pluginInstanceToUse = pluginInstanceFromCaller || _pluginInstance || getGlobalPluginInstance();

    // ... (performSearchAction function remains the same as it doesn't directly use pluginInstance for saving player data during the search itself)
    const itemsToObtainCount = Math.floor(Math.random() * 2) + 1; // 1 to 2 items
    let foundItemsMsgParts = [];
    const mapInfo = pool.mapInfo;

    const combinedItemPools = [];
    // Populate from map's itemPool
    if (mapInfo.itemPool && mapInfo.refreshRate) {
        for (const rarity in mapInfo.itemPool) {
            if (mapInfo.refreshRate[rarity] && mapInfo.itemPool[rarity]) {
                mapInfo.itemPool[rarity].forEach(itemEntry => {
                    combinedItemPools.push({
                        entry: itemEntry, // Can be string (item name) or object (weapon descriptor)
                        rarity: rarity,
                        // Adjust probability for weapons slightly if needed, or keep uniform
                        probability: mapInfo.refreshRate[rarity] * (typeof itemEntry === 'object' && itemEntry.type === 'weapon' ? 0.7 : 1), // Example: weapons slightly rarer
                        source: 'map'
                    });
                });
            }
        }
    }
    // Populate from publicItemsPool (global items)
    const publicPoolTotalProbabilityWeight = 0.3; // How much public items contribute overall
    if (publicItemsPool && publicItemsPool.length > 0) {
        publicItemsPool.forEach(publicItemEntry => {
            const rarity = publicItemEntry.rarity || "普通";
            // Distribute the publicPoolTotalProbabilityWeight among all public items
            // This is a simplified approach; a more robust system might use individual probabilities for public items.
            const perPublicItemProbFactor = (publicPoolTotalProbabilityWeight / publicItemsPool.length) * 0.1; // Small chance per public item

            combinedItemPools.push({
                entry: publicItemEntry.name, // Public items are usually by name
                rarity: rarity,
                probability: perPublicItemProbFactor,
                source: 'public',
                itemDef: publicItemEntry // Store the full definition for public items
            });
        });
    }


    if (combinedItemPools.length === 0 && (!allItems || allItems.length === 0) && (!allWeapons || allWeapons.length === 0)) {
        gameLogArray.push(`  [${playerInGame.nickname}] 仔细搜寻，但此地似乎已被搜刮殆尽，未发现任何可用物资。`);
        return;
    }

    for (let i = 0; i < itemsToObtainCount; i++) {
        let chosenItemDef = null;
        let itemType = 'item'; // 'item' or 'weapon'
        let attempts = 0;
        const maxFindAttempts = 20; // Prevent infinite loops if probabilities are misconfigured

        // Weighted random selection based on rarity probabilities from mapInfo.refreshRate
        // This loop prioritizes finding items based on defined rarities first.
        while (!chosenItemDef && attempts < maxFindAttempts) {
            attempts++;
            let selectedRarity = "普通"; // Default
            const rarityRoll = Math.random();
            let cumulativeProb = 0;
            // Ensure refreshRate exists and sort rarities by their probability to ensure correct weighted selection
            const sortedRarities = Object.keys(mapInfo.refreshRate || {}).sort((a, b) => (mapInfo.refreshRate[a] || 0) - (mapInfo.refreshRate[b] || 0));

            for (const rarity of sortedRarities) {
                cumulativeProb += (mapInfo.refreshRate[rarity] || 0);
                if (rarityRoll < cumulativeProb) {
                    selectedRarity = rarity;
                    break;
                }
            }
            // Fallback if roll didn't hit any defined rarity (e.g., sum of probs < 1)
            if (attempts === 1 && !mapInfo.refreshRate[selectedRarity] && sortedRarities.length > 0) {
                selectedRarity = sortedRarities[0]; // Pick the lowest probability one as a fallback
            }


            // Filter combinedItemPools for items of the selectedRarity
            const potentialDropsThisRarity = combinedItemPools.filter(p => p.rarity === selectedRarity);

            if (potentialDropsThisRarity.length > 0) {
                // Randomly pick one from the filtered list for that rarity
                const chosenDropContainer = potentialDropsThisRarity[Math.floor(Math.random() * potentialDropsThisRarity.length)];

                if (chosenDropContainer) {
                    if (chosenDropContainer.source === 'public') {
                        chosenItemDef = chosenDropContainer.itemDef; // Already have full def
                        itemType = chosenItemDef.type === 'weapon' ? 'weapon' : 'item';
                    } else { // Source is 'map'
                        const mapEntry = chosenDropContainer.entry;
                        if (typeof mapEntry === 'string') { // Item name
                            chosenItemDef = allItems.find(item => item.name === mapEntry && item.rarity === selectedRarity);
                            if (chosenItemDef) itemType = 'item';
                        } else if (typeof mapEntry === 'object' && mapEntry.type === 'weapon') { // Weapon descriptor
                            chosenItemDef = allWeapons.find(w => w.name === mapEntry.name && w.rarity === selectedRarity);
                            if (chosenItemDef) itemType = 'weapon';
                        }
                    }
                }
            }
            if (chosenItemDef) break; // Found an item
        }

        // Fallback if no item found after attempts (e.g., rarity pool was empty or bad luck)
        if (!chosenItemDef) {
            // Try to give a common item as a fallback
            const commonItems = allItems.filter(it => it.rarity === "普通" && it.name !== DEFAULT_FALLBACK_ITEM_NAME);
            if (commonItems.length > 0) {
                chosenItemDef = commonItems[Math.floor(Math.random() * commonItems.length)];
            } else { // Ultimate fallback
                chosenItemDef = allItems.find(it => it.name === DEFAULT_FALLBACK_ITEM_NAME) || (allItems.length > 0 ? allItems[0] : null);
            }
            if (chosenItemDef) itemType = 'item'; // Fallbacks are usually items
        }


        if (chosenItemDef) {
            if (itemType === 'weapon') {
                if (chosenItemDef.name === INITIAL_WEAPON_NAME) { // Don't find initial weapon
                    foundItemsMsgParts.push(`发现了多余的 ${INITIAL_WEAPON_NAME}(初始装备)，已忽略。`);
                } else if ((!playerInGame.isNpc && playerInGame.initialHeldWeapons.includes(chosenItemDef.name)) || playerInGame.foundWeaponsInGame.includes(chosenItemDef.name)) {
                    // Player already has this weapon (either from start or found in this game)
                    const value = chosenItemDef.price || 0; // Convert to funds if already owned
                    playerInGame.temporaryFunds += value;
                    foundItemsMsgParts.push(`发现了重复装备: ${chosenItemDef.name}(${chosenItemDef.rarity})，转化为 ${value} 临时资金。`);
                } else {
                    playerInGame.foundWeaponsInGame.push(chosenItemDef.name);
                    foundItemsMsgParts.push(`[装备]: ${chosenItemDef.name}(${chosenItemDef.rarity})`);
                }
            } else { // Item
                // Ensure item has a type, default to 'item' if not specified
                playerInGame.currentItems.push(JSON.parse(JSON.stringify({...chosenItemDef, type: chosenItemDef.type || 'item' })));
                foundItemsMsgParts.push(`${chosenItemDef.name}(${chosenItemDef.rarity})`);
            }
        } else {
            // If absolutely nothing could be found (should be rare with fallbacks)
            const ultimateFallback = { name: "不明物质残渣", rarity: "未知", price: 0, type: 'item' };
            playerInGame.currentItems.push(ultimateFallback);
            foundItemsMsgParts.push(`${ultimateFallback.name}(${ultimateFallback.rarity})`);
        }
    }

    if (foundItemsMsgParts.length > 0) {
        gameLogArray.push(`  [${playerInGame.nickname}] 在废墟中搜寻: ${foundItemsMsgParts.join('、 ')}。`);
    } else {
        gameLogArray.push(`  [${playerInGame.nickname}] 在废墟中仔细搜寻，但似乎一无所获。`);
    }
}


export async function transferSpoils(winner, loser, pool, pluginInstanceFromCaller, allWeapons) {
    const pluginInstanceToUse = pluginInstanceFromCaller || _pluginInstance || getGlobalPluginInstance();

    // Check for plugin instance if players are involved in permanent data changes
    if (!pluginInstanceToUse &&
        ( (!winner.isNpc && loser.status === 'defeated' && !loser.isNpc) || // Player wins against player
            (!loser.isNpc && loser.status === 'defeated' && !winner.isNpc) )   // Player loses against player
    ) {
        logger.error(`[GameHandler - transferSpoils] CRITICAL: pluginInstance is undefined. Permanent spoils transfer between players cannot save data for map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战利品处理模块遭遇严重错误，玩家永久档案数据可能无法正确处理。`);
    }
    // ... (rest of transferSpoils function remains the same, but ensure any calls to pluginInstanceToUse.getPlayer or savePlayerData use pluginInstanceToUse)
    pool.gameProcessLog.push(`  [${winner.nickname}] 开始清点 [${loser.nickname}] 的遗留物品!`);

    // Transfer current items (temporary for this game instance)
    if (loser.currentItems.length > 0) {
        const itemNames = loser.currentItems.map(i => `${i.name}(${i.rarity || i.type})`).join('、 ');
        pool.gameProcessLog.push(`  缴获物资: ${itemNames}。`);
        winner.currentItems.push(...JSON.parse(JSON.stringify(loser.currentItems))); // Deep copy
        loser.currentItems = [];
    }

    // Transfer temporary funds
    if (loser.temporaryFunds > 0) {
        pool.gameProcessLog.push(`  缴获临时资金: ${loser.temporaryFunds}。`);
        winner.temporaryFunds += loser.temporaryFunds;
        loser.temporaryFunds = 0;
    }

    // Transfer weapons found in this game instance
    if (loser.foundWeaponsInGame.length > 0) {
        let lootedNewWeaponsMsgParts = [];
        let convertedToFundsMsgParts = [];
        for (const weaponName of loser.foundWeaponsInGame) {
            if (weaponName === INITIAL_WEAPON_NAME) continue; // Skip initial weapon

            const weaponDef = allWeapons.find(w => w.name === weaponName);
            if (!weaponDef) {
                logger.warn(`[GameHandler] transferSpoils: Definition for weapon "${weaponName}" not found in allWeapons during in-game transfer.`);
                continue;
            }

            // If winner already has it (from start or found in this game), convert to funds
            if ((!winner.isNpc && winner.initialHeldWeapons.includes(weaponName)) || winner.foundWeaponsInGame.includes(weaponName)) {
                const value = weaponDef.price || 0; // Use price as conversion value
                winner.temporaryFunds += value;
                convertedToFundsMsgParts.push(`${weaponName}(转化为 ${value} 临时资金)`);
            } else { // Winner gets the new weapon (for this game instance)
                winner.foundWeaponsInGame.push(weaponName);
                lootedNewWeaponsMsgParts.push(`${weaponName}(${weaponDef.rarity})`);
            }
        }
        if (lootedNewWeaponsMsgParts.length > 0) {
            pool.gameProcessLog.push(`  缴获本局内发现的装备: ${lootedNewWeaponsMsgParts.join('、 ')}。`);
        }
        if (convertedToFundsMsgParts.length > 0) {
            pool.gameProcessLog.push(`  部分重复装备已转化为资金: ${convertedToFundsMsgParts.join('、 ')}。`);
        }
        loser.foundWeaponsInGame = [];
    }

    // NPC unique loot
    if (loser.isNpc && loser.npcDefinition?.uniqueLoot && loser.npcDefinition.uniqueLoot.length > 0) {
        pool.gameProcessLog.push(`  [${winner.nickname}] 搜刮了 [${loser.nickname}] 的特殊遗物...`);
        loser.npcDefinition.uniqueLoot.forEach(lootItem => {
            if (Math.random() < lootItem.dropChance) {
                const lootItemDef = lootItem.type === 'weapon' ? allWeapons.find(w => w.name === lootItem.name) : lootItem; // For items, lootItem itself is the def
                if (!lootItemDef) {
                    logger.warn(`[GameHandler] NPC ${loser.nickname} unique loot item ${lootItem.name} definition not found or invalid.`);
                    return;
                }

                pool.gameProcessLog.push(`    获得了特殊物品: ${lootItemDef.name}(${lootItemDef.rarity || lootItem.rarity})!`);
                if (lootItem.type === 'weapon') {
                    // Check if winner already has this unique weapon (from start or found in this game)
                    if ((!winner.isNpc && winner.initialHeldWeapons.includes(lootItemDef.name)) || winner.foundWeaponsInGame.includes(lootItemDef.name)) {
                        const value = lootItemDef.price || 50; // Default value if price missing
                        winner.temporaryFunds += value;
                        pool.gameProcessLog.push(`    (重复的特殊装备 ${lootItemDef.name} 转化为 ${value} 临时资金)`);
                    } else {
                        winner.foundWeaponsInGame.push(lootItemDef.name);
                    }
                } else { // Unique item
                    winner.currentItems.push(JSON.parse(JSON.stringify({
                        name: lootItemDef.name,
                        rarity: lootItemDef.rarity,
                        price: lootItemDef.price || 0,
                        type: lootItem.type // Ensure type is preserved (e.g., 'collectible')
                    })));
                }
            }
        });
    }

    // PvP: Transfer of equipped weapon (permanent loss/gain if both are players and instance exists)
    if (!winner.isNpc && !loser.isNpc && pluginInstanceToUse && loser.status === 'defeated') {
        const { playerData: loserStorageData } = await pluginInstanceToUse.getPlayer(loser.userId);
        const { playerData: winnerStorageData } = await pluginInstanceToUse.getPlayer(winner.userId);

        if (!loserStorageData || !winnerStorageData) {
            logger.error(`[GameHandler] transferSpoils (PvP): Failed to get player data for ${loser.userId} or ${winner.userId}. Permanent weapon transfer aborted.`);
            pool.gameProcessLog.push(`  [系统错误] 处理玩家间永久装备转移时，档案同步失败。`);
            return; // Abort permanent transfer if data is missing
        }

        const lostEquippedWeaponName = loser.weapon.name; // The weapon loser was using in this game
        const lostEquippedWeaponDef = allWeapons.find(w => w.name === lostEquippedWeaponName);

        // Cannot lose the initial weapon permanently
        if (lostEquippedWeaponName !== INITIAL_WEAPON_NAME) {
            const weaponIdxInLoserStorage = loserStorageData.heldWeapons.indexOf(lostEquippedWeaponName);

            if (weaponIdxInLoserStorage > -1) { // Loser actually owns this weapon in their permanent storage
                loserStorageData.heldWeapons.splice(weaponIdxInLoserStorage, 1); // Remove from loser's storage
                pool.gameProcessLog.push(`  [${loser.nickname}] 永久失去了装备 "${lostEquippedWeaponName}"！`);

                // Add to winner's storage if they don't have it, otherwise convert to funds (for winner's temp funds this game)
                if (winnerStorageData.heldWeapons.includes(lostEquippedWeaponName)) {
                    const value = lostEquippedWeaponDef?.price || 0; // Use weapon's price
                    winner.temporaryFunds += value; // Add to winner's temporary funds for this game
                    pool.gameProcessLog.push(`  [${winner.nickname}] 已拥有同型号装备 "${lostEquippedWeaponName}"，其价值 (${value}资金) 已计入本次探索的临时资金。`);
                } else {
                    winnerStorageData.heldWeapons.push(lostEquippedWeaponName); // Add to winner's storage
                    pool.gameProcessLog.push(`  [${winner.nickname}] 永久获得了装备 "${lostEquippedWeaponName}"！(已存入装备库)`);
                }
                // Save changes to both players' permanent data
                await savePlayerData(loser.userId, loserStorageData);
                await savePlayerData(winner.userId, winnerStorageData);
            } else {
                // This case means the loser was using a weapon in-game that wasn't in their permanent storage.
                // This could happen if they found it during this game instance and then lost it again.
                // No permanent transfer needed from storage in this specific sub-case, as it was never "permanent" for the loser.
                logger.warn(`[GameHandler] transferSpoils (PvP): Loser ${loser.nickname} was using ${lostEquippedWeaponName} but it was not in their stored heldWeapons. No permanent storage transfer occurred for this specific weapon.`);
                pool.gameProcessLog.push(`  [情报] ${loser.nickname} 使用的装备 ${lostEquippedWeaponName} 未在其永久档案中找到，或为本局临时获取，故未发生永久转移。`);
            }
        } else {
            pool.gameProcessLog.push(`  [情报] ${loser.nickname} 的初始装备 ${INITIAL_WEAPON_NAME} 不会永久丢失。`);
        }
    }
}
