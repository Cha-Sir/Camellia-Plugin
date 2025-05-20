/**
 * 计算战斗双方的最终战斗力 (考虑武器被动和受伤状态)
 * @param {object} attackerWeapon 攻击方武器对象
 * @param {object} defenderWeapon 防守方武器对象
 * @param {string} attackerStatus 攻击方状态 ('active', 'wounded')
 * @param {string} defenderStatus 防守方状态 ('active', 'wounded')
 * @returns {{attackerPower: number, defenderPower: number, log: string[]}} 双方战斗力及效果日志
 */
function calculateCombatPowerWithPassives(attackerWeapon, defenderWeapon, attackerStatus, defenderStatus) {
    let attackerPower = attackerWeapon.baseCombatPower || 0;
    let defenderPower = defenderWeapon.baseCombatPower || 0;
    const combatLog = [];

    // 攻击方被动
    if (attackerWeapon.passive) {
        switch (attackerWeapon.passive) {
            case "破片效应":
                attackerPower *= 1.15;
                combatLog.push(`攻击方(${attackerWeapon.name})触发[破片效应]，目标结构完整性受损!`);
                break;
            case "不稳定输出":
                if (defenderWeapon.baseCombatPower > attackerWeapon.baseCombatPower * 0.75) { // 调整触发条件
                    attackerPower *= 1.3; // 略微提高增幅
                    combatLog.push(`攻击方(${attackerWeapon.name})触发[不稳定输出]，能量奔涌，威力激增!`);
                } else if (Math.random() < 0.1) { // 有小概率反噬
                    attackerPower *= 0.8;
                    combatLog.push(`攻击方(${attackerWeapon.name})[不稳定输出]失控，能量反噬!`);
                }
                break;
            case "精准校准":
                attackerPower *= 1.12; // 略微调整
                combatLog.push(`攻击方(${attackerWeapon.name})触发[精准校准]，锁定致命节点!`);
                break;
            case "认知干扰":
                defenderPower *= 0.85;
                combatLog.push(`攻击方(${attackerWeapon.name})释放[认知干扰]，目标思维混乱，行动受阻!`);
                break;
            case "异界低语":
                attackerPower *= 1.22;
                combatLog.push(`攻击方(${attackerWeapon.name})吟诵[异界低语]，不可名状的力量开始侵蚀现实!`);
                break;
            case "存在抹消（概率）":
                if (Math.random() < 0.1) { // 10% 概率触发特殊效果
                    defenderPower = 0; // 直接将对方战力清零，代表“抹消”
                    combatLog.push(`攻击方(${attackerWeapon.name})的[存在抹消]特性激活！目标的“存在”开始变得模糊...`);
                } else {
                    attackerPower *= 1.1; // 未触发抹消时，提供少量增益
                    combatLog.push(`攻击方(${attackerWeapon.name})的[存在抹消]特性未完全激活，但依旧锋利。`);
                }
                break;
        }
    }

    // 防守方被动
    if (defenderWeapon.passive) {
        switch (defenderWeapon.passive) {
            case "偏折力场":
                defenderPower *= 1.15;
                combatLog.push(`防守方(${defenderWeapon.name})展开[偏折力场]，攻击被部分扭曲!`);
                break;
        }
    }

    if (attackerStatus === 'wounded') {
        attackerPower *= 0.6; // 受伤惩罚调整
        combatLog.push(`攻击方(${attackerWeapon.name})系统受损，出力大幅下降!`);
    }
    if (defenderStatus === 'wounded') {
        defenderPower *= 0.6; // 受伤惩罚调整
        combatLog.push(`防守方(${defenderWeapon.name})系统受损，出力大幅下降!`);
    }

    return {
        attackerPower: Math.round(attackerPower),
        defenderPower: Math.round(defenderPower),
        log: combatLog
    };
}

/**
 * 根据双方最终战斗力决定基础胜负概率
 * @param {number} attackerFinalPower 攻击方最终战力
 * @param {number} defenderFinalPower 防守方最终战力
 * @returns {boolean} true 如果攻击方胜利, false 如果防守方胜利 (基于概率)
 */
function determineBattleOutcome(attackerFinalPower, defenderFinalPower) {
    const totalPower = attackerFinalPower + defenderFinalPower;
    if (totalPower === 0) return Math.random() < 0.5;

    let winProbability = attackerFinalPower / totalPower;
    const powerDifferenceRatio = Math.abs(attackerFinalPower - defenderFinalPower) / totalPower;
    const randomFactorRange = 0.15 * (1 - powerDifferenceRatio); // 调整随机因子范围
    const randomRoll = (Math.random() - 0.5) * randomFactorRange;

    winProbability += randomRoll;
    winProbability = Math.max(0.08, Math.min(0.92, winProbability)); // 调整胜率边界

    return Math.random() < winProbability;
}

export { calculateCombatPowerWithPassives, determineBattleOutcome };
