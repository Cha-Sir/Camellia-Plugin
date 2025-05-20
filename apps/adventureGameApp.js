import plugin from '../../../lib/plugins/plugin.js';
import {
    loadAllBaseData, getItems, getWeapons, getMaps,
    getPlayerData, savePlayerData
} from '../utils/dataManager.js';
import {
    calculateCombatPowerWithPassives, determineBattleOutcome
} from '../utils/combatHelper.js';

const gamePools = {};
const STRATEGY_PROBABILITY = {
    '猛攻': { fight: 0.8, search: 0.2 },
    '均衡': { fight: 0.5, search: 0.5 },
    '避战': { fight: 0.2, search: 0.8 }
};
const VALID_STRATEGIES = Object.keys(STRATEGY_PROBABILITY);

export class AdventureGame extends plugin {
    constructor() {
        super({
            name: '搜打撤小游戏',
            dsc: '一个简单的搜寻、战斗、撤离的文字冒险游戏。指令: #进入地图, #查看商店, #购买武器, #出售物品, #我的信息, #重载冒险数据 (主人)',
            event: 'message',
            priority: 500,
            rule: [
                {
                    reg: `^#进入地图\\s*([^\\s]+)\\s*武器\\s*([^\\s]+)\\s*策略\\s*(${VALID_STRATEGIES.join('|')})$`,
                    fnc: 'enterMap'
                },
                { reg: '^#查看商店$', fnc: 'viewShop' },
                { reg: '^#购买武器\\s*([^\\s]+)$', fnc: 'buyWeaponFromShop' },
                { reg: '^#出售物品\\s*([^\\s]+)$', fnc: 'sellItemFromInventory' },
                { reg: '^#我的信息$', fnc: 'viewMyInfo' },
                { reg: '^#重载冒险数据$', fnc: 'reloadDataAdmin', permission: 'master' }
            ]
        });
        this.initializeData();
    }

    async initializeData() {
        try {
            await loadAllBaseData();
            logger.info('[AdventureGameApp] 基础数据已初始化。');
        } catch (error) {
            logger.error('[AdventureGameApp] 初始化基础数据失败:', error);
        }
    }

    async reloadDataAdmin(e) {
        if (!e.isMaster) return false;
        try {
            await loadAllBaseData();
            e.reply("冒险插件基础数据已成功重载。");
            logger.info('[AdventureGameApp] 基础数据已由管理员重载。');
        } catch (error) {
            logger.error('[AdventureGameApp] 管理员重载基础数据失败:', error);
            e.reply("冒险插件基础数据重载失败，请查看后台日志。");
        }
        return true;
    }

    async getPlayer(userId, nickname = '') {
        const result = await getPlayerData(userId, nickname);
        return result;
    }

    async enterMap(e) {
        const userId = e.user_id;
        const nickname = e.sender.card || e.sender.nickname || `玩家${userId.slice(-4)}`;
        const match = e.msg.match(/^#进入地图\s*([^\s]+)\s*武器\s*([^\s]+)\s*策略\s*([^\s]+)$/);
        if (!match) return false;

        const mapName = match[1];
        const weaponName = match[2];
        const strategy = match[3];

        const maps = getMaps();
        if (!maps || maps.length === 0) {
            logger.warn('[AdventureGameApp] 地图数据未加载或为空！');
            return e.reply("错误：地图数据未能加载，请联系管理员检查插件配置。");
        }
        const selectedMap = maps.find(m => m.name === mapName);
        if (!selectedMap) {
            return e.reply(`地图 "${mapName}" 不存在。可用地图: ${maps.map(m => m.name).join('、') || '无，请检查配置'}`);
        }

        const { playerData, isNewPlayer } = await this.getPlayer(userId, nickname);
        if (!playerData) { // 进一步检查 playerData 是否真的存在
            logger.error(`[AdventureGameApp] enterMap: 玩家 ${userId} 数据获取失败或返回null/undefined。`);
            return e.reply("抱歉，获取您的玩家信息时遇到问题，请稍后再试。");
        }
        if (isNewPlayer) {
            // e.reply(`欢迎新冒险者 ${playerData.nickname}！您的档案已创建，现在可以进入地图了。`);
        }

        if (playerData.funds < selectedMap.entryFee) {
            return e.reply(`金币不足！进入 "${mapName}" 需要 ${selectedMap.entryFee} 金币，您只有 ${playerData.funds} 金币。`);
        }

        const weapons = getWeapons();
        if (!weapons || weapons.length === 0) {
            logger.warn('[AdventureGameApp] 武器数据未加载或为空！');
            return e.reply("错误：武器数据未能加载，请联系管理员检查插件配置。");
        }
        const selectedWeapon = weapons.find(w => w.name === weaponName);
        if (!selectedWeapon) {
            return e.reply(`武器 "${weaponName}" 不存在。请检查您的输入或查看商店。`);
        }
        if (!playerData.heldWeapons || !playerData.heldWeapons.includes(weaponName)) { // 增加 playerData.heldWeapons 存在性检查
            return e.reply(`您未持有武器 "${weaponName}"。请先在商店购买或通过其他方式获取。`);
        }

        if (selectedWeapon.baseCombatPower < selectedMap.limitCombatPower) {
            return e.reply(`您的武器 "${weaponName}" (战力${selectedWeapon.baseCombatPower}) 未达到地图 "${mapName}" 的最低战力要求 (${selectedMap.limitCombatPower})。`);
        }

        if (!gamePools[mapName]) {
            gamePools[mapName] = { players: [], mapInfo: { ...selectedMap }, log: [], status: 'waiting', groupId: e.group_id };
        }
        const pool = gamePools[mapName];

        if (pool.status === 'in_progress') return e.reply(`"${mapName}" 的战局正在进行中，请稍后再试。`);
        if (pool.players.find(p => p.userId === userId)) return e.reply(`您已在 "${mapName}" 的等待队列中。`);
        if (pool.players.length >= selectedMap.playerCapacity) return e.reply(`"${mapName}" 的等待队列已满 (${pool.players.length}/${selectedMap.playerCapacity})。`);

        playerData.funds -= selectedMap.entryFee;
        await savePlayerData(userId, playerData);

        pool.players.push({
            userId: userId,
            nickname: playerData.nickname,
            weapon: { ...selectedWeapon },
            strategy: strategy,
            currentItems: [], status: 'active', actionsTaken: 0,
        });

        e.reply(`${playerData.nickname} 已装备 "${weaponName}" (策略: ${strategy}) 进入 "${mapName}" 等待队列 (${pool.players.length}/${selectedMap.playerCapacity})。`);

        if (pool.players.length === selectedMap.playerCapacity) {
            await this.processGame(mapName);
        }
        return true;
    }

    async processGame(mapName) {
        const pool = gamePools[mapName];
        if (!pool || pool.status !== 'waiting') { return; }
        pool.status = 'in_progress';
        pool.log = [`[${mapName}] 战局开始！${pool.mapInfo.description}`];
        pool.log.push(`参与者 (${pool.players.length}人): ${pool.players.map(p => `${p.nickname}(${p.weapon.name})`).join(', ')}`);
        const itemsDB = getItems();
        if (!itemsDB || itemsDB.length === 0) { logger.error("[AdventureGameApp] 物品数据库为空!"); pool.log.push("错误：系统物品数据丢失!");}

        for (let round = 1; round <= 3; round++) {
            pool.log.push(`\n--- 第 ${round} 轮行动 ---`);
            for (const playerInGame of pool.players) {
                if (playerInGame.status !== 'active' || playerInGame.actionsTaken >= 3) continue;
                const actionRoll = Math.random();
                const playerStrategyProb = STRATEGY_PROBABILITY[playerInGame.strategy];
                let actionType = (actionRoll < playerStrategyProb.fight) ? '战斗' : '搜索';
                pool.log.push(`\n[${playerInGame.nickname}] (${playerInGame.strategy}) 准备执行 ${actionType} 行动...`);

                if (actionType === '搜索') {
                    const itemsFoundCount = Math.floor(Math.random() * 5) + 1;
                    let foundItemsMsgParts = [];
                    if (itemsDB && itemsDB.length > 0) {
                        for (let i = 0; i < itemsFoundCount; i++) {
                            const rarityRoll = Math.random(); let cumulativeProb = 0; let chosenRarity = null;
                            const sortedRefreshRates = Object.entries(pool.mapInfo.refreshRate || {})
                                .sort(([,a],[,b]) => a - b);
                            for (const [rarity, probability] of sortedRefreshRates) {
                                cumulativeProb += probability; if (rarityRoll < cumulativeProb) { chosenRarity = rarity; break; }
                            }
                            if (!chosenRarity && sortedRefreshRates.length > 0) chosenRarity = sortedRefreshRates[0]?.[0] || "普通";
                            else if (!chosenRarity) chosenRarity = "普通";
                            const possibleItems = itemsDB.filter(item => item.rarity === chosenRarity);
                            if (possibleItems.length > 0) {
                                const foundItem = { ...possibleItems[Math.floor(Math.random() * possibleItems.length)] };
                                playerInGame.currentItems.push(foundItem);
                                foundItemsMsgParts.push(`${foundItem.name}(${foundItem.rarity})`);
                            }
                        }
                    }
                    if (foundItemsMsgParts.length > 0) pool.log.push(`[${playerInGame.nickname}] 搜索一番，发现了: ${foundItemsMsgParts.join('、 ')}。`);
                    else pool.log.push(`[${playerInGame.nickname}] 仔细搜索了周围，但一无所获。`);
                } else { // 战斗行动
                    const potentialTargets = pool.players.filter(p => p.userId !== playerInGame.userId && p.status === 'active');
                    if (potentialTargets.length === 0) {
                        pool.log.push(`[${playerInGame.nickname}] 环顾四周，未发现可攻击的目标，改为进行了一次快速搜索。`);
                        if (itemsDB && itemsDB.length > 0 && Math.random() < 0.5) {
                            const commonItems = itemsDB.filter(item => item.rarity === "普通");
                            if (commonItems.length > 0) {
                                const foundItem = { ...commonItems[Math.floor(Math.random() * commonItems.length)] };
                                playerInGame.currentItems.push(foundItem);
                                pool.log.push(`[${playerInGame.nickname}] 快速搜索中，意外找到了 ${foundItem.name}(普通)。`);
                            }
                        }
                    } else {
                        let target = null;
                        const weightedTargets = potentialTargets.map(t => {
                            let weight = 1; // <--- 再次确认此行
                            if (playerInGame.strategy === '猛攻') {
                                if (t.strategy === '猛攻') weight = 3;
                                if (t.strategy === '避战') weight = 0.5;
                            } else if (playerInGame.strategy === '均衡') {
                                if (t.strategy === '猛攻') weight = 1.5;
                                if (t.strategy === '避战') weight = 0.7;
                            } else {
                                if (t.strategy === '猛攻') weight = 1;
                                if (t.strategy === '避战') weight = 0.3;
                            }
                            // logger.debug(`[AdventureGameApp] 目标选择加权: 攻击者 ${playerInGame.nickname}(${playerInGame.strategy}), 目标 ${t.nickname}(${t.strategy}), 权重 ${weight}`);
                            return { player: t, weight: Math.max(0.1, weight) };
                        });
                        const totalWeight = weightedTargets.reduce((sum, t) => sum + t.weight, 0);
                        let randomWeight = Math.random() * totalWeight;
                        for (const wt of weightedTargets) { randomWeight -= wt.weight; if (randomWeight <= 0) { target = wt.player; break; } }
                        if (!target) target = potentialTargets[Math.floor(Math.random() * potentialTargets.length)];

                        pool.log.push(`[${playerInGame.nickname}] (手持 ${playerInGame.weapon.name}) 对 [${target.nickname}] (手持 ${target.weapon.name}) 发起了攻击！`);
                        const combatResult = calculateCombatPowerWithPassives(playerInGame.weapon, target.weapon);
                        combatResult.log.forEach(logEntry => pool.log.push(`  ${logEntry}`));
                        pool.log.push(`  战力对比: [${playerInGame.nickname}] ${combatResult.attackerPower} vs [${target.nickname}] ${combatResult.defenderPower}`);
                        const attackerWins = determineBattleOutcome(combatResult.attackerPower, combatResult.defenderPower);

                        const processBattleSpoils = async (winnerGameObj, loserGameObj, winnerLogName, loserLogName) => {
                            pool.log.push(`  战斗结果: [${winnerLogName}] 胜利！击败了 [${loserLogName}]！`);
                            loserGameObj.status = 'defeated';
                            if (loserGameObj.currentItems.length > 0) {
                                pool.log.push(`  [${winnerLogName}] 缴获了 [${loserLogName}] 的物品: ${loserGameObj.currentItems.map(i => i.name).join('、 ')}。`);
                                winnerGameObj.currentItems.push(...loserGameObj.currentItems);
                                loserGameObj.currentItems = [];
                            }
                            const { playerData: loserStorageData } = await this.getPlayer(loserGameObj.userId);
                            const { playerData: winnerStorageData } = await this.getPlayer(winnerGameObj.userId);

                            if (!loserStorageData || !winnerStorageData) {
                                logger.error(`[AdventureGameApp] processBattleSpoils: 无法获取 ${loserLogName} 或 ${winnerLogName} 的存档数据。`);
                                pool.log.push(`  错误：处理战利品时无法读取玩家存档，武器可能无法正常转移。`);
                                return; // 提前退出，避免后续错误
                            }

                            const lostWeaponName = loserGameObj.weapon.name;
                            const weaponIdxInLoser = loserStorageData.heldWeapons.indexOf(lostWeaponName);
                            if (weaponIdxInLoser > -1 && lostWeaponName !== "新手太刀") {
                                loserStorageData.heldWeapons.splice(weaponIdxInLoser, 1);
                                pool.log.push(`  [${loserLogName}] 失去了武器 "${lostWeaponName}"！`);
                                if (!winnerStorageData.heldWeapons.includes(lostWeaponName)) {
                                    winnerStorageData.heldWeapons.push(lostWeaponName);
                                    pool.log.push(`  [${winnerLogName}] 获得了武器 "${lostWeaponName}"！`);
                                } else {
                                    const allWeapons = getWeapons();
                                    const weaponDataForPrice = allWeapons.find(w => w.name === lostWeaponName);
                                    const compensation = Math.floor((weaponDataForPrice?.price || 50) * 0.3);
                                    winnerStorageData.funds += compensation;
                                    pool.log.push(`  [${winnerLogName}] 已拥有 "${lostWeaponName}"，额外获得了 ${compensation} 金币补偿。`);
                                }
                            } else if (lostWeaponName === "新手太刀") { pool.log.push(`  [${loserLogName}] 的新手太刀受到了保护，未被夺走。`); }
                            else if (weaponIdxInLoser === -1 && lostWeaponName !== "新手太刀") {
                                logger.warn(`[AdventureGameApp] 战斗结算警告：失败者 ${loserLogName} (${loserGameObj.userId}) 的存档中未找到本局使用的武器 ${lostWeaponName}`);
                                pool.log.push(`  警告：[${loserLogName}] 的武器 "${lostWeaponName}" 在其永久仓库中未找到，无法正常处理掉落。`);
                            }
                            await savePlayerData(loserGameObj.userId, loserStorageData);
                            await savePlayerData(winnerGameObj.userId, winnerStorageData);
                            pool.log.push(`  [${loserLogName}] 被淘汰出局，本局探索结束，没有收益。`);
                        };

                        if (attackerWins) await processBattleSpoils(playerInGame, target, playerInGame.nickname, target.nickname);
                        else await processBattleSpoils(target, playerInGame, target.nickname, playerInGame.nickname);
                    }
                }
                playerInGame.actionsTaken++;
            }
        }

        pool.log.push(`\n--- 战局结束，开始结算 ---`);
        for (const playerInGame of pool.players) {
            if (playerInGame.status === 'active') {
                const { playerData: playerStorageData, isNewPlayer: _ } = await this.getPlayer(playerInGame.userId);
                if (!playerStorageData) {
                    logger.error(`[AdventureGameApp] 结算阶段: 玩家 ${playerInGame.nickname} (${playerInGame.userId}) 数据获取失败。`);
                    pool.log.push(`[${playerInGame.nickname}] 结算失败：无法读取您的存档。`);
                    continue;
                }
                let totalValueGained = 0; let collectiblesGainedNames = [];
                for (const item of playerInGame.currentItems) {
                    if (item.rarity === '收藏品') {
                        playerStorageData.collectibles.push({ name: item.name, rarity: item.rarity, price: item.price });
                        collectiblesGainedNames.push(item.name);
                    } else totalValueGained += (item.price || 0);
                }
                playerStorageData.funds += totalValueGained;
                await savePlayerData(playerInGame.userId, playerStorageData);
                let summary = `[${playerInGame.nickname}] 成功撤离！`;
                if (totalValueGained > 0) summary += `获得金币: ${totalValueGained}。`;
                if (collectiblesGainedNames.length > 0) summary += `获得收藏品: ${collectiblesGainedNames.join('、 ')}。`;
                if (totalValueGained === 0 && collectiblesGainedNames.length === 0 && playerInGame.currentItems.length > 0) summary += `虽然带回了一些物品，但它们没有直接金币价值且非收藏品。`;
                else if (playerInGame.currentItems.length === 0 && totalValueGained === 0 && collectiblesGainedNames.length === 0) summary += `虽然安全返回，但两手空空。`;
                pool.log.push(summary);
            }
        }
        const groupToNotify = global.Bot ? global.Bot.pickGroup(pool.groupId) : null;
        if (groupToNotify && pool.log && pool.log.length > 0) {
            try {
                const forwardMsgNodes = []; let currentMessageNodeContent = ""; const MAX_NODE_LENGTH = 3800; // 稍微减小一点以防万一
                for (const logEntry of pool.log) {
                    if (currentMessageNodeContent.length + logEntry.length + 1 > MAX_NODE_LENGTH && currentMessageNodeContent.length > 0) {
                        forwardMsgNodes.push({ message: currentMessageNodeContent.trim(), nickname: global.Bot.nickname, user_id: global.Bot.uin });
                        currentMessageNodeContent = "";
                    }
                    currentMessageNodeContent += logEntry + "\n";
                }
                if (currentMessageNodeContent.trim().length > 0) {
                    forwardMsgNodes.push({ message: currentMessageNodeContent.trim(), nickname: "战局播报员", user_id: global.Bot.uin });
                }
                if (forwardMsgNodes.length > 0) {
                    const fullForwardMsg = await global.Bot.makeForwardMsg(forwardMsgNodes);
                    await groupToNotify.sendMsg(fullForwardMsg);
                } else await groupToNotify.sendMsg("[AdventureGame] 战局日志为空或无法生成转发。");
            } catch (sendError) {
                logger.error(`[AdventureGameApp] 发送战局日志(转发)失败 to ${pool.groupId}:`, sendError);
                const logMessageString = pool.log.join('\n');
                try { await groupToNotify.sendMsg(logMessageString.substring(0, 1500) + (logMessageString.length > 1500 ? "\n(日志过长，已截断)" : "")); }
                catch (fallbackError) { logger.error(`[AdventureGameApp] 降级发送日志也失败:`, fallbackError); await groupToNotify.sendMsg("[AdventureGame] 战局结束，日志发送失败。"); }
            }
        } else if (groupToNotify && (!pool.log || pool.log.length === 0)) await groupToNotify.sendMsg("[AdventureGame] 战局结束，无日志记录。");
        else if (!groupToNotify) logger.error(`[AdventureGameApp] 无法找到群组 ${pool.groupId} (Bot: ${global.Bot ? 'OK' : 'null'}) 发送日志。`);
        delete gamePools[mapName];
    }

    async viewMyInfo(e) {
        const userId = e.user_id;
        const nickname = e.sender.card || e.sender.nickname || `玩家${userId.slice(-4)}`;
        const { playerData, isNewPlayer } = await this.getPlayer(userId, nickname);

        if (!playerData) {
            logger.error(`[AdventureGameApp] viewMyInfo: 玩家 ${userId} 数据获取失败或返回null/undefined。`);
            return e.reply("抱歉，查询您的信息时遇到问题，可能档案尚未成功创建或读取失败，请稍后再试或联系管理员。");
        }

        let infoMsg = "";
        if (isNewPlayer) {
            infoMsg += `欢迎新玩家，${playerData.nickname}！您的档案已自动创建。\n`;
            infoMsg += "--- 这是您的初始信息 ---\n";
        } else {
            infoMsg += `--- ${playerData.nickname} 的冒险者档案 ---\n`;
        }
        infoMsg += `财富: ${playerData.funds} 金币\n`;
        infoMsg += `持有武器 (${playerData.heldWeapons ? playerData.heldWeapons.length : 0}):\n`; // 增加 playerData.heldWeapons 存在性检查
        if (playerData.heldWeapons && playerData.heldWeapons.length > 0) {
            const weaponsData = getWeapons();
            playerData.heldWeapons.forEach(wName => {
                const wData = weaponsData ? weaponsData.find(w => w.name === wName) : null;
                infoMsg += `  - ${wName} (战力: ${wData?.baseCombatPower || '未知'})\n`;
            });
        } else infoMsg += `  空空如也\n`;
        infoMsg += `大红 (${playerData.collectibles ? playerData.collectibles.length : 0}):\n`; // 增加 playerData.collectibles 存在性检查
        if (playerData.collectibles && playerData.collectibles.length > 0) {
            playerData.collectibles.forEach(c => {
                infoMsg += `  - ${c.name} (${c.rarity}), 估价: ${c.price || 0} 金币\n`;
            });
        } else infoMsg += `  暂无收藏\n`;
        e.reply(infoMsg);
        return true;
    }

    async buyWeaponFromShop(e) {
        const userId = e.user_id;
        const nickname = e.sender.card || e.sender.nickname || `玩家${userId.slice(-4)}`;
        const weaponName = e.msg.replace("#购买武器", "").trim();

        const weapons = getWeapons();
        if (!weapons || weapons.length === 0) return e.reply("商店数据暂未加载，无法购买武器。");
        const weaponToBuy = weapons.find(w => w.name === weaponName && w.price > 0);
        if (!weaponToBuy) return e.reply(`武器 "${weaponName}" 不存在或不可购买。`);

        const { playerData } = await this.getPlayer(userId, nickname);
        if (!playerData) return e.reply("获取玩家信息失败，无法购买。");

        if (playerData.heldWeapons && playerData.heldWeapons.includes(weaponName)) return e.reply(`您已拥有武器 "${weaponName}"。`);
        if (playerData.funds < weaponToBuy.price) return e.reply(`金币不足！购买 "${weaponName}" 需要 ${weaponToBuy.price} 金币，您只有 ${playerData.funds} 金币。`);

        playerData.funds -= weaponToBuy.price;
        if (!playerData.heldWeapons) playerData.heldWeapons = []; // 初始化以防万一
        playerData.heldWeapons.push(weaponName);
        await savePlayerData(userId, playerData);

        e.reply(`[${playerData.nickname}] 成功购买武器 "${weaponName}"！花费 ${weaponToBuy.price} 金币，剩余 ${playerData.funds} 金币。`);
        return true;
    }

    async sellItemFromInventory(e) {
        const userId = e.user_id;
        const nickname = e.sender.card || e.sender.nickname || `玩家${userId.slice(-4)}`;
        const itemName = e.msg.replace("#出售物品", "").trim();

        const { playerData } = await this.getPlayer(userId, nickname);
        if (!playerData) return e.reply("获取玩家信息失败，无法出售。");
        if (!playerData.collectibles) playerData.collectibles = []; // 初始化

        const collectibleIndex = playerData.collectibles.findIndex(c => c.name === itemName);
        if (collectibleIndex > -1) {
            const itemToSell = playerData.collectibles[collectibleIndex];
            const sellPrice = Math.floor((itemToSell.price || 0) * 0.7);
            if (sellPrice <= 0 && (itemToSell.price || 0) > 0) return e.reply(`收藏品 "${itemName}" 价值过低，出售无法获得金币。`);
            if ((itemToSell.price || 0) <= 0) return e.reply(`收藏品 "${itemName}" 没有设定有效价格，无法出售。`);

            playerData.funds += sellPrice;
            playerData.collectibles.splice(collectibleIndex, 1);
            await savePlayerData(userId, playerData);
            return e.reply(`[${playerData.nickname}] 成功出售收藏品 "${itemName}"，获得 ${sellPrice} 金币。剩余 ${playerData.funds} 金币。`);
        }
        e.reply(`您未持有可出售的收藏品 "${itemName}"，或该物品不是收藏品。`);
        return true;
    }
}
