// camellia-plugin/utils/messageHelper.js
import path from 'path';
import fs from 'fs';
import { mercenaryImagePath } from './dataManager.js'; // 导入佣兵图片基础路径
/**
 * @file 消息处理相关的辅助函数。
 */

/**
 * 根据内容数组创建转发消息。
 * 如果内容过多，会分割成多个节点。
 * 节点可以是字符串，也可以是 segment.image() 返回的图片片段。
 * @param {(string|{type: 'image', file: string}|{type: 'image', path: string})}[] contentArray - 包含文本或图片描述对象的数组。
 *   图片对象格式: { type: 'image', file: '图片文件名或URL' } 或 { type: 'image', path: '绝对本地路径' }
 * @param {string} [title="都市情报"] - 转发消息的标题。
 * @returns {Promise<object|string|null>} 成功时返回Yunzai的转发消息对象，失败或内容为空时返回null或错误提示字符串。
 */
export async function makeForwardMsgWithContent(contentArray, title = "都市情报") {
    if (!global.segment || typeof global.segment.image !== 'function') {
        logger.error('[MessageHelper] global.segment.image is not available. Cannot send images in forward messages.');
        // 可以选择回退到纯文本，或者直接报错
        const textOnlyContent = contentArray
            .filter(item => typeof item === 'string')
            .join('\n');
        if (textOnlyContent) {
            return `${title}:\n${textOnlyContent.substring(0, 1000)}\n...(图片功能异常，仅显示文本内容)`;
        }
        return "[都市迷踪] 消息组件异常，无法生成转发消息。";
    }

    if (!contentArray || contentArray.length === 0) {
        logger.warn(`[MessageHelper] makeForwardMsgWithContent: contentArray is empty or null for title "${title}".`);
        return null;
    }

    const forwardMsgNodes = [];
    let currentMessageNodeContent = []; // 现在累积消息片段（文本或图片）

    const MAX_TEXT_NODE_LENGTH_APPROX = 3800; // 文本节点大约长度
    let currentTextLengthInNode = 0;


    for (const item of contentArray) {
        if (typeof item === 'string') {
            // 如果当前节点是文本，并且加入新文本会超长，则先提交当前节点
            if (currentTextLengthInNode > 0 && (currentTextLengthInNode + item.length + 1 > MAX_TEXT_NODE_LENGTH_APPROX)) {
                forwardMsgNodes.push({
                    message: currentMessageNodeContent.join("").trim(), // 拼接文本片段
                    nickname: `${title}`,
                    user_id: global.Bot.uin,
                });
                currentMessageNodeContent = [];
                currentTextLengthInNode = 0;
            }
            currentMessageNodeContent.push(item + "\n");
            currentTextLengthInNode += item.length + 1;

        } else if (typeof item === 'object' && item.type === 'image') {
            // 如果当前有累积的文本，先发送文本节点
            if (currentMessageNodeContent.length > 0) {
                forwardMsgNodes.push({
                    message: currentMessageNodeContent.join("").trim(),
                    nickname: `${title}`,
                    user_id: global.Bot.uin,
                });
                currentMessageNodeContent = [];
                currentTextLengthInNode = 0;
            }

            let imageSource = item.file || item.path;
            let imageSegment = null;

            if (imageSource) {
                if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
                    imageSegment = global.segment.image(imageSource);
                } else {
                    // 本地文件处理
                    const absoluteImagePath = item.path || path.join(mercenaryImagePath, imageSource);
                    if (fs.existsSync(absoluteImagePath)) {
                        // segment.image 通常可以直接接受本地文件路径
                        // 对于Yunzai，它内部会处理如何将本地路径转换成可发送的格式
                        // (可能是上传到临时服务器，或使用file://，或转base64)
                        imageSegment = global.segment.image(absoluteImagePath);
                        // logger.debug(`[MessageHelper] Creating image segment for local file: ${absoluteImagePath}`);
                    } else {
                        logger.warn(`[MessageHelper] Image file not found: ${absoluteImagePath} for item:`, item);
                        currentMessageNodeContent.push(`[图片加载失败: ${imageSource}]\n`);
                        currentTextLengthInNode += `[图片加载失败: ${imageSource}]\n`.length;
                    }
                }
            } else {
                currentMessageNodeContent.push("[图片信息缺失]\n");
                currentTextLengthInNode += "[图片信息缺失]\n".length;
            }

            if (imageSegment) {
                // segment.image() 返回的是一个对象或数组，可以直接作为 message
                forwardMsgNodes.push({
                    message: imageSegment,
                    nickname: `${title}`,
                    user_id: global.Bot.uin,
                });
            }
        }
    }

    // 添加最后一个文本节点（如果还有内容）
    if (currentMessageNodeContent.length > 0) {
        forwardMsgNodes.push({
            message: currentMessageNodeContent.join("").trim(),
            nickname: `${title}`,
            user_id: global.Bot.uin,
        });
    }

    if (forwardMsgNodes.length > 0 && global.Bot && global.Bot.makeForwardMsg) {
        try {
            // 过滤掉 message 为空或无效的节点 (虽然理论上不应该发生)
            const validNodes = forwardMsgNodes.filter(node => node.message && (typeof node.message === 'string' || (Array.isArray(node.message) && node.message.length > 0) || typeof node.message === 'object'));
            if (validNodes.length === 0) {
                logger.warn(`[MessageHelper] No valid forward message nodes were generated for title "${title}".`);
                return "[都市迷踪] 记录为空或无效。";
            }
            return await global.Bot.makeForwardMsg(validNodes);
        } catch (error) {
            logger.error(`[MessageHelper] global.Bot.makeForwardMsg failed for title "${title}":`, error);
            if (forwardMsgNodes.length > 0 && forwardMsgNodes[0].message) {
                let fallbackMessageContent = forwardMsgNodes[0].message;
                if (typeof fallbackMessageContent !== 'string') {
                    // 如果第一个节点是图片segment，无法直接转字符串显示
                    fallbackMessageContent = "[图片内容，转发失败]";
                }
                return `${title}:\n${fallbackMessageContent.substring(0, 500)}\n...(消息过长或转发生成失败，仅显示部分内容)`;
            }
            return "[都市迷踪] 消息生成失败，详情请查看日志。";
        }
    } else if (forwardMsgNodes.length === 0) {
        logger.warn(`[MessageHelper] No forward message nodes were generated for title "${title}".`);
        return "[都市迷踪] 记录为空。";
    } else {
        logger.error(`[MessageHelper] global.Bot or global.Bot.makeForwardMsg is not available.`);
        const fallbackText = contentArray
            .filter(item => typeof item === 'string')
            .join('\n')
            .substring(0, 1000);
        return fallbackText + (fallbackText.length >= 1000 ? "\n...(消息过长且无法转发)" : "");
    }
}