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
 * successRateModifier: number, // This is the modifier from passives/environment before the random battle fluctuation
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
    const combatLog = []; // This log accumulates messages from all stages
    let totalSuccessRateModifier = 0; // Accumulates success rate changes from passives

    let attackerIgnoresWoundedStatus = false;
    let defenderIgnoresWoundedStatus = false;
    let loserCanIgnoreWound = false; // If any passive allows loser to ignore wound

    let finalAttackerNpcSuppressionMaxRate;
    let finalDefenderNpcSuppressionMaxRate;

    combatLog.push(`[战况分析] ${attacker.nickname || '攻击方'} (初始威胁: ${currentAttackerPower}) vs ${defender.nickname || '防守方'} (初始威胁: ${currentDefenderPower})`);

    // 1. Apply Attacker's Weapon Passives
    if (attackerWeaponDef) {
        // Corrected: Removed combatLog argument as applyAttackerWeaponPassives returns its own logEntries
        const attackerWeaponPassiveResult = applyAttackerWeaponPassives(attacker, defender, attackerWeaponDef, currentAttackerPower, currentDefenderPower);
        currentAttackerPower = Math.round(attackerWeaponPassiveResult.attackerPower);
        currentDefenderPower = Math.round(attackerWeaponPassiveResult.defenderPower);
        totalSuccessRateModifier += attackerWeaponPassiveResult.successRateMod;
        if (attackerWeaponPassiveResult.ignoresWounded) attackerIgnoresWoundedStatus = true;
        combatLog.push(...attackerWeaponPassiveResult.logEntries);
    }


    // 2. Apply Defender's Weapon Passives
    if (defenderWeaponDef) {
        // Corrected: Removed combatLog argument
        const defenderWeaponPassiveResult = applyDefenderWeaponPassives(defender, attacker, defenderWeaponDef, currentAttackerPower, currentDefenderPower);
        currentAttackerPower = Math.round(defenderWeaponPassiveResult.attackerPower);
        currentDefenderPower = Math.round(defenderWeaponPassiveResult.defenderPower);
        totalSuccessRateModifier += defenderWeaponPassiveResult.successRateMod; // Defender's evasion can reduce attacker's success rate
        if (defenderWeaponPassiveResult.ignoresWounded) defenderIgnoresWoundedStatus = true;
        if (defenderWeaponPassiveResult.postCombatIgnoreWound) loserCanIgnoreWound = true;
        combatLog.push(...defenderWeaponPassiveResult.logEntries);
    }


    // 3. Apply NPC Combat Passives (if applicable)
    // Note: NPC combat passives might also affect successRateModifier or introduce suppression.
    if (attacker.isNpc && attacker.combatPassive) {
        // Corrected: Removed combatLog argument
        const npcPassiveResult = applyNpcCombatPassives(attacker, defender, true, currentAttackerPower, currentDefenderPower);
        currentAttackerPower = Math.round(npcPassiveResult.npcPower);
        currentDefenderPower = Math.round(npcPassiveResult.opponentPower);
        totalSuccessRateModifier += npcPassiveResult.successRateMod;
        if (npcPassiveResult.npcSuppressionMaxRate !== undefined) {
            finalAttackerNpcSuppressionMaxRate = npcPassiveResult.npcSuppressionMaxRate;
        }
        combatLog.push(...npcPassiveResult.logEntries);
    }
    if (defender.isNpc && defender.combatPassive) {
        // Corrected: Removed combatLog argument
        const npcPassiveResult = applyNpcCombatPassives(defender, attacker, false, currentDefenderPower, currentAttackerPower);
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
        currentAttackerPower *= 0.6; // 负伤状态战力惩罚
        combatLog.push(`攻击方 (${attacker.nickname || '攻击方'}) 系统受损，出力大幅下降!`);
    }
    if (defender.status === 'wounded' && !defenderIgnoresWoundedStatus) {
        currentDefenderPower *= 0.6; // 负伤状态战力惩罚
        combatLog.push(`防守方 (${defender.nickname || '防守方'}) 系统受损，出力大幅下降!`);
    }

    currentAttackerPower = Math.max(0, Math.round(currentAttackerPower));
    currentDefenderPower = Math.max(0, Math.round(currentDefenderPower));

    combatLog.push(`[最终评估] ${attacker.nickname || '攻击方'} 威胁 ${currentAttackerPower} vs ${defender.nickname || '防守方'} 威胁 ${currentDefenderPower}`);

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
 * @param {number} passiveSuccessRateModifier 来自被动技能/环境等的成功率修正值 (e.g., 0.1 for +10%)
 * @param {object} combatPassivesResult - 从 calculateCombatPowerWithPassives 返回的包含NPC压制等特殊被动信息的对象
 * @returns {{
 * attackerWins: boolean,
 * roll: number, // 攻击方投掷结果 (0-1)
 * threshold: number, // 攻击方胜利所需的小于的阈值 (即最终成功率)
 * baseSuccessRate: number, // 仅基于战力计算的基础成功率
 * finalSuccessRate: number, // 应用所有修正和随机波动后的最终成功率 (即threshold)
 * detail: string // 判定详情
 * }} 攻击方是否胜利及判定详情
 */
function determineBattleOutcome(attackerFinalPower, defenderFinalPower, passiveSuccessRateModifier = 0, combatPassivesResult = {}) {
    const totalPower = attackerFinalPower + defenderFinalPower;
    let baseSuccessRate;

    if (totalPower === 0) { //双方战力都为0的罕见情况
        baseSuccessRate = 0.5;
    } else {
        baseSuccessRate = attackerFinalPower / totalPower;
    }

    // 步骤1: 应用被动技能/环境等带来的直接成功率修正
    let successRateAfterPassives = baseSuccessRate + passiveSuccessRateModifier;

    // 步骤2: 应用NPC压制效果
    // 攻击方NPC的压制特性可能限制防守方的最大成功率，从而间接保证攻击方的最低成功率。
    // attackerNpcSuppressionMaxRate 指的是“由于攻击方NPC的压制，防守方所能达到的最大成功率”。
    if (combatPassivesResult.attackerNpcSuppressionMaxRate !== undefined) {
        const defenderMaxSuccessDueToAttackerSuppression = combatPassivesResult.attackerNpcSuppressionMaxRate;
        const attackerMinWinProbDueToOwnSuppression = 1 - defenderMaxSuccessDueToAttackerSuppression;
        if (successRateAfterPassives < attackerMinWinProbDueToOwnSuppression) {
            successRateAfterPassives = attackerMinWinProbDueToOwnSuppression;
        }
    }
    // 防守方NPC的压制特性可能直接限制攻击方的最大成功率。
    if (combatPassivesResult.defenderNpcSuppressionMaxRate !== undefined) {
        if (successRateAfterPassives > combatPassivesResult.defenderNpcSuppressionMaxRate) {
            successRateAfterPassives = combatPassivesResult.defenderNpcSuppressionMaxRate;
        }
    }

    // 步骤3: 引入基于战力差距的随机战斗波动
    // 双方战力越接近，随机波动范围越大；差距越大，波动范围越小。
    const powerDifferenceRatio = totalPower > 0 ? Math.abs(attackerFinalPower - defenderFinalPower) / totalPower : 0;
    // randomFactorRange 最大为 0.15 (战力相等时)，随着战力差增大而减小，最小为 0.15 * (1 - 0.8) = 0.03
    const randomFactorRange = 0.15 * (1 - Math.min(powerDifferenceRatio, 0.8));

    // randomFluctuation 是一个介于 -randomFactorRange 和 +randomFactorRange 之间的值
    const randomFluctuation = (Math.random() - 0.5) * 2 * randomFactorRange;
    let finalCalculatedSuccessRate = successRateAfterPassives + randomFluctuation;

    // 步骤4: 将最终计算出的成功率限制在合理范围内 (例如 5% 到 95%)
    // 这个值将作为攻击方胜利的“阈值”
    const finalSuccessRate = Math.max(0.05, Math.min(0.95, finalCalculatedSuccessRate));

    // 步骤5: 生成攻击方的投掷结果
    const roll = Math.random(); // 实际的投掷结果，范围从 0.0 到 1.0 (不含1.0)
    const attackerWins = roll < finalSuccessRate; // 如果投掷结果小于最终成功率，则攻击方胜利

    // 构建详细的判定说明
    const detail = `战力基础胜率: ${baseSuccessRate.toFixed(3)}, 被动/环境修正后: ${successRateAfterPassives.toFixed(3)}, 随机波动后(最终阈值): ${finalSuccessRate.toFixed(3)}. 投掷: ${roll.toFixed(3)}`;

    return {
        attackerWins,
        roll: roll,
        threshold: finalSuccessRate,
        baseSuccessRate: baseSuccessRate,
        finalSuccessRate: finalSuccessRate,
        detail: detail
    };
}

export { calculateCombatPowerWithPassives, determineBattleOutcome };
