// camellia-plugin/utils/dataManager.js
import fs from 'fs-extra';
import path from 'path';
import { INITIAL_WEAPON_NAME } from './constants.js';

const _path = process.cwd();
const pluginRootPath = path.join(_path, 'plugins', 'camellia-plugin');
const pluginDataDir = path.join(pluginRootPath, 'data');

try {
    fs.ensureDirSync(pluginDataDir);
} catch (dirError) {
    const currentLogger = global.logger || console;
    currentLogger.error(`[AdventureGame/DataManager] 创建插件数据目录 ${pluginDataDir} 失败:`, dirError);
}

const playersDir = path.join(pluginDataDir, 'players');

try {
    fs.ensureDirSync(playersDir);
} catch (dirError) {
    const currentLogger = global.logger || console;
    currentLogger.error(`[AdventureGame/DataManager] 创建玩家目录 ${playersDir} 失败:`, dirError);
}

const ITEM_FILE = path.join(pluginDataDir, 'items.json');
const WEAPON_FILE = path.join(pluginDataDir, 'weapons.json');
const MAP_FILE = path.join(pluginDataDir, 'maps.json');
const PUBLIC_ITEM_FILE = path.join(pluginDataDir, 'publicItems.json');
const TITLE_FILE = path.join(pluginDataDir, 'titles.json');
const ACTIVITY_TEXT_FILE = path.join(pluginDataDir, 'currentActivity.txt');
const NPC_FILE = path.join(pluginDataDir, 'npcs.json');

let itemsData = [];
let weaponsData = [];
let mapsData = [];
let publicItemsData = [];
let titlesData = [];
let currentActivityText = "";
let npcsData = [];

/**
 * 加载所有基础游戏数据.
 */
async function loadAllBaseData() {
    const currentLogger = global.logger || console;
    try {
        itemsData = await fs.readJson(ITEM_FILE, { throws: false }) || [];
        weaponsData = await fs.readJson(WEAPON_FILE, { throws: false }) || [];
        mapsData = await fs.readJson(MAP_FILE, { throws: false }) || [];
        publicItemsData = await fs.readJson(PUBLIC_ITEM_FILE, { throws: false }) || [];
        titlesData = await fs.readJson(TITLE_FILE, { throws: false }) || [];
        npcsData = await fs.readJson(NPC_FILE, { throws: false }) || [];

        if (await fs.pathExists(ACTIVITY_TEXT_FILE)) {
            currentActivityText = await fs.readFile(ACTIVITY_TEXT_FILE, 'utf-8');
        } else {
            currentActivityText = "当前没有特别活动。";
            await fs.writeFile(ACTIVITY_TEXT_FILE, currentActivityText, 'utf-8');
            currentLogger.info(`[AdventureGame/DataManager] 未找到活动文件 ${ACTIVITY_TEXT_FILE}，已创建默认文件。`);
        }

        currentLogger.info('[AdventureGame/DataManager] 基础数据加载成功!');

        if (itemsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: items.json 为空或加载失败。');
        if (weaponsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: weapons.json 为空或加载失败。');
        if (mapsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: maps.json 为空或加载失败。');
        if (publicItemsData.length === 0) currentLogger.info('[AdventureGame/DataManager] 提示: publicItems.json 为空或加载失败。');
        if (titlesData.length === 0) currentLogger.info('[AdventureGame/DataManager] 提示: titles.json 为空或加载失败。');
        if (npcsData.length === 0) currentLogger.warn('[AdventureGame/DataManager] 警告: npcs.json 为空或加载失败 (NPC系统可能无法正常运作)。');

        let initialWeapon = weaponsData.find(w => w.name === INITIAL_WEAPON_NAME);
        if (!initialWeapon) {
            weaponsData.push({
                name: INITIAL_WEAPON_NAME, price: 0, baseCombatPower: 50, passive: "无", passiveType: "none", rarity: "普通",
                description: "都市治安维持部队的标准化装备，可靠但平庸。新手必备，无法被夺走或出售。"
            });
            currentLogger.info(`[AdventureGame/DataManager] 已动态添加 '${INITIAL_WEAPON_NAME}'。`);
        } else {
            if (initialWeapon.price !== 0) currentLogger.warn(`[AdventureGame/DataManager] 初始武器 '${INITIAL_WEAPON_NAME}' price 不为0。`);
            if (!initialWeapon.description?.includes("无法被夺走或出售")) initialWeapon.description = (initialWeapon.description || "") + " 新手必备，无法被夺走或出售。";
            if (!initialWeapon.passiveType) initialWeapon.passiveType = "none";
        }

        weaponsData.forEach(weapon => {
            if (!weapon.rarity) weapon.rarity = "普通";
            if (!weapon.passiveType) weapon.passiveType = "none";
        });

        npcsData.forEach(npc => {
            if (npc.weapon && typeof npc.weapon.name === 'string' && !weaponsData.find(w => w.name === npc.weapon.name)) {
                // currentLogger.warn(`[AdventureGame/DataManager] NPC "${npc.name}" 的武器 "${npc.weapon.name}" 未在全局 weapons.json 中定义。如果它是独特的，请忽略此消息。`);
            }
        });

    } catch (error) {
        currentLogger.error('[AdventureGame/DataManager] 加载基础数据失败:', error);
        throw error;
    }
}

function getItems() { return itemsData; }
function getWeapons() { return weaponsData; }
function getMaps() { return mapsData; }
function getPublicItems() { return publicItemsData; }
function getTitles() { return titlesData; }
function getCurrentActivityText() { return currentActivityText; }
function getNpcs() { return npcsData; }

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
    }

    if (!loadedPlayerData) {
        isNewPlayer = true;
        finalPlayerData = {
            userId: userId,
            nickname: nickname || `调查员${String(userId).slice(-4)}`,
            funds: 100,
            heldWeapons: [INITIAL_WEAPON_NAME],
            collectibles: [],
            purchasedTitles: [],
            activeTitle: "",
            // 新增伤病状态字段
            permanentInjuryStatus: 'none', // 'none', 'light', 'medium', 'heavy' (对应中文：无伤，轻伤，一般伤，重伤)
            needsTreatment: false
        };
        if (weaponsData.length === 0) await loadAllBaseData();

        const saveSuccess = await savePlayerData(userId, finalPlayerData);
        if (saveSuccess) {
            currentLogger.info(`[AdventureGame/DataManager] 已为 ${userId} (${finalPlayerData.nickname}) 创建新的调查档案于 ${playerFile}`);
        } else {
            currentLogger.error(`[AdventureGame/DataManager] 为 ${userId} (${finalPlayerData.nickname}) 创建新调查档案失败。`);
        }
    } else {
        finalPlayerData = loadedPlayerData;
        if (!finalPlayerData.heldWeapons) finalPlayerData.heldWeapons = [];
        if (!finalPlayerData.heldWeapons.includes(INITIAL_WEAPON_NAME)) {
            finalPlayerData.heldWeapons.push(INITIAL_WEAPON_NAME);
            currentLogger.info(`[AdventureGame/DataManager] 为老玩家 ${userId} (${finalPlayerData.nickname}) 补发了初始武器 '${INITIAL_WEAPON_NAME}'。`);
        }
        if (!finalPlayerData.collectibles) finalPlayerData.collectibles = [];
        if (!finalPlayerData.purchasedTitles) finalPlayerData.purchasedTitles = [];
        if (typeof finalPlayerData.activeTitle === 'undefined') finalPlayerData.activeTitle = "";
        // 初始化新字段（如果老玩家数据中没有）
        if (typeof finalPlayerData.permanentInjuryStatus === 'undefined') finalPlayerData.permanentInjuryStatus = 'none';
        if (typeof finalPlayerData.needsTreatment === 'undefined') finalPlayerData.needsTreatment = false;


        if (nickname && finalPlayerData.nickname !== nickname) {
            finalPlayerData.nickname = nickname;
            savePlayerData(userId, finalPlayerData).catch(err => {
                currentLogger.error(`[AdventureGame/DataManager] 更新玩家 ${userId} 昵称时保存失败:`, err);
            });
        }
    }
    return { playerData: finalPlayerData, isNewPlayer };
}

async function savePlayerData(userId, data) {
    const playerFile = path.join(playersDir, `${userId}.json`);
    const currentLogger = global.logger || console;
    try {
        await fs.writeJson(playerFile, data, { spaces: 2 });
        currentLogger.debug(`[AdventureGame/DataManager] 调查员 ${userId} 档案已保存到 ${playerFile}`);
        return true;
    } catch (error) {
        currentLogger.error(`[AdventureGame/DataManager] 保存调查员 ${userId} 档案到 ${playerFile} 失败:`, error);
        return false;
    }
}

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
    getPublicItems,
    getTitles,
    getCurrentActivityText,
    getNpcs,
    getPlayerData,
    savePlayerData,
    getAllPlayerData,
    pluginDataDir
};
