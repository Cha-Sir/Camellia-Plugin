// 此文件内容与之前版本一致，无需修改。
// 确保此文件与 adventureGameApp.js 中的相对路径引用正确。

/**
 * 计算战斗双方的最终战斗力 (考虑武器被动)
 * @param {object} attackerWeapon 攻击方武器对象
 * @param {object} defenderWeapon 防守方武器对象
 * @returns {{attackerPower: number, defenderPower: number, log: string[]}} 双方战斗力及被动效果日志
 */
function calculateCombatPowerWithPassives(attackerWeapon, defenderWeapon) {
    let attackerPower = attackerWeapon.baseCombatPower || 0; // 添加默认值以防万一
    let defenderPower = defenderWeapon.baseCombatPower || 0;
    const combatLog = [];

    // 攻击方被动
    if (attackerWeapon.passive) {
        switch (attackerWeapon.passive) {
            case "锋利":
                attackerPower *= 1.15;
                combatLog.push(`攻击方(${attackerWeapon.name})触发[锋利]，攻击力提升!`);
                break;
            case "破甲":
                if (defenderWeapon.baseCombatPower > attackerWeapon.baseCombatPower) {
                    attackerPower *= 1.25;
                    combatLog.push(`攻击方(${attackerWeapon.name})触发[破甲]，针对高战力目标攻击力大幅提升!`);
                }
                break;
            case "精准射击":
                attackerPower *= 1.1;
                combatLog.push(`攻击方(${attackerWeapon.name})触发[精准射击]，攻击力提升!`);
                break;
            case "淬毒":
                attackerPower += 20; // 简化为直接增加攻击力
                combatLog.push(`攻击方(${attackerWeapon.name})触发[淬毒]，附加额外伤害!`);
                break;
            case "元素增幅":
                attackerPower *= 1.2;
                combatLog.push(`攻击方(${attackerWeapon.name})触发[元素增幅]，魔法力量汹涌!`);
                break;
        }
    }


    // 防守方被动
    if (defenderWeapon.passive) {
        switch (defenderWeapon.passive) {
            case "格挡反击":
                defenderPower *= 1.1; // 简化：略微提升防御力
                combatLog.push(`防守方(${defenderWeapon.name})触发[格挡反击]，防御力略微提升!`);
                break;
        }
    }


    return {
        attackerPower: Math.round(attackerPower),
        defenderPower: Math.round(defenderPower),
        log: combatLog
    };
}

/**
 * 根据双方最终战斗力决定战斗结果
 * @param {number} attackerFinalPower 攻击方最终战力
 * @param {number} defenderFinalPower 防守方最终战力
 * @returns {boolean} true 如果攻击方胜利, false 如果防守方胜利
 */
function determineBattleOutcome(attackerFinalPower, defenderFinalPower) {
    const totalPower = attackerFinalPower + defenderFinalPower;
    if (totalPower === 0) return Math.random() < 0.5;

    let winProbability = attackerFinalPower / totalPower;
    const diffFactor = Math.abs(attackerFinalPower - defenderFinalPower) / totalPower;
    const randomFactor = (Math.random() - 0.5) * diffFactor * 0.5;
    winProbability += randomFactor;
    winProbability = Math.max(0.05, Math.min(0.95, winProbability));

    return Math.random() < winProbability;
}

export { calculateCombatPowerWithPassives, determineBattleOutcome };
