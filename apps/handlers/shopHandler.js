// camellia-plugin/apps/handlers/shopHandler.js
import {
    getWeapons,
    getTitles,
    getPlayerData,
    savePlayerData,
    getItems,
    getMercenaries,
    getDailySeedShopData,
    saveDailySeedShopData
} from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import * as constants from '../../utils/constants.js'; // 修改导入方式
import { processMercenaryAcquisition } from './mercenaryHandler.js';
import path from 'path';
import fs from 'fs';

/**
 * 查看黑市商店（武器和称号）。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleViewShop(e, pluginInstance) {
    const weapons = getWeapons().filter(w => w.price > 0 && w.name !== constants.INITIAL_WEAPON_NAME); // 使用 constants.INITIAL_WEAPON_NAME
    const titles = getTitles().filter(t => t.price > 0);

    let shopMsg = "--- “黑市”情报终端 ---\n\n【可交易装备】(指令: #购买武器 武器名称)\n";
    if (weapons.length > 0) {
        weapons.forEach(w => {
            shopMsg += `  - ${w.name} (稀有度: ${w.rarity || '标准'}, 威胁评估: ${w.baseCombatPower || '未知'}, 特性: ${w.passive || '无'}) - 价格: ${w.price} 资金\n`;
        });
    } else {
        shopMsg += "  当前无特殊装备供应。\n";
    }

    shopMsg += "\n【可认证身份标识】(指令: #购买称号 称号名称)\n";
    if (titles.length > 0) {
        titles.forEach(t => {
            shopMsg += `  - ${t.name} (效果: ${t.description || '身份象征'}) - 价格: ${t.price} 资金\n`;
        });
    } else {
        shopMsg += "  当前无特殊身份标识可供认证。\n";
    }

    shopMsg += "\n提示: 使用 #出售物品 <物品名> 来变卖您的收藏品。";
    shopMsg += "\n新增：#光之种商店 - 使用光之种购买特殊佣兵。";

    if (shopMsg.length > constants.MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) { // 使用 constants.MAX_MESSAGE_LENGTH
        try {
            const forwardMsg = await makeForwardMsgWithContent([shopMsg.trim()], "黑市商品清单");
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                e.reply(shopMsg.substring(0, constants.MAX_MESSAGE_LENGTH) + "\n...(商品信息过长，部分未能完整显示)"); // 使用 constants.MAX_MESSAGE_LENGTH
            }
        } catch (err) {
            logger.error('[ShopHandler] 创建商店信息转发失败:', err);
            e.reply(shopMsg.substring(0, constants.MAX_MESSAGE_LENGTH) + "\n...(信息过载，部分截断)"); // 使用 constants.MAX_MESSAGE_LENGTH
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
    const weaponName = e.msg.replace(/^#购买武器\s*/, "").trim();
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法购买。");

    const weaponToBuy = getWeapons().find(w => w.name === weaponName && w.price > 0 && w.name !== constants.INITIAL_WEAPON_NAME); // 使用 constants.INITIAL_WEAPON_NAME
    if (!weaponToBuy) return e.reply(`未知的武器型号 "${weaponName}" 或该武器为非卖品。`);
    if (playerData.heldWeapons.includes(weaponName)) return e.reply(`您已拥有装备 "${weaponName}"。`);
    if (playerData.funds < weaponToBuy.price) return e.reply(`资金不足！购买 ${weaponName} 需要 ${weaponToBuy.price} 资金，您当前持有 ${playerData.funds}。`);

    playerData.funds -= weaponToBuy.price;
    playerData.heldWeapons.push(weaponName);
    await savePlayerData(userId, playerData);

    return e.reply(`购买成功！获得装备: ${weaponName}。花费 ${weaponToBuy.price} 资金，剩余 ${playerData.funds} 资金。`);
}

/**
 * 处理从商店购买称号的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleBuyTitleFromShop(e, pluginInstance) {
    const userId = e.user_id;
    const titleName = e.msg.replace(/^#购买称号\s*/, "").trim();
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法购买。");

    const titleToBuy = getTitles().find(t => t.name === titleName && t.price > 0);
    if (!titleToBuy) return e.reply(`未知的身份标识 "${titleName}" 或该标识为非卖品。`);
    if (playerData.purchasedTitles.includes(titleName)) return e.reply(`您已拥有身份标识 "${titleName}"。`);
    if (playerData.funds < titleToBuy.price) return e.reply(`资金不足！认证 ${titleName} 需要 ${titleToBuy.price} 资金，您当前持有 ${playerData.funds}。`);

    playerData.funds -= titleToBuy.price;
    playerData.purchasedTitles.push(titleName);
    await savePlayerData(userId, playerData);

    return e.reply(`身份标识认证成功！获得: 【${titleName}】。花费 ${titleToBuy.price} 资金，剩余 ${playerData.funds} 资金。\n使用 #装备称号 ${titleName} 进行佩戴。`);
}

/**
 * 处理装备称号的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleEquipTitle(e, pluginInstance) {
    const userId = e.user_id;
    const titleName = e.msg.replace(/^#装备称号\s*/, "").trim();
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法装备。");

    if (titleName.toLowerCase() === "无" || titleName.toLowerCase() === "none") {
        if (playerData.activeTitle === "") return e.reply("您当前未佩戴任何身份标识。");
        playerData.activeTitle = "";
        await savePlayerData(userId, playerData);
        return e.reply("已卸下当前身份标识。");
    }

    if (!playerData.purchasedTitles.includes(titleName)) return e.reply(`您未拥有身份标识 "${titleName}"。`);
    if (playerData.activeTitle === titleName) return e.reply(`您已佩戴【${titleName}】。`);

    playerData.activeTitle = titleName;
    await savePlayerData(userId, playerData);
    return e.reply(`身份标识已更换为: 【${titleName}】。`);
}

/**
 * 处理出售物品的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleSellItemFromInventory(e, pluginInstance) {
    const userId = e.user_id;
    const itemName = e.msg.replace(/^#出售物品\s*/, "").trim();
    const { playerData } = await pluginInstance.getPlayer(userId, e.sender.card || e.sender.nickname);

    if (!playerData) return e.reply("身份验证失败，无法出售。");
    if (!playerData.collectibles || playerData.collectibles.length === 0) return e.reply("您的个人收藏库是空的。");

    const itemIndex = playerData.collectibles.findIndex(c => c.name === itemName);
    if (itemIndex === -1) return e.reply(`您的收藏中没有物品 "${itemName}"。`);

    const itemToSell = playerData.collectibles[itemIndex];
    const sellPrice = Math.floor((itemToSell.price || 0) * 0.7);

    playerData.funds += sellPrice;
    playerData.collectibles.splice(itemIndex, 1);
    await savePlayerData(userId, playerData);

    return e.reply(`成功出售收藏品: ${itemName}！获得 ${sellPrice} 资金。\n当前资金: ${playerData.funds}。`);
}


/**
 * 获取当前UTC日期字符串 YYYY-MM-DD
 */
function getCurrentUTCDateString() {
    const today = new Date();
    const year = today.getUTCFullYear();
    const month = String(today.getUTCMonth() + 1).padStart(2, '0');
    const day = String(today.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 检查并刷新光之种商店（如果需要）
 */
async function refreshSeedShopIfNeeded() {
    const currentLogger = global.logger || console;
    let shopData = getDailySeedShopData();
    const currentDate = getCurrentUTCDateString();
    const currentUTCHour = new Date().getUTCHours();

    if (shopData.lastRefreshDate !== currentDate || (shopData.lastRefreshDate === currentDate && currentUTCHour >= constants.SEED_SHOP_REFRESH_HOUR_UTC && !shopData.refreshedTodayAtHour)) { // 使用 constants.SEED_SHOP_REFRESH_HOUR_UTC
        currentLogger.info(`[ShopHandler] 需要刷新光之种商店。上次刷新: ${shopData.lastRefreshDate}, 当前日期: ${currentDate}, 当前UTC小时: ${currentUTCHour}`);

        const allMercenaries = getMercenaries();
        if (!allMercenaries || allMercenaries.length === 0) {
            currentLogger.error("[ShopHandler] 无法刷新光之种商店：佣兵数据未加载。");
            return shopData;
        }

        const newShopItems = [];
        const selectedMercIds = new Set();

        for (const slotConfig of constants.SEED_SHOP_CONFIG.slots) { // 使用 constants.SEED_SHOP_CONFIG
            const candidates = allMercenaries.filter(m => m.rarity === slotConfig.rarity && !selectedMercIds.has(m.id));
            for (let i = 0; i < slotConfig.count; i++) {
                if (candidates.length === 0) {
                    currentLogger.warn(`[ShopHandler] 光之种商店：稀有度 ${slotConfig.rarity} 的候选佣兵不足以填满 ${slotConfig.count} 个槽位。`);
                    break;
                }
                const randomIndex = Math.floor(Math.random() * candidates.length);
                const chosenMerc = candidates.splice(randomIndex, 1)[0];
                if (chosenMerc) {
                    newShopItems.push({
                        mercenaryId: chosenMerc.id,
                        name: chosenMerc.name,
                        rarity: chosenMerc.rarity,
                        price: slotConfig.price,
                    });
                    selectedMercIds.add(chosenMerc.id);
                }
            }
        }
        shopData.items = newShopItems;
        shopData.lastRefreshDate = currentDate;
        shopData.refreshedTodayAtHour = currentUTCHour >= constants.SEED_SHOP_REFRESH_HOUR_UTC; // 使用 constants.SEED_SHOP_REFRESH_HOUR_UTC
        await saveDailySeedShopData(shopData);
        currentLogger.info(`[ShopHandler] 光之种商店已刷新，包含 ${newShopItems.length} 件商品。`);
    } else if (shopData.lastRefreshDate === currentDate && currentUTCHour < constants.SEED_SHOP_REFRESH_HOUR_UTC) { // 使用 constants.SEED_SHOP_REFRESH_HOUR_UTC
        if (shopData.refreshedTodayAtHour) {
            shopData.refreshedTodayAtHour = false;
            await saveDailySeedShopData(shopData);
        }
    }
    return shopData;
}


export async function handleViewSeedShop(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) return e.reply("身份验证失败，无法访问光之种商店。");

    const shopData = await refreshSeedShopIfNeeded();

    let shopMsg = `--- 光之种商店 (每日UTC ${constants.SEED_SHOP_REFRESH_HOUR_UTC}:00刷新) ---\n`; // 使用 constants.SEED_SHOP_REFRESH_HOUR_UTC
    shopMsg += `您的光之种: ${playerData.seedsOfLight || 0}\n\n`;
    shopMsg += "今日商品 (指令: #购买 商品名称):\n";
    shopMsg += "注意：购买五星角色会清空您的保底次数！:\n";

    if (!shopData.items || shopData.items.length === 0) {
        shopMsg += "  商店正在补货中，请稍后再来。\n";
    } else {
        shopData.items.forEach((item, index) => {
            shopMsg += `  ${index + 1}. ${item.name} (${"★".repeat(item.rarity)}) - 价格: ${item.price} 光之种\n`;
        });
    }

    if (shopMsg.length > constants.MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) { // 使用 constants.MAX_MESSAGE_LENGTH
        try {
            const forwardMsg = await makeForwardMsgWithContent([shopMsg.trim()], "光之种商店");
            if (forwardMsg) await e.reply(forwardMsg);
            else e.reply(shopMsg.substring(0, constants.MAX_MESSAGE_LENGTH) + "\n...(商店信息过长)"); // 使用 constants.MAX_MESSAGE_LENGTH
        } catch (err) {
            logger.error('[ShopHandler] 创建光之种商店信息转发失败:', err);
            e.reply(shopMsg.substring(0, constants.MAX_MESSAGE_LENGTH) + "\n...(信息过载)"); // 使用 constants.MAX_MESSAGE_LENGTH
        }
    } else {
        e.reply(shopMsg);
    }
    return true;
}

export async function handleBuyFromSeedShop(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const itemName = e.msg.replace(/^#购买\s*/, "").trim();

    let { playerData } = await pluginInstance.getPlayer(userId, nickname);
    if (!playerData) return e.reply("身份验证失败，无法购买。");

    const shopData = await refreshSeedShopIfNeeded();
    const allMercenaries = getMercenaries();
    const mercenaryImagePath = pluginInstance.mercenaryImagePath || (await import('../../utils/dataManager.js')).mercenaryImagePath;

    const itemToBuy = shopData.items.find(item => item.name === itemName);

    if (!itemToBuy) {
        return e.reply(`"${itemName}" 不是光之种商店的当前商品。请使用 #光之种商店 查看。购买武器请用 #购买武器，称号请用 #购买称号。`);
    }

    const mercDefToBuy = allMercenaries.find(m => m.id === itemToBuy.mercenaryId);
    if (!mercDefToBuy) {
        logger.error(`[ShopHandler] 光之种商店商品 ${itemName} (ID: ${itemToBuy.mercenaryId}) 在佣兵主数据中未找到！`);
        return e.reply(`商品 "${itemName}" 数据异常，暂时无法购买，请联系管理员。`);
    }

    playerData.seedsOfLight = playerData.seedsOfLight || 0;
    if (playerData.seedsOfLight < itemToBuy.price) {
        return e.reply(`光之种不足！购买 ${itemToBuy.name} 需要 ${itemToBuy.price} 光之种，您只有 ${playerData.seedsOfLight}。`);
    }

    playerData.seedsOfLight -= itemToBuy.price;

    const acquisitionResult = processMercenaryAcquisition(playerData, mercDefToBuy);
    playerData = acquisitionResult.playerData;

    await savePlayerData(userId, playerData);

    const purchaseContent = [];
    purchaseContent.push(`--- 光之种交易凭证 ---`);
    purchaseContent.push(`您已花费 ${itemToBuy.price} 光之种购买了佣兵。`);
    purchaseContent.push(acquisitionResult.message);
    purchaseContent.push(`剩余光之种: ${playerData.seedsOfLight}`);
    // 确保这里使用 constants.PITY_5STAR_THRESHOLD
    purchaseContent.push(`(5星保底计数: ${playerData.pityCounter5Star || 0}/${constants.PITY_5STAR_THRESHOLD}, 当前额外5星率: ${(playerData.current5StarBonusRate * 100).toFixed(1)}%)`);

    if (mercDefToBuy.imageUrl) {
        const imageFullPath = path.join(mercenaryImagePath, mercDefToBuy.imageUrl);
        if (fs.existsSync(imageFullPath)) {
            purchaseContent.push({ type: 'image', file: mercDefToBuy.imageUrl });
        } else {
            purchaseContent.push(`[图片 ${mercDefToBuy.imageUrl} 加载失败]`);
            logger.warn(`[ShopHandler] 光之种购买：佣兵图片 ${imageFullPath} 未找到。`);
        }
    }

    const forwardMsg = await makeForwardMsgWithContent(purchaseContent, "光之种商店购买");
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        const textOnlyContent = purchaseContent.filter(item => typeof item === 'string').join('\n');
        await e.reply(textOnlyContent);
    }
    return true;
}