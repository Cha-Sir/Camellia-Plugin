// camellia-plugin/apps/adventureGameApp.js
/**
 * @file 都市迷踪（搜打撤）插件主文件。
 * @description 初始化插件，定义消息规则，并将具体逻辑分发到不同的处理器模块。
 */

import plugin from '../../../lib/plugins/plugin.js'; // 假设 Yunzai-Bot 根目录下的 lib

// 导入数据加载和核心工具函数
// 从 camellia-plugin/apps/adventureGameApp.js 到 camellia-plugin/utils/
import { loadAllBaseData, getPlayerData } from '../utils/dataManager.js';

// 导入常量
// 从 camellia-plugin/apps/adventureGameApp.js 到 camellia-plugin/utils/
import { VALID_STRATEGIES } from '../utils/constants.js';

// 导入各个功能模块的处理器
// 从 camellia-plugin/apps/adventureGameApp.js 到 camellia-plugin/apps/handlers/
import * as gameHandler from './handlers/gameHandler.js';
import * as shopHandler from './handlers/shopHandler.js';
import * as infoHandler from './handlers/infoHandler.js';

export class AdventureGame extends plugin {
    constructor() {
        super({
            name: '都市迷踪（搜打撤）',
            dsc: '近未来都市的异常探索游戏。 #搜打撤帮助 查看指令',
            event: 'message', // 监听消息事件
            priority: 500,    // 插件优先级
            rule: [
                {
                    // 进入地图指令，匹配策略部分使用 VALID_STRATEGIES 动态生成
                    reg: `^#进入地图\\s*([^\\s]+|\\d+)\\s*武器\\s*([^\\s]+)\\s*策略\\s*(${VALID_STRATEGIES.join('|')})$`,
                    fnc: 'enterMap' // 对应下面的 enterMap 方法
                },
                { reg: '^#查看商店$', fnc: 'viewShop' },
                { reg: '^#购买武器\\s*([^\\s]+)$', fnc: 'buyWeaponFromShop' },
                { reg: '^#出售物品\\s*([^\\s]+)$', fnc: 'sellItemFromInventory' },
                { reg: '^#我的信息$', fnc: 'viewMyInfo' },
                { reg: '^#重载冒险数据$', fnc: 'reloadDataAdmin', permission: 'master' }, // 仅限主人权限
                { reg: '^#搜打撤帮助$', fnc: 'showHelp' },
                { reg: '^#地图列表$', fnc: 'listMaps' },
                { reg: '^#武器列表$', fnc: 'listWeapons' },
                { reg: '^#排行榜$', fnc: 'showLeaderboard' }
            ]
        });
        this.initializeData(); // 初始化插件数据
    }

    /**
     * 初始化插件所需的基础数据。
     * 在插件启动时调用。
     */
    async initializeData() {
        try {
            await loadAllBaseData(); // 加载items.json, weapons.json, maps.json等
            logger.info('[AdventureGameApp/NearFuture] 核心系统数据接口已连接。');
        } catch (error) {
            logger.error('[AdventureGameApp/NearFuture] 核心系统数据接口连接失败:', error);
        }
    }

    /**
     * 管理员指令：重新加载所有基础数据。
     * @param {object} e - Yunzai的事件对象。
     */
    async reloadDataAdmin(e) {
        if (!e.isMaster) return false; // 权限检查
        try {
            await loadAllBaseData();
            e.reply("核心系统数据已强制刷新。");
            logger.info('[AdventureGameApp/NearFuture] 核心数据已由管理员强制刷新。');
        } catch (error) {
            logger.error('[AdventureGameApp/NearFuture] 管理员强制刷新核心数据失败:', error);
            e.reply("核心系统数据刷新失败，请检查维护日志。");
        }
        return true;
    }

    /**
     * 获取玩家数据，如果玩家不存在则创建新玩家。
     * 这是插件实例的一个辅助方法，可能会被多个处理器使用。
     * @param {string} userId - 玩家的QQ号。
     * @param {string} [nickname=''] - 玩家的昵称。
     * @returns {Promise<object>} 包含 playerData 和 isNewPlayer 的对象。
     */
    async getPlayer(userId, nickname = '') {
        // 直接调用dataManager中的getPlayerData
        return await getPlayerData(userId, nickname);
    }

    // --- 规则函数，将逻辑分发到对应的处理器 ---

    async enterMap(e) {
        // 'this' 指向 AdventureGame 插件实例，传递给处理器以便访问 getPlayer 等方法
        return await gameHandler.handleEnterMap(e, this);
    }

    async viewShop(e) {
        return await shopHandler.handleViewShop(e, this);
    }

    async buyWeaponFromShop(e) {
        return await shopHandler.handleBuyWeaponFromShop(e, this);
    }

    async sellItemFromInventory(e) {
        return await shopHandler.handleSellItemFromInventory(e, this);
    }

    async viewMyInfo(e) {
        return await infoHandler.handleViewMyInfo(e, this);
    }

    async showHelp(e) {
        return await infoHandler.handleShowHelp(e, this);
    }

    async listMaps(e) {
        return await infoHandler.handleListMaps(e, this);
    }

    async listWeapons(e) {
        return await infoHandler.handleListWeapons(e, this);
    }

    async showLeaderboard(e) {
        return await infoHandler.handleShowLeaderboard(e, this);
    }
}
