// camellia-plugin/apps/handlers/gameHandler.js

import { getItems, getWeapons, getMaps, getPublicItems, getPlayerData, savePlayerData, getNpcs } from '../../utils/dataManager.js';
import { calculateCombatPowerWithPassives, determineBattleOutcome } from '../../utils/combatHelper.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    STRATEGY_PROBABILITY,
    DEFAULT_FALLBACK_ITEM_NAME,
    INITIAL_WEAPON_NAME,
    POST_COMBAT_ESCAPE_UNHARMED_CHANCE, // Note: This constant might be re-evaluated based on new logic for player "escape"
    POST_COMBAT_ESCAPE_WOUNDED_CHANCE,  // Note: This constant might be re-evaluated
    INJURY_LEVELS // Assuming INJURY_LEVELS is defined in constants.js or here
} from '../../utils/constants.js';


const gamePools = {};
const playerQueueStatus = {};
const QUEUE_CHECK_INTERVAL = 60 * 1000;
const DEFAULT_NPC_FILL_DELAY_MINUTES = 5;
const PLUGIN_NAME = '都市迷踪（搜打撤）';

let queueCheckIntervalId = null;

// Helper function to get the display name
function getFormattedNickname(playerInGame) {
    if (!playerInGame) return "未知参与者";
    if (playerInGame.isNpc) {
        return playerInGame.nickname;
    }
    if (playerInGame.activeTitle && playerInGame.activeTitle.trim() !== "") {
        return `【${playerInGame.activeTitle}】${playerInGame.nickname}`;
    }
    return playerInGame.nickname;
}

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
    // ... (other checks for global.plugins if necessary) ...
    return pInstance;
}

export function initializeGameHandlerTimedTasks() {
    if (queueCheckIntervalId) {
        clearInterval(queueCheckIntervalId);
        logger.info('[GameHandler] Cleared existing queue check interval.');
    }
    queueCheckIntervalId = setInterval(() => {
        checkAndFillQueuesWithNpcs();
    }, QUEUE_CHECK_INTERVAL);
    logger.info(`[GameHandler] Timed task for checking NPC queues initialized. Interval: ${QUEUE_CHECK_INTERVAL / 1000}s.`);
}

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
                        // Ensure NPC is not already in the pool for this specific map instance
                        const randomNpcId = availableNpcIdsOnMap[Math.floor(Math.random() * availableNpcIdsOnMap.length)];
                        const npcDef = allNpcDefs.find(n => n.id === randomNpcId);
                        if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition && p.npcDefinition.id === npcDef.id)) {
                            const npcPlayerObject = createNpcPlayerObject(npcDef, allWeaponDefs, false);
                            pool.players.push(npcPlayerObject);
                            logger.info(`[GameHandler] NPC "${getFormattedNickname(npcPlayerObject)}" 因超时已加入地图 "${mapName}"。`);
                            spawnedNpcCount++;
                        }
                    }
                }
                // ... (rest of NPC fill logic and game start) ...
                let timeoutSpawnedNpcNames = pool.players
                    .filter(p => p.isNpc && !p.justSpawnedRandomly) // Filter for NPCs not spawned by random event
                    .slice(-spawnedNpcCount) // Get the ones just added by timeout
                    .map(n => getFormattedNickname(n));

                if (spawnedNpcCount > 0) {
                    pool.gameProcessLog.push(`[系统提示] 由于等待超时，${spawnedNpcCount}名NPC调查员(${timeoutSpawnedNpcNames.join('、 ')})已加入队伍！`);
                }

                if (pool.players.length >= pool.mapInfo.playerCapacity) {
                    if (pluginInstance || pool.players.every(p => p.isNpc)) { // Game can start if only NPCs or if pluginInstance is available
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
    // ... (NPC object creation logic - assumed correct from original)
    let npcWeaponResolved = null;
    if (typeof npcDef.weapon === 'string') {
        npcWeaponResolved = allWeaponDefs.find(w => w.name === npcDef.weapon) ||
            { name: npcDef.weapon, baseCombatPower: 50, passive: "无", passiveType: "none", rarity: "普通", description: "未知装备 (来自NPC定义)" };
    } else if (typeof npcDef.weapon === 'object' && npcDef.weapon.name) {
        const globalWeaponMatch = allWeaponDefs.find(w => w.name === npcDef.weapon.name);
        if (globalWeaponMatch) {
            npcWeaponResolved = {
                ...globalWeaponMatch, // Start with global definition
                // Override with NPC-specific values if they exist
                baseCombatPower: npcDef.weapon.baseCombatPower || globalWeaponMatch.baseCombatPower,
                passive: npcDef.weapon.passive || globalWeaponMatch.passive,
                passiveType: npcDef.weapon.passiveType || globalWeaponMatch.passiveType,
                passiveValue: npcDef.weapon.passiveValue !== undefined ? npcDef.weapon.passiveValue : globalWeaponMatch.passiveValue,
                passiveDescription: npcDef.weapon.passiveDescription || globalWeaponMatch.passiveDescription,
                rarity: npcDef.weapon.rarity || globalWeaponMatch.rarity // Ensure rarity is also considered for override
            };
        } else {
            // If no global match, use the NPC's weapon object directly
            npcWeaponResolved = { ...npcDef.weapon };
        }
    } else {
        // Fallback if no weapon string or object with name is provided
        npcWeaponResolved = { name: "特殊制式装备", baseCombatPower: npcDef.baseCombatPower || 50, passive: "标准型号", passiveType: "none", rarity: "特殊", description: "NPC专属标准装备"};
    }
    // Ensure essential fields have defaults if still missing after resolution
    npcWeaponResolved.baseCombatPower = npcWeaponResolved.baseCombatPower || npcDef.baseCombatPower || 0;
    npcWeaponResolved.passive = npcWeaponResolved.passive || "无";
    npcWeaponResolved.passiveType = npcWeaponResolved.passiveType || "none";
    npcWeaponResolved.rarity = npcWeaponResolved.rarity || "普通";
    // Deep copy passiveValue if it's an object and defined in npcDef.weapon
    if (npcDef.weapon && npcDef.weapon.passiveValue !== undefined && npcWeaponResolved.passiveValue === undefined) {
        npcWeaponResolved.passiveValue = JSON.parse(JSON.stringify(npcDef.weapon.passiveValue));
    }


    return {
        userId: `npc-${npcDef.id}-${Date.now()}${Math.floor(Math.random()*1000)}`,
        nickname: `【${npcDef.title}】${npcDef.name}`,
        isNpc: true,
        npcDefinition: JSON.parse(JSON.stringify(npcDef)), // Deep copy
        weapon: JSON.parse(JSON.stringify(npcWeaponResolved)), // Deep copy
        strategy: npcDef.strategy || (npcDef.hostility === 'hostile' ? '猛攻' : '均衡'),
        currentItems: [],
        foundWeaponsInGame: [],
        temporaryFunds: 0,
        status: 'active', // NPCs start active
        actionsTaken: 0,
        groupId: null, // NPCs don't belong to a specific group in this context
        initialHeldWeapons: npcWeaponResolved ? [npcWeaponResolved.name] : [], // For consistency, though less relevant for NPCs
        hostility: npcDef.hostility, // 'neutral', 'hostile', 'friendly'
        combatPassive: npcDef.combatPassive ? JSON.parse(JSON.stringify(npcDef.combatPassive)) : null, // Deep copy
        uniqueLoot: npcDef.uniqueLoot ? JSON.parse(JSON.stringify(npcDef.uniqueLoot)) : [], // Deep copy
        justSpawnedRandomly: spawnedByRandomEvent // Flag if NPC was spawned by random event this turn
    };
}


export async function handleEnterMap(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const groupId = e.group_id;
    const rawNickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
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

    const { playerData } = await pluginInstance.getPlayer(userId, rawNickname);
    if (!playerData) return e.reply("抱歉，您的身份识别出现错误，无法同步档案。");

    // Request 5: Check for injury
    if (playerData.needsTreatment && playerData.permanentInjuryStatus !== 'none') {
        const injuryName = INJURY_LEVELS[playerData.permanentInjuryStatus]?.name || playerData.permanentInjuryStatus;
        e.reply(`[警告] 您当前状态为【${injuryName}】，行动可能会受到影响。建议使用 #治疗 进行休整后再进入高危区域。`);
        // Depending on game rules, you might prevent entry or apply penalties later. For now, it's a warning.
    }

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

    playerData.funds -= selectedMap.entryFee;
    await savePlayerData(userId, playerData);

    const playerInGame = {
        userId: userId,
        nickname: playerData.nickname,
        activeTitle: playerData.activeTitle,
        isNpc: false,
        weapon: JSON.parse(JSON.stringify(selectedWeaponDef)),
        strategy: strategy,
        currentItems: [],
        foundWeaponsInGame: [],
        temporaryFunds: 0,
        status: 'active', // Player starts active
        // permanentInjuryStatus: playerData.permanentInjuryStatus, // Carry over current injury for potential in-game effects
        // needsTreatment: playerData.needsTreatment,
        actionsTaken: 0,
        groupId: groupId,
        initialHeldWeapons: [...playerData.heldWeapons]
    };
    pool.players.push(playerInGame);
    pool.playerGroupIds[userId] = groupId;
    playerQueueStatus[userId] = mapName;

    // Request 6: Update queue message to include NPCs
    const totalInQueue = pool.players.length;
    const realPlayersInQueue = pool.players.filter(p => !p.isNpc).length;
    const npcsInQueueCount = totalInQueue - realPlayersInQueue;
    let queueCountMessage = `${totalInQueue}/${selectedMap.playerCapacity}`;
    if (npcsInQueueCount > 0) {
        queueCountMessage += ` (真人 ${realPlayersInQueue}, NPC ${npcsInQueueCount})`;
    } else {
        queueCountMessage += ` (真人 ${realPlayersInQueue})`;
    }
    e.reply(`${getFormattedNickname(playerInGame)} 已装备 "${weaponName}" (策略: ${strategy}) 进入 "${mapName}" 待命队列 (${queueCountMessage})。`);


    let gameStartedByThisJoin = false;
    if (pool.players.length < selectedMap.playerCapacity && !pool.npcsSpawnedThisInstance && selectedMap.npcSpawnChance > 0 && Math.random() < selectedMap.npcSpawnChance) {
        // ... (NPC spawn logic - assumed correct from original) ...
        const allNpcDefs = getNpcs();
        const allWeaponDefsForNpcs = getWeapons(); // Ensure this is defined
        const availableNpcIdsOnMap = selectedMap.availableNpcIds || [];
        let numNpcsToTrySpawn = selectedMap.maxNpcsToSpawnOnJoin || 1; // Max NPCs to spawn when a player joins
        let spawnedThisCheck = 0;

        if (availableNpcIdsOnMap.length > 0 && numNpcsToTrySpawn > 0) {
            if (pool.gameProcessLog.length === 0) { // Only add this if it's the first log entry for the pool
                pool.gameProcessLog.push(`[系统提示] 侦测到异常活动，区域内似乎存在其他实体...`);
            }
            for (let i = 0; i < numNpcsToTrySpawn && pool.players.length < selectedMap.playerCapacity; i++) {
                const randomNpcId = availableNpcIdsOnMap[Math.floor(Math.random() * availableNpcIdsOnMap.length)];
                const npcDef = allNpcDefs.find(n => n.id === randomNpcId);
                // Ensure NPC is not already in the pool for this specific map instance
                if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition && p.npcDefinition.id === npcDef.id)) {
                    const npcPlayerObject = createNpcPlayerObject(npcDef, allWeaponDefsForNpcs, true); // true for spawnedByRandomEvent
                    pool.players.push(npcPlayerObject);
                    logger.info(`[GameHandler] NPC ${getFormattedNickname(npcPlayerObject)} 因随机刷新加入地图 "${mapName}"。`);
                    spawnedThisCheck++;
                }
            }
            if (spawnedThisCheck > 0) {
                pool.npcsSpawnedThisInstance = true; // Mark that NPCs have been spawned for this queue instance
                const newlySpawnedNpcNames = pool.players.filter(p => p.isNpc && p.justSpawnedRandomly).map(n => getFormattedNickname(n)).join('、 ');
                if (newlySpawnedNpcNames) {
                    gameStartedByThisJoin = pool.players.length === selectedMap.playerCapacity; // Check if full AFTER adding NPCs
                    const immediateSpawnNotification = `[系统警报] ${mapName}: ${newlySpawnedNpcNames} 已闯入区域${gameStartedByThisJoin ? "，探索队伍满员，遭遇战即将爆发！" : "，并加入了待命队列..."}`;
                    await e.reply(immediateSpawnNotification).catch(err => logger.error(`[GameHandler] Error sending immediate NPC spawn message: ${err}`));
                }
            }
        }
    }

    if (pool.players.length === selectedMap.playerCapacity) {
        pool.players.forEach(p => { if (p.isNpc) p.justSpawnedRandomly = false; }); // Reset flag
        await processGameInstance(mapName, pluginInstance);
    }
    return true;
}

export async function handleLeaveQueue(e, pluginInstanceFromApp) {
    // ... (Logic for leaving queue - assumed mostly correct, ensure refund logic is sound)
    const userId = e.user_id;
    const pluginInstance = pluginInstanceFromApp || getPluginInstance();

    if (!pluginInstance) {
        logger.error(`[GameHandler - handleLeaveQueue] CRITICAL: 无法找到插件实例。玩家 ${userId} 退出队列请求失败。`);
        return e.reply("系统核心组件通讯失败，无法处理您的请求，请联系管理员。");
    }

    if (!playerQueueStatus[userId]) return e.reply("您当前不在任何地图的待命队列中。");

    const mapName = playerQueueStatus[userId];
    const pool = gamePools[mapName];

    if (!pool || pool.status === 'in_progress') { // If game started or pool is gone
        delete playerQueueStatus[userId]; // Clean up status anyway
        return e.reply(`"${mapName}" 的探索任务已开始或队列信息异常，无法退出。`);
    }

    const playerIndex = pool.players.findIndex(p => p.userId === userId && !p.isNpc);
    if (playerIndex === -1) {
        delete playerQueueStatus[userId]; // Clean up status if somehow out of sync
        return e.reply(`在 "${mapName}" 的队列中未找到您的记录。`);
    }

    const { playerData } = await pluginInstance.getPlayer(userId); // Get player data for refund
    const playerInGame = pool.players[playerIndex]; // Get the player object from the pool to display name

    if (playerData && pool.mapInfo.entryFee > 0) {
        playerData.funds += pool.mapInfo.entryFee; // Refund entry fee
        await savePlayerData(userId, playerData);
        e.reply(`${getFormattedNickname(playerInGame)} 已从 "${mapName}" 队列退出，返还入场费 ${pool.mapInfo.entryFee} 资金。`);
    } else {
        e.reply(`${getFormattedNickname(playerInGame)} 已从 "${mapName}" 队列退出。`);
    }

    pool.players.splice(playerIndex, 1); // Remove player from pool
    delete playerQueueStatus[userId]; // Clear their queue status
    delete pool.playerGroupIds[userId]; // Remove their group ID mapping for this pool

    // If the queue becomes empty of real players and NPCs were not spawned by random event (implying it might just be timed NPCs left or empty)
    // Reset queue start time if no real players are left, to give NPCs a fresh timeout or let the queue die if no more players join.
    if (pool.players.filter(p => !p.isNpc).length === 0 && !pool.npcsSpawnedThisInstance) {
        pool.queueStartTime = Date.now(); // Reset timer if only NPCs might be left or it's empty
        logger.info(`[GameHandler] Queue for "${mapName}" is now empty of real players or only contains timed NPCs, timer reset.`);
    }
    return true;
}

export async function handleViewQueues(e, pluginInstanceFromApp) {
    // ... (Logic for viewing queues - assumed correct)
    let replyMsg = "--- 当前地图待命队列 ---";
    let hasQueues = false;

    for (const mapName in gamePools) {
        const pool = gamePools[mapName];
        if (pool.status === 'waiting' && pool.players.length > 0) {
            hasQueues = true;
            const realPlayers = pool.players.filter(p => !p.isNpc);
            const npcsInQueue = pool.players.filter(p => p.isNpc);

            replyMsg += `\n[${mapName}] (${pool.players.length}/${pool.mapInfo.playerCapacity} 总计): `;
            if (realPlayers.length > 0) {
                replyMsg += "真人: " + realPlayers.map(p => getFormattedNickname(p)).join('、 ');
            }
            if (npcsInQueue.length > 0) {
                replyMsg += (realPlayers.length > 0 ? "; " : "") + "NPCs: " + npcsInQueue.map(n => getFormattedNickname(n)).join('、 ');
            }
        }
    }
    if (!hasQueues) replyMsg = "当前没有地图正在等待调查员。";
    return e.reply(replyMsg);
}


async function performCombat(attacker, defender, pool, allWeapons, pluginInstance) {
    const attackerDisplayName = getFormattedNickname(attacker);
    const defenderDisplayName = getFormattedNickname(defender);

    if (!pluginInstance && ((!attacker.isNpc && attacker.status !== 'defeated') || (!defender.isNpc && defender.status !== 'defeated'))) {
        logger.error(`[GameHandler - performCombat] CRITICAL: pluginInstance is undefined. Combat involving players on map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战斗模块遭遇严重错误，玩家数据可能无法正确处理。`);
    }

    // NPC Dialogue
    if (attacker.isNpc && attacker.npcDefinition?.dialogue) {
        const dialogueKey = attacker.npcDefinition.dialogue.onEngage || attacker.npcDefinition.dialogue.onEncounter;
        if (dialogueKey) pool.gameProcessLog.push(`  🗣️ [${attackerDisplayName}]: "${dialogueKey}"`);
    }
    if (defender.isNpc && defender.npcDefinition?.dialogue && defender.userId !== attacker.userId) { // Check userId to prevent self-dialogue if somehow targeted self
        const dialogueKey = defender.npcDefinition.dialogue.onEngage || defender.npcDefinition.dialogue.onEncounter;
        if (dialogueKey) pool.gameProcessLog.push(`  🗣️ [${defenderDisplayName}]: "${dialogueKey}"`);
    }

    // NPC Master Escape pre-combat check
    if (defender.isNpc && defender.combatPassive?.type === 'master_escape' && defender.status === 'active') {
        const npcWeaponPower = defender.weapon?.baseCombatPower || defender.npcDefinition?.baseCombatPower || 0;
        const attackerWeaponPower = attacker.weapon?.baseCombatPower || 0; // Attacker could be NPC or player
        const powerRatioThreshold = defender.combatPassive.details?.powerRatioThreshold || 0.7;

        if (npcWeaponPower < attackerWeaponPower * powerRatioThreshold) {
            const escapeChance = defender.combatPassive.details?.escapeChance || 0.75;
            if (Math.random() < escapeChance) {
                defender.status = 'escaped'; // NPC escapes the encounter
                pool.gameProcessLog.push(`  [${defenderDisplayName}] (${defender.combatPassive.name || '逃跑大师'}) 感知到巨大威胁，瞬间消失在阴影中，成功脱离战斗！`);
                if (defender.npcDefinition?.dialogue?.onEscape) pool.gameProcessLog.push(`  🗣️ [${defenderDisplayName}]: "${defender.npcDefinition.dialogue.onEscape}"`);
                return; // Combat ends here for this pair
            } else {
                pool.gameProcessLog.push(`  [${defenderDisplayName}] (${defender.combatPassive.name || '逃跑大师'}) 试图脱离，但被 [${attackerDisplayName}] 缠住！`);
            }
        }
    }


    const combatResult = calculateCombatPowerWithPassives(attacker, defender, allWeapons);
    combatResult.log.forEach(log => pool.gameProcessLog.push(`  ${log}`));

    const outcome = determineBattleOutcome(combatResult.attackerFinalPower, combatResult.defenderFinalPower, combatResult.successRateModifier, combatResult);
    let winner = outcome.attackerWins ? attacker : defender;
    let loser = outcome.attackerWins ? defender : attacker;
    const winnerDisplayName = getFormattedNickname(winner); // Re-get for winner/loser
    const loserDisplayNameForLog = getFormattedNickname(loser); // Re-get for winner/loser


    // Request 4: Enhanced log output for dice roll
    const detailMatch = outcome.detail.match(/判定掷骰: ([\d.]+), 攻击方胜率阈值: ([\d.]+)/);
    let battleRoll = "N/A", battleThreshold = "N/A";
    if (detailMatch) {
        battleRoll = parseFloat(detailMatch[1]).toFixed(3);
        battleThreshold = parseFloat(detailMatch[2]).toFixed(3);
    }
    pool.gameProcessLog.push(`  战斗判定: ${attackerDisplayName} (攻击方) 投掷 ${battleRoll} vs 成功阈值 ${battleThreshold}.`);
    if (outcome.attackerWins) {
        pool.gameProcessLog.push(`  结果: ${attackerDisplayName} 的投掷 (${battleRoll}) 小于阈值 (${battleThreshold})，攻击成功！ [${winnerDisplayName}] 占据上风!`);
    } else {
        pool.gameProcessLog.push(`  结果: ${attackerDisplayName} 的投掷 (${battleRoll}) 大于或等于阈值 (${battleThreshold})，攻击失败！ [${winnerDisplayName}] 占据上风!`);
    }
    // Original log: pool.gameProcessLog.push(`  冲突结果: [${winnerDisplayName}] 占据上风! (判定细节: ${outcome.detail})`); // This can be removed or adapted


    if (loser.status === 'active' || loser.status === 'wounded') { // If loser was not already defeated
        if (loser.status === 'wounded' && !combatResult.loserIgnoresWounded) { // Was already wounded and takes another hit (and no passive ignores this)
            loser.status = 'defeated';
            if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
            pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 已受重创，不敌对手，被迫退出探索！`);
            if (pluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
            else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);

        } else { // Was active, OR was wounded but a passive ignored the wound application from THIS combat
            // Request 1: Player loses, becomes wounded (if not already/ignored by passive), continues searching.
            if (!loser.isNpc) { // Player specific logic for losing an encounter
                if (!combatResult.loserIgnoresWounded) { // If passives don't prevent this specific wounding
                    loser.status = 'wounded'; // Player becomes wounded from this combat loss
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 在战斗中失利并负伤，但选择继续探索！`);
                } else {
                    // Player lost, but passive prevented the 'wounded' status from being applied from *this* combat
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 在战斗中失利，但凭借特殊能力避免了即时负伤，继续探索！`);
                }
                // Player does NOT get 'defeated' or 'escaped' from the game instance here just for losing one fight.
                // They continue to the next action/round if able. Spoils are not transferred unless 'defeated'.
            } else { // NPC loser logic (can be defeated or escape)
                let escUnharmedNPC = POST_COMBAT_ESCAPE_UNHARMED_CHANCE, escWoundedNPC = POST_COMBAT_ESCAPE_WOUNDED_CHANCE;
                if (loser.weapon?.passiveType === 'escape_boost_post_combat') {
                    const boost = loser.weapon.passiveValue || 0.15; // Default boost if not specified
                    escUnharmedNPC += boost;
                    escWoundedNPC += boost;
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 的装备 (${loser.weapon.name}) 触发特性 [${loser.weapon.passive || '紧急脱离'}]，尝试增加逃脱几率！`);
                }
                const escRoll = Math.random();

                if (escRoll < escUnharmedNPC) {
                    loser.status = 'escaped'; // NPC escapes unharmed from this combat
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 反应迅速，在混乱中成功撤退！未损失物资。`);
                    if (loser.npcDefinition?.dialogue?.onEscape) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onEscape}"`);
                } else if (escRoll < escUnharmedNPC + escWoundedNPC) {
                    if (!combatResult.loserIgnoresWounded) { // Check if passive prevents NPC from becoming wounded
                        loser.status = 'wounded'; // NPC becomes wounded
                        pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 冲突失利，受到创伤！但成功保留当前物资并暂时后撤。`);
                    } else {
                        pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 冲突失利，但其特性使其免于负伤，暂时后撤。`);
                    }
                } else {
                    loser.status = 'defeated'; // NPC is defeated
                    if (loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 未能成功脱离，被 [${winnerDisplayName}] 击倒！`);
                    if (pluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
                    else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);
                }
            }
        }
    }
}


async function performSearchAction(playerInGame, pool, allItems, allWeapons, publicItemsPool, gameLogArray, pluginInstance) {
    // ... (Search action logic - assumed correct)
    const itemsToObtainCount = Math.floor(Math.random() * 2) + 1; // Example: 1 to 2 items
    let foundItemsMsgParts = [];
    const mapInfo = pool.mapInfo;
    const playerDisplayName = getFormattedNickname(playerInGame);

    // Combine map-specific and public item pools for selection
    const candidatePool = [];

    // Add map-specific items
    if (mapInfo.itemPool) {
        for (const rarityKey in mapInfo.itemPool) {
            if (mapInfo.itemPool[rarityKey]) {
                mapInfo.itemPool[rarityKey].forEach(itemEntry => {
                    // itemEntry can be a string (item name) or an object {type: 'weapon', name: 'WeaponName'}
                    candidatePool.push({ identifier: itemEntry, rarity: rarityKey, source: 'map' });
                });
            }
        }
    }

    // Add public items (if any)
    if (publicItemsPool && publicItemsPool.length > 0) {
        publicItemsPool.forEach(publicItemDef => {
            // Ensure public items also have a rarity for consistent selection logic
            candidatePool.push({ identifier: publicItemDef.name, rarity: publicItemDef.rarity || "普通", source: 'public', fullDef: publicItemDef });
        });
    }
    if (candidatePool.length === 0) {
        gameLogArray.push(`  [${playerDisplayName}] 仔细搜寻，但此地似乎已被搜刮殆尽，未发现任何可用物资。`);
        return;
    }

    for (let i = 0; i < itemsToObtainCount; i++) {
        let chosenItemDef = null;
        let itemType = 'item'; // Default to 'item', can be 'weapon' or 'collectible'
        let selectedRaritySlot = "普通"; // Default rarity

        // Determine rarity based on map's refreshRate
        const rarityRoll = Math.random();
        let cumulativeProb = 0;
        const mapRefreshRarities = Object.keys(mapInfo.refreshRate || {});

        if (mapRefreshRarities.length === 0) { // Fallback if no refresh rates defined
            logger.warn(`[GameHandler] Map "${mapInfo.name}" has no refreshRate defined. Defaulting to '普通' rarity for search.`);
            // selectedRaritySlot remains "普通"
        } else {
            // Sort rarities by their probability to ensure consistent selection if roll is at boundary
            // Or, rely on the order in maps.json if that's intended. For now, direct iteration.
            for (const rarity of mapRefreshRarities) { // Iterate through defined rarities for the map
                cumulativeProb += (mapInfo.refreshRate[rarity] || 0);
                if (rarityRoll < cumulativeProb) {
                    selectedRaritySlot = rarity;
                    break;
                }
            }
            // If loop finishes and no rarity selected (e.g., sum of probs < 1 and roll is high),
            // it might default to the last one or need a fallback.
            // For simplicity, assume refreshRate sums to 1 or a dominant rarity catches remaining probability.
            // If selectedRaritySlot is still default "普通" and it's not in refreshRate, pick highest prob one.
            if (!mapInfo.refreshRate[selectedRaritySlot] && mapRefreshRarities.length > 0) {
                selectedRaritySlot = mapRefreshRarities.sort((a,b) => (mapInfo.refreshRate[b] || 0) - (mapInfo.refreshRate[a] || 0))[0] || mapRefreshRarities[0];
            }
        }


        // Filter candidate pool by selected rarity
        const itemsOfSelectedRarity = candidatePool.filter(c => c.rarity === selectedRaritySlot);

        if (itemsOfSelectedRarity.length > 0) {
            const chosenCandidate = itemsOfSelectedRarity[Math.floor(Math.random() * itemsOfSelectedRarity.length)];
            if (chosenCandidate.source === 'public') {
                chosenItemDef = chosenCandidate.fullDef;
            } else { // From map pool
                const mapItemId = chosenCandidate.identifier;
                if (typeof mapItemId === 'string') { // Assumed to be a regular item name
                    chosenItemDef = allItems.find(it => it.name === mapItemId && it.rarity === chosenCandidate.rarity);
                } else if (typeof mapItemId === 'object' && mapItemId.type === 'weapon') { // Weapon entry
                    chosenItemDef = allWeapons.find(w => w.name === mapItemId.name && w.rarity === chosenCandidate.rarity);
                }
            }
            if (chosenItemDef) {
                itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item'); // item.type could be 'collectible'
            }
        }

        // Fallback if no item of selected rarity found (e.g., misconfiguration)
        if (!chosenItemDef) {
            const fallbackCandidates = candidatePool.filter(c => c.rarity === "普通"); // Try common items
            if (fallbackCandidates.length > 0) {
                const chosenFallbackCandidate = fallbackCandidates[Math.floor(Math.random() * fallbackCandidates.length)];
                if (chosenFallbackCandidate.source === 'public') chosenItemDef = chosenFallbackCandidate.fullDef;
                else {
                    const mapItemId = chosenFallbackCandidate.identifier;
                    if (typeof mapItemId === 'string') chosenItemDef = allItems.find(it => it.name === mapItemId && it.rarity === "普通");
                    else if (typeof mapItemId === 'object' && mapItemId.type === 'weapon') chosenItemDef = allWeapons.find(w => w.name === mapItemId.name && w.rarity === "普通");
                }
                if (chosenItemDef) itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item');
            }
        }
        // Ultimate fallback if still no item
        if (!chosenItemDef) {
            chosenItemDef = allItems.find(it => it.name === DEFAULT_FALLBACK_ITEM_NAME) || (allItems.length > 0 ? allItems[0] : null);
            if (chosenItemDef) itemType = chosenItemDef.type || 'item';
            else { // Absolute last resort
                chosenItemDef = { name: "不明物质残渣", rarity: "未知", price: 0, type: 'item' };
                itemType = 'item';
            }
        }


        if (chosenItemDef) {
            if (itemType === 'weapon') {
                if (chosenItemDef.name === INITIAL_WEAPON_NAME) {
                    foundItemsMsgParts.push(`发现了多余的 ${INITIAL_WEAPON_NAME}(初始装备)，已忽略。`);
                } else if ((!playerInGame.isNpc && playerInGame.initialHeldWeapons.includes(chosenItemDef.name)) || playerInGame.foundWeaponsInGame.includes(chosenItemDef.name)) {
                    // Already has this weapon (either started with it or found it earlier in this game)
                    const val = chosenItemDef.price || 0;
                    playerInGame.temporaryFunds += val;
                    foundItemsMsgParts.push(`发现了重复装备: ${chosenItemDef.name}(${chosenItemDef.rarity})，转化为 ${val} 临时资金。`);
                } else {
                    playerInGame.foundWeaponsInGame.push(chosenItemDef.name);
                    foundItemsMsgParts.push(`[装备]: ${chosenItemDef.name}(${chosenItemDef.rarity})`);
                }
            } else { // Regular item or collectible
                // Ensure the item object added to currentItems has a 'type' field, defaulting if necessary
                const finalItemType = chosenItemDef.type || (chosenItemDef.rarity === '收藏品' ? 'collectible' : 'item');
                playerInGame.currentItems.push(JSON.parse(JSON.stringify({ ...chosenItemDef, type: finalItemType })));
                foundItemsMsgParts.push(`${chosenItemDef.name}(${chosenItemDef.rarity})`);
            }
        }
        // If chosenItemDef is somehow still null (should not happen with fallbacks), this loop iteration finds nothing.
    }

    if (foundItemsMsgParts.length > 0) {
        gameLogArray.push(`  [${playerDisplayName}] 在废墟中搜寻: ${foundItemsMsgParts.join('、 ')}。`);
    } else {
        gameLogArray.push(`  [${playerDisplayName}] 在废墟中仔细搜寻，但似乎一无所获。`);
    }
}

async function transferSpoils(winner, loser, pool, pluginInstance, allWeapons) {
    // ... (Spoils transfer logic - assumed correct)
    const winnerDisplayName = getFormattedNickname(winner);
    const loserDisplayName = getFormattedNickname(loser);

    if (!pluginInstance && ((!winner.isNpc && loser.status === 'defeated') || (!loser.isNpc && loser.status === 'defeated'))) {
        logger.error(`[GameHandler - transferSpoils] CRITICAL: pluginInstance is undefined. Spoils transfer for map ${pool.mapInfo.name}.`);
        pool.gameProcessLog.push(`  [系统错误] 战利品处理模块遭遇严重错误。`);
    }

    pool.gameProcessLog.push(`  [${winnerDisplayName}] 开始清点 [${loserDisplayName}] 的遗留物品!`);

    // Transfer items
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

    // Transfer weapons found in this game
    if (loser.foundWeaponsInGame.length > 0) {
        let lootedNewWpnMsgParts = [];
        let convertedToFundsMsgParts = [];
        for (const wpnName of loser.foundWeaponsInGame) {
            if (wpnName === INITIAL_WEAPON_NAME) continue; // Skip initial weapon

            const wpnDef = allWeapons.find(w => w.name === wpnName);
            if (!wpnDef) {
                logger.warn(`[GameHandler] transferSpoils: Weapon definition for "${wpnName}" not found.`);
                continue;
            }

            // Check if winner already has this weapon (either from start of game or found in this game)
            if ((!winner.isNpc && winner.initialHeldWeapons.includes(wpnName)) || winner.foundWeaponsInGame.includes(wpnName)) {
                const val = wpnDef.price || 0; // Use weapon's price as value
                winner.temporaryFunds += val;
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
    // NPC unique loot
    if (loser.isNpc && loser.npcDefinition?.uniqueLoot && loser.npcDefinition.uniqueLoot.length > 0) {
        pool.gameProcessLog.push(`  [${winnerDisplayName}] 搜刮了 [${loserDisplayName}] 的特殊遗物...`);
        loser.npcDefinition.uniqueLoot.forEach(lItem => {
            if (Math.random() < lItem.dropChance) {
                const lItemDef = lItem.type === 'weapon' ? allWeapons.find(w => w.name === lItem.name) : lItem; // For items, lItem itself is the def
                if (!lItemDef) {
                    logger.warn(`[GameHandler] NPC ${getFormattedNickname(loser)} unique loot ${lItem.name} definition not found.`);
                    return;
                }
                pool.gameProcessLog.push(`    获得了特殊物品: ${lItemDef.name}(${lItemDef.rarity || lItem.rarity})!`);

                if (lItem.type === 'weapon') {
                    if ((!winner.isNpc && winner.initialHeldWeapons.includes(lItemDef.name)) || winner.foundWeaponsInGame.includes(lItemDef.name)) {
                        const val = lItemDef.price || 50; // Default value if price missing
                        winner.temporaryFunds += val;
                        pool.gameProcessLog.push(`    (重复装备 ${lItemDef.name} 转化为 ${val} 临时资金)`);
                    } else {
                        winner.foundWeaponsInGame.push(lItemDef.name);
                    }
                } else { // Item or collectible
                    winner.currentItems.push(JSON.parse(JSON.stringify({ name: lItemDef.name, rarity: lItemDef.rarity, price: lItemDef.price || 0, type: lItem.type })));
                }
            }
        });
    }


    // PvP: Transfer loser's equipped weapon (permanent loss/gain)
    if (!winner.isNpc && !loser.isNpc && pluginInstance) { // Both are players
        const { playerData: loserStore } = await pluginInstance.getPlayer(loser.userId);
        const { playerData: winnerStore } = await pluginInstance.getPlayer(winner.userId);

        if (!loserStore || !winnerStore) {
            logger.error(`[GameHandler] transferSpoils (PvP): Failed to get player data for ${loser.userId} or ${winner.userId}.`);
            pool.gameProcessLog.push(`  [系统错误] 处理玩家间装备转移时档案同步失败。`);
            return;
        }

        const lostWpnName = loser.weapon.name; // The weapon the loser was using in this game
        const lostWpnDef = allWeapons.find(w => w.name === lostWpnName);

        if (lostWpnName !== INITIAL_WEAPON_NAME) { // Cannot lose initial weapon
            const wpnIdxLoserStore = loserStore.heldWeapons.indexOf(lostWpnName);
            if (wpnIdxLoserStore > -1) { // If the loser actually owns it in their permanent storage
                loserStore.heldWeapons.splice(wpnIdxLoserStore, 1); // Remove from loser's permanent storage
                pool.gameProcessLog.push(`  [${loserDisplayName}] 永久失去了装备 "${lostWpnName}"！`);

                if (winnerStore.heldWeapons.includes(lostWpnName)) { // If winner already owns it
                    const val = lostWpnDef?.price || 0;
                    winner.temporaryFunds += val; // Winner gets cash value instead (added to temporary for this game)
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 已拥有同型号装备 "${lostWpnName}"，转化为 ${val} 临时资金。`);
                } else {
                    winnerStore.heldWeapons.push(lostWpnName); // Add to winner's permanent storage
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 永久获得了装备 "${lostWpnName}"！(已存入装备库)`);
                }
                await savePlayerData(loser.userId, loserStore);
                await savePlayerData(winner.userId, winnerStore);
            } else {
                // This case should ideally not happen if playerInGame.weapon is correctly sourced from playerData.heldWeapons
                logger.warn(`[GameHandler] transferSpoils (PvP): Loser ${loserDisplayName} using ${lostWpnName} which was not found in their permanent storage. No permanent transfer occurs.`);
                pool.gameProcessLog.push(`  [警示] ${loserDisplayName} 使用的装备 ${lostWpnName} 未在其永久档案中找到，无法进行常规转移。`);
            }
        }
    }
}


export async function processGameInstance(mapName, pluginInstanceFromApp) {
    const pool = gamePools[mapName];
    const pluginInstance = pluginInstanceFromApp || getPluginInstance();

    if (!pool || pool.status !== 'waiting') { /* ... */ return; }
    if (!pluginInstance && pool.players.some(p => !p.isNpc)) { /* ... */ return; }

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
        let activeParticipantsThisRound = pool.players.filter(p => (p.status === 'active' || p.status === 'wounded') && p.actionsTaken < 3); // Wounded players can still act
        if (activeParticipantsThisRound.length === 0) {
            pool.gameProcessLog.push("所有参与者已行动完毕或失去行动能力。");
            break;
        }
        activeParticipantsThisRound.sort(() => Math.random() - 0.5); // Randomize action order

        for (const participant of activeParticipantsThisRound) {
            if (participant.status === 'defeated' || participant.status === 'escaped' || participant.actionsTaken >= 3) continue;

            const participantDisplayName = getFormattedNickname(participant);

            if (participant.isNpc) {
                pool.gameProcessLog.push(`\n[${participantDisplayName}] (状态: ${participant.status}) 开始行动...`);
                if (participant.hostility === 'hostile' && participant.strategy === '猛攻') {
                    const potentialTargets = pool.players.filter(p => !p.isNpc && (p.status === 'active' || p.status === 'wounded')); // Target active/wounded players
                    if (potentialTargets.length > 0) {
                        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 锁定了目标 [${getFormattedNickname(target)}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        await performCombat(participant, target, pool, allWeapons, pluginInstance);
                    } else {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未发现可攻击的玩家目标，转为搜寻。`);
                        await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                    }
                } else { // Neutral/Friendly NPC or non-aggressive strategy
                    await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                }
            } else { // Player's turn
                const playerInGame = participant;
                const actionRoll = Math.random();
                const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
                let actionType = (actionRoll < playerStrategyProb.fight) ? '遭遇' : '搜寻';

                pool.gameProcessLog.push(`\n[${participantDisplayName}] (策略: ${playerInGame.strategy}, 状态: ${playerInGame.status}) 准备 ${actionType}...`);

                if (actionType === '搜寻') {
                    await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, pluginInstance);
                } else { // Encounter
                    const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && (p.status === 'active' || p.status === 'wounded')); // Can encounter other active/wounded
                    if (potentialTargets.length === 0) {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未侦测到其他活动目标。`);
                        if (playerInGame.strategy === '猛攻') { // Aggressive players search if no targets
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
            // Status might have changed in combat/search, re-check before next participant
            if (participant.status === 'defeated' || participant.status === 'escaped') continue;
        }
        // Check if all remaining participants have finished their actions or are out
        if (pool.players.every(p => p.status === 'defeated' || p.status === 'escaped' || p.actionsTaken >=3)) {
            pool.gameProcessLog.push("所有参与者行动结束。");
            break;
        }
    }
    pool.gameProcessLog.push(`\n--- 区域探索阶段结束 ---`);
    pool.settlementLog.push(`\n--- [区域: ${mapName}] 探索报告 ---`);

    // Settlement
    for (const p of pool.players) {
        const displayName = getFormattedNickname(p);
        if (p.isNpc) {
            // ... (NPC settlement log - assumed correct) ...
            let npcSummary = `\nNPC: ${displayName}\n  最终状态: `;
            if (p.status === 'defeated') npcSummary += "已被击败";
            else if (p.status === 'escaped') npcSummary += "已脱离";
            else if (p.status === 'active' || p.status === 'wounded') npcSummary += "行动结束，仍活跃"; // Wounded NPCs also "still active"
            else npcSummary += p.status; // Should not happen if logic is correct

            if (p.currentItems.length > 0 || p.foundWeaponsInGame.length > 0) {
                npcSummary += `\n  持有物品: ${[...p.currentItems.map(i => i.name), ...p.foundWeaponsInGame.map(w=>w)].join('、 ') || '无'}`;
            }
            pool.settlementLog.push(npcSummary);
            continue;
        }

        // Player settlement
        let playerSummary = `\n调查员: ${displayName} (编号: ...${String(p.userId).slice(-4)})\n  最终状态: `;
        let playerStorageData = null;
        if (pluginInstance) {
            const { playerData: fetchedData } = await pluginInstance.getPlayer(p.userId);
            playerStorageData = fetchedData;
        }

        if (!playerStorageData && pluginInstance) {
            logger.error(`[GameHandler] 结算阶段: 调查员 ${displayName} (${p.userId}) 档案同步失败。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：无法同步您的个人档案。");
            // continue; // Skip settlement for this player if data fetch failed
        }


        if (p.status === 'defeated') {
            playerSummary += "任务中断，信号消失";
            if (playerStorageData) { // Request 5: Set heavy injury on defeat
                playerStorageData.permanentInjuryStatus = 'heavy';
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: 重伤，需紧急治疗！`;
            }
        } else if (p.status === 'escaped') { // This status should ideally not be set for players if they are to continue exploring
            playerSummary += "成功脱离区域"; // Or "提前撤离"
            if (playerStorageData && p.status === 'wounded') { // If they were wounded when they "escaped"
                playerStorageData.permanentInjuryStatus = ['light', 'medium', 'heavy'][Math.floor(Math.random() * 3)];
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: ${INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus}，建议治疗。`;
            }
        } else if (p.status === 'wounded') {
            playerSummary += "受创撤离";
            if (playerStorageData) { // Request 5: Set random injury if ended wounded
                const injuryTypes = ['light', 'medium', 'heavy'];
                playerStorageData.permanentInjuryStatus = injuryTypes[Math.floor(Math.random() * injuryTypes.length)];
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: ${INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus}，建议治疗。`;
            }
        } else { // 'active'
            playerSummary += "任务完成，安全返回";
            // No new injury if active and not previously wounded that carried over
        }


        let totalValueGainedFromItems = 0;
        let collectiblesGainedThisGame = [];
        let newWeaponsAddedToStorageNames = [];
        let itemsGainedThisGameStrings = [];

        playerSummary += "\n  本次探索收获:";
        const noGains = p.currentItems.length === 0 && p.foundWeaponsInGame.length === 0 && p.temporaryFunds === 0;
        if (noGains && p.status !== 'defeated') playerSummary += " 无实质收获";

        p.currentItems.forEach(item => {
            // item.type should be 'collectible' for collectibles
            if (item.type === 'collectible') { // Check item.type
                if (playerStorageData) {
                    if (!playerStorageData.collectibles.find(c => c.name === item.name)) {
                        playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price, type: 'collectible' }); // Store with type
                        collectiblesGainedThisGame.push(`${item.name}(${item.rarity})`);
                    } else { // Request 3: Duplicate collectible
                        const sellPrice = Math.floor((item.price || 0) * 0.7); // Example: 70% of value
                        playerStorageData.funds += sellPrice;
                        playerSummary += `\n    - 重复收藏品 ${item.name}(${item.rarity}) 自动折算为 ${sellPrice} 资金。`;
                    }
                } else { // No playerStorageData, just log as temp gain
                    collectiblesGainedThisGame.push(`${item.name}(${item.rarity}) (未同步)`);
                }
            } else { // Non-collectible items are auto-sold
                itemsGainedThisGameStrings.push(`${item.name}(${item.rarity}, 价值 ${item.price || 0}资金)`);
                totalValueGainedFromItems += (item.price || 0);
            }
        });

        p.foundWeaponsInGame.forEach(weaponName => {
            if (weaponName === INITIAL_WEAPON_NAME) return;
            if (playerStorageData && !playerStorageData.heldWeapons.includes(weaponName)) {
                playerStorageData.heldWeapons.push(weaponName);
            }
            // Always add to newWeaponsAddedToStorageNames for logging, even if no playerStorageData (implies temporary gain)
            if (!newWeaponsAddedToStorageNames.includes(weaponName)) { // Avoid duplicate logging if somehow found twice
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

        // Warning for existing injury if not treated
        if (playerStorageData && playerStorageData.needsTreatment && playerStorageData.permanentInjuryStatus !== 'none') {
            const injuryName = INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus;
            playerSummary += `\n  健康状况: 【${injuryName}】 - 别忘了治疗！`;
        }


        pool.settlementLog.push(playerSummary);
        if (playerStorageData && pluginInstance) await savePlayerData(p.userId, playerStorageData);
    }

    // Send logs
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
    delete gamePools[mapName]; // Clean up game pool
    logger.info(`[GameHandler] 探索任务于区域 "${mapName}" 已结束并清理。`);
}
