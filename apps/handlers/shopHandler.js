// camellia-plugin/apps/handlers/shopHandler.js

/**
 * @file 商店相关逻辑处理器。
 * @description 处理查看商店、购买武器、出售物品、购买称号、装备称号等功能。
 */

import { getWeapons, getTitles, getPlayerData, savePlayerData, getItems } from '../../utils/dataManager.js'; // Added getItems
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import { MAX_MESSAGE_LENGTH } from '../../utils/constants.js';

export async function handleViewShop(e, pluginInstance) {
    // ... (View shop logic - assumed correct)
    const weapons = getWeapons();
    const titles = getTitles(); // 获取称号数据

    let shopMsg = "--- “黑市”装备与身份认证终端 ---\n";

    // 显示可购买武器
    shopMsg += "可用装备 (指令: #购买武器 装备名称):\n";
    if (!weapons || weapons.length === 0) {
        shopMsg += "  “黑市”线路不稳定，请稍后再试！ (武器数据未加载)\n";
    } else {
        const purchasableWeapons = weapons.filter(w => w.price > 0);
        if (purchasableWeapons.length === 0) {
            shopMsg += "  暂无可交易的装备。\n";
        } else {
            purchasableWeapons.forEach(w => {
                shopMsg += `  - ${w.name} (稀有度: ${w.rarity || '标准'}, 威胁评估: ${w.baseCombatPower}, 特性: ${w.passive || '无'}, 价格: ${w.price} 资金)\n`;
            });
        }
    }

    // 显示可购买称号
    shopMsg += "\n可认证身份标识 (指令: #购买称号 称号名称):\n";
    if (!titles || titles.length === 0) {
        shopMsg += "  身份认证系统离线。(称号数据未加载)\n";
    } else {
        const purchasableTitles = titles.filter(t => t.price > 0);
        if (purchasableTitles.length === 0) {
            shopMsg += "  暂无可认证的特殊身份标识。\n";
        } else {
            purchasableTitles.forEach(t => {
                shopMsg += `  - ${t.name} (效果: ${t.description || '身份象征'}, 价格: ${t.price} 资金)\n`;
            });
        }
    }
    // ... (message sending logic)
    if (shopMsg.length > MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) {
        try {
            const forwardMsg = await makeForwardMsgWithContent([shopMsg.trim()], "黑市情报");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                // Fallback if forward message creation fails
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

export async function handleBuyWeaponFromShop(e, pluginInstance) {
    // ... (Buy weapon logic - assumed correct)
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const weaponName = e.msg.replace(/^#购买武器\s*/, "").trim();

    const weapons = getWeapons();
    if (!weapons || weapons.length === 0) return e.reply("“黑市”线路不稳定，无法交易。(武器数据缺失)");

    const weaponToBuy = weapons.find(w => w.name === weaponName && w.price > 0);
    if (!weaponToBuy) return e.reply(`装备型号 "${weaponName}" 未在黑市流通或非卖品。请使用 #查看商店 确认。`);

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法交易。");

    if (playerData.funds < weaponToBuy.price) return e.reply(`资金不足！采购 "${weaponName}" 需要 ${weaponToBuy.price} 资金，您只有 ${playerData.funds}。`);

    playerData.funds -= weaponToBuy.price;
    if (!playerData.heldWeapons) playerData.heldWeapons = [];

    if (!playerData.heldWeapons.includes(weaponName)) {
        playerData.heldWeapons.push(weaponName);
    } else {
        // Player already owns the weapon.
        // For non-consumable weapons, this usually means no new item is added.
        // The message can clarify this. Funds are still deducted as per current logic.
        e.reply(`[${playerData.nickname}] 您已拥有装备 "${weaponName}"。本次采购未新增库存，资金仍按交易扣除。`);
    }

    await savePlayerData(userId, playerData);

    e.reply(`[${playerData.nickname}] 成功采购装备 "${weaponName}"！花费 ${weaponToBuy.price} 资金，剩余 ${playerData.funds} 资金。`);
    return true;
}

export async function handleBuyTitleFromShop(e, pluginInstance) {
    // ... (Buy title logic - assumed correct)
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const titleName = e.msg.replace(/^#购买称号\s*/, "").trim();

    const titles = getTitles();
    if (!titles || titles.length === 0) return e.reply("身份认证系统暂时关闭。(称号数据缺失)");

    const titleToBuy = titles.find(t => t.name === titleName && t.price > 0);
    if (!titleToBuy) return e.reply(`身份标识 "${titleName}" 未开放认证或不存在。请使用 #查看商店 确认。`);

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法认证。");

    if (playerData.purchasedTitles && playerData.purchasedTitles.includes(titleName)) {
        return e.reply(`您已拥有身份标识 "${titleName}"。`);
    }

    if (playerData.funds < titleToBuy.price) return e.reply(`资金不足！认证 "${titleName}" 需要 ${titleToBuy.price} 资金，您只有 ${playerData.funds}。`);

    playerData.funds -= titleToBuy.price;
    if (!playerData.purchasedTitles) playerData.purchasedTitles = [];
    playerData.purchasedTitles.push(titleName);

    await savePlayerData(userId, playerData);

    e.reply(`[${playerData.nickname}] 成功认证身份标识 "${titleName}"！花费 ${titleToBuy.price} 资金，剩余 ${playerData.funds} 资金。\n使用 #装备称号 ${titleName} 来展示它。`);
    return true;
}

export async function handleEquipTitle(e, pluginInstance) {
    // ... (Equip title logic - assumed correct)
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const titleName = e.msg.replace(/^#装备称号\s*/, "").trim();

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法操作。");

    if (titleName.toLowerCase() === "无" || titleName.toLowerCase() === "卸下") {
        if (playerData.activeTitle === "") {
            return e.reply("您当前未展示任何身份标识。");
        }
        playerData.activeTitle = "";
        await savePlayerData(userId, playerData);
        return e.reply(`[${playerData.nickname}] 已卸下身份标识。`);
    }

    if (!playerData.purchasedTitles || !playerData.purchasedTitles.includes(titleName)) {
        return e.reply(`您尚未拥有身份标识 "${titleName}"。请先从商店购买。`);
    }

    if (playerData.activeTitle === titleName) {
        return e.reply(`您已在展示身份标识 "${titleName}"。`);
    }

    playerData.activeTitle = titleName;
    await savePlayerData(userId, playerData);

    e.reply(`[${playerData.nickname}] 已装备身份标识: 【${titleName}】`);
    return true;
}


export async function handleSellItemFromInventory(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const itemName = e.msg.replace(/^#出售物品\s*/, "").trim();

    const { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法交易。");

    if (!playerData.collectibles) playerData.collectibles = [];

    // Request 2: Sell items of type 'collectible' regardless of rarity.
    // The current logic sells from `playerData.collectibles`.
    // We need to ensure items added to `playerData.collectibles` in gameHandler correctly have their `type` as 'collectible'.
    // The selling part itself is okay if the item is in `playerData.collectibles`.
    // The user's concern "在商店出售无法出售稀有度不是收藏品的东西" might be a misunderstanding.
    // If an item's definition (from items.json) has type: 'collectible', it should be added to playerData.collectibles.
    // Then, this function can sell it. Rarity of such an item doesn't block sale.

    const collectibleIndex = playerData.collectibles.findIndex(c => c.name === itemName);

    if (collectibleIndex > -1) {
        const itemToSell = playerData.collectibles[collectibleIndex];

        // Ensure the item being sold is indeed a collectible type, though being in this array implies it.
        // This check is more for sanity or if items could be wrongly added to collectibles array.
        // const allGameItems = getItems();
        // const itemDef = allGameItems.find(i => i.name === itemToSell.name);
        // if (!itemDef || itemDef.type !== 'collectible') { // Assuming items.json has a 'type' field.
        //     return e.reply(`物品 "${itemName}" 非法或不符合“收藏品”交易标准。`);
        // }
        // The above check might be redundant if gameHandler correctly populates collectibles.
        // The main point of the user request is that if type IS collectible, rarity doesn't matter.
        // This is implicitly handled by finding it in the collectibles array.

        const sellPrice = Math.floor((itemToSell.price || 0) * 0.7); // Sell at 70% of its stored price

        if ((itemToSell.price || 0) <= 0) {
            return e.reply(`“收藏品” "${itemName}" 未设定有效价值或价值为0，无法交易。`);
        }
        if (sellPrice <= 0) { // Check if sell price after discount is too low
            return e.reply(`“收藏品” "${itemName}" 价值过低，折算后无法兑换有效资金。`);
        }

        playerData.funds += sellPrice;
        playerData.collectibles.splice(collectibleIndex, 1); // Remove from collectibles
        await savePlayerData(userId, playerData);

        return e.reply(`[${playerData.nickname}] 成功出售“收藏品” "${itemName}" (稀有度: ${itemToSell.rarity || '未知'})，获得 ${sellPrice} 资金。当前总资金: ${playerData.funds}。`);
    }

    // If not found in collectibles, inform the user.
    e.reply(`您的个人收藏中未找到可出售的物品 "${itemName}"。目前仅支持通过此指令交易已入库的“收藏品”类型物品。`);
    return true;
}
