// camellia-plugin/apps/adventureGameApp.js
/**
 * @file 都市迷踪（搜打撤）插件主文件。
 * @description 初始化插件，定义消息规则，并将具体逻辑分发到不同的处理器模块。
 */

import plugin from '../../../lib/plugins/plugin.js'; // 假设 Yunzai-Bot 根目录下的 lib

// 导入数据加载和核心工具函数
import { loadAllBaseData, getPlayerData } from '../utils/dataManager.js';

// 导入常量
import { VALID_STRATEGIES } from '../utils/constants.js';

// 导入各个功能模块的处理器
import * as gameHandler from './handlers/gameHandler.js';
import * as shopHandler from './handlers/shopHandler.js';
import * as infoHandler from './handlers/infoHandler.js';
import * as activityHandler from './handlers/activityHandler.js';
import * as hospitalHandler from './handlers/hospitalHandler.js'; // 新增医院处理器

export class AdventureGame extends plugin {
    constructor() {
        super({
            name: '都市迷踪（搜打撤）',
            dsc: '近未来都市的异常探索游戏。 #搜打撤帮助 查看指令',
            event: 'message', // 监听消息事件
            priority: 500,    // 插件优先级
            rule: [
                {
                    reg: `^#进入地图\\s*([^\\s]+|\\d+)\\s*武器\\s*([^\\s]+)\\s*策略\\s*(${VALID_STRATEGIES.join('|')})$`,
                    fnc: 'enterMap'
                },
                { reg: '^#退出队列$', fnc: 'leaveQueue' },
                { reg: '^#查看队列$', fnc: 'viewQueues' },
                { reg: '^#查看商店$', fnc: 'viewShop' },
                { reg: '^#购买武器\\s*([^\\s]+)$', fnc: 'buyWeaponFromShop' },
                { reg: '^#购买称号\\s*(.+)$', fnc: 'buyTitleFromShop' },
                { reg: '^#装备称号\\s*(.+)$', fnc: 'equipTitle' },
                { reg: '^#出售物品\\s*([^\\s]+)$', fnc: 'sellItemFromInventory' },
                { reg: '^#我的信息$', fnc: 'viewMyInfo' },
                { reg: '^#重载冒险数据$', fnc: 'reloadDataAdmin', permission: 'master' },
                { reg: '^#搜打撤帮助$', fnc: 'showHelp' },
                { reg: '^#地图列表$', fnc: 'listMaps' },
                { reg: '^#武器列表$', fnc: 'listWeapons' },
                { reg: '^#排行榜$', fnc: 'showLeaderboard' },
                { reg: '^#查看当前活动$', fnc: 'viewCurrentActivity' },
                // 新增医院相关指令
                { reg: '^#治疗$', fnc: 'handleHealPromptCommand' },
                { reg: '^#确认治疗$', fnc: 'handleConfirmHealCommand' }
            ]
        });
        this.initializePluginSystems();
    }

    /**
     * Initializes plugin systems including data loading and timed tasks.
     */
    async initializePluginSystems() {
        try {
            await loadAllBaseData();
            logger.info('[AdventureGameApp/NearFuture] 核心系统数据接口已连接。');
            gameHandler.initializeGameHandlerTimedTasks(this);
            logger.info('[AdventureGameApp/NearFuture] Game handler timed tasks initialized.');
        } catch (error) {
            logger.error('[AdventureGameApp/NearFuture] 插件系统初始化失败:', error);
        }
    }

    async reloadDataAdmin(e) {
        if (!e.isMaster) return false;
        try {
            await loadAllBaseData();
            e.reply("核心系统数据已强制刷新。");
            logger.info('[AdventureGameApp/NearFuture] 核心数据已由管理员强制刷新。');
            gameHandler.initializeGameHandlerTimedTasks(this);
            logger.info('[AdventureGameApp/NearFuture] Game handler timed tasks re-initialized after data reload.');
        } catch (error) {
            logger.error('[AdventureGameApp/NearFuture] 管理员强制刷新核心数据失败:', error);
            e.reply("核心系统数据刷新失败，请检查维护日志。");
        }
        return true;
    }

    async getPlayer(userId, nickname = '') {
        return await getPlayerData(userId, nickname);
    }

    // --- Rule functions, dispatching logic to handlers ---
    async enterMap(e) { return await gameHandler.handleEnterMap(e, this); }
    async leaveQueue(e) { return await gameHandler.handleLeaveQueue(e, this); }
    async viewQueues(e) { return await gameHandler.handleViewQueues(e, this); }
    async viewShop(e) { return await shopHandler.handleViewShop(e, this); }
    async buyWeaponFromShop(e) { return await shopHandler.handleBuyWeaponFromShop(e, this); }
    async buyTitleFromShop(e) { return await shopHandler.handleBuyTitleFromShop(e, this); }
    async equipTitle(e) { return await shopHandler.handleEquipTitle(e, this); }
    async sellItemFromInventory(e) { return await shopHandler.handleSellItemFromInventory(e, this); }
    async viewMyInfo(e) { return await infoHandler.handleViewMyInfo(e, this); }
    async showHelp(e) { return await infoHandler.handleShowHelp(e, this); }
    async listMaps(e) { return await infoHandler.handleListMaps(e, this); }
    async listWeapons(e) { return await infoHandler.handleListWeapons(e, this); }
    async showLeaderboard(e) { return await infoHandler.handleShowLeaderboard(e, this); }
    async viewCurrentActivity(e) { return await activityHandler.handleViewCurrentActivity(e, this); }

    // Hospital commands
    async handleHealPromptCommand(e) { return await hospitalHandler.handleHealPrompt(e, this); }
    async handleConfirmHealCommand(e) { return await hospitalHandler.handleConfirmHeal(e, this); }
}
