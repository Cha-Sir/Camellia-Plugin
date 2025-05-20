// camellia-plugin/apps/handlers/activityHandler.js

/**
 * @file 活动相关逻辑处理器。
 * @description 处理查看当前活动等功能。
 */

import { getCurrentActivityText } from '../../utils/dataManager.js';
import { makeForwardMsgWithContent } from '../../utils/messageHelper.js';
import { MAX_MESSAGE_LENGTH } from '../../utils/constants.js';


/**
 * 处理查看当前活动的请求。
 * @param {object} e - Yunzai的事件对象。
 * @param {object} pluginInstance - 插件主类的实例。
 */
export async function handleViewCurrentActivity(e, pluginInstance) {
    const activityText = getCurrentActivityText();

    if (!activityText || activityText.trim() === "") {
        return e.reply("获取活动信息失败，或当前没有活动。");
    }

    const title = "都市迷踪 - 当前活动公告";

    // 如果消息过长，尝试使用转发消息发送
    if (activityText.length > MAX_MESSAGE_LENGTH && global.Bot && global.Bot.makeForwardMsg) {
        try {
            // 将活动文本按换行符分割成数组，以便转发消息能正确分段显示
            const activityLines = activityText.split('\n');
            const forwardMsg = await makeForwardMsgWithContent(activityLines, title);
            if (forwardMsg) {
                await e.reply(forwardMsg);
            } else {
                // 如果转发失败，回退到直接发送部分内容
                e.reply(`${title}\n${activityText.substring(0, MAX_MESSAGE_LENGTH)}\n...(活动内容过长，部分信息未能完整显示)`);
            }
        } catch (err) {
            logger.error('[ActivityHandler] 创建活动信息转发失败:', err);
            e.reply(`${title}\n${activityText.substring(0, MAX_MESSAGE_LENGTH)}\n...(信息过载，部分截断)`);
        }
    } else {
        e.reply(`${title}\n${activityText}`);
    }
    return true;
}
