// camellia-plugin/utils/dataManager.js
import fs from 'fs-extra';
import path from 'path';
import { INITIAL_WEAPON_NAME } from './constants.js'; // 导入初始武器名称

const _path = process.cwd();
const pluginRootPath = path.join(_path, 'plugins', 'camellia-plugin');
const pluginDataDir = path.join(pluginRootPath, 'data');
const playersDir = path.join(pluginDataDir, 'players');

try {
    fs.ensureDirSync(playersDir); // 确保玩家数据目录存在
} catch (dirError) {
    const currentLogger = global.logger || console;
    currentLogger.error(`[AdventureGame/DataManager] 创建玩家目录 ${playersDir} 失败:`, dirError);
}

const ITEM_FILE = path.join(pluginDataDir, 'items.json');
const WEAPON_FILE = path.join(pluginDataDir, 'weapons.json');
const MAP_FILE = path.join(pluginDataDir, 'maps.json');

let itemsData = [];
let weaponsData = [];
let mapsData = [];

/**
 * 加载所有基础游戏数据 (物品、武器、地图)。
 * 会确保初始武器的定义存在。
 */
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

        // 确保初始武器定义存在于武器数据中
        let initialWeapon = weaponsData.find(w => w.name === INITIAL_WEAPON_NAME);
        if (!initialWeapon) {
            weaponsData.push({
                name: INITIAL_WEAPON_NAME,
                price: 0, // 价格为0，通常表示不可购买或特殊物品
                baseCombatPower: 50,
                passive: "无",
                rarity: "普通",
                description: "都市治安维持部队的标准化装备，可靠但平庸。新手必备，无法被夺走或出售。"
            });
            currentLogger.info(`[AdventureGame/DataManager] 已动态添加 '${INITIAL_WEAPON_NAME}' 定义到武器数据缓存。建议更新 weapons.json 文件以持久化此更改。`);
        } else {
            // 确保初始武器的属性符合预期（例如，价格为0）
            if (initialWeapon.price !== 0) {
                currentLogger.warn(`[AdventureGame/DataManager] 初始武器 '${INITIAL_WEAPON_NAME}' 在 weapons.json 中的 price 不为0 (当前为 ${initialWeapon.price})。建议修改为0。`);
                // initialWeapon.price = 0; // 可选择在此强制修改
            }
            if (!initialWeapon.description?.includes("无法被夺走或出售")) {
                initialWeapon.description = (initialWeapon.description || "") + " 新手必备，无法被夺走或出售。";
                currentLogger.info(`[AdventureGame/DataManager] 已为 '${INITIAL_WEAPON_NAME}' 动态更新描述。`);
            }
        }

        // 确保所有武器都有稀有度属性
        weaponsData.forEach(weapon => {
            if (!weapon.rarity) {
                weapon.rarity = "普通"; // 默认稀有度
                currentLogger.warn(`[AdventureGame/DataManager] 武器 "${weapon.name}" 缺少 rarity 属性，已默认为 "普通"。建议更新 weapons.json。`);
            }
        });

    } catch (error) {
        currentLogger.error('[AdventureGame/DataManager] 加载基础数据失败:', error);
        throw error; // 抛出错误，以便上层可以捕获
    }
}

/** 获取所有物品数据 */
function getItems() { return itemsData; }
/** 获取所有武器数据 */
function getWeapons() { return weaponsData; }
/** 获取所有地图数据 */
function getMaps() { return mapsData; }

/**
 * 获取玩家数据。如果玩家不存在，则创建新玩家档案。
 * @param {string} userId - 玩家QQ号。
 * @param {string} [nickname=''] - 玩家昵称。
 * @returns {Promise<{playerData: object, isNewPlayer: boolean}>} 包含玩家数据和是否为新玩家的标志。
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
        currentLogger.error(`[AdventureGame/DataManager] 读取调查员 ${userId} 档案 ${playerFile} 失败:`, readError);
        // 即使读取失败，也尝试创建新玩家，而不是返回null
    }

    if (!loadedPlayerData) {
        isNewPlayer = true;
        finalPlayerData = {
            userId: userId,
            nickname: nickname || `调查员${String(userId).slice(-4)}`,
            funds: 100, // 初始资金
            heldWeapons: [INITIAL_WEAPON_NAME], // 新玩家自动获得初始武器
            collectibles: [] // 初始收藏品为空
        };
        // 确保武器数据已加载，以便在创建新玩家时初始武器定义是可用的
        if (weaponsData.length === 0) await loadAllBaseData(); // 如果武器数据为空，尝试重新加载

        const saveSuccess = await savePlayerData(userId, finalPlayerData);
        if (saveSuccess) {
            currentLogger.info(`[AdventureGame/DataManager] 已为 ${userId} (${finalPlayerData.nickname}) 创建新的调查档案于 ${playerFile}`);
        } else {
            currentLogger.error(`[AdventureGame/DataManager] 为 ${userId} (${finalPlayerData.nickname}) 创建新调查档案失败。`);
            // 即使保存失败，也返回新创建的玩家数据，让游戏可以继续（数据可能不会持久化）
        }
    } else {
        finalPlayerData = loadedPlayerData;
        // 确保老玩家也有初始武器，如果他们因某种原因没有
        if (!finalPlayerData.heldWeapons) finalPlayerData.heldWeapons = [];
        if (!finalPlayerData.heldWeapons.includes(INITIAL_WEAPON_NAME)) {
            finalPlayerData.heldWeapons.push(INITIAL_WEAPON_NAME);
            currentLogger.info(`[AdventureGame/DataManager] 为老玩家 ${userId} (${finalPlayerData.nickname}) 补发了初始武器 '${INITIAL_WEAPON_NAME}'。`);
        }
        if (!finalPlayerData.collectibles) {
            finalPlayerData.collectibles = [];
        }
        // 如果传入了新的昵称且与存档中不同，则更新
        if (nickname && finalPlayerData.nickname !== nickname) {
            finalPlayerData.nickname = nickname;
            // 更新昵称后，异步保存，不阻塞主流程
            savePlayerData(userId, finalPlayerData).catch(err => {
                currentLogger.error(`[AdventureGame/DataManager] 更新玩家 ${userId} 昵称时保存失败:`, err);
            });
        }
    }
    return { playerData: finalPlayerData, isNewPlayer };
}

/**
 * 保存玩家数据到JSON文件。
 * @param {string} userId - 玩家QQ号。
 * @param {object} data - 要保存的玩家数据。
 * @returns {Promise<boolean>} 保存成功返回true，否则返回false。
 */
async function savePlayerData(userId, data) {
    const playerFile = path.join(playersDir, `${userId}.json`);
    const currentLogger = global.logger || console;
    try {
        await fs.writeJson(playerFile, data, { spaces: 2 }); // 使用2个空格进行格式化输出
        currentLogger.debug(`[AdventureGame/DataManager] 调查员 ${userId} 档案已保存到 ${playerFile}`);
        return true;
    } catch (error) {
        currentLogger.error(`[AdventureGame/DataManager] 保存调查员 ${userId} 档案到 ${playerFile} 失败:`, error);
        return false;
    }
}

/**
 * 获取所有玩家的数据。
 * @returns {Promise<Array<object>>} 包含所有玩家数据的数组。
 */
async function getAllPlayerData() {
    const currentLogger = global.logger || console;
    const allPlayers = [];
    try {
        const files = await fs.readdir(playersDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(playersDir, file);
                try {
                    const playerData = await fs.readJson(filePath, { throws: false });
                    if (playerData && typeof playerData === 'object' && playerData.userId) {
                        allPlayers.push(playerData);
                    } else {
                        currentLogger.warn(`[AdventureGame/DataManager] 文件 ${file} 内容无效或缺少 userId，已跳过。`);
                    }
                } catch (readError) {
                    currentLogger.error(`[AdventureGame/DataManager] 读取调查档案 ${file} 失败:`, readError);
                }
            }
        }
    } catch (error) {
        currentLogger.error('[AdventureGame/DataManager] 读取调查档案目录失败:', error);
    }
    return allPlayers;
}


export {
    loadAllBaseData,
    getItems,
    getWeapons,
    getMaps,
    getPlayerData,
    savePlayerData,
    getAllPlayerData,
    pluginDataDir // 导出数据目录路径，可能用于其他模块
};
