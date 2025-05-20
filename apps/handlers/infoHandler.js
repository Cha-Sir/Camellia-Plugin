// camellia-plugin/apps/handlers/infoHandler.js

/**
 * @file 信息展示和帮助指令处理器。
 * @description 处理查看个人信息、地图/武器列表、排行榜和帮助。
 */

import { getPlayerData, getMaps, getWeapons, getAllPlayerData, getTitles } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import { MAX_MESSAGE_LENGTH, VALID_STRATEGIES } from '../../utils/constants.js';

/**
 * 处理查看“我的信息”的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
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

    // 显示称号信息
    infoMsg += `当前身份标识: ${playerData.activeTitle ? `【${playerData.activeTitle}】` : '无'}\n`;
    if (playerData.purchasedTitles && playerData.purchasedTitles.length > 0) {
        infoMsg += `已认证标识 (${playerData.purchasedTitles.length}): ${playerData.purchasedTitles.join('、 ')}\n`;
    } else {
        infoMsg += `已认证标识: 无\n`;
    }


    infoMsg += `持有装备 (${playerData.heldWeapons ? playerData.heldWeapons.length : 0}):\n`;
    if (playerData.heldWeapons && playerData.heldWeapons.length > 0) {
        const weaponsData = getWeapons();
        playerData.heldWeapons.forEach(wName => {
            const wData = weaponsData ? weaponsData.find(w => w.name === wName) : null;
            infoMsg += `  - ${wName} (稀有度: ${wData?.rarity || '未知'}, 威胁评估: ${wData?.baseCombatPower || '未知'}, 特性: ${wData?.passive || '无'})\n`;
        });
    } else {
        infoMsg += `  装备库为空\n`;
    }
    infoMsg += `个人收藏 (${playerData.collectibles ? playerData.collectibles.length : 0}):\n`;
    if (playerData.collectibles && playerData.collectibles.length > 0) {
        playerData.collectibles.forEach(c => {
            infoMsg += `  - ${c.name} (${c.rarity}), 参考价值: ${c.price || 0} 资金\n`;
        });
    } else {
        infoMsg += `  暂无特殊收藏品\n`;
    }

    if (infoMsg.length > MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) {
        try {
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

/**
 * 处理显示帮助信息的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleShowHelp(e, pluginInstance) {
    const helpMsg = `--- 都市迷踪行动手册 ---\n` +
        `#进入地图 地图名/编号 武器 武器名 策略 策略名 - 前往指定异常区域进行探索。\n` +
        `  可选行动策略: ${VALID_STRATEGIES.join('、 ')}\n` +
        `#退出队列 - 离开当前地图的待命队列。\n`+
        `#查看队列 - 查看所有地图的待命人数。\n`+
        `#查看商店 - 访问“黑市”查看可交易的装备与身份标识。\n` +
        `#购买武器 武器名称 - 从“黑市”采购指定装备。\n` +
        `#购买称号 称号名称 - 从“黑市”认证新的身份标识。\n` +
        `#装备称号 称号名称 / #装备称号 无 - 展示或卸下已认证的身份标识。\n` +
        `#出售物品 物品名称 - 将“收藏品”兑换为资金。\n` +
        `#我的信息 - 查看个人资金、装备、收藏品和身份标识。\n` +
        `#地图列表 - 显示所有已知的异常区域及其情报(附带编号)。\n` +
        `#武器列表 - 显示所有已记录的装备型号及其参数。\n` +
        `#排行榜 - 查看“资金”排行榜。\n` +
        `#查看当前活动 - 获取最新的活动信息。\n` +
        `#搜打撤帮助 - 显示此行动手册。\n` +
        `#重载冒险数据 - (仅限“管理员”)强制刷新核心系统数据。`;
    e.reply(helpMsg);
    return true;
}

/**
 * 处理显示地图列表的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleListMaps(e, pluginInstance) {
    const maps = getMaps();
    if (!maps || maps.length === 0) {
        return e.reply("当前“都市档案库”中没有可用的区域情报。");
    }
    let mapListMsg = "--- 已知异常区域列表 (可使用 #进入地图 区域编号 进入) ---\n";
    maps.forEach((map, index) => {
        mapListMsg += `\n${index + 1}. 区域名称: ${map.name}\n` +
            `  “信息费”: ${map.entryFee} 资金\n` +
            `  建议威胁评估: ${map.limitCombatPower}\n` +
            `  调查小队上限: ${map.playerCapacity}人\n` +
            `  区域描述: ${map.description || '情报缺失'}\n` +
            `  物资信号(参考 - 地图私有池): 普通(${Math.round((map.refreshRate?.['普通'] || 0) * 100)}%), 稀有(${Math.round((map.refreshRate?.['稀有'] || 0) * 100)}%), 罕见(${Math.round((map.refreshRate?.['罕见'] || 0) * 100)}%), 史诗(${Math.round((map.refreshRate?.['史诗'] || 0) * 100)}%), 传奇(${Math.round((map.refreshRate?.['传奇'] || 0) * 100)}%), 收藏品(${Math.round((map.refreshRate?.['收藏品'] || 0) * 100)}%)\n` +
            `  (注: 实际搜寻还会受到公共物品池影响)\n`;
    });

    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([mapListMsg.trim()], "都市区域档案");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(mapListMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(区域情报过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建区域情报转发失败:', err);
            e.reply(mapListMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(情报过载，部分截断)");
        }
    } else {
        e.reply(mapListMsg);
    }
    return true;
}

/**
 * 处理显示武器列表的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleListWeapons(e, pluginInstance) {
    const weapons = getWeapons();
    if (!weapons || weapons.length === 0) {
        return e.reply("当前“装备数据库”中没有信息。");
    }
    let weaponListMsg = "--- 装备数据库 ---\n";
    weapons.forEach(w => {
        weaponListMsg += `\n型号: ${w.name}\n` +
            `  稀有度: ${w.rarity || '标准'}\n` +
            `  基础威胁评估: ${w.baseCombatPower}\n` +
            `  特性: ${w.passive || '无'} (类型: ${w.passiveType || 'none'})\n` + // 显示被动类型
            `     效果: ${w.passiveDescription || w.description || '暂无详细描述'}\n` + // 显示被动描述
            `  “黑市”价格: ${w.price > 0 ? w.price + ' 资金' : '非卖品/初始装备'}\n`;
        // `  描述: ${w.description || '暂无公开描述'}\n`; // 可以合并到特性效果里
    });

    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([weaponListMsg.trim()], "装备数据库");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(weaponListMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(装备数据过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建装备数据库转发失败:', err);
            e.reply(weaponListMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(数据过载，部分截断)");
        }
    } else {
        e.reply(weaponListMsg);
    }
    return true;
}

/**
 * 处理显示排行榜的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleShowLeaderboard(e, pluginInstance) {
    const allPlayersData = await getAllPlayerData();
    const allGameWeapons = getWeapons();
    // const allGameTitles = getTitles(); // 如果需要显示称号效果，可以加载

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
            if (bestWeaponName === "无装备" && player.heldWeapons.includes("制式警棍")) { // 确保制式警棍能正确显示
                const defaultWeapon = allGameWeapons.find(w => w.name === "制式警棍");
                if (defaultWeapon) bestWeaponName = `制式警棍 (威胁评估 ${defaultWeapon.baseCombatPower})`;
            }
        }
        const displayedNickname = player.activeTitle ? `【${player.activeTitle}】 ${player.nickname}` : player.nickname;
        return {
            nickname: displayedNickname || `调查员${String(player.userId).slice(-4)}`,
            userId: player.userId,
            funds: player.funds || 0,
            bestWeaponDisplay: bestWeaponName,
        };
    }).sort((a, b) => b.funds - a.funds)
        .slice(0, 10); // 只显示前10名

    if (leaderboard.length === 0) {
        return e.reply("“都市财富榜”暂无有效数据。");
    }

    let leaderboardMsg = "--- 都市财富榜 Top 10 ---\n";
    leaderboard.forEach((player, index) => {
        leaderboardMsg += `\n${index + 1}. ${player.nickname} (编号: ...${String(player.userId).slice(-4)})\n` + // 确保 userId 正确显示
            `   资金: ${player.funds}\n` +
            `   最强装备: ${player.bestWeaponDisplay}\n`;
    });

    if (global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([leaderboardMsg.trim()], "都市财富榜");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(leaderboardMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(排行榜数据过长，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[InfoHandler] 创建财富榜转发失败:', err);
            e.reply(leaderboardMsg.substring(0, MAX_MESSAGE_LENGTH * 2) + "\n...(数据过载，部分截断)");
        }
    } else {
        e.reply(leaderboardMsg);
    }
    return true;
}
