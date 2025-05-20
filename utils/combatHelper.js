// camellia-plugin/utils/combatHelper.js

import {
    applyAttackerWeaponPassives,
    applyDefenderWeaponPassives,
    applyNpcCombatPassives
} from './passiveEffects.js'; // 导入新的被动效果处理器

/**
 * 计算战斗双方的最终战斗力及应用被动效果。
 * @param {object} attacker - 攻击方玩家或NPC游戏内对象
 * @param {object} defender - 防守方玩家或NPC游戏内对象
 * @param {Array<object>} allWeapons - 所有武器定义
 * @returns {{
 * attackerFinalPower: number,
 * defenderFinalPower: number,
 * log: string[],
 * successRateModifier: number,
 * attackerIgnoresWounded: boolean,
 * defenderIgnoresWounded: boolean,
 * loserIgnoresWounded: boolean, // Combined from weapon and NPC passives if applicable
 * attackerNpcSuppressionMaxRate?: number,
 * defenderNpcSuppressionMaxRate?: number
 * }}
 */
function calculateCombatPowerWithPassives(attacker, defender, allWeapons) {
    // 获取武器定义，优先NPC自带的，其次全局的
    // Ensure weapon definitions are fully resolved here
    const attackerWeaponDef = attacker.isNpc && attacker.weapon && typeof attacker.weapon.name === 'string' ?
        attacker.weapon :
        (allWeapons.find(w => w.name === attacker.weapon.name) || attacker.weapon);
    const defenderWeaponDef = defender.isNpc && defender.weapon && typeof defender.weapon.name === 'string' ?
        defender.weapon :
        (allWeapons.find(w => w.name === defender.weapon.name) || defender.weapon);

    let currentAttackerPower = attackerWeaponDef?.baseCombatPower || 0;
    let currentDefenderPower = defenderWeaponDef?.baseCombatPower || 0;
    const combatLog = [];
    let totalSuccessRateModifier = 0; // Accumulates success rate changes

    let attackerIgnoresWoundedStatus = false;
    let defenderIgnoresWoundedStatus = false;
    let loserCanIgnoreWound = false; // If any passive allows loser to ignore wound

    let finalAttackerNpcSuppressionMaxRate;
    let finalDefenderNpcSuppressionMaxRate;

    combatLog.push(`[战况分析] ${attacker.nickname} (初始威胁: ${currentAttackerPower}) vs ${defender.nickname} (初始威胁: ${currentDefenderPower})`);

    // 1. Apply Attacker's Weapon Passives
    if (attackerWeaponDef) {
        const attackerWeaponPassiveResult = applyAttackerWeaponPassives(attacker, defender, attackerWeaponDef, currentAttackerPower, currentDefenderPower, combatLog);
        currentAttackerPower = Math.round(attackerWeaponPassiveResult.attackerPower);
        currentDefenderPower = Math.round(attackerWeaponPassiveResult.defenderPower);
        totalSuccessRateModifier += attackerWeaponPassiveResult.successRateMod;
        if (attackerWeaponPassiveResult.ignoresWounded) attackerIgnoresWoundedStatus = true;
        combatLog.push(...attackerWeaponPassiveResult.logEntries);
    }


    // 2. Apply Defender's Weapon Passives
    if (defenderWeaponDef) {
        const defenderWeaponPassiveResult = applyDefenderWeaponPassives(defender, attacker, defenderWeaponDef, currentAttackerPower, currentDefenderPower, combatLog);
        currentAttackerPower = Math.round(defenderWeaponPassiveResult.attackerPower);
        currentDefenderPower = Math.round(defenderWeaponPassiveResult.defenderPower);
        totalSuccessRateModifier += defenderWeaponPassiveResult.successRateMod;
        if (defenderWeaponPassiveResult.ignoresWounded) defenderIgnoresWoundedStatus = true;
        if (defenderWeaponPassiveResult.postCombatIgnoreWound) loserCanIgnoreWound = true;
        combatLog.push(...defenderWeaponPassiveResult.logEntries);
    }


    // 3. Apply NPC Combat Passives (if applicable)
    if (attacker.isNpc) {
        const npcPassiveResult = applyNpcCombatPassives(attacker, defender, true, currentAttackerPower, currentDefenderPower, combatLog);
        currentAttackerPower = Math.round(npcPassiveResult.npcPower);
        currentDefenderPower = Math.round(npcPassiveResult.opponentPower);
        totalSuccessRateModifier += npcPassiveResult.successRateMod;
        if (npcPassiveResult.npcSuppressionMaxRate !== undefined) {
            finalAttackerNpcSuppressionMaxRate = npcPassiveResult.npcSuppressionMaxRate;
        }
        combatLog.push(...npcPassiveResult.logEntries);
    }
    if (defender.isNpc) {
        const npcPassiveResult = applyNpcCombatPassives(defender, attacker, false, currentDefenderPower, currentAttackerPower, combatLog);
        currentDefenderPower = Math.round(npcPassiveResult.npcPower);
        currentAttackerPower = Math.round(npcPassiveResult.opponentPower);
        totalSuccessRateModifier += npcPassiveResult.successRateMod;
        if (npcPassiveResult.npcSuppressionMaxRate !== undefined) {
            finalDefenderNpcSuppressionMaxRate = npcPassiveResult.npcSuppressionMaxRate;
        }
        combatLog.push(...npcPassiveResult.logEntries);
    }

    // 4. Apply Wounded Status Effects (if not ignored by passives)
    if (attacker.status === 'wounded' && !attackerIgnoresWoundedStatus) {
        currentAttackerPower *= 0.6;
        combatLog.push(`攻击方 (${attacker.nickname}) 系统受损，出力大幅下降!`);
    }
    if (defender.status === 'wounded' && !defenderIgnoresWoundedStatus) {
        currentDefenderPower *= 0.6;
        combatLog.push(`防守方 (${defender.nickname}) 系统受损，出力大幅下降!`);
    }

    currentAttackerPower = Math.max(0, Math.round(currentAttackerPower));
    currentDefenderPower = Math.max(0, Math.round(currentDefenderPower));

    combatLog.push(`[最终评估] ${attacker.nickname} 威胁 ${currentAttackerPower} vs ${defender.nickname} 威胁 ${currentDefenderPower}`);

    return {
        attackerFinalPower: currentAttackerPower,
        defenderFinalPower: currentDefenderPower,
        log: combatLog,
        successRateModifier: totalSuccessRateModifier,
        attackerIgnoresWounded: attackerIgnoresWoundedStatus,
        defenderIgnoresWounded: defenderIgnoresWoundedStatus,
        loserIgnoresWounded: loserCanIgnoreWound,
        attackerNpcSuppressionMaxRate: finalAttackerNpcSuppressionMaxRate,
        defenderNpcSuppressionMaxRate: finalDefenderNpcSuppressionMaxRate
    };
}

/**
 * 根据双方最终战斗力及成功率修正决定胜负
 * @param {number} attackerFinalPower 攻击方最终战力
 * @param {number} defenderFinalPower 防守方最终战力
 * @param {number} successRateModifier 来自被动的成功率修正值 (百分点)
 * @param {object} combatPassivesResult - 从 calculateCombatPowerWithPassives 返回的包含NPC压制等特殊被动信息的对象
 * @returns {{attackerWins: boolean, detail: string}} 攻击方是否胜利及判定详情
 */
function determineBattleOutcome(attackerFinalPower, defenderFinalPower, successRateModifier = 0, combatPassivesResult = {}) {
    const totalPower = attackerFinalPower + defenderFinalPower;
    let attackerWinProbability;

    if (totalPower === 0) { //双方战力都为0的罕见情况
        attackerWinProbability = 0.5;
    } else {
        attackerWinProbability = attackerFinalPower / totalPower;
    }

    // 应用直接的成功率修正
    attackerWinProbability += successRateModifier;

    // 应用NPC压制被动 (限制对手的最高成功率，从而保证自己有最低成功率，或限制自己的最高成功率)
    if (combatPassivesResult.attackerNpcSuppressionMaxRate !== undefined) { // 攻击方NPC有压制，限制防守方成功率
        const defenderMaxSuccess = combatPassivesResult.attackerNpcSuppressionMaxRate;
        const attackerMinWinProb = 1 - defenderMaxSuccess;
        if (attackerWinProbability < attackerMinWinProb) {
            attackerWinProbability = attackerMinWinProb;
        }
    }
    if (combatPassivesResult.defenderNpcSuppressionMaxRate !== undefined) { // 防守方NPC有压制，限制攻击方成功率
        if (attackerWinProbability > combatPassivesResult.defenderNpcSuppressionMaxRate) {
            attackerWinProbability = combatPassivesResult.defenderNpcSuppressionMaxRate;
        }
    }

    // 引入随机性，但战力差越大，随机性影响越小
    const powerRatio = totalPower > 0 ? Math.abs(attackerFinalPower - defenderFinalPower) / totalPower : 0;
    const randomFactorRange = 0.15 * (1 - Math.min(powerRatio, 0.8)); // 最大削减80%的随机范围

    const randomRoll = (Math.random() - 0.5) * 2 * randomFactorRange; // 随机数范围 [-randomFactorRange, +randomFactorRange]
    attackerWinProbability += randomRoll;

    // 确保胜率在合理范围内 (例如 5% 到 95%)
    attackerWinProbability = Math.max(0.05, Math.min(0.95, attackerWinProbability));

    const roll = Math.random();
    const attackerWins = roll < attackerWinProbability;

    const detail = `判定掷骰: ${roll.toFixed(3)}, 攻击方胜率阈值: ${attackerWinProbability.toFixed(3)} (含所有修正)`;

    return { attackerWins, detail };
}

export { calculateCombatPowerWithPassives, determineBattleOutcome };
