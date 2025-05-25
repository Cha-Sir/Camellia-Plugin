// camellia-plugin/utils/messageHelper.js
import path from 'path';
import fs from 'fs';
import { mercenaryImagePath } from './dataManager.js'; // 假设此文件存在且正确导出

/**
 * @file 消息处理相关的辅助函数。
 */

const DEFAULT_LINE_WRAP_THRESHOLD = 150; // 每行文字的推荐最大长度，可根据实际效果调整
const PREFERRED_BREAK_CHARS = "，。！？；,.;"; // 优先在这些标点后换行

/**
 * 格式化单个节点的文本，实现自动换行。
 * @param {string} text - 需要格式化的原始文本。
 * @param {number} maxLengthPerLine - 每行的最大字符长度。
 * @param {string} preferredBreakChars - 优先用于换行的标点符号字符串。
 * @returns {string} - 格式化后的文本，包含换行符。
 */
function formatNodeTextWithLineBreaks(text, maxLengthPerLine = DEFAULT_LINE_WRAP_THRESHOLD, preferredBreakChars = PREFERRED_BREAK_CHARS) {
    if (!text || typeof text !== 'string') {
        return text; //直接返回非字符串或空值
    }

    // 首先，尊重原文中已有的换行符
    const originalLines = text.split('\n');
    const resultLines = [];

    for (const singleOriginalLine of originalLines) {
        if (singleOriginalLine.length <= maxLengthPerLine) {
            resultLines.push(singleOriginalLine);
            continue;
        }

        let currentLineContent = "";
        // 对于中文这类字符，直接按字处理可能更简单
        // 对于混合语言，按词分割更复杂，这里先用字符迭代简化处理
        for (let i = 0; i < singleOriginalLine.length; i++) {
            const char = singleOriginalLine[i];
            currentLineContent += char;

            if (currentLineContent.length >= maxLengthPerLine) {
                let breakPoint = -1;
                // 从当前行末尾向前查找最佳断点（标点符号）
                // 允许稍微超出maxLengthPerLine一点点，以便找到标点
                for (let j = currentLineContent.length - 1; j >= 0; j--) {
                    // 确保断点不会太靠前，导致一行过短 (例如，至少是长度阈值的1/3)
                    // 并且断点后的部分不会太短 (例如，如果断点是最后一个字符，那也是可以的)
                    if (preferredBreakChars.includes(currentLineContent[j]) && j > maxLengthPerLine / 3) {
                        breakPoint = j;
                        break;
                    }
                }

                if (breakPoint !== -1) {
                    // 在标点符号后换行
                    resultLines.push(currentLineContent.substring(0, breakPoint + 1));
                    currentLineContent = currentLineContent.substring(breakPoint + 1);
                } else {
                    // 未找到合适标点，进行硬换行 (或者可以让这行稍微长一点，取决于策略)
                    // 这里我们选择在maxLengthPerLine处硬换行
                    resultLines.push(currentLineContent.substring(0, maxLengthPerLine));
                    currentLineContent = currentLineContent.substring(maxLengthPerLine);
                }
            }
        }
        // 添加最后剩余的部分
        if (currentLineContent.length > 0) {
            resultLines.push(currentLineContent);
        }
    }

    return resultLines.join('\n').trim();
}


/**
 * 根据内容数组创建转发消息。
 * @param {(string|{type: 'image', file: string}|{type: 'image', path: string})}[] contentArray - 包含文本或图片描述对象的数组。
 * @param {string} [title="都市情报"] - 转发消息的标题。
 * @param {boolean} [forceSeparateTextNodes=false] - 如果为 true, 每个字符串元素都会成为一个独立的转发节点，并应用内部换行。否则，会尝试合并文本节点。
 * @returns {Promise<object|string|null>} 成功时返回Yunzai的转发消息对象，失败或内容为空时返回null或错误提示字符串。
 */
export async function makeForwardMsgWithContent(contentArray, title = "都市情报", forceSeparateTextNodes = false) {
    // 假设 logger 是全局可用的，如果不是，请传入或者用 console
    const currentLogger = global.logger || console;

    if (!global.segment || typeof global.segment.image !== 'function') {
        currentLogger.error('[MessageHelper] global.segment.image is not available. Cannot send images in forward messages.');
        const textOnlyContent = contentArray
            .filter(item => typeof item === 'string')
            .join('\n');
        if (textOnlyContent) {
            return `${title}:\n${textOnlyContent.substring(0, 1000)}\n...(图片功能异常，仅显示文本内容)`;
        }
        return "[卡莫利安] 消息组件异常，无法生成转发消息。";
    }

    if (!contentArray || contentArray.length === 0) {
        currentLogger.warn(`[MessageHelper] makeForwardMsgWithContent: contentArray is empty or null for title "${title}".`);
        return null;
    }

    const forwardMsgNodes = [];
    let currentMessageNodeContentArray = []; // 用于非 forceSeparateTextNodes 时的文本合并
    let currentTextLengthInNode = 0; // 用于非 forceSeparateTextNodes 时的文本合并
    const MAX_TEXT_NODE_LENGTH_APPROX = 3800; // 单个转发节点（合并文本时）的最大文本长度近似值


    for (const item of contentArray) {
        if (typeof item === 'string') {
            if (forceSeparateTextNodes) {
                if (currentMessageNodeContentArray.length > 0) { // Should not happen if logic is clean before this string item
                    forwardMsgNodes.push({
                        message: currentMessageNodeContentArray.join("").trim(),
                        nickname: `${title}`,
                        user_id: global.Bot.uin,
                    });
                    currentMessageNodeContentArray = [];
                    currentTextLengthInNode = 0;
                }
                // 每个字符串直接成为一个新节点，并应用内部换行
                if (item.trim() !== "") { // 避免空字符串节点
                    const formattedText = formatNodeTextWithLineBreaks(item.trim()); // 调用新函数
                    forwardMsgNodes.push({
                        message: formattedText,
                        nickname: `${title}`,
                        user_id: global.Bot.uin,
                    });
                }
            } else { // Original logic: try to combine text nodes
                if (currentMessageNodeContentArray.length > 0 &&
                    (currentTextLengthInNode + item.length + 1 > MAX_TEXT_NODE_LENGTH_APPROX || item.length > MAX_TEXT_NODE_LENGTH_APPROX / 2)) {
                    forwardMsgNodes.push({
                        message: currentMessageNodeContentArray.join("").trim(),
                        nickname: `${title}`,
                        user_id: global.Bot.uin,
                    });
                    currentMessageNodeContentArray = [];
                    currentTextLengthInNode = 0;
                }
                currentMessageNodeContentArray.push(item + "\n"); // 合并时，依然保留原始的换行（或添加换行）
                currentTextLengthInNode += item.length + 1;
            }

        } else if (typeof item === 'object' && item.type === 'image') {
            // 图片前的累积文本（如果不强制分离，或者即便是强制分离，前面若有文本也已处理）
            if (currentMessageNodeContentArray.length > 0) {
                forwardMsgNodes.push({
                    message: currentMessageNodeContentArray.join("").trim(),
                    nickname: `${title}`,
                    user_id: global.Bot.uin,
                });
                currentMessageNodeContentArray = [];
                currentTextLengthInNode = 0;
            }

            let imageSource = item.file || item.path;
            let imageSegment = null;

            if (imageSource) {
                if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
                    imageSegment = global.segment.image(imageSource);
                } else {
                    const absoluteImagePath = item.path || path.join(mercenaryImagePath, imageSource); // mercenaryImagePath 需要正确设置
                    if (fs.existsSync(absoluteImagePath)) {
                        imageSegment = global.segment.image(absoluteImagePath);
                    } else {
                        currentLogger.warn(`[MessageHelper] Image file not found: ${absoluteImagePath} for item:`, item);
                        const errorText = `[图片加载失败: ${imageSource}]\n`;
                        if (forceSeparateTextNodes) {
                            // 即便图片加载失败，错误文本也应该遵循换行规则（虽然很短）
                            forwardMsgNodes.push({ message: formatNodeTextWithLineBreaks(errorText.trim()), nickname: title, user_id: global.Bot.uin });
                        } else {
                            currentMessageNodeContentArray.push(errorText);
                            currentTextLengthInNode += errorText.length;
                        }
                    }
                }
            } else {
                const errorText = "[图片信息缺失]\n";
                if (forceSeparateTextNodes) {
                    forwardMsgNodes.push({ message: formatNodeTextWithLineBreaks(errorText.trim()), nickname: title, user_id: global.Bot.uin });
                } else {
                    currentMessageNodeContentArray.push(errorText);
                    currentTextLengthInNode += errorText.length;
                }
            }

            if (imageSegment) {
                forwardMsgNodes.push({
                    message: imageSegment,
                    nickname: `${title}`,
                    user_id: global.Bot.uin,
                });
            }
        }
    }

    // 添加最后一个累积的文本节点（如果不强制分离）
    if (currentMessageNodeContentArray.length > 0) {
        forwardMsgNodes.push({
            message: currentMessageNodeContentArray.join("").trim(), // 合并的文本不经过formatNodeTextWithLineBreaks，因为它可能包含多段原始内容
            nickname: `${title}`,
            user_id: global.Bot.uin,
        });
    }

    if (forwardMsgNodes.length > 0 && global.Bot && global.Bot.makeForwardMsg) {
        try {
            // 过滤掉message为空或仅含空白的节点
            const validNodes = forwardMsgNodes.filter(node => {
                if (typeof node.message === 'string') return node.message.trim() !== "";
                return !!node.message; // 对于图片等非字符串消息，只要存在就有效
            });

            if (validNodes.length === 0) {
                currentLogger.warn(`[MessageHelper] No valid forward message nodes were generated for title "${title}".`);
                return "[卡莫利安系统] 记录为空或无效。";
            }
            return await global.Bot.makeForwardMsg(validNodes);
        } catch (error) {
            currentLogger.error(`[MessageHelper] global.Bot.makeForwardMsg failed for title "${title}":`, error);
            // Fallback logic...
            if (forwardMsgNodes.length > 0 && forwardMsgNodes[0].message) {
                let fallbackMessageContent = "";
                if (typeof forwardMsgNodes[0].message === 'string') {
                    fallbackMessageContent = forwardMsgNodes[0].message;
                } else if (Array.isArray(forwardMsgNodes[0].message) && typeof forwardMsgNodes[0].message[0]?.text === 'string') { // Handle segment object (e.g. if image was stringified)
                    fallbackMessageContent = forwardMsgNodes[0].message[0].text;
                } else {
                    fallbackMessageContent = "[消息内容复杂，转发失败]";
                }
                return `${title}:\n${fallbackMessageContent.substring(0, 500)}\n...(消息过长或转发生成失败，仅显示部分内容)`;
            }
            return "[卡莫利安] 消息生成失败，详情请查看日志。";
        }
    } else if (forwardMsgNodes.length === 0) {
        currentLogger.warn(`[MessageHelper] No forward message nodes were generated for title "${title}".`);
        return "[卡莫利安] 记录为空。";
    } else {
        // Fallback for no global.Bot.makeForwardMsg
        currentLogger.error(`[MessageHelper] global.Bot or global.Bot.makeForwardMsg is not available.`);
        const fallbackText = contentArray
            .filter(item => typeof item === 'string')
            // 如果forceSeparateTextNodes为true，我们应该用格式化后的文本进行fallback
            .map(item => (typeof item === 'string' && forceSeparateTextNodes) ? formatNodeTextWithLineBreaks(item) : item)
            .join('\n')
            .substring(0, 1000);
        return fallbackText + (fallbackText.length >= 1000 ? "\n...(消息过长且无法转发)" : "");
    }
}