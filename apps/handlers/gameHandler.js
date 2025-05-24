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
    INJURY_LEVELS,
    VALID_STRATEGIES
} from '../../utils/constants.js';


const gamePools = {};
const playerQueueStatus = {};
const QUEUE_CHECK_INTERVAL = 60 * 1000;
const DEFAULT_NPC_FILL_DELAY_MINUTES = 5;
const PLUGIN_NAME = '都市迷踪（搜打撤）';

let queueCheckIntervalId = null;
let pluginAppInstance = null; // 用于存储插件主实例

// 辅助函数：获取玩家或NPC的显示名称（包含称号）
function getFormattedNickname(playerInGame) {
    if (!playerInGame) return "未知参与者";
    if (playerInGame.isNpc) {
        return playerInGame.nickname; // NPC昵称已包含称号
    }
    // 真实玩家
    if (playerInGame.activeTitle && playerInGame.activeTitle.trim() !== "") {
        return `【${playerInGame.activeTitle}】${playerInGame.nickname}`;
    }
    return playerInGame.nickname;
}

// 辅助函数：获取插件实例 (作为后备)
function getPluginInstanceFallback() {
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
    if (!pInstance) {
        logger.warn('[GameHandler] getPluginInstanceFallback: 未能从 global.Bot.plugins 找到插件实例。');
    }
    return pInstance;
}

/**
 * 初始化游戏处理器的定时任务。
 * @param {object} instance - 插件主类的实例。
 */
export function initializeGameHandlerTimedTasks(instance) {
    pluginAppInstance = instance; // 存储插件实例
    if (!pluginAppInstance) {
        logger.error('[GameHandler] initializeGameHandlerTimedTasks: 传入的插件实例无效！定时任务可能无法正常工作。');
    }

    if (queueCheckIntervalId) {
        clearInterval(queueCheckIntervalId);
        logger.info('[GameHandler] 已清除现有的队列检查定时器。');
    }
    queueCheckIntervalId = setInterval(() => {
        // 现在 checkAndFillQueuesWithNpcs 会优先使用 pluginAppInstance
        checkAndFillQueuesWithNpcs();
    }, QUEUE_CHECK_INTERVAL);
    logger.info(`[GameHandler] NPC队列检查定时任务已初始化。间隔: ${QUEUE_CHECK_INTERVAL / 1000}秒。`);
}

export function stopGameHandlerTimedTasks() {
    if (queueCheckIntervalId) {
        clearInterval(queueCheckIntervalId);
        queueCheckIntervalId = null;
        logger.info('[GameHandler] 已停止队列检查定时器。');
    }
}

async function checkAndFillQueuesWithNpcs() {
    const currentTime = Date.now();
    const allNpcDefs = getNpcs();
    const allWeaponDefs = getWeapons();
    // 优先使用存储的实例，其次尝试回退获取方法
    const currentPluginInstance = pluginAppInstance || getPluginInstanceFallback();

    if (!currentPluginInstance && Object.values(gamePools).some(pool => pool.status === 'waiting' && pool.players.some(p => !p.isNpc))) {
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
                        if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition && p.npcDefinition.id === npcDef.id)) {
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
                    // 确保在调用 processGameInstance 时传递 currentPluginInstance
                    if (currentPluginInstance || pool.players.every(p => p.isNpc)) {
                        if (spawnedNpcCount > 0 && tempPlayerForNotification && tempPlayerForNotification.groupId && global.Bot && global.Bot.pickGroup) {
                            const groupToNotify = global.Bot.pickGroup(tempPlayerForNotification.groupId);
                            if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                                let immediateMsg = `[${mapName}] 探索队伍已满员！`;
                                if (timeoutSpawnedNpcNames.length > 0) {
                                    immediateMsg += ` 由 ${timeoutSpawnedNpcNames.join('、 ')} 等自动填充。即将开始探索...`;
                                } else {
                                    immediateMsg += ` 即将开始探索...`;
                                }
                                await groupToNotify.sendMsg(immediateMsg).catch(err => logger.error(`[GameHandler] 发送NPC超时填充消息错误: ${err}`));
                            }
                        }
                        await processGameInstance(mapName, currentPluginInstance); // 传递获取到的实例
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
        justSpawnedRandomly: spawnedByRandomEvent
    };
}

export async function handleEnterMap(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const groupId = e.group_id;
    const rawNickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    // 优先使用传入的实例
    const currentPluginInstance = pluginInstanceFromApp || pluginAppInstance || getPluginInstanceFallback();


    if (!currentPluginInstance) {
        logger.error(`[GameHandler - handleEnterMap] 关键错误: 无法找到插件实例。玩家 ${userId} 进入地图请求失败。`);
        return e.reply("系统核心组件通讯失败，无法处理您的请求，请联系管理员。");
    }
    if (playerQueueStatus[userId]) {
        return e.reply(`您已在地图 "${playerQueueStatus[userId]}" 的待命队列中。请先使用 #退出队列。`);
    }

    const match = e.msg.match(/^#进入地图\s*([^\s]+|\d+)(?:\s*武器\s*([^\s]+)\s*策略\s*([^\s]+))?$/);
    if (!match) return false;

    const mapIdentifier = match[1];
    let weaponNameInput = match[2];
    let strategyInput = match[3];

    // 使用 currentPluginInstance 调用 getPlayer
    const { playerData } = await currentPluginInstance.getPlayer(userId, rawNickname);
    if (!playerData) return e.reply("抱歉，您的身份识别出现错误，无法同步档案。");

    if (playerData.autoHealEnabled && playerData.needsTreatment && playerData.permanentInjuryStatus !== 'none') {
        const injuryKey = playerData.permanentInjuryStatus;
        const injuryInfo = INJURY_LEVELS[injuryKey];

        if (injuryInfo && injuryInfo.cost > 0) {
            if (playerData.funds >= injuryInfo.cost) {
                playerData.funds -= injuryInfo.cost;
                playerData.permanentInjuryStatus = 'none';
                playerData.needsTreatment = false;
                await savePlayerData(userId, playerData);
                e.reply(`[自动治疗] 已花费 ${injuryInfo.cost} 资金治疗【${injuryInfo.name}】，您已恢复健康！`);
            } else {
                e.reply(`[自动治疗] 资金不足 (需${injuryInfo.cost})，无法自动治疗【${injuryInfo.name}】。请先补充资金或手动治疗。探索行动已取消。`);
                return true;
            }
        } else if (injuryInfo && injuryInfo.cost === 0 && injuryKey !== 'none') {
            playerData.permanentInjuryStatus = 'none';
            playerData.needsTreatment = false;
            await savePlayerData(userId, playerData);
            e.reply(`[自动治疗] 您的状态【${injuryInfo.name}】无需花费资金，已自动调整为健康。`);
        }
    }

    let finalWeaponName = weaponNameInput;
    let finalStrategy = strategyInput;
    let usedDefaultWeapon = false;
    let usedDefaultStrategy = false;

    if (!finalWeaponName) {
        if (playerData.defaultWeapon && playerData.defaultWeapon !== "") {
            finalWeaponName = playerData.defaultWeapon;
            usedDefaultWeapon = true;
        } else {
            return e.reply("您尚未在指令中提供武器，也未设置默认武器。请使用 #装备 【武器名】 设置默认武器，或在指令中指定。");
        }
    }

    if (!finalStrategy) {
        if (playerData.defaultStrategy && playerData.defaultStrategy !== "") {
            finalStrategy = playerData.defaultStrategy;
            usedDefaultStrategy = true;
        } else {
            return e.reply("您尚未在指令中提供策略，也未设置默认策略。请使用 #策略 【策略名】 设置默认策略，或在指令中指定。");
        }
    }

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

    if (playerData.needsTreatment && playerData.permanentInjuryStatus && playerData.permanentInjuryStatus !== 'none') {
        const injuryName = INJURY_LEVELS[playerData.permanentInjuryStatus]?.name || playerData.permanentInjuryStatus;
        if (!playerData.autoHealEnabled || (playerData.autoHealEnabled && INJURY_LEVELS[playerData.permanentInjuryStatus]?.cost > playerData.funds)) {
            e.reply(`[警告] 您当前状态为【${injuryName}】，行动可能会受到影响。自动治疗未开启或资金不足。`);
        }
    }

    const playerDisplayNameForJoin = playerData.activeTitle ? `【${playerData.activeTitle}】${playerData.nickname}` : playerData.nickname;

    if (playerData.funds < selectedMap.entryFee) {
        return e.reply(`“信息费”不足！进入 "${mapName}" 需要 ${selectedMap.entryFee} “资金”，您目前持有 ${playerData.funds}。`);
    }

    const allPlayerWeapons = getWeapons();
    const selectedWeaponDef = allPlayerWeapons.find(w => w.name === finalWeaponName);
    if (!selectedWeaponDef) return e.reply(`未知的装备型号: "${finalWeaponName}"。${usedDefaultWeapon ? '(来自您的默认设置)' : ''} 请使用 #武器列表 查看可用装备。`);
    if (!playerData.heldWeapons || !playerData.heldWeapons.includes(finalWeaponName)) return e.reply(`您未持有装备 "${finalWeaponName}"。${usedDefaultWeapon ? '(默认武器)' : ''} 请检查 #我的信息。`);
    if (selectedWeaponDef.baseCombatPower < selectedMap.limitCombatPower) {
        return e.reply(`您的装备 "${finalWeaponName}" (威胁评估 ${selectedWeaponDef.baseCombatPower}) 未达到区域 "${mapName}" 的最低安全等级 (${selectedMap.limitCombatPower})。`);
    }
    if (!VALID_STRATEGIES.includes(finalStrategy)) {
        return e.reply(`未知的策略: "${finalStrategy}". ${usedDefaultStrategy ? '(来自您的默认设置)' : ''} 可选策略: ${VALID_STRATEGIES.join(', ')}.`);
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

    let initialStatusInGame = 'active';
    if (playerData.needsTreatment && playerData.permanentInjuryStatus && playerData.permanentInjuryStatus !== 'none') {
        initialStatusInGame = 'wounded';
    }

    const playerInGame = {
        userId: userId,
        nickname: playerData.nickname,
        activeTitle: playerData.activeTitle,
        isNpc: false,
        weapon: JSON.parse(JSON.stringify(selectedWeaponDef)),
        strategy: finalStrategy,
        currentItems: [],
        foundWeaponsInGame: [],
        temporaryFunds: 0,
        status: initialStatusInGame,
        actionsTaken: 0,
        groupId: groupId,
        initialHeldWeapons: [...playerData.heldWeapons]
    };
    pool.players.push(playerInGame);
    pool.playerGroupIds[userId] = groupId;
    playerQueueStatus[userId] = mapName;

    let joinMessage = `${getFormattedNickname(playerInGame)} 已装备 "${finalWeaponName}"`;
    if (usedDefaultWeapon) joinMessage += " (默认)";
    joinMessage += ` (策略: ${finalStrategy}`;
    if (usedDefaultStrategy) joinMessage += " (默认)";
    joinMessage += `) 进入 "${mapName}" 待命队列`;

    const totalInQueue = pool.players.length;
    const realPlayersInQueue = pool.players.filter(p => !p.isNpc).length;
    const npcsInQueueCount = totalInQueue - realPlayersInQueue;
    let queueCountMessage = `${totalInQueue}/${selectedMap.playerCapacity}`;
    if (npcsInQueueCount > 0) {
        queueCountMessage += ` (真人 ${realPlayersInQueue}, NPC ${npcsInQueueCount})`;
    } else {
        queueCountMessage += ` (真人 ${realPlayersInQueue})`;
    }
    e.reply(`${joinMessage} (${queueCountMessage}).`);

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
                if (npcDef && !pool.players.find(p => p.isNpc && p.npcDefinition && p.npcDefinition.id === npcDef.id)) {
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
                    await e.reply(immediateSpawnNotification).catch(err => logger.error(`[GameHandler] 发送NPC立即生成消息错误: ${err}`));
                }
            }
        }
    }

    if (pool.players.length === selectedMap.playerCapacity) {
        pool.players.forEach(p => { if (p.isNpc) p.justSpawnedRandomly = false; });
        await processGameInstance(mapName, currentPluginInstance); // 传递获取到的实例
    }
    return true;
}

export async function handleLeaveQueue(e, pluginInstanceFromApp) {
    const userId = e.user_id;
    const currentPluginInstance = pluginInstanceFromApp || pluginAppInstance || getPluginInstanceFallback();

    if (!currentPluginInstance) {
        logger.error(`[GameHandler - handleLeaveQueue] 关键错误: 无法找到插件实例。玩家 ${userId} 退出队列请求失败。`);
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

    const { playerData } = await currentPluginInstance.getPlayer(userId); // 使用 currentPluginInstance
    const playerInGame = pool.players[playerIndex];

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
        logger.info(`[GameHandler] 地图 "${mapName}" 的队列中已无真实玩家，计时器重置。`);
    }
    return true;
}

export async function handleViewQueues(e, pluginInstanceFromApp) {
    // This function is informational and doesn't strictly need the plugin instance for its core logic
    // unless it were to fetch player names/details dynamically, which it currently doesn't for queue view.
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

async function performCombat(attacker, defender, pool, allWeapons, pluginInstanceFromCaller) {
    const attackerDisplayName = getFormattedNickname(attacker);
    const defenderDisplayName = getFormattedNickname(defender);
    const currentPluginInstance = pluginInstanceFromCaller || pluginAppInstance || getPluginInstanceFallback();


    if (!currentPluginInstance && ((!attacker.isNpc && attacker.status !== 'defeated') || (!defender.isNpc && defender.status !== 'defeated'))) {
        logger.error(`[GameHandler - performCombat] 关键错误: pluginInstance 未定义。地图 ${pool.mapInfo.name} 中的玩家战斗数据可能无法正确保存。`);
        pool.gameProcessLog.push(`  [系统错误] 战斗模块遭遇严重错误，玩家数据可能无法正确处理。`);
    }

    if (attacker.isNpc && attacker.npcDefinition?.dialogue) {
        const dialogueKey = attacker.npcDefinition.dialogue.onEngage || attacker.npcDefinition.dialogue.onEncounter;
        if (dialogueKey) pool.gameProcessLog.push(`  🗣️ [${attackerDisplayName}]: "${dialogueKey}"`);
    }
    if (defender.isNpc && defender.npcDefinition?.dialogue && defender.userId !== attacker.userId) {
        const dialogueKey = defender.npcDefinition.dialogue.onEngage || defender.npcDefinition.dialogue.onEncounter;
        if (dialogueKey) pool.gameProcessLog.push(`  🗣️ [${defenderDisplayName}]: "${dialogueKey}"`);
    }

    if (defender.isNpc && defender.combatPassive?.type === 'master_escape' && defender.status === 'active') {
        const npcWeaponPower = defender.weapon?.baseCombatPower || defender.npcDefinition?.baseCombatPower || 0;
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
    combatResult.log.forEach(log => pool.gameProcessLog.push(`  ${log}`));

    const outcome = determineBattleOutcome(combatResult.attackerFinalPower, combatResult.defenderFinalPower, combatResult.successRateModifier, combatResult);

    let winner = outcome.attackerWins ? attacker : defender;
    let loser = outcome.attackerWins ? defender : attacker;
    const winnerDisplayName = getFormattedNickname(winner);
    const loserDisplayNameForLog = getFormattedNickname(loser);

    const powerDifferenceVal = combatResult.attackerFinalPower - combatResult.defenderFinalPower;
    const powerDiffEffectPct = Math.round((outcome.baseSuccessRate - 0.5) * 100);
    const envModifierPct = Math.round(combatResult.successRateModifier * 100);
    const finalSuccessRatePct = Math.round(outcome.finalSuccessRate * 100);
    const rollPct = Math.round(outcome.roll * 100);
    const thresholdDisplayPct = finalSuccessRatePct;

    let summaryMessage = `  因为战力差 ${powerDifferenceVal} (攻${combatResult.attackerFinalPower} vs 防${combatResult.defenderFinalPower})`;
    summaryMessage += `，成功率${powerDiffEffectPct >= 0 ? '+' : ''}${powerDiffEffectPct}%`;

    if (envModifierPct !== 0) {
        summaryMessage += `，经过随机环境计算，成功率${envModifierPct > 0 ? '+' : ''}${envModifierPct}%`;
    }

    summaryMessage += `，最终成功率为 ${finalSuccessRatePct}%。`;
    summaryMessage += ` 【${attackerDisplayName}】投掷结果为 ${rollPct}，`;
    summaryMessage += outcome.attackerWins ? `小于 ${thresholdDisplayPct}` : `大于或等于 ${thresholdDisplayPct}`;
    summaryMessage += `，结算判定: ${outcome.attackerWins ? '攻击成功' : '攻击失败'}！`;
    summaryMessage += ` [${winnerDisplayName}] 占据上风!`;
    pool.gameProcessLog.push(summaryMessage);

    if (loser.status === 'active' || loser.status === 'wounded') {
        if (loser.status === 'wounded' && !combatResult.loserIgnoresWounded) {
            loser.status = 'defeated';
            if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
            pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 已受重创，不敌对手，被迫退出探索！`);
            if (currentPluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, currentPluginInstance, allWeapons); // Pass instance
            else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);

        } else {
            if (!loser.isNpc) {
                if (!combatResult.loserIgnoresWounded) {
                    loser.status = 'wounded';
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 在战斗中失利并负伤，但选择继续探索！`);
                } else {
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 在战斗中失利，但凭借特殊能力避免了即时负伤，继续探索！`);
                }
            } else {
                let escUnharmedNPC = POST_COMBAT_ESCAPE_UNHARMED_CHANCE;
                let escWoundedNPC = POST_COMBAT_ESCAPE_WOUNDED_CHANCE;
                if (loser.weapon?.passiveType === 'escape_boost_post_combat') {
                    const boost = loser.weapon.passiveValue || 0.15;
                    escUnharmedNPC += boost;
                    escWoundedNPC += boost;
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 的装备 (${loser.weapon.name}) 触发特性 [${loser.weapon.passive || '紧急脱离'}]，尝试增加逃脱几率！`);
                }
                const escRoll = Math.random();

                if (escRoll < escUnharmedNPC) {
                    loser.status = 'escaped';
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 反应迅速，在混乱中成功撤退！未损失物资。`);
                    if (loser.isNpc && loser.npcDefinition?.dialogue?.onEscape) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onEscape}"`);
                } else if (escRoll < escUnharmedNPC + escWoundedNPC) {
                    if (!combatResult.loserIgnoresWounded) {
                        loser.status = 'wounded';
                        pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 冲突失利，受到创伤！但成功保留当前物资并暂时后撤。`);
                    } else {
                        pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 冲突失利，但其特性使其免于负伤，暂时后撤。`);
                    }
                } else {
                    loser.status = 'defeated';
                    if (loser.isNpc && loser.npcDefinition?.dialogue?.onDefeat) pool.gameProcessLog.push(`  🗣️ [${loserDisplayNameForLog}]: "${loser.npcDefinition.dialogue.onDefeat}"`);
                    pool.gameProcessLog.push(`  [${loserDisplayNameForLog}] 未能成功脱离，被 [${winnerDisplayName}] 击倒！`);
                    if (currentPluginInstance || winner.isNpc) await transferSpoils(winner, loser, pool, currentPluginInstance, allWeapons); // Pass instance
                    else pool.gameProcessLog.push(`  [系统警告] 由于核心组件错误，无法处理战利品转移。`);
                }
            }
        }
    }
}

async function performSearchAction(playerInGame, pool, allItems, allWeapons, publicItemsPool, gameLogArray, pluginInstanceFromCaller) {
    // This function primarily modifies playerInGame object and gameLogArray,
    // pluginInstance is not strictly needed here unless future logic requires it (e.g., complex item interactions)
    const itemsToObtainCount = Math.floor(Math.random() * 2) + 1;
    let foundItemsMsgParts = [];
    const mapInfo = pool.mapInfo;
    const playerDisplayName = getFormattedNickname(playerInGame);
    const candidatePool = [];

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
        let chosenItemDef = null;
        let itemType = 'item';
        let selectedRaritySlot = "普通";

        const rarityRoll = Math.random();
        let cumulativeProb = 0;
        const mapRefreshRarities = Object.keys(mapInfo.refreshRate || {});

        if (mapRefreshRarities.length === 0) {
            logger.warn(`[GameHandler] 地图 "${mapInfo.name}" 未定义refreshRate。默认为'普通'稀有度。`);
        } else {
            for (const rarity of mapRefreshRarities) {
                cumulativeProb += (mapInfo.refreshRate[rarity] || 0);
                if (rarityRoll < cumulativeProb) {
                    selectedRaritySlot = rarity;
                    break;
                }
            }
            if (!mapInfo.refreshRate[selectedRaritySlot] && mapRefreshRarities.length > 0) {
                selectedRaritySlot = mapRefreshRarities.sort((a,b) => (mapInfo.refreshRate[b] || 0) - (mapInfo.refreshRate[a] || 0))[0] || mapRefreshRarities[0];
            }
        }

        const itemsOfSelectedRarity = candidatePool.filter(c => c.rarity === selectedRaritySlot);
        if (itemsOfSelectedRarity.length > 0) {
            const chosenCandidate = itemsOfSelectedRarity[Math.floor(Math.random() * itemsOfSelectedRarity.length)];
            if (chosenCandidate.source === 'public') {
                chosenItemDef = chosenCandidate.fullDef;
            } else {
                const mapItemId = chosenCandidate.identifier;
                if (typeof mapItemId === 'string') {
                    chosenItemDef = allItems.find(it => it.name === mapItemId && it.rarity === chosenCandidate.rarity);
                } else if (typeof mapItemId === 'object' && mapItemId.type === 'weapon') {
                    chosenItemDef = allWeapons.find(w => w.name === mapItemId.name && w.rarity === chosenCandidate.rarity);
                }
            }
            if (chosenItemDef) {
                itemType = chosenItemDef.type === 'weapon' ? 'weapon' : (chosenItemDef.type || 'item');
            }
        }

        if (!chosenItemDef) {
            const fallbackCandidates = candidatePool.filter(c => c.rarity === "普通");
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
        if (!chosenItemDef) {
            chosenItemDef = allItems.find(it => it.name === DEFAULT_FALLBACK_ITEM_NAME) || (allItems.length > 0 ? allItems[0] : null);
            if (chosenItemDef) itemType = chosenItemDef.type || 'item';
            else {
                chosenItemDef = { name: "不明物质残渣", rarity: "未知", price: 0, type: 'item' };
                itemType = 'item';
            }
        }

        if (chosenItemDef) {
            if (itemType === 'weapon') {
                if (chosenItemDef.name === INITIAL_WEAPON_NAME) {
                    foundItemsMsgParts.push(`发现了多余的 ${INITIAL_WEAPON_NAME}(初始装备)，已忽略。`);
                } else if ((!playerInGame.isNpc && playerInGame.initialHeldWeapons.includes(chosenItemDef.name)) || playerInGame.foundWeaponsInGame.includes(chosenItemDef.name)) {
                    const val = chosenItemDef.price || 0;
                    playerInGame.temporaryFunds += val;
                    foundItemsMsgParts.push(`发现了重复装备: ${chosenItemDef.name}(${chosenItemDef.rarity})，转化为 ${val} 临时资金。`);
                } else {
                    playerInGame.foundWeaponsInGame.push(chosenItemDef.name);
                    foundItemsMsgParts.push(`[装备]: ${chosenItemDef.name}(${chosenItemDef.rarity})`);
                }
            } else {
                const finalItemType = chosenItemDef.type || (chosenItemDef.rarity === '收藏品' ? 'collectible' : 'item');
                playerInGame.currentItems.push(JSON.parse(JSON.stringify({ ...chosenItemDef, type: finalItemType })));
                foundItemsMsgParts.push(`${chosenItemDef.name}(${chosenItemDef.rarity})`);
            }
        }
    }

    if (foundItemsMsgParts.length > 0) {
        gameLogArray.push(`  [${playerDisplayName}] 在废墟中搜寻: ${foundItemsMsgParts.join('、 ')}。`);
    } else {
        gameLogArray.push(`  [${playerDisplayName}] 在废墟中仔细搜寻，但似乎一无所获。`);
    }
}

async function transferSpoils(winner, loser, pool, pluginInstanceFromCaller, allWeapons) {
    const winnerDisplayName = getFormattedNickname(winner);
    const loserDisplayName = getFormattedNickname(loser);
    const currentPluginInstance = pluginInstanceFromCaller || pluginAppInstance || getPluginInstanceFallback();

    if (!currentPluginInstance && ((!winner.isNpc && loser.status === 'defeated') || (!loser.isNpc && loser.status === 'defeated'))) {
        logger.error(`[GameHandler - transferSpoils] 关键错误: pluginInstance 未定义。地图 ${pool.mapInfo.name} 的战利品转移失败。`);
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
        winner.temporaryFunds += loser.temporaryFunds;
        loser.temporaryFunds = 0;
    }
    if (loser.foundWeaponsInGame.length > 0) {
        let lootedNewWpnMsgParts = [];
        let convertedToFundsMsgParts = [];
        for (const wpnName of loser.foundWeaponsInGame) {
            if (wpnName === INITIAL_WEAPON_NAME) continue;

            const wpnDef = allWeapons.find(w => w.name === wpnName);
            if (!wpnDef) {
                logger.warn(`[GameHandler] transferSpoils: 武器 "${wpnName}" 定义未找到。`);
                continue;
            }
            if ((!winner.isNpc && winner.initialHeldWeapons.includes(wpnName)) || winner.foundWeaponsInGame.includes(wpnName)) {
                const val = wpnDef.price || 0;
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
    if (loser.isNpc && loser.npcDefinition?.uniqueLoot && loser.npcDefinition.uniqueLoot.length > 0) {
        pool.gameProcessLog.push(`  [${winnerDisplayName}] 搜刮了 [${loserDisplayName}] 的特殊遗物...`);
        loser.npcDefinition.uniqueLoot.forEach(lItem => {
            if (Math.random() < lItem.dropChance) {
                const lItemDef = lItem.type === 'weapon' ? allWeapons.find(w => w.name === lItem.name) : lItem;
                if (!lItemDef) {
                    logger.warn(`[GameHandler] NPC ${getFormattedNickname(loser)} 特殊掉落 ${lItem.name} 定义未找到。`);
                    return;
                }
                pool.gameProcessLog.push(`    获得了特殊物品: ${lItemDef.name}(${lItemDef.rarity || lItem.rarity})!`);

                if (lItem.type === 'weapon') {
                    if ((!winner.isNpc && winner.initialHeldWeapons.includes(lItemDef.name)) || winner.foundWeaponsInGame.includes(lItemDef.name)) {
                        const val = lItemDef.price || 50;
                        winner.temporaryFunds += val;
                        pool.gameProcessLog.push(`    (重复装备 ${lItemDef.name} 转化为 ${val} 临时资金)`);
                    } else {
                        winner.foundWeaponsInGame.push(lItemDef.name);
                    }
                } else {
                    winner.currentItems.push(JSON.parse(JSON.stringify({ name: lItemDef.name, rarity: lItemDef.rarity, price: lItemDef.price || 0, type: lItem.type })));
                }
            }
        });
    }

    if (!winner.isNpc && !loser.isNpc && currentPluginInstance) { // Check currentPluginInstance
        const { playerData: loserStore } = await currentPluginInstance.getPlayer(loser.userId);
        const { playerData: winnerStore } = await currentPluginInstance.getPlayer(winner.userId);

        if (!loserStore || !winnerStore) {
            logger.error(`[GameHandler] transferSpoils (PvP): 获取玩家 ${loser.userId} 或 ${winner.userId} 数据失败。`);
            pool.gameProcessLog.push(`  [系统错误] 处理玩家间装备转移时档案同步失败。`);
            return;
        }

        const lostWpnName = loser.weapon.name;
        const lostWpnDef = allWeapons.find(w => w.name === lostWpnName);

        if (lostWpnName !== INITIAL_WEAPON_NAME) {
            const wpnIdxLoserStore = loserStore.heldWeapons.indexOf(lostWpnName);
            if (wpnIdxLoserStore > -1) {
                loserStore.heldWeapons.splice(wpnIdxLoserStore, 1);
                pool.gameProcessLog.push(`  [${loserDisplayName}] 永久失去了装备 "${lostWpnName}"！`);

                if (winnerStore.heldWeapons.includes(lostWpnName)) {
                    const val = lostWpnDef?.price || 0;
                    winner.temporaryFunds += val;
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 已拥有同型号装备 "${lostWpnName}"，转化为 ${val} 临时资金。`);
                } else {
                    winnerStore.heldWeapons.push(lostWpnName);
                    pool.gameProcessLog.push(`  [${winnerDisplayName}] 永久获得了装备 "${lostWpnName}"！(已存入装备库)`);
                }
                await savePlayerData(loser.userId, loserStore);
                await savePlayerData(winner.userId, winnerStore);
            } else {
                logger.warn(`[GameHandler] transferSpoils (PvP): 失败者 ${loserDisplayName} 使用的 ${lostWpnName} 不在其永久库存中。`);
                pool.gameProcessLog.push(`  [警示] ${loserDisplayName} 使用的装备 ${lostWpnName} 未在其永久档案中找到，无法进行常规转移。`);
            }
        }
    } else if (!winner.isNpc && !loser.isNpc && !currentPluginInstance) {
        logger.error(`[GameHandler] transferSpoils (PvP): pluginInstance 未定义，无法处理玩家间装备转移。`);
        pool.gameProcessLog.push(`  [系统错误] 核心组件通讯失败，无法处理玩家间装备转移。`);
    }
}

export async function processGameInstance(mapName, pluginInstanceFromApp) {
    const pool = gamePools[mapName];
    // 优先使用传入的实例，其次是模块级存储的，最后是回退方法
    const currentPluginInstance = pluginInstanceFromApp || pluginAppInstance || getPluginInstanceFallback();


    if (!pool || pool.status !== 'waiting') {
        logger.warn(`[GameHandler] processGameInstance 被调用，但地图 "${mapName}" 不处于 'waiting' 状态或不存在。状态: ${pool?.status}`);
        if (pool) delete gamePools[mapName];
        Object.keys(playerQueueStatus).forEach(uid => { if (playerQueueStatus[uid] === mapName) delete playerQueueStatus[uid]; });
        return;
    }
    if (!currentPluginInstance && pool.players.some(p => !p.isNpc)) {
        logger.error(`[GameHandler - processGameInstance] 关键错误: 无法找到插件实例。涉及真实玩家的地图 ${mapName} 探索将失败。`);
        const uniqueGroupIdsForError = [...new Set(pool.players.filter(p => !p.isNpc && p.groupId).map(p => p.groupId))];
        for (const groupId of uniqueGroupIdsForError) {
            if (global.Bot && global.Bot.pickGroup) {
                const groupToNotify = global.Bot.pickGroup(groupId);
                if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                    await groupToNotify.sendMsg(`[${mapName}] 探索启动失败：系统核心组件通讯异常。请联系管理员。`).catch(err => logger.error("发送关键失败消息错误:", err));
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
        let activeParticipantsThisRound = pool.players.filter(p => (p.status === 'active' || p.status === 'wounded') && p.actionsTaken < 3);
        if (activeParticipantsThisRound.length === 0) {
            pool.gameProcessLog.push("所有参与者已行动完毕或失去行动能力。");
            break;
        }
        activeParticipantsThisRound.sort(() => Math.random() - 0.5);

        for (const participant of activeParticipantsThisRound) {
            if (participant.status === 'defeated' || participant.status === 'escaped' || participant.actionsTaken >= 3) continue;

            const participantDisplayName = getFormattedNickname(participant);

            if (participant.isNpc) {
                pool.gameProcessLog.push(`\n[${participantDisplayName}] (状态: ${participant.status}) 开始行动...`);
                if (participant.hostility === 'hostile' && participant.strategy === '猛攻') {
                    const potentialTargets = pool.players.filter(p => !p.isNpc && (p.status === 'active' || p.status === 'wounded'));
                    if (potentialTargets.length > 0) {
                        const target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 锁定了目标 [${getFormattedNickname(target)}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        await performCombat(participant, target, pool, allWeapons, currentPluginInstance);
                    } else {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未发现可攻击的玩家目标，转为搜寻。`);
                        await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, currentPluginInstance);
                    }
                } else {
                    await performSearchAction(participant, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, currentPluginInstance);
                }
            } else {
                const playerInGame = participant;
                const actionRoll = Math.random();
                const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
                let actionType = (actionRoll < playerStrategyProb.fight) ? '遭遇' : '搜寻';

                pool.gameProcessLog.push(`\n[${participantDisplayName}] (策略: ${playerInGame.strategy}, 状态: ${playerInGame.status}) 准备 ${actionType}...`);

                if (actionType === '搜寻') {
                    await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, currentPluginInstance);
                } else {
                    const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && (p.status === 'active' || p.status === 'wounded'));
                    if (potentialTargets.length === 0) {
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 未侦测到其他活动目标。`);
                        if (playerInGame.strategy === '猛攻') {
                            pool.gameProcessLog.push(`  [${participantDisplayName}] (猛攻策略) 转为强行搜寻！`);
                            await performSearchAction(playerInGame, pool, allItems, allWeapons, publicItems, pool.gameProcessLog, currentPluginInstance);
                        }
                    } else {
                        let target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];
                        const targetType = target.isNpc ? "NPC" : "调查员";
                        pool.gameProcessLog.push(`  [${participantDisplayName}] 锁定了${targetType}目标 [${getFormattedNickname(target)}] (装备: ${target.weapon.name}, 状态: ${target.status})！`);
                        await performCombat(playerInGame, target, pool, allWeapons, currentPluginInstance);
                    }
                }
            }
            participant.actionsTaken++;
            if (participant.status === 'defeated' || participant.status === 'escaped') continue;
        }
        if (pool.players.every(p => p.status === 'defeated' || p.status === 'escaped' || p.actionsTaken >=3)) {
            pool.gameProcessLog.push("所有参与者行动结束。");
            break;
        }
    }
    pool.gameProcessLog.push(`\n--- 区域探索阶段结束 ---`);
    pool.settlementLog.push(`\n--- [区域: ${mapName}] 探索报告 ---`);

    for (const p of pool.players) {
        const displayName = getFormattedNickname(p);
        if (p.isNpc) {
            let npcSummary = `\nNPC: ${displayName}\n  最终状态: `;
            if (p.status === 'defeated') npcSummary += "已被击败";
            else if (p.status === 'escaped') npcSummary += "已脱离";
            else if (p.status === 'active' || p.status === 'wounded') npcSummary += "行动结束，仍活跃";
            else npcSummary += p.status;

            if (p.currentItems.length > 0 || p.foundWeaponsInGame.length > 0) {
                npcSummary += `\n  持有物品: ${[...p.currentItems.map(i => i.name), ...p.foundWeaponsInGame.map(w=>w)].join('、 ') || '无'}`;
            }
            pool.settlementLog.push(npcSummary);
            continue;
        }

        let playerSummary = `\n调查员: ${displayName} (编号: ...${String(p.userId).slice(-4)})\n  最终状态: `;
        let playerStorageData = null;
        if (currentPluginInstance) { // 使用 currentPluginInstance
            const { playerData: fetchedData } = await currentPluginInstance.getPlayer(p.userId);
            playerStorageData = fetchedData;
        }

        if (!playerStorageData && currentPluginInstance) { // 检查 currentPluginInstance
            logger.error(`[GameHandler] 结算阶段: 调查员 ${displayName} (${p.userId}) 档案同步失败。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：无法同步您的个人档案。");
            // 不在此处 continue，允许记录部分信息，但后续保存会失败
        } else if (!currentPluginInstance && !p.isNpc) { // 如果没有实例且是真实玩家
            logger.error(`[GameHandler] 结算阶段: 调查员 ${displayName} (${p.userId}) 因缺少插件实例而无法同步档案。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：核心组件通讯失败，无法同步您的个人档案。");
        }


        if (p.status === 'defeated') {
            playerSummary += "任务中断，信号消失";
            if (playerStorageData) {
                playerStorageData.permanentInjuryStatus = 'heavy';
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: 重伤，需紧急治疗！`;
            }
        } else if (p.status === 'escaped') {
            playerSummary += "成功脱离区域";
            if (playerStorageData && p.status === 'wounded') {
                playerStorageData.permanentInjuryStatus = ['light', 'medium', 'heavy'][Math.floor(Math.random() * 3)];
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: ${INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus}，建议治疗。`;
            }
        } else if (p.status === 'wounded') {
            playerSummary += "受创撤离";
            if (playerStorageData) {
                const injuryTypes = ['light', 'medium', 'heavy'];
                playerStorageData.permanentInjuryStatus = injuryTypes[Math.floor(Math.random() * injuryTypes.length)];
                playerStorageData.needsTreatment = true;
                playerSummary += `\n  伤势评估: ${INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus}，建议治疗。`;
            }
        } else {
            playerSummary += "任务完成，安全返回";
        }

        let totalValueGainedFromItems = 0;
        let collectiblesGainedThisGame = [];
        let newWeaponsAddedToStorageNames = [];
        let itemsGainedThisGameStrings = [];

        playerSummary += "\n  本次探索收获:";
        const noGains = p.currentItems.length === 0 && p.foundWeaponsInGame.length === 0 && p.temporaryFunds === 0;
        if (noGains && p.status !== 'defeated') playerSummary += " 无实质收获";

        p.currentItems.forEach(item => {
            if (item.type === 'collectible') {
                if (playerStorageData) {
                    if (!playerStorageData.collectibles.find(c => c.name === item.name)) {
                        playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price, type: 'collectible' });
                        collectiblesGainedThisGame.push(`${item.name}(${item.rarity})`);
                    } else {
                        const sellPrice = Math.floor((item.price || 0) * 0.7);
                        playerStorageData.funds += sellPrice;
                        playerSummary += `\n    - 重复收藏品 ${item.name}(${item.rarity}) 自动折算为 ${sellPrice} 资金。`;
                    }
                } else {
                    collectiblesGainedThisGame.push(`${item.name}(${item.rarity}) (未同步)`);
                }
            } else {
                itemsGainedThisGameStrings.push(`${item.name}(${item.rarity}, 价值 ${item.price || 0}资金)`);
                totalValueGainedFromItems += (item.price || 0);
            }
        });

        p.foundWeaponsInGame.forEach(weaponName => {
            if (weaponName === INITIAL_WEAPON_NAME) return;
            if (playerStorageData && !playerStorageData.heldWeapons.includes(weaponName)) {
                playerStorageData.heldWeapons.push(weaponName);
            }
            if (!newWeaponsAddedToStorageNames.includes(weaponName)) {
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

        if (playerStorageData && playerStorageData.needsTreatment && playerStorageData.permanentInjuryStatus !== 'none') {
            const injuryName = INJURY_LEVELS[playerStorageData.permanentInjuryStatus]?.name || playerStorageData.permanentInjuryStatus;
            playerSummary += `\n  健康状况: 【${injuryName}】 - 别忘了治疗！`;
        }

        pool.settlementLog.push(playerSummary);
        // 只有在有实例和玩家数据时才保存
        if (playerStorageData && currentPluginInstance) await savePlayerData(p.userId, playerStorageData);
    }

    const uniqueGroupIds = [...new Set(pool.players.filter(p => !p.isNpc && p.groupId).map(p => p.groupId))];
    for (const groupId of uniqueGroupIds) {
        if (global.Bot && typeof global.Bot.pickGroup === 'function') {
            const groupToNotify = global.Bot.pickGroup(groupId);
            if (groupToNotify && typeof groupToNotify.sendMsg === 'function') {
                if (pool.gameProcessLog.length > 0) {
                    const gameProcessForwardMsg = await makeForwardMsgWithContent(pool.gameProcessLog, `探索行动记录: ${mapName}`);
                    if (gameProcessForwardMsg) await groupToNotify.sendMsg(gameProcessForwardMsg).catch(err => logger.error(`发送游戏过程日志错误: ${err}`));
                }
                if (pool.settlementLog.length > 0) {
                    const settlementForwardMsg = await makeForwardMsgWithContent(pool.settlementLog, `探索结算报告: ${mapName}`);
                    if (settlementForwardMsg) await groupToNotify.sendMsg(settlementForwardMsg).catch(err => logger.error(`发送结算日志错误: ${err}`));
                }
            }
        }
    }
    delete gamePools[mapName];
    logger.info(`[GameHandler] 探索任务于区域 "${mapName}" 已结束并清理。`);
}
