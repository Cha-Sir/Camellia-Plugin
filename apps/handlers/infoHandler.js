// camellia-plugin/apps/handlers/infoHandler.js

import { getPlayerData, savePlayerData, getMaps, getWeapons, getAllPlayerData, getTitles, getMercenaries } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import { MAX_MESSAGE_LENGTH, VALID_STRATEGIES, INJURY_LEVELS, INITIAL_WEAPON_NAME, ARENA_TEAM_SIZE } from '../../utils/constants.js';

export async function handleClaimNewbieGift(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) {
        return e.reply("身份验证失败，无法领取礼包。");
    }

    if (playerData.hasClaimedNewbieGift) {
        return e.reply(`【${playerData.nickname}】您已经领取过新手礼包了，每位调查员限领一次哦。`);
    }

    const giftFunds = 20000;
    playerData.funds += giftFunds;
    playerData.seedsOfLight = (playerData.seedsOfLight || 0) + 10; // 新手礼包赠送10光之种

    const allWeapons = getWeapons();
    const purchasableWeapons = allWeapons.filter(w => w.price > 0 && w.name !== INITIAL_WEAPON_NAME);
    let giftedWeaponName = null;
    let giftedWeaponMsg = "但目前商店没有可赠送的额外武器。";

    if (purchasableWeapons.length > 0) {
        const randomWeapon = purchasableWeapons[Math.floor(Math.random() * purchasableWeapons.length)];
        giftedWeaponName = randomWeapon.name;
        if (!playerData.heldWeapons.includes(giftedWeaponName)) {
            playerData.heldWeapons.push(giftedWeaponName);
        }
        giftedWeaponMsg = `额外获得随机适用装备: ${giftedWeaponName}！`;
    }

    playerData.hasClaimedNewbieGift = true;
    await savePlayerData(userId, playerData);

    let replyMsg = `🎉 新手礼包已查收！🎉\n`;
    replyMsg += `【${playerData.nickname}】恭喜您获得 ${giftFunds} 启动资金！\n`;
    replyMsg += `同时获得 10 光之种，用于强化您的佣兵！\n`;
    replyMsg += `${giftedWeaponMsg}\n`;
    replyMsg += `当前总资金: ${playerData.funds}。当前光之种: ${playerData.seedsOfLight}。\n祝您在都市的探索一帆风顺！`;

    return e.reply(replyMsg);
}

export async function handleViewMyInfo(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData, isNewPlayer } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) {
        logger.error(`[InfoHandler] viewMyInfo: 调查员 ${userId} 档案同步失败。`);
        return e.reply("抱歉，您的个人档案模块出现错误，请稍后再试。");
    }

    let infoMsg = "";
    const displayedNickname = playerData.activeTitle ? `【${playerData.activeTitle}】 ${playerData.nickname}` : playerData.nickname;

    if (isNewPlayer) {
        infoMsg += `欢迎新晋调查员，${displayedNickname}！您的个人档案已建立。\n`;
        infoMsg += "--- 这是您的初始档案信息 ---\n";
    } else {
        infoMsg += `--- 调查员 ${displayedNickname} 的个人档案 ---\n`;
    }
    infoMsg += `资金: ${playerData.funds}\n`;
    infoMsg += `光之种: ${playerData.seedsOfLight || 0} (用于佣兵进阶)\n`; // 显示光之种

    if (playerData.needsTreatment && playerData.permanentInjuryStatus && playerData.permanentInjuryStatus !== 'none') {
        const injuryName = INJURY_LEVELS[playerData.permanentInjuryStatus]?.name || playerData.permanentInjuryStatus;
        infoMsg += `健康状况: 【${injuryName}】 (建议使用 #治疗 进行休整)\n`;
    } else {
        infoMsg += `健康状况: 良好\n`;
    }

    infoMsg += `当前身份标识: ${playerData.activeTitle ? `【${playerData.activeTitle}】` : '无'}\n`;
    if (playerData.purchasedTitles && playerData.purchasedTitles.length > 0) {
        infoMsg += `已认证标识 (${playerData.purchasedTitles.length}): ${playerData.purchasedTitles.join('、 ')}\n`;
    } else {
        infoMsg += `已认证标识: 无\n`;
    }

    infoMsg += `默认装备: ${playerData.defaultWeapon || '未设置'}\n`;
    infoMsg += `默认策略: ${playerData.defaultStrategy || '未设置'}\n`;
    infoMsg += `自动治疗: ${playerData.autoHealEnabled ? '开启' : '关闭'}\n`;

    infoMsg += `\n持有装备 (${playerData.heldWeapons ? playerData.heldWeapons.length : 0}):\n`;
    if (playerData.heldWeapons && playerData.heldWeapons.length > 0) {
        const weaponsData = getWeapons();
        playerData.heldWeapons.forEach(wName => {
            const wData = weaponsData.find(w => w.name === wName);
            infoMsg += `  - ${wName} (稀有度: ${wData?.rarity || '未知'}, 威胁评估: ${wData?.baseCombatPower || '未知'}, 特性: ${wData?.passive || '无'})\n`;
        });
    } else {
        infoMsg += `  装备库为空\n`;
    }
    infoMsg += `\n个人收藏 (${playerData.collectibles ? playerData.collectibles.length : 0}):\n`;
    if (playerData.collectibles && playerData.collectibles.length > 0) {
        playerData.collectibles.forEach(c => {
            infoMsg += `  - ${c.name} (${c.rarity || '未知'}), 参考价值: ${c.price || 0} 资金\n`;
        });
    } else {
        infoMsg += `  暂无特殊收藏品\n`;
    }

    infoMsg += `\n佣兵数量: ${playerData.mercenaries ? playerData.mercenaries.length : 0} (使用 #佣兵列表 查看详情)\n`;
    if (playerData.arenaTeam && playerData.arenaTeam.length > 0) {
        const allMercDefs = getMercenaries();
        const teamNames = playerData.arenaTeam.map(id => {
            const def = allMercDefs.find(m => m.id === id);
            return def ? def.name : `未知佣兵(${id})`;
        });
        infoMsg += `竞技场队伍 (${playerData.arenaTeam.length}/${ARENA_TEAM_SIZE}): ${teamNames.join('、 ')}\n`;
    } else {
        infoMsg += `竞技场队伍: 未配置\n`;
    }


    if (infoMsg.length > MAX_MESSAGE_LENGTH * 2 && global.Bot && global.Bot.makeForwardMsg) {
        try {
            // For personal info, usually better as one block, so pass as single string in array.
            const forwardMsg = await makeForwardMsgWithContent([infoMsg.trim()], "个人档案");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(infoMsg.substring(0, MAX_MESSAGE_LENGTH) + "\n...(个人档案过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建个人档案转发失败:', err);
            e.reply(infoMsg.substring(0, MAX_MESSAGE_LENGTH) + "\n...(信息过载，部分截断)");
        }
    } else {
        e.reply(infoMsg);
    }
    return true;
}

export async function handleShowHelp(e, pluginInstance) {
    let helpMsg = "--- 都市迷踪与佣兵竞技行动手册 ---\n\n";
    helpMsg += "  #新手礼包 - (限领一次)获得启动资金、随机装备和少量光之种。\n";
    helpMsg += "【冒险准备 (搜打撤)】\n";
    helpMsg += "  #装备 武器名 - 设置默认地图武器。\n";
    helpMsg += `  #策略 策略名 - 设置默认地图策略。可选：${VALID_STRATEGIES.join('、 ')}。\n`;
    helpMsg += "  #自动治疗 - 开/关进入地图时自动治疗功能。\n\n";

    helpMsg += "【开始冒险 (搜打撤)】\n";
    helpMsg += "  #进入地图 地图名/编号 [武器 武器名 策略 策略名]\n";
    helpMsg += "    - 前往指定区域探索。若未指定，则使用默认设置。\n";
    helpMsg += "  #退出队列 - 离开当前地图的待命队列。\n";
    helpMsg += "  #查看队列 - 查看所有地图的待命人数。\n\n";

    helpMsg += "【角色信息 & 装备 (搜打撤)】\n";
    helpMsg += "  #我的信息 - 查看个人资金、光之种、装备、收藏品、佣兵概况等。\n";
    helpMsg += "  #武器列表 - 显示所有已记录的装备型号。\n";
    helpMsg += "  #查看商店 - 访问“黑市”交易装备与身份标识。\n";
    helpMsg += "  #购买武器 武器名称 - 从“黑市”采购装备。\n";
    helpMsg += "  #出售物品 物品名称 - 将“收藏品”兑换为资金。\n\n";

    helpMsg += "【称号系统 (搜打撤)】\n";
    helpMsg += "  #购买称号 称号名称 - 认证新的身份标识。\n";
    helpMsg += "  #装备称号 称号名称 / #装备称号 无 - 更换或卸下标识。\n\n";

    helpMsg += "【医疗 & 其他情报 (搜打撤)】\n";
    helpMsg += "  #治疗 - 查看当前伤势及治疗费用。\n";
    helpMsg += "  #确认治疗 - 执行治疗。\n";
    helpMsg += "  #地图列表 - 显示已知区域情报(附带编号)。\n";
    helpMsg += "  #排行榜 - 查看“资金”排行榜。\n";
    helpMsg += "  #查看当前活动 - 获取最新活动信息。\n\n";

    helpMsg += "--- 佣兵与竞技场系统 ---\n\n";
    helpMsg += "【佣兵招募与培养】\n";
    helpMsg += "  #随机招募 - 花费资金招募一名随机佣兵。\n";
    helpMsg += "  #随机十连 - 花费资金进行十次招募 (保底三星以上)。\n";
    helpMsg += "  #每日十连 - 每日免费进行一次十连招募 (保底三星以上)。\n";
    helpMsg += "  #佣兵列表 - 查看您拥有的所有佣兵及其摘要(含光之种数量)。\n";
    helpMsg += "  #查看佣兵 [序号/名称] - 查看指定佣兵详细信息、图片及进阶消耗。\n";
    helpMsg += "  #进阶 [序号/名称] - 消耗光之种提升指定佣兵的进阶等级。\n\n";


    helpMsg += "【竞技场】\n";
    helpMsg += `  #佣兵配队 序号1,序号2,...,序号${ARENA_TEAM_SIZE} - 配置竞技场队伍 (使用 #佣兵列表 中的序号)。\n`;
    helpMsg += "  #加入竞技场 - 加入匹配队列，等待与其他玩家对战。\n";
    helpMsg += "  #退出竞技场队列 - 离开竞技场匹配队列。\n\n";

    helpMsg += "【帮助 & 管理】\n";
    helpMsg += "  #搜打撤帮助 - 显示此行动手册。\n";
    helpMsg += "  #重载冒险数据 - (仅限“管理员”)强制刷新核心系统数据。\n";


    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            // For help, it's better to send it as one coherent block of text.
            // Pass as a single string in an array.
            const forwardMsg = await makeForwardMsgWithContent([helpMsg.trim()], "都市迷踪行动手册");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(helpMsg); // Fallback
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建帮助手册转发失败:', err);
            e.reply(helpMsg);
        }
    } else {
        e.reply(helpMsg);
    }
    return true;
}


export async function handleListMaps(e, pluginInstance) {
    const maps = getMaps();
    if (!maps || maps.length === 0) {
        return e.reply("当前“都市档案库”中没有可用的区域情报。");
    }
    let mapListText = "--- 已知异常区域列表 (可使用 #进入地图 区域编号 进入) ---\n";
    maps.forEach((map, index) => {
        mapListText += `\n${index + 1}. 区域名称: ${map.name}\n` +
            `  “信息费”: ${map.entryFee} 资金\n` +
            `  建议威胁评估: ${map.limitCombatPower}\n` +
            `  调查小队上限: ${map.playerCapacity}人\n` +
            `  区域描述: ${map.description || '情报缺失'}\n` +
            `  物资信号(参考 - 地图私有池): 普通(${Math.round((map.refreshRate?.['普通'] || 0) * 100)}%), 稀有(${Math.round((map.refreshRate?.['稀有'] || 0) * 100)}%), 罕见(${Math.round((map.refreshRate?.['罕见'] || 0) * 100)}%), 史诗(${Math.round((map.refreshRate?.['史诗'] || 0) * 100)}%), 传奇(${Math.round((map.refreshRate?.['传奇'] || 0) * 100)}%), 收藏品(${Math.round((map.refreshRate?.['收藏品'] || 0) * 100)}%)\n` +
            `  (注: 实际搜寻还会受到公共物品池影响)\n`;
    });

    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([mapListText.trim()], "都市区域档案");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(mapListText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(区域情报过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建区域情报转发失败:', err);
            e.reply(mapListText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(情报过载，部分截断)");
        }
    } else {
        e.reply(mapListText);
    }
    return true;
}

export async function handleListWeapons(e, pluginInstance) {
    const weapons = getWeapons();
    if (!weapons || weapons.length === 0) {
        return e.reply("当前“装备数据库”中没有信息。");
    }
    let weaponListText = "--- 装备数据库 ---\n";
    weapons.forEach(w => {
        weaponListText += `\n型号: ${w.name}\n` +
            `  稀有度: ${w.rarity || '标准'}\n` +
            `  基础威胁评估: ${w.baseCombatPower}\n` +
            `  特性: ${w.passive || '无'} (类型: ${w.passiveType || 'none'})\n` +
            `     效果: ${w.passiveDescription || w.description || '暂无详细描述'}\n` +
            `  “黑市”价格: ${w.price > 0 ? w.price + ' 资金' : (w.name === INITIAL_WEAPON_NAME ? '初始装备' : '非卖品')}\n`;
    });

    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([weaponListText.trim()], "装备数据库");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(weaponListText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(装备数据过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建装备数据库转发失败:', err);
            e.reply(weaponListText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(数据过载，部分截断)");
        }
    } else {
        e.reply(weaponListText);
    }
    return true;
}

export async function handleShowLeaderboard(e, pluginInstance) {
    const allPlayersData = await getAllPlayerData();
    const allGameWeapons = getWeapons();

    if (!allPlayersData || allPlayersData.length === 0) {
        return e.reply("“都市财富榜”暂无数据。");
    }

    const leaderboard = allPlayersData.map(player => {
        let bestWeaponName = "无装备";
        let maxCombatPower = 0;
        if (player.heldWeapons && player.heldWeapons.length > 0 && allGameWeapons && allGameWeapons.length > 0) {
            player.heldWeapons.forEach(weaponName => {
                const weaponData = allGameWeapons.find(w => w.name === weaponName);
                if (weaponData && weaponData.baseCombatPower > maxCombatPower) {
                    maxCombatPower = weaponData.baseCombatPower;
                    bestWeaponName = `${weaponName} (威胁评估 ${maxCombatPower})`;
                }
            });
            if (bestWeaponName === "无装备" && player.heldWeapons.includes(INITIAL_WEAPON_NAME)) {
                const defaultWeapon = allGameWeapons.find(w => w.name === INITIAL_WEAPON_NAME);
                if (defaultWeapon) bestWeaponName = `${INITIAL_WEAPON_NAME} (威胁评估 ${defaultWeapon.baseCombatPower})`;
            }
        }
        const displayedNickname = player.activeTitle ? `【${player.activeTitle}】 ${player.nickname}` : player.nickname;
        return {
            nickname: displayedNickname || `调查员${String(player.userId).slice(-4)}`,
            userId: player.userId,
            funds: player.funds || 0,
            bestWeaponDisplay: bestWeaponName,
            seedsOfLight: player.seedsOfLight || 0 // 添加光之种到排行榜数据
        };
    }).sort((a, b) => b.funds - a.funds) // 主排序：资金
        .slice(0, 10);

    // 可以考虑添加一个光之种排行榜，或者在财富榜上附带显示光之种数量
    // 这里我们仅在财富榜条目中加入光之种信息

    if (leaderboard.length === 0) {
        return e.reply("“都市财富榜”暂无有效数据。");
    }

    let leaderboardText = "--- 都市财富榜 Top 10 ---\n";
    leaderboard.forEach((player, index) => {
        leaderboardText += `\n${index + 1}. ${player.nickname} (编号: ...${String(player.userId).slice(-4)})\n` +
            `   资金: ${player.funds} | 光之种: ${player.seedsOfLight}\n` + // 显示光之种
            `   最强装备(搜打撤): ${player.bestWeaponDisplay}\n`;
    });
    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([leaderboardText.trim()], "都市财富榜");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(leaderboardText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(排行榜数据过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建财富榜转发失败:', err);
            e.reply(leaderboardText.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(数据过载，部分截断)");
        }
    } else {
        e.reply(leaderboardText);
    }
    return true;
}

export async function handleSetDefaultWeapon(e, pluginInstance) {
    const userId = e.user_id;
    const match = e.msg.match(/^#装备\s*([^\s]+)$/);
    if (!match) return false;

    const weaponName = match[1];
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法设置默认装备。");

    const allWeapons = getWeapons();
    const weaponDef = allWeapons.find(w => w.name === weaponName);

    if (!weaponDef) return e.reply(`未知的装备型号: "${weaponName}"。`);
    if (!playerData.heldWeapons || !playerData.heldWeapons.includes(weaponName)) {
        return e.reply(`您未持有装备 "${weaponName}"，无法设置其为默认。`);
    }

    playerData.defaultWeapon = weaponName;
    await savePlayerData(userId, playerData);
    return e.reply(`默认地图武器已设置为: ${weaponName}。`);
}

export async function handleSetDefaultStrategy(e, pluginInstance) {
    const userId = e.user_id;
    const match = e.msg.match(/^#策略\s*([^\s]+)$/);
    if (!match) return false;

    const strategyName = match[1];
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法设置默认策略。");
    if (!VALID_STRATEGIES.includes(strategyName)) {
        return e.reply(`未知的策略: "${strategyName}". 可选策略: ${VALID_STRATEGIES.join(', ')}.`);
    }

    playerData.defaultStrategy = strategyName;
    await savePlayerData(userId, playerData);
    return e.reply(`默认地图策略已设置为: ${strategyName}。`);
}

export async function handleToggleAutoHeal(e, pluginInstance) {
    const userId = e.user_id;
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法切换自动治疗状态。");

    playerData.autoHealEnabled = !playerData.autoHealEnabled;
    await savePlayerData(userId, playerData);
    return e.reply(`自动治疗功能已 ${playerData.autoHealEnabled ? '开启' : '关闭'}。`);
}