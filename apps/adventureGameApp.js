// camellia-plugin/apps/adventureGameApp.js
/**
 * @file 都市迷踪（搜打撤）插件主文件。
 * @description 初始化插件，定义消息规则，并将具体逻辑分发到不同的处理器模块。
 */

import plugin from '../../../lib/plugins/plugin.js';
import { loadAllBaseData, getPlayerData } from '../utils/dataManager.js';
import { VALID_STRATEGIES } from '../utils/constants.js';

import * as gameHandler from './handlers/gameHandler.js';
import * as shopHandler from './handlers/shopHandler.js';
import * as infoHandler from './handlers/infoHandler.js';
import * as activityHandler from './handlers/activityHandler.js';
import * as hospitalHandler from './handlers/hospitalHandler.js';
import * as mercenaryHandler from './handlers/mercenaryHandler.js'; // 新增佣兵处理器
import * as arenaHandler from './handlers/arenaHandler.js';       // 新增竞技场处理器

export class AdventureGame extends plugin {
    constructor() {
        super({
            name: '都市迷踪（含佣兵竞技）', // 修改插件名称以反映新功能
            dsc: '近未来都市的异常探索与佣兵竞技游戏。 #搜打撤帮助 查看指令',
            event: 'message',
            priority: 500,
            rule: [
                // 原有规则
                {
                    reg: `^#进入地图\\s*([^\\s]+|\\d+)(?:\\s*武器\\s*([^\\s]+)\\s*策略\\s*(${VALID_STRATEGIES.join('|')}))?$`,
                    fnc: 'enterMap'
                },
                { reg: `^#新手礼包$`, fnc: 'claimNewbieGift' },
                { reg: '^#退出队列$', fnc: 'leaveQueue' },
                { reg: '^#查看队列$', fnc: 'viewQueues' },
                { reg: '^#查看商店$', fnc: 'viewShop' },
                { reg: '^#购买武器\\s*([^\\s]+)$', fnc: 'buyWeaponFromShop' },
                { reg: '^#购买称号\\s*(.+)$', fnc: 'buyTitleFromShop' },
                { reg: '^#装备称号\\s*(.+)$', fnc: 'equipTitle' },
                { reg: '^#出售物品\\s*([^\\s]+)$', fnc: 'sellItemFromInventory' },
                { reg: '^#我的信息$', fnc: 'viewMyInfo' },
                { reg: '^#重载冒险数据$', fnc: 'reloadDataAdmin', permission: 'master' },
                { reg: '^#搜打撤帮助$', fnc: 'showHelp' }, // 帮助信息需要更新
                { reg: '^#地图列表$', fnc: 'listMaps' },
                { reg: '^#武器列表$', fnc: 'listWeapons' },
                { reg: '^#排行榜$', fnc: 'showLeaderboard' },
                { reg: '^#查看当前活动$', fnc: 'viewCurrentActivity' },
                { reg: '^#治疗$', fnc: 'handleHealPromptCommand' },
                { reg: '^#确认治疗$', fnc: 'handleConfirmHealCommand' },
                { reg: `^#装备\\s*([^\\s]+)$`, fnc: 'setDefaultWeapon' },
                { reg: `^#策略\\s*(${VALID_STRATEGIES.join('|')})$`, fnc: 'setDefaultStrategy' },
                { reg: `^#自动治疗$`, fnc: 'toggleAutoHeal' },

                // 新增佣兵系统规则
                { reg: '^#随机招募$', fnc: 'recruitMercenary' },
                { reg: '^#随机十连$', fnc: 'recruitMercenaryTenTimes' },
                { reg: '^#佣兵列表$', fnc: 'listPlayerMercenaries' },

                // 新增竞技场系统规则
                // 匹配 #佣兵配队 1,2,3,4,5 或 #佣兵配队 佣兵名1, 佣兵名2 ...
                // 为简化，当前handler的实现是基于序号的，所以正则匹配数字和逗号/空格
                { reg: '^#佣兵配队\\s*([\\d,\\s，]+)$', fnc: 'setArenaTeam' },
                { reg: '^#加入竞技场$', fnc: 'joinArena' },
                { reg: '^#退出竞技场队列$', fnc: 'leaveArenaQueue' },
                { // 新增：查看佣兵详情指令
                    reg: '^#查看佣兵(?:\\s*(.+))?$', // 匹配 #查看佣兵 和 #查看佣兵 名字/序号 (参数可选)
                    fnc: 'viewMercenaryDetail',
                    permission: 'all',
                    describe: '查看指定佣兵的详细信息或列出所有佣兵以供选择',
                },
                { // 新增：#查看 作为 #查看佣兵 的别名 (无参数时)
                    reg: '^#查看$',
                    fnc: 'viewMercenaryDetail', // 直接调用同一个处理函数，它会处理无参数的情况
                    permission: 'all',
                    describe: '列出可查看详情的佣兵 (同 #查看佣兵)',
                },// 新增
            ]
        });
        this.initializePluginSystems();
    }

    async initializePluginSystems() {
        try {
            await loadAllBaseData();
            logger.info('[AdventureGameApp] 核心系统数据接口已连接。');
            gameHandler.initializeGameHandlerTimedTasks(this);
            logger.info('[AdventureGameApp] Game handler timed tasks initialized.');
        } catch (error) {
            logger.error('[AdventureGameApp] 插件系统初始化失败:', error);
        }
    }

    async reloadDataAdmin(e) {
        if (!e.isMaster) return false;
        try {
            await loadAllBaseData();
            e.reply("核心系统数据已强制刷新。");
            logger.info('[AdventureGameApp] 核心数据已由管理员强制刷新。');
            gameHandler.initializeGameHandlerTimedTasks(this);
            logger.info('[AdventureGameApp] Game handler timed tasks re-initialized after data reload.');
        } catch (error) {
            logger.error('[AdventureGameApp] 管理员强制刷新核心数据失败:', error);
            e.reply("核心系统数据刷新失败，请检查维护日志。");
        }
        return true;
    }

    async getPlayer(userId, nickname = '') {
        return await getPlayerData(userId, nickname);
    }

    // --- 原有规则函数 ---
    async enterMap(e) { return await gameHandler.handleEnterMap(e, this); }
    async leaveQueue(e) { return await gameHandler.handleLeaveQueue(e, this); }
    async viewQueues(e) { return await gameHandler.handleViewQueues(e, this); }
    async viewShop(e) { return await shopHandler.handleViewShop(e, this); }
    async buyWeaponFromShop(e) { return await shopHandler.handleBuyWeaponFromShop(e, this); }
    async buyTitleFromShop(e) { return await shopHandler.handleBuyTitleFromShop(e, this); }
    async equipTitle(e) { return await shopHandler.handleEquipTitle(e, this); }
    async sellItemFromInventory(e) { return await shopHandler.handleSellItemFromInventory(e, this); }
    async viewMyInfo(e) { return await infoHandler.handleViewMyInfo(e, this); }
    async showHelp(e) { return await infoHandler.handleShowHelp(e, this); } // 帮助内容需要更新
    async listMaps(e) { return await infoHandler.handleListMaps(e, this); }
    async listWeapons(e) { return await infoHandler.handleListWeapons(e, this); }
    async showLeaderboard(e) { return await infoHandler.handleShowLeaderboard(e, this); }
    async viewCurrentActivity(e) { return await activityHandler.handleViewCurrentActivity(e, this); }
    async handleHealPromptCommand(e) { return await hospitalHandler.handleHealPrompt(e, this); }
    async handleConfirmHealCommand(e) { return await hospitalHandler.handleConfirmHeal(e, this); }
    async setDefaultWeapon(e) { return await infoHandler.handleSetDefaultWeapon(e, this); }
    async setDefaultStrategy(e) { return await infoHandler.handleSetDefaultStrategy(e, this); }
    async toggleAutoHeal(e) { return await infoHandler.handleToggleAutoHeal(e, this); }

    // --- 新增佣兵系统处理函数 ---
    async recruitMercenary(e) { return await mercenaryHandler.handleRecruitMercenary(e, this); }
    async recruitMercenaryTenTimes(e) { return await mercenaryHandler.handleRecruitMercenaryTenTimes(e, this); }
    async listPlayerMercenaries(e) { return await mercenaryHandler.handleListPlayerMercenaries(e, this); }
    async viewMercenaryDetail(e) { return await mercenaryHandler.handleViewMercenaryDetail(e, this); }
    // --- 新增竞技场系统处理函数 ---
    async setArenaTeam(e) { return await arenaHandler.handleSetArenaTeam(e, this); }
    async joinArena(e) { return await arenaHandler.handleJoinArena(e, this); }
    async leaveArenaQueue(e) { return await arenaHandler.handleLeaveArenaQueue(e, this); }
    async claimNewbieGift(e) { return await infoHandler.handleClaimNewbieGift(e, this); }// 新增
}