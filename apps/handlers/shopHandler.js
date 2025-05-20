// camellia-plugin/apps/handlers/shopHandler.js

/**
 * @file 商店相关逻辑处理器。
 * @description 处理查看商店、购买武器、出售物品等功能。
 */

// 从 camellia-plugin/apps/handlers/shopHandler.js 到 camellia-plugin/utils/
import { getWeapons, getPlayerData, savePlayerData } from '../../utils/dataManager.js'; // Removed getItems as it's not used here
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import { MAX_MESSAGE_LENGTH } from '../../utils/constants.js';

/**
 * 处理查看商店的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleViewShop(e, pluginInstance) {
    const weapons = getWeapons(); // 获取所有武器数据
    if (!weapons || weapons.length === 0) {
        return e.reply("“黑市”线路不稳定，请稍后再试！ (武器数据未加载)");
    }

    let shopMsg = "--- “黑市”装备终端 ---\n可用装备 (指令: #购买武器 装备名称):\n";
    // 筛选出可购买的武器 (价格大于0)
    const purchasableWeapons = weapons.filter(w => w.price > 0);

    if (purchasableWeapons.length === 0) {
        shopMsg += "  暂无可交易的装备。\n";
    } else {
        purchasableWeapons.forEach(w => {
            shopMsg += `  - ${w.name} (稀有度: ${w.rarity || '标准'}, 威胁评估: ${w.baseCombatPower}, 特性: ${w.passive || '无'}, 价格: ${w.price} 资金)\n`;
        });
    }

    // 如果消息过长，尝试使用转发消息发送
    if (shopMsg.length > MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([shopMsg.trim()], "黑市情报");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(shopMsg.substring(0, MAX_MESSAGE_LENGTH) + "\n...(黑市情报过载，部分信息未能完整显示)");
            }
        } catch (err) {
            logger.error('[ShopHandler] 创建黑市信息转发失败:', err);
            e.reply(shopMsg.substring(0, MAX_MESSAGE_LENGTH) + "\n...(信息过载，部分截断，请尝试缩小查询范围)");
        }
    } else {
        e.reply(shopMsg);
    }
    return true;
}

/**
 * 处理从商店购买武器的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleBuyWeaponFromShop(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const weaponName = e.msg.replace("#购买武器", "").trim(); // 获取要购买的武器名称

    const weapons = getWeapons();
    if (!weapons || weapons.length === 0) return e.reply("“黑市”线路不稳定，无法交易。(武器数据缺失)");

    // 查找要购买的武器是否存在且可购买
    const weaponToBuy = weapons.find(w => w.name === weaponName && w.price > 0);
    if (!weaponToBuy) return e.reply(`装备型号 "${weaponName}" 未在黑市流通或非卖品。请使用 #查看商店 确认。`);

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法交易。");

    // 检查资金是否充足
    if (playerData.funds < weaponToBuy.price) return e.reply(`资金不足！采购 "${weaponName}" 需要 ${weaponToBuy.price} 资金，您只有 ${playerData.funds}。`);

    // 扣除资金，添加武器到玩家装备库
    playerData.funds -= weaponToBuy.price;
    if (!playerData.heldWeapons) playerData.heldWeapons = [];
    if (!playerData.heldWeapons.includes(weaponName)) {
        playerData.heldWeapons.push(weaponName);
    } else {
        e.reply(`[${playerData.nickname}] 您已拥有装备 "${weaponName}"。本次采购未新增库存，资金已扣除。`);
        // No need to push again, just save player data for fund change
    }

    await savePlayerData(userId, playerData); // 保存玩家数据

    e.reply(`[${playerData.nickname}] 成功采购装备 "${weaponName}"！花费 ${weaponToBuy.price} 资金，剩余 ${playerData.funds} 资金。`);
    return true;
}

/**
 * 处理从库存出售物品的请求 (目前仅支持出售“收藏品”)。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleSellItemFromInventory(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const itemName = e.msg.replace("#出售物品", "").trim(); // 获取要出售的物品名称

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法交易。");

    if (!playerData.collectibles) playerData.collectibles = [];

    // 查找玩家收藏品中是否有该物品
    const collectibleIndex = playerData.collectibles.findIndex(c => c.name === itemName);
    if (collectibleIndex > -1) {
        const itemToSell = playerData.collectibles[collectibleIndex];
        const sellPrice = Math.floor((itemToSell.price || 0) * 0.7);

        if ((itemToSell.price || 0) <= 0) return e.reply(`“收藏品” "${itemName}" 未设定有效价值或价值为0，无法交易。`);
        if (sellPrice <= 0 ) return e.reply(`“收藏品” "${itemName}" 价值过低，折算后无法兑换有效资金。`);

        playerData.funds += sellPrice;
        playerData.collectibles.splice(collectibleIndex, 1);
        await savePlayerData(userId, playerData);

        return e.reply(`[${playerData.nickname}] 成功出售“收藏品” "${itemName}"，获得 ${sellPrice} 资金。当前总资金: ${playerData.funds}。`);
    }

    e.reply(`您的个人收藏中未找到可出售的物品 "${itemName}"。目前仅支持交易“收藏品”类型的物品。`);
    return true;
}
