// camellia-plugin/apps/handlers/gameHandler.js

/**
 * @file 核心游戏逻辑处理器。
 * @description 处理进入地图、游戏流程、搜寻、战斗等核心功能。
 */

import { getItems, getWeapons, getMaps, getPlayerData, savePlayerData } from '../../utils/dataManager.js';
import { calculateCombatPowerWithPassives, determineBattleOutcome } from '../../utils/combatHelper.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import {
    STRATEGY_PROBABILITY,
    EVASIVE_PRE_COMBAT_ESCAPE_CHANCE,
    POST_COMBAT_ESCAPE_UNHARMED_CHANCE,
    POST_COMBAT_ESCAPE_WOUNDED_CHANCE,
    DEFAULT_FALLBACK_ITEM_NAME,
    INITIAL_WEAPON_NAME // 引入初始武器名称常量
} from '../../utils/constants.js';

// 存储当前所有地图的游戏实例 (池子)
const gamePools = {};

/**
 * 处理玩家进入地图的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例，用于访问如getPlayer等方法。
 */
export async function handleEnterMap(e, pluginInstance) {
    const userId = e.user_id;
    const groupId = e.group_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;

    const match = e.msg.match(/^#进入地图\s*([^\s]+|\d+)\s*武器\s*([^\s]+)\s*策略\s*([^\s]+)$/);
    if (!match) return false;

    const mapIdentifier = match[1];
    const weaponName = match[2];
    const strategy = match[3];

    const maps = getMaps();
    if (!maps || maps.length === 0) {
        logger.warn('[GameHandler] 地图数据库异常！');
        return e.reply("错误：地图数据模块异常，请联系“管理员”。");
    }

    let selectedMap = null;
    const mapNumber = parseInt(mapIdentifier, 10);
    if (!isNaN(mapNumber) && mapNumber > 0 && mapNumber <= maps.length) {
        selectedMap = maps[mapNumber - 1];
    } else {
        selectedMap = maps.find(m => m.name === mapIdentifier);
    }

    if (!selectedMap) {
        return e.reply(`未知的区域坐标或编号: "${mapIdentifier}"。`);
    }
    const mapName = selectedMap.name;

    if (!selectedMap.itemPool || typeof selectedMap.itemPool !== 'object' || Object.keys(selectedMap.itemPool).length === 0) {
        logger.error(`[GameHandler] 区域 "${mapName}" 缺少有效的物品池配置 (itemPool)！`);
        return e.reply(`错误：区域 "${mapName}" 配置不完整 (itemPool)，无法进入。`);
    }
    if (!selectedMap.refreshRate || typeof selectedMap.refreshRate !== 'object' || Object.keys(selectedMap.refreshRate).length === 0) {
        logger.error(`[GameHandler] 区域 "${mapName}" 缺少有效的刷新率配置 (refreshRate)！`);
        return e.reply(`错误：区域 "${mapName}" 配置不完整 (refreshRate)，无法进入。`);
    }

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) {
        logger.error(`[GameHandler] enterMap: 调查员 ${userId} 身份验证失败。`);
        return e.reply("抱歉，您的身份识别出现错误。");
    }

    if (playerData.funds < selectedMap.entryFee) {
        return e.reply(`“信息费”不足！进入 "${mapName}" 需要 ${selectedMap.entryFee} “资金”，您只有 ${playerData.funds}。`);
    }

    const weapons = getWeapons();
    if (!weapons || weapons.length === 0) {
        logger.warn('[GameHandler] 装备数据库异常！');
        return e.reply("错误：装备数据模块异常。");
    }
    const selectedWeapon = weapons.find(w => w.name === weaponName);
    if (!selectedWeapon) {
        return e.reply(`未知的装备型号: "${weaponName}"。`);
    }
    if (!playerData.heldWeapons || !playerData.heldWeapons.includes(weaponName)) {
        return e.reply(`您未持有装备 "${weaponName}"。`);
    }
    if (selectedWeapon.baseCombatPower < selectedMap.limitCombatPower) {
        return e.reply(`您的装备 "${weaponName}" (威胁评估${selectedWeapon.baseCombatPower}) 未达到区域 "${mapName}" 的最低安全等级 (${selectedMap.limitCombatPower})。`);
    }

    if (!gamePools[mapName]) {
        gamePools[mapName] = {
            players: [], mapInfo: { ...selectedMap }, gameProcessLog: [], settlementLog: [], status: 'waiting', playerGroupIds: {}
        };
    }
    const pool = gamePools[mapName];

    if (pool.status === 'in_progress') return e.reply(`"${mapName}" 的探索任务正在进行中。`);
    if (pool.players.find(p => p.userId === userId)) return e.reply(`您已在 "${mapName}" 的待命队列中。`);
    if (pool.players.length >= selectedMap.playerCapacity) return e.reply(`"${mapName}" 的待命队列已满。`);

    playerData.funds -= selectedMap.entryFee;
    await savePlayerData(userId, playerData);

    pool.players.push({
        userId: userId,
        nickname: playerData.nickname,
        weapon: { ...selectedWeapon }, // 玩家当前装备的武器对象
        strategy: strategy,
        currentItems: [],       // 本次探索中搜寻到的非武器物品
        foundWeaponsInGame: [], // 本次探索中搜寻或缴获的武器名称列表 (用于判断重复)
        temporaryFunds: 0,      // 本次探索中因重复武器等获得的临时资金
        status: 'active',       // 玩家状态: active, wounded, defeated
        actionsTaken: 0,
        groupId: groupId,
        initialHeldWeapons: [...playerData.heldWeapons] // 玩家进入游戏时已持有的武器，用于判断重复
    });
    pool.playerGroupIds[userId] = groupId;

    e.reply(`${playerData.nickname} 已装备 "${weaponName}" (策略: ${strategy}) 进入 "${mapName}" 待命队列 (${pool.players.length}/${selectedMap.playerCapacity})。`);

    if (pool.players.length === selectedMap.playerCapacity) {
        await processGameInstance(mapName, pluginInstance);
    }
    return true;
}

/**
 * 处理特定地图的游戏流程。
 * @param {string} mapName - 地图名称。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function processGameInstance(mapName, pluginInstance) {
    const pool = gamePools[mapName];
    if (!pool || pool.status !== 'waiting') return;
    pool.status = 'in_progress';
    pool.gameProcessLog = [`[区域: ${mapName}] 探索开始！${pool.mapInfo.description || '未知区域...'}`];
    pool.gameProcessLog.push(`参与调查员 (${pool.players.length}名): ${pool.players.map(p => `${p.nickname}(${p.weapon.name})`).join(', ')}`);

    const allItems = getItems();    // 获取所有物品定义
    const allWeapons = getWeapons(); // 获取所有武器定义

    // 游戏共进行3轮
    for (let round = 1; round <= 3; round++) {
        pool.gameProcessLog.push(`\n--- 第 ${round} 行动阶段 ---`);
        for (const playerInGame of pool.players) {
            if (playerInGame.status === 'defeated' || playerInGame.actionsTaken >= 3) continue;

            const actionRoll = Math.random();
            const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
            let actionType = (actionRoll < playerStrategyProb.fight) ? '遭遇' : '搜寻';
            pool.gameProcessLog.push(`\n[${playerInGame.nickname}] (策略: ${playerInGame.strategy}, 状态: ${playerInGame.status === 'wounded' ? '受创' : '完好'}) 准备 ${actionType}...`);

            if (actionType === '搜寻') {
                await performSearchAction(playerInGame, pool, allItems, allWeapons, pool.gameProcessLog, pluginInstance);
            } else { // 遭遇其他玩家
                const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && p.status !== 'defeated');

                if (potentialTargets.length === 0) {
                    pool.gameProcessLog.push(`[${playerInGame.nickname}] 未侦测到其他活动目标。`);
                    if (playerInGame.strategy === '猛攻') {
                        pool.gameProcessLog.push(`[${playerInGame.nickname}] (猛攻策略) 转为强行搜寻！`);
                        await performSearchAction(playerInGame, pool, allItems, allWeapons, pool.gameProcessLog, pluginInstance);
                    }
                } else {
                    let target = null;
                    // 使用之前的权重逻辑选择目标
                    const weightedTargets = potentialTargets.map(t => {
                        let weight = 1;
                        if (playerInGame.strategy === '猛攻') { (t.strategy === '猛攻') ? weight = 3 : (t.strategy === '避战') ? weight = 0.5 : weight = 1.5;}
                        else if (playerInGame.strategy === '均衡') { (t.strategy === '猛攻') ? weight = 1.5 : (t.strategy === '避战') ? weight = 0.7 : weight = 1;}
                        else if (playerInGame.strategy === '避战') { (t.strategy === '猛攻') ? weight = 1 : (t.strategy === '避战') ? weight = 0.3 : weight = 0.7;}
                        if (t.status === 'wounded') weight *= 1.2;
                        return { player: t, weight: Math.max(0.1, weight) };
                    });
                    const totalWeight = weightedTargets.reduce((sum, t) => sum + t.weight, 0);
                    let randomWeight = Math.random() * totalWeight;
                    for (const wt of weightedTargets) { randomWeight -= wt.weight; if (randomWeight <= 0) { target = wt.player; break; } }
                    if (!target) target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)]; // Fallback

                    pool.gameProcessLog.push(`[${playerInGame.nickname}] (装备: ${playerInGame.weapon.name}, 状态: ${playerInGame.status === 'wounded' ? '受创' : '完好'}) 锁定了目标 [${target.nickname}] (装备: ${target.weapon.name}, 策略: ${target.strategy}, 状态: ${target.status === 'wounded' ? '受创' : '完好'})！`);

                    if (target.strategy === '避战' && Math.random() < EVASIVE_PRE_COMBAT_ESCAPE_CHANCE) {
                        pool.gameProcessLog.push(`  [${target.nickname}] (避战策略) 感知到威胁，迅速脱离了 [${playerInGame.nickname}] 的视线！`);
                        if (playerInGame.strategy === '猛攻') {
                            pool.gameProcessLog.push(`  [${playerInGame.nickname}] 目标消失，转为强行搜寻！`);
                            await performSearchAction(playerInGame, pool, allItems, allWeapons, pool.gameProcessLog, pluginInstance);
                        }
                    } else {
                        if(target.strategy === '避战') pool.gameProcessLog.push(`  [${target.nickname}] (避战策略) 未能成功脱离，冲突爆发！`);
                        const combatResult = calculateCombatPowerWithPassives(playerInGame.weapon, target.weapon, playerInGame.status, target.status);
                        combatResult.log.forEach(log => pool.gameProcessLog.push(`  ${log}`));
                        pool.gameProcessLog.push(`  威胁评估对比: [${playerInGame.nickname}] ${combatResult.attackerPower} vs [${target.nickname}] ${combatResult.defenderPower}`);
                        const attackerWins = determineBattleOutcome(combatResult.attackerPower, combatResult.defenderPower);
                        let winner = attackerWins ? playerInGame : target;
                        let loser = attackerWins ? target : playerInGame;
                        pool.gameProcessLog.push(`  冲突结果: [${winner.nickname}] 占据上风!`);

                        if (loser.status === 'wounded') {
                            loser.status = 'defeated';
                            pool.gameProcessLog.push(`  [${loser.nickname}] 已受重创，被迫退出探索！`);
                            await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
                        } else {
                            const escapeRoll = Math.random();
                            if (escapeRoll < POST_COMBAT_ESCAPE_UNHARMED_CHANCE) {
                                pool.gameProcessLog.push(`  [${loser.nickname}] 反应迅速，在混乱中成功撤退！未损失物资。`);
                            } else if (escapeRoll < POST_COMBAT_ESCAPE_UNHARMED_CHANCE + POST_COMBAT_ESCAPE_WOUNDED_CHANCE) {
                                loser.status = 'wounded';
                                pool.gameProcessLog.push(`  [${loser.nickname}] 冲突失利，受到创伤！但成功保留当前物资并暂时后撤。`);
                            } else {
                                loser.status = 'defeated';
                                pool.gameProcessLog.push(`  [${loser.nickname}] 未能成功脱离，被 [${winner.nickname}] 击倒！`);
                                await transferSpoils(winner, loser, pool, pluginInstance, allWeapons);
                            }
                        }
                    }
                }
            }
            playerInGame.actionsTaken++;
        }
    }
    pool.gameProcessLog.push(`\n--- 区域探索阶段结束 ---`);

    // --- 游戏结算阶段 ---
    pool.settlementLog.push(`\n--- [区域: ${mapName}] 探索报告 ---`);
    for (const playerInGame of pool.players) {
        let playerSummary = `\n调查员: ${playerInGame.nickname} (编号: ...${String(playerInGame.userId).slice(-4)})\n  最终状态: `;
        if (playerInGame.status === 'defeated') {
            playerSummary += "任务中断，信号消失";
            pool.settlementLog.push(playerSummary + "\n  回收物品: 无\n  临时资金: 0 (已遗失)");
            continue;
        }
        playerSummary += playerInGame.status === 'wounded' ? "受创撤离" : "任务完成，安全返回";

        const { playerData: playerStorageData } = await pluginInstance.getPlayer(playerInGame.userId);
        if (!playerStorageData) {
            logger.error(`[GameHandler] 结算阶段: 调查员 ${playerInGame.nickname} (${playerInGame.userId}) 档案同步失败。`);
            pool.settlementLog.push(playerSummary + "\n  结算失败：无法同步您的个人档案。");
            continue;
        }

        let totalValueGainedFromItems = 0;
        let collectiblesGainedThisGame = [];
        let newWeaponsAddedToStorage = []; // 新增到永久库存的武器
        let itemsGainedThisGame = [];

        playerSummary += "\n  本次探索收获:";
        // 处理搜寻到的普通物品
        if (playerInGame.currentItems.length === 0 && playerInGame.foundWeaponsInGame.length === 0 && playerInGame.temporaryFunds === 0) {
            playerSummary += " 无实质收获";
        }

        for (const item of playerInGame.currentItems) { // currentItems 现在只存非武器物品
            if (item.type === 'collectible' || item.rarity === '收藏品') {
                if (!playerStorageData.collectibles.find(c => c.name === item.name)) {
                    playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price });
                }
                collectiblesGainedThisGame.push(`${item.name}(${item.rarity})`);
            } else { // 普通物品
                itemsGainedThisGame.push(`${item.name}(${item.rarity}, 价值 ${item.price || 0}资金)`);
                totalValueGainedFromItems += (item.price || 0);
            }
        }

        // 处理本次游戏中获得的武器 (已在搜寻或缴获时判断重复并转换为临时资金或加入foundWeaponsInGame)
        for (const weaponName of playerInGame.foundWeaponsInGame) {
            if (weaponName === INITIAL_WEAPON_NAME) continue; // 初始武器不计入新获取
            if (!playerStorageData.heldWeapons.includes(weaponName)) {
                playerStorageData.heldWeapons.push(weaponName);
                const weaponDef = allWeapons.find(w=>w.name === weaponName);
                newWeaponsAddedToStorage.push(`${weaponName}(${weaponDef?.rarity || '未知'})`);
            }
        }


        if (itemsGainedThisGame.length > 0) playerSummary += `\n    - 回收物资: ${itemsGainedThisGame.join('、 ')} (已自动折算为资金)`;
        if (newWeaponsAddedToStorage.length > 0) playerSummary += `\n    - 获取新装备: ${newWeaponsAddedToStorage.join('、 ')} (已存入装备库)`;
        if (collectiblesGainedThisGame.length > 0) playerSummary += `\n    - 获取“收藏品”: ${collectiblesGainedThisGame.join('、 ')} (已存入个人收藏)`;

        playerSummary += `\n  资金变化: +${totalValueGainedFromItems} (来自物资回收) +${playerInGame.temporaryFunds} (来自临时资金)`;
        playerStorageData.funds += totalValueGainedFromItems;
        playerStorageData.funds += playerInGame.temporaryFunds; // 将临时资金转为永久资金
        playerSummary += `\n  当前总资金: ${playerStorageData.funds}`;

        if (playerInGame.status === 'wounded') playerSummary += `\n  警告: 您的状态不稳定，建议尽快进行休整！`;

        pool.settlementLog.push(playerSummary);
        await savePlayerData(playerInGame.userId, playerStorageData);
    }

    // --- 发送游戏报告给相关群组 ---
    const uniqueGroupIds = [...new Set(pool.players.map(p => p.groupId).filter(id => id))];

    for (const groupId of uniqueGroupIds) {
        const groupToNotify = global.Bot ? global.Bot.pickGroup(groupId) : null;
        if (groupToNotify) {
            if (pool.gameProcessLog && pool.gameProcessLog.length > 0) {
                try {
                    const gameProcessForwardMsg = await makeForwardMsgWithContent(pool.gameProcessLog, `探索行动记录: ${mapName}`);
                    if (gameProcessForwardMsg) await groupToNotify.sendMsg(gameProcessForwardMsg);
                    else await groupToNotify.sendMsg(`[都市迷踪-${mapName}] 行动记录为空或无法生成。`);
                } catch (sendError) {
                    logger.error(`[GameHandler] 发送探索行动记录(转发)失败 to group ${groupId} for map ${mapName}:`, sendError);
                    await groupToNotify.sendMsg(`[都市迷踪-${mapName}] 行动记录发送失败。`);
                }
            }
            if (pool.settlementLog && pool.settlementLog.length > 0) {
                try {
                    const settlementForwardMsg = await makeForwardMsgWithContent(pool.settlementLog, `探索结算报告: ${mapName}`);
                    if (settlementForwardMsg) await groupToNotify.sendMsg(settlementForwardMsg);
                    else await groupToNotify.sendMsg(`[都市迷踪-${mapName}] 结算报告为空或无法生成。`);
                } catch (sendError) {
                    logger.error(`[GameHandler] 发送探索结算报告(转发)失败 to group ${groupId} for map ${mapName}:`, sendError);
                    await groupToNotify.sendMsg(`[都市迷踪-${mapName}] 结算报告发送失败。`);
                }
            }
        } else {
            logger.error(`[GameHandler] 无法找到通讯频道 ${groupId} (地图: ${mapName}) 发送探索报告。`);
        }
    }
    delete gamePools[mapName];
    logger.info(`[GameHandler] 探索任务于区域 "${mapName}" 已结束并清理。`);
}


/**
 * 执行搜寻动作。
 * @param {object} playerInGame - 当前执行搜寻的玩家游戏内对象。
 * @param {object} pool - 当前地图的游戏池。
 * @param {Array<object>} allItems - 所有物品的定义列表。
 * @param {Array<object>} allWeapons - 所有武器的定义列表。
 * @param {Array<string>} gameLogArray - 游戏过程日志数组。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function performSearchAction(playerInGame, pool, allItems, allWeapons, gameLogArray, pluginInstance) {
    const itemsToObtainCount = Math.floor(Math.random() * 3) + 1; // 调整为1-3件，避免过多重复武器转换
    let foundItemsMsgParts = [];

    logger.debug(`[SearchDebug] performSearchAction for ${playerInGame.nickname} in ${pool.mapInfo.name}. Items to find: ${itemsToObtainCount}`);

    if ((!allItems || allItems.length === 0) && (!allWeapons || allWeapons.length === 0)) {
        // ... (错误处理不变)
        gameLogArray.push(`[${playerInGame.nickname}] 系统数据库异常：无可搜寻物品或装备！`);
        logger.error("[GameHandler/Search] performSearchAction: allItems AND allWeapons are empty or undefined!");
        const emergencyFallback = { name: "未知残片", rarity: "普通", price: 1, type: 'item' };
        for (let i = 0; i < itemsToObtainCount; i++) {
            playerInGame.currentItems.push(emergencyFallback); // 只添加普通物品
            foundItemsMsgParts.push(`${emergencyFallback.name}(${emergencyFallback.rarity})`);
        }
        if (foundItemsMsgParts.length > 0) {
            gameLogArray.push(`[${playerInGame.nickname}] 在一片混乱中，勉强辨识出: ${foundItemsMsgParts.join('、 ')}。`);
        }
        return;
    }

    for (let i = 0; i < itemsToObtainCount; i++) {
        let chosenItemDef = null; // 找到的物品/武器的定义
        let itemType = 'item';
        let attempts = 0;
        const maxFindAttempts = 5;

        const mapItemPool = pool.mapInfo.itemPool;
        const mapRefreshRate = pool.mapInfo.refreshRate;

        if (mapItemPool && mapRefreshRate && Object.keys(mapRefreshRate).length > 0) {
            while (!chosenItemDef && attempts < maxFindAttempts) {
                // ... (稀有度选择逻辑不变)
                attempts++;
                let selectedRarity = "普通";
                const rarityRoll = Math.random();
                let cumulativeProb = 0;
                const sortedRarities = Object.keys(mapRefreshRate).sort((a, b) => mapRefreshRate[a] - mapRefreshRate[b]);
                for (const rarity of sortedRarities) {
                    cumulativeProb += (mapRefreshRate[rarity] || 0);
                    if (rarityRoll < cumulativeProb) { selectedRarity = rarity; break; }
                }
                if (!mapRefreshRate[selectedRarity] && sortedRarities.length > 0) selectedRarity = sortedRarities[0];

                const potentialDrops = mapItemPool[selectedRarity];
                if (potentialDrops && potentialDrops.length > 0) {
                    const foundDropEntry = potentialDrops[Math.floor(Math.random() * potentialDrops.length)];
                    if (typeof foundDropEntry === 'string') { // 普通物品
                        chosenItemDef = allItems ? allItems.find(item => item.name === foundDropEntry && item.rarity === selectedRarity) : null;
                        if (chosenItemDef) itemType = 'item';
                    } else if (typeof foundDropEntry === 'object' && foundDropEntry.type === 'weapon') { // 武器
                        chosenItemDef = allWeapons ? allWeapons.find(w => w.name === foundDropEntry.name && w.rarity === selectedRarity) : null;
                        if (chosenItemDef) itemType = 'weapon';
                    }
                }
                if (chosenItemDef) break;
            }
        }
        // ... (后备查找逻辑，简化处理，优先普通物品)
        if (!chosenItemDef) {
            logger.warn(`[SearchDebug] Primary search failed. Fallback for ${playerInGame.nickname}.`);
            if (allItems && allItems.length > 0) {
                const commonItems = allItems.filter(it => it.rarity === "普通" && it.name !== DEFAULT_FALLBACK_ITEM_NAME);
                if (commonItems.length > 0) chosenItemDef = commonItems[Math.floor(Math.random() * commonItems.length)];
                else chosenItemDef = allItems.find(it => it.name === DEFAULT_FALLBACK_ITEM_NAME);
                if (chosenItemDef) itemType = 'item';
            }
            if (!chosenItemDef && allItems && allItems.length > 0) { // 最终后备
                chosenItemDef = allItems[0];
                itemType = 'item';
            }
        }


        if (chosenItemDef) {
            if (itemType === 'weapon') {
                if (chosenItemDef.name === INITIAL_WEAPON_NAME) {
                    foundItemsMsgParts.push(`发现了多余的${INITIAL_WEAPON_NAME}(初始装备)，已忽略。`);
                } else if (playerInGame.initialHeldWeapons.includes(chosenItemDef.name) || playerInGame.foundWeaponsInGame.includes(chosenItemDef.name)) {
                    // 玩家永久持有或本次游戏中已获得过此武器
                    const value = chosenItemDef.price || 0;
                    playerInGame.temporaryFunds += value;
                    foundItemsMsgParts.push(`发现了重复装备: ${chosenItemDef.name}(${chosenItemDef.rarity})，转化为 ${value} 临时资金。`);
                    logger.debug(`[SearchDebug] ${playerInGame.nickname} found duplicate weapon ${chosenItemDef.name}, got ${value} temporary funds.`);
                } else {
                    // 发现新武器
                    playerInGame.foundWeaponsInGame.push(chosenItemDef.name);
                    foundItemsMsgParts.push(`[装备]: ${chosenItemDef.name}(${chosenItemDef.rarity})`);
                    logger.debug(`[SearchDebug] ${playerInGame.nickname} found new weapon ${chosenItemDef.name}.`);
                }
            } else { // 普通物品或收藏品
                playerInGame.currentItems.push({ ...chosenItemDef, type: itemType });
                foundItemsMsgParts.push(`${chosenItemDef.name}(${chosenItemDef.rarity})`);
            }
        } else {
            const ultimateFallback = { name: "不明物质残渣", rarity: "未知", price: 0, type: 'item' };
            playerInGame.currentItems.push(ultimateFallback);
            foundItemsMsgParts.push(`${ultimateFallback.name}(${ultimateFallback.rarity})`);
            logger.error(`[SearchDebug] CRITICAL: All search failed for ${playerInGame.nickname}. Added '不明物质残渣'.`);
        }
    }

    if (foundItemsMsgParts.length > 0) {
        gameLogArray.push(`[${playerInGame.nickname}] 在废墟中搜寻: ${foundItemsMsgParts.join('、 ')}。`);
    } else {
        gameLogArray.push(`[${playerInGame.nickname}] 在废墟中搜寻，但一无所获。`);
    }
}

/**
 * 转移战利品从战败者到胜利者。
 * @param {object} winner - 胜利方玩家的游戏内对象。
 * @param {object} loser - 战败方玩家的游戏内对象。
 * @param {object} pool - 当前地图的游戏池。
 * @param {object} pluginInstance - 插件主类的实例。
 * @param {Array<object>} allWeapons - 所有武器的定义列表。
 */
export async function transferSpoils(winner, loser, pool, pluginInstance, allWeapons) {
    pool.gameProcessLog.push(`  [${winner.nickname}] 开始清点 [${loser.nickname}] 的遗留物品!`);

    // 转移普通物品
    if (loser.currentItems.length > 0) {
        pool.gameProcessLog.push(`  缴获物资: ${loser.currentItems.map(i => `${i.name}(${i.rarity || i.type})`).join('、 ')}。`);
        winner.currentItems.push(...loser.currentItems);
        loser.currentItems = [];
    }

    // 转移临时资金
    if (loser.temporaryFunds > 0) {
        pool.gameProcessLog.push(`  缴获临时资金: ${loser.temporaryFunds}。`);
        winner.temporaryFunds += loser.temporaryFunds;
        loser.temporaryFunds = 0;
    }

    // 处理失败者在本次游戏中找到的武器 (foundWeaponsInGame)
    // 这些武器如果胜利者没有，则胜利者获得；如果胜利者有，则转换为胜利者的临时资金
    if (loser.foundWeaponsInGame.length > 0) {
        let lootedNewWeaponsMsg = [];
        let convertedToFundsMsg = [];
        for (const weaponName of loser.foundWeaponsInGame) {
            if (weaponName === INITIAL_WEAPON_NAME) continue; // 初始武器不处理

            const weaponDef = allWeapons.find(w => w.name === weaponName);
            if (!weaponDef) continue;

            if (winner.initialHeldWeapons.includes(weaponName) || winner.foundWeaponsInGame.includes(weaponName)) {
                // 胜利者已拥有此武器 (永久或本次游戏中获得)
                const value = weaponDef.price || 0;
                winner.temporaryFunds += value;
                convertedToFundsMsg.push(`${weaponName}(转化为 ${value} 临时资金)`);
            } else {
                // 胜利者获得新武器
                winner.foundWeaponsInGame.push(weaponName);
                lootedNewWeaponsMsg.push(weaponName);
            }
        }
        if (lootedNewWeaponsMsg.length > 0) {
            pool.gameProcessLog.push(`  缴获新装备: ${lootedNewWeaponsMsg.join('、 ')}。`);
        }
        if (convertedToFundsMsg.length > 0) {
            pool.gameProcessLog.push(`  部分重复装备已转化为临时资金: ${convertedToFundsMsg.join('、 ')}。`);
        }
        loser.foundWeaponsInGame = [];
    }


    // 处理失败者当前装备的武器 (loser.weapon) - 这是永久武器的逻辑
    const { playerData: loserStorageData } = await pluginInstance.getPlayer(loser.userId);
    const { playerData: winnerStorageData } = await pluginInstance.getPlayer(winner.userId);

    if (!loserStorageData || !winnerStorageData) {
        logger.error(`[GameHandler] transferSpoils: 无法获取 ${loser.nickname} 或 ${winner.nickname} 的个人档案。`);
        pool.gameProcessLog.push(`  错误：处理战利品时无法同步个人档案。`);
        return;
    }

    const lostEquippedWeaponName = loser.weapon.name; // 失败者当前装备的武器
    if (lostEquippedWeaponName !== INITIAL_WEAPON_NAME) { // 初始武器不可被夺走
        const weaponIdxInLoser = loserStorageData.heldWeapons.indexOf(lostEquippedWeaponName);
        if (weaponIdxInLoser > -1) {
            loserStorageData.heldWeapons.splice(weaponIdxInLoser, 1); // 从失败者永久库存移除
            pool.gameProcessLog.push(`  [${loser.nickname}] 失去了装备 "${lostEquippedWeaponName}"！`);

            // 检查胜利者是否已拥有该武器 (永久或本次游戏中获得)
            const weaponDef = allWeapons.find(w => w.name === lostEquippedWeaponName);
            if (winner.initialHeldWeapons.includes(lostEquippedWeaponName) || winner.foundWeaponsInGame.includes(lostEquippedWeaponName)) {
                const value = weaponDef ? (weaponDef.price || 0) : 0;
                winner.temporaryFunds += value;
                pool.gameProcessLog.push(`  [${winner.nickname}] 已拥有同型号装备 "${lostEquippedWeaponName}"，转化为 ${value} 临时资金。`);
            } else {
                winnerStorageData.heldWeapons.push(lostEquippedWeaponName); // 添加到胜利者永久库存
                winner.foundWeaponsInGame.push(lostEquippedWeaponName); // 也记录在本次游戏获得，避免重复添加临时资金
                pool.gameProcessLog.push(`  [${winner.nickname}] 获得了装备 "${lostEquippedWeaponName}"！`);
            }
        } else {
            logger.warn(`[GameHandler] 结算警告：失败者 ${loser.nickname} 装备库中未找到其当前装备 ${lostEquippedWeaponName}。可能不应发生。`);
        }
    } else {
        pool.gameProcessLog.push(`  [${loser.nickname}] 的 ${INITIAL_WEAPON_NAME} 不会被夺走。`);
    }
    await savePlayerData(loser.userId, loserStorageData);
    await savePlayerData(winner.userId, winnerStorageData);
}

