// camellia-plugin/apps/handlers/hospitalHandler.js

/**
 * @file 医院及治疗相关逻辑处理器。
 */

import { getPlayerData, savePlayerData } from '../../utils/dataManager.js';
import { INJURY_LEVELS } from '../../utils/constants.js'; // Assuming INJURY_LEVELS is in constants.js

export async function handleHealPrompt(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) {
        return e.reply("身份验证失败，无法访问医疗服务。");
    }

    if (!playerData.needsTreatment || playerData.permanentInjuryStatus === 'none') {
        return e.reply(`[${nickname}] 您目前健康状况良好，无需治疗。`);
    }

    const injuryKey = playerData.permanentInjuryStatus;
    const injuryInfo = INJURY_LEVELS[injuryKey];

    if (!injuryInfo) {
        logger.error(`[HospitalHandler] 玩家 ${userId} (${nickname}) 存在未知伤病状态: ${injuryKey}`);
        playerData.permanentInjuryStatus = 'none'; // Reset to avoid loop
        playerData.needsTreatment = false;
        await savePlayerData(userId, playerData);
        return e.reply(`[${nickname}] 您的健康档案存在异常数据，已尝试修正。请重新评估状况。`);
    }

    let replyMsg = `调查员 ${nickname}，您当前的伤势评估为：【${injuryInfo.name}】。\n`;
    replyMsg += `治疗所需资金：${injuryInfo.cost}。\n`;
    replyMsg += `请回复 #确认治疗 以进行治疗。`;

    return e.reply(replyMsg);
}

export async function handleConfirmHeal(e, pluginInstance) {
    const userId = e.user_id;
    const nickname = e.sender.card || e.sender.nickname || `调查员${String(userId).slice(-4)}`;
    const { playerData } = await pluginInstance.getPlayer(userId, nickname);

    if (!playerData) {
        return e.reply("身份验证失败，无法执行治疗。");
    }

    if (!playerData.needsTreatment || playerData.permanentInjuryStatus === 'none') {
        return e.reply(`[${nickname}] 您无需治疗，或已恢复健康。`);
    }

    const injuryKey = playerData.permanentInjuryStatus;
    const injuryInfo = INJURY_LEVELS[injuryKey];

    if (!injuryInfo) {
        logger.error(`[HospitalHandler] 确认治疗时，玩家 ${userId} (${nickname}) 存在未知伤病状态: ${injuryKey}`);
        playerData.permanentInjuryStatus = 'none';
        playerData.needsTreatment = false;
        await savePlayerData(userId, playerData);
        return e.reply(`[${nickname}] 您的健康档案在治疗确认时出现异常，已尝试修正。请重新评估状况。`);
    }

    if (playerData.funds < injuryInfo.cost) {
        return e.reply(`[${nickname}] 资金不足！治疗【${injuryInfo.name}】需要 ${injuryInfo.cost} 资金，您当前持有 ${playerData.funds}。`);
    }

    playerData.funds -= injuryInfo.cost;
    playerData.permanentInjuryStatus = 'none';
    playerData.needsTreatment = false;

    await savePlayerData(userId, playerData);

    return e.reply(`[${nickname}] 治疗成功！您已恢复健康。花费 ${injuryInfo.cost} 资金，剩余 ${playerData.funds} 资金。`);
}
