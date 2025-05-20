import fs from 'fs-extra';
import path from 'path';

const _path = process.cwd();
const pluginRoot = path.join(_path, 'plugins', 'adventureGame');
const pluginDataDir = path.join(pluginRoot, 'data');
const playersDir = path.join(pluginDataDir, 'players');

// 确保玩家数据目录存在，如果不存在则创建
try {
    fs.ensureDirSync(playersDir);
} catch (dirError) {
    const currentLogger = global.logger || console;
    currentLogger.error(`[AdventureGame/DataManager] 创建玩家目录 ${playersDir} 失败:`, dirError);
    // 如果目录创建失败，后续操作很可能会失败
}


const ITEM_FILE = path.join(pluginDataDir, 'items.json');
const WEAPON_FILE = path.join(pluginDataDir, 'weapons.json');
const MAP_FILE = path.join(pluginDataDir, 'maps.json');

let itemsData = [];
let weaponsData = [];
let mapsData = [];

async function loadAllBaseData() {
    const currentLogger = global.logger || console;
    try {
        itemsData = await fs.readJson(ITEM_FILE, { throws: false }) || [];
        weaponsData = await fs.readJson(WEAPON_FILE, { throws: false }) || [];
        mapsData = await fs.readJson(MAP_FILE, { throws: false }) || [];
        currentLogger.info('[AdventureGame/DataManager] 基础数据加载成功!');
        if (itemsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: items.json 为空或加载失败。');
        if (weaponsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: weapons.json 为空或加载失败。');
        if (mapsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: maps.json 为空或加载失败。');

        // 确保“新手太刀”在武器数据缓存中存在定义
        if (weaponsData.length > 0 && !weaponsData.find(w => w.name === '新手太刀')) {
            weaponsData.push({ name: "新手太刀", price: 0, baseCombatPower: 50, passive: "无" });
            currentLogger.info("[AdventureGame/DataManager] 已动态添加 '新手太刀' 定义到武器数据缓存。建议更新 weapons.json 文件以持久化此更改。");
        } else if (weaponsData.length === 0) {
            // 如果 weapons.json 完全为空或加载失败，也尝试添加新手太刀
            weaponsData.push({ name: "新手太刀", price: 0, baseCombatPower: 50, passive: "无" });
            currentLogger.warn("[AdventureGame/DataManager] weapons.json 为空，已动态添加 '新手太刀'。请检查文件。");
        }


    } catch (error) {
        currentLogger.error('[AdventureGame/DataManager] 加载基础数据失败:', error);
        throw error; // 重新抛出错误，让上层知道
    }
}

function getItems() { return itemsData; }
function getWeapons() { return weaponsData; }
function getMaps() { return mapsData; }

/**
 * 获取指定玩家的数据，如果玩家数据不存在则创建新的。
 * @param {string} userId 玩家的QQ号
 * @param {string} [nickname=''] 玩家的昵称，用于初始化
 * @returns {Promise<{playerData: object, isNewPlayer: boolean}>} 包含玩家数据和是否为新玩家标志的对象
 */
async function getPlayerData(userId, nickname = '') {
    const playerFile = path.join(playersDir, `${userId}.json`);
    let loadedPlayerData = null;
    const currentLogger = global.logger || console;
    let isNewPlayer = false;
    let finalPlayerData;

    try {
        loadedPlayerData = await fs.readJson(playerFile, { throws: false });
    } catch (readError) {
        currentLogger.error(`[AdventureGame/DataManager] 读取玩家 ${userId} 数据文件 ${playerFile} 失败:`, readError);
        // 即使读取失败，也尝试创建新玩家流程
        loadedPlayerData = null;
    }


    if (!loadedPlayerData) {
        isNewPlayer = true;
        finalPlayerData = {
            userId: userId,
            nickname: nickname || `玩家${userId.slice(-4)}`,
            funds: 100,
            heldWeapons: ['新手太刀'], // 确保新玩家有新手太刀
            collectibles: []
        };

        // 再次确认武器数据中有“新手太刀”的定义，以防万一
        if (!weaponsData.find(w => w.name === '新手太刀')) {
            currentLogger.warn(`[AdventureGame/DataManager] 新玩家 ${userId} (${finalPlayerData.nickname}) 创建时，'新手太刀' 在武器数据缓存中未找到定义！这可能导致后续查找武器属性失败。`);
            // 如果 loadAllBaseData 没能添加，这里再尝试一次 (虽然理论上不应该)
            if (!weaponsData.some(w => w.name === '新手太刀')) {
                weaponsData.push({ name: "新手太刀", price: 0, baseCombatPower: 50, passive: "无" });
                currentLogger.info("[AdventureGame/DataManager] 在 getPlayerData 中为新玩家动态添加了 '新手太刀' 定义。");
            }
        }
        const saveSuccess = await savePlayerData(userId, finalPlayerData);
        if (saveSuccess) {
            currentLogger.info(`[AdventureGame/DataManager] 已为 ${userId} (${finalPlayerData.nickname}) 创建新的玩家档案于 ${playerFile}`);
        } else {
            currentLogger.error(`[AdventureGame/DataManager] 为 ${userId} (${finalPlayerData.nickname}) 创建新玩家档案失败（保存未成功）。`);
            // 即使保存失败，也返回新玩家数据结构，但isNewPlayer可能需要反思其含义
            // 或者这里应该抛出错误，让调用者知道创建失败
        }
    } else {
        finalPlayerData = loadedPlayerData;
        if (nickname && finalPlayerData.nickname !== nickname) {
            finalPlayerData.nickname = nickname;
            await savePlayerData(userId, finalPlayerData); // 这里也应该检查保存状态
        }
    }
    return { playerData: finalPlayerData, isNewPlayer };
}

/**
 * 保存玩家数据到对应的JSON文件
 * @param {string} userId 玩家的QQ号
 * @param {object} data 玩家数据对象
 * @returns {Promise<boolean>} true if save was successful, false otherwise
 */
async function savePlayerData(userId, data) {
    const playerFile = path.join(playersDir, `${userId}.json`);
    const currentLogger = global.logger || console;
    try {
        await fs.writeJson(playerFile, data, { spaces: 2 });
        currentLogger.debug(`[AdventureGame/DataManager] 玩家 ${userId} 数据已保存到 ${playerFile}`);
        return true;
    } catch (error) {
        currentLogger.error(`[AdventureGame/DataManager] 保存玩家 ${userId} 数据到 ${playerFile} 失败:`, error);
        return false;
    }
}

export {
    loadAllBaseData,
    getItems,
    getWeapons,
    getMaps,
    getPlayerData,
    savePlayerData
};
