// camellia-plugin/utils/messageHelper.js

/**
 * @file 消息处理相关的辅助函数。
 */

/**
 * 根据日志数组创建转发消息。
 * 如果日志条目过多，会分割成多个节点。
 * @param {string[]} logArray - 包含日志条目的字符串数组。
 * @param {string} [title="都市情报"] - 转发消息的标题。
 * @returns {Promise<object|string|null>} 成功时返回Yunzai的转发消息对象，失败或内容为空时返回null或错误提示字符串。
 */
export async function makeForwardMsgWithContent(logArray, title = "都市情报") {
    if (!logArray || logArray.length === 0) {
        logger.warn(`[MessageHelper] makeForwardMsgWithContent: logArray is empty or null for title "${title}".`);
        return null;
    }

    const forwardMsgNodes = [];
    let currentMessageNodeContent = "";
    const MAX_NODE_LENGTH = 3800;

    for (const logEntry of logArray) {
        if (currentMessageNodeContent.length + logEntry.length + 1 > MAX_NODE_LENGTH && currentMessageNodeContent.length > 0) {
            forwardMsgNodes.push({
                message: currentMessageNodeContent.trim(),
                nickname: `${title}`,
                user_id: global.Bot.uin,
            });
            currentMessageNodeContent = "";
        }
        currentMessageNodeContent += logEntry + "\n";
    }

    if (currentMessageNodeContent.trim().length > 0) {
        forwardMsgNodes.push({
            message: currentMessageNodeContent.trim(),
            nickname: `${title}`,
            user_id: global.Bot.uin,
        });
    }

    if (forwardMsgNodes.length > 0 && global.Bot && global.Bot.makeForwardMsg) {
        try {
            return await global.Bot.makeForwardMsg(forwardMsgNodes);
        } catch (error) {
            logger.error(`[MessageHelper] global.Bot.makeForwardMsg failed for title "${title}":`, error);
            if (forwardMsgNodes.length > 0 && forwardMsgNodes[0].message) {
                return `${title}:\n${forwardMsgNodes[0].message.substring(0, 500)}\n...(消息过长或转发生成失败，仅显示部分内容)`;
            }
            return "[都市迷踪] 消息生成失败，详情请查看日志。";
        }
    } else if (forwardMsgNodes.length === 0) {
        logger.warn(`[MessageHelper] No forward message nodes were generated for title "${title}".`);
        return "[都市迷踪] 记录为空。";
    } else {
        logger.error(`[MessageHelper] global.Bot or global.Bot.makeForwardMsg is not available.`);
        return logArray.join('\n').substring(0, 1000) + (logArray.join('\n').length > 1000 ? "\n...(消息过长且无法转发)" : "");
    }
}
