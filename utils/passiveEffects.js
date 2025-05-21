// camellia-plugin/utils/passiveEffects.js

/**
 * @file 被动技能效果处理器
 * @description 根据被动类型应用具体效果，并返回对战斗参数的修改。
 */

// --- Helper Functions for Common Passive Effects ---

/**
 * 统一处理威力提升的帮助函数。
 * @param {number} currentPower - 当前威力值。
 * @param {number|undefined} value - 提升的数值或百分比 (例如 0.1 代表 10%)。
 * @param {boolean} isPercentage - value是否为百分比。
 * @param {Array<string>} logCollector - 日志收集器。
 * @param {string} effectName - 效果名称，用于日志。
 * @param {string} entityNickname - 触发效果的实体昵称。
 * @param {string} weaponName - 触发效果的武器名称。
 * @returns {number} - 计算后的新威力值。
 */
function _applyPowerBoost(currentPower, value, isPercentage, logCollector, effectName, entityNickname, weaponName) {
    const boostVal = Number(value) || 0;
    let newPower = currentPower;
    let logMsg = `  特性[${effectName}]@${entityNickname}(${weaponName}): `;

    if (isPercentage) {
        newPower = currentPower * (1 + boostVal);
        logMsg += `威胁评估提升 ${(boostVal * 100).toFixed(0)}%。`;
    } else {
        newPower = currentPower + boostVal;
        logMsg += `威胁评估提升 ${boostVal}。`;
    }
    logCollector.push(logMsg);
    return Math.max(0, Math.round(newPower));
}

/**
 * 统一处理威力削弱的帮助函数。
 * @param {number} currentPower - 当前威力值。
 * @param {number|undefined} value - 削弱的数值或百分比 (例如 0.1 代表 10%)。
 * @param {boolean} isPercentage - value是否为百分比。
 * @param {Array<string>} logCollector - 日志收集器。
 * @param {string} effectName - 效果名称，用于日志。
 * @param {string} entityNickname - 触发效果的实体昵称。
 * @param {string} weaponName - 触发效果的武器名称。
 * @param {string} targetNickname - 被影响的目标昵称。
 * @returns {number} - 计算后的新威力值。
 */
function _applyPowerDebuff(currentPower, value, isPercentage, logCollector, effectName, entityNickname, weaponName, targetNickname) {
    const debuffVal = Number(value) || 0;
    let newPower = currentPower;
    let logMsg = `  特性[${effectName}]@${entityNickname}(${weaponName}) 影响 ${targetNickname}: `;

    if (isPercentage) {
        newPower = currentPower * (1 - debuffVal);
        logMsg += `威胁评估降低 ${(debuffVal * 100).toFixed(0)}%。`;
    } else {
        newPower = currentPower - debuffVal;
        logMsg += `威胁评估降低 ${debuffVal}。`;
    }
    logCollector.push(logMsg);
    return Math.max(0, Math.round(newPower));
}

/**
 * 统一处理成功率修正的帮助函数。
 * @param {number} currentSuccessRateMod - 当前的成功率修正值。
 * @param {number|undefined} modValue - 本次修正的数值 (例如 0.1 代表 +10%)。
 * @param {Array<string>} logCollector - 日志收集器。
 * @param {string} effectName - 效果名称，用于日志。
 * @param {string} entityNickname - 触发效果的实体昵称。
 * @param {string} weaponName - 触发效果的武器名称。
 * @returns {number} - 计算后的新成功率修正值。
 */
function _applySuccessRateModifier(currentSuccessRateMod, modValue, logCollector, effectName, entityNickname, weaponName) {
    const val = Number(modValue) || 0;
    logCollector.push(`  特性[${effectName}]@${entityNickname}(${weaponName}): 交战成功率修正 ${((val) * 100).toFixed(0)}%。`);
    return currentSuccessRateMod + val;
}

/**
 * 记录条件未满足的日志。
 * @param {Array<string>} logCollector - 日志收集器。
 * @param {string} passiveName - 被动技能名称。
 * @param {string} entityNickname - 实体昵称。
 * @param {string} weaponName - 武器名称。
 * @param {string} reason - 未满足的原因。
 */
function _logConditionNotMet(logCollector, passiveName, entityNickname, weaponName, reason) {
    logCollector.push(`  特性[${passiveName}]@${entityNickname}(${weaponName}) 条件未满足: ${reason}。`);
}

/**
 * 记录通用日志。
 * @param {Array<string>} logCollector - 日志收集器。
 * @param {string} message - 要记录的消息。
 */
function _logGeneric(logCollector, message) {
    logCollector.push(`  ${message}`);
}


/**
 * 应用攻击方的武器被动效果。
 * @param {object} attacker - 攻击方对象 (玩家或NPC)。
 * @param {object} defender - 防守方对象 (玩家或NPC)。
 * @param {object} attackerWeaponDef - 攻击方武器的完整定义。
 * @param {number} initialAttackerPower - 攻击方应用被动前的基础战力。
 * @param {number} initialDefenderPower - 防守方应用被动前的基础战力。
 * @returns {object} 包含对战力、成功率等的修改。
 */
export function applyAttackerWeaponPassives(attacker, defender, attackerWeaponDef, initialAttackerPower, initialDefenderPower) {
    let attackerPower = initialAttackerPower;
    let defenderPower = initialDefenderPower;
    let successRateMod = 0;
    let ignoresWounded = false;
    const localLog = [];
    const attackerName = attacker.nickname || '攻击方';
    const defenderName = defender.nickname || '防守方';

    if (!attackerWeaponDef || !attackerWeaponDef.passiveType || attackerWeaponDef.passiveType === "none") {
        if (attackerWeaponDef && attackerWeaponDef.name !== "制式警棍") {
            _logGeneric(localLog, `攻击方 (${attackerName} - ${attackerWeaponDef.name}) 无特殊武器特性。`);
        }
        return { attackerPower, defenderPower, successRateMod, ignoresWounded, logEntries: localLog };
    }

    const passiveName = attackerWeaponDef.passive || attackerWeaponDef.passiveType;
    _logGeneric(localLog, `攻击方 (${attackerName} - ${attackerWeaponDef.name}) 武器特性 [${passiveName}] 发动...`);

    switch (attackerWeaponDef.passiveType) {
        case "power_boost_flat":
            attackerPower = _applyPowerBoost(attackerPower, attackerWeaponDef.passiveValue, false, localLog, passiveName, attackerName, attackerWeaponDef.name);
            break;
        case "power_boost_percentage":
            attackerPower = _applyPowerBoost(attackerPower, attackerWeaponDef.passiveValue, true, localLog, passiveName, attackerName, attackerWeaponDef.name);
            break;
        case "target_power_debuff_flat":
            defenderPower = _applyPowerDebuff(defenderPower, attackerWeaponDef.passiveValue, false, localLog, passiveName, attackerName, attackerWeaponDef.name, defenderName);
            break;
        case "target_power_debuff_percentage":
            defenderPower = _applyPowerDebuff(defenderPower, attackerWeaponDef.passiveValue, true, localLog, passiveName, attackerName, attackerWeaponDef.name, defenderName);
            break;
        case "power_boost_if_target_wounded":
            if (defender.status === 'wounded') {
                attackerPower = _applyPowerBoost(attackerPower, attackerWeaponDef.passiveValue || 0.2, true, localLog, `${passiveName} (目标受创)`, attackerName, attackerWeaponDef.name);
            } else {
                _logConditionNotMet(localLog, passiveName, attackerName, attackerWeaponDef.name, "目标状态完好");
            }
            break;
        case "power_boost_if_self_wounded":
            if (attacker.status === 'wounded') {
                attackerPower = _applyPowerBoost(attackerPower, attackerWeaponDef.passiveValue || 0.25, true, localLog, `${passiveName} (自身受创)`, attackerName, attackerWeaponDef.name);
            } else {
                _logConditionNotMet(localLog, passiveName, attackerName, attackerWeaponDef.name, "自身状态完好");
            }
            break;
        case "ignore_self_wounded_status":
            ignoresWounded = true;
            _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}): 无视自身损伤，维持标准出力！`);
            break;
        case "direct_success_rate_modifier":
            successRateMod = _applySuccessRateModifier(successRateMod, attackerWeaponDef.passiveValue, localLog, passiveName, attackerName, attackerWeaponDef.name);
            break;
        case "critical_hit_success_boost":
            if (attackerWeaponDef.passiveValue && typeof attackerWeaponDef.passiveValue.successRateBonus === 'number') {
                successRateMod = _applySuccessRateModifier(successRateMod, attackerWeaponDef.passiveValue.successRateBonus, localLog, passiveName, attackerName, attackerWeaponDef.name);
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}) 发动失败 (参数配置错误)。`);
            }
            break;
        case "target_debuff_on_hit_chance":
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.chance || 0)) {
                if (attackerWeaponDef.passiveValue.debuffEffect === "reduce_power_percentage") {
                    const debuffAmount = attackerWeaponDef.passiveValue.debuffAmount || 0;
                    defenderPower = _applyPowerDebuff(defenderPower, debuffAmount, true, localLog, `${passiveName} (触发)`, attackerName, attackerWeaponDef.name, defenderName);
                }
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}) 未触发。`);
            }
            break;
        case "multi_hit_chance":
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.chance_per_hit || 0)) {
                const boostFactor = attackerWeaponDef.passiveValue.damage_modifier_per_hit || 0.2;
                attackerPower = _applyPowerBoost(attackerPower, boostFactor, true, localLog, `${passiveName} (触发)`, attackerName, attackerWeaponDef.name);
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}) 未触发。`);
            }
            break;
        case "conditional_power_boost_or_debuff":
            if (attackerWeaponDef.passiveValue) {
                const pv = attackerWeaponDef.passiveValue;
                if (initialDefenderPower > initialAttackerPower * (pv.condition_threshold_multiplier || 0.75)) {
                    attackerPower = _applyPowerBoost(attackerPower, pv.boost || 0.3, true, localLog, `${passiveName} (威力激增)`, attackerName, attackerWeaponDef.name);
                } else if (Math.random() < (pv.debuff_chance || 0.1)) {
                    attackerPower = _applyPowerBoost(attackerPower, pv.debuff || -0.2, true, localLog, `${passiveName} (能量反噬)`, attackerName, attackerWeaponDef.name); // Debuff is a negative boost
                } else {
                    _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}): 输出稳定，无特殊波动。`);
                }
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}): 参数缺失，无效果。`);
            }
            break;
        case "direct_success_rate_modifier_conditional":
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.trigger_chance || 0.05)) {
                successRateMod = _applySuccessRateModifier(successRateMod, attackerWeaponDef.passiveValue.rate_modifier || 1.0, localLog, `${passiveName} (激活)`, attackerName, attackerWeaponDef.name);
                _logGeneric(localLog, `    交战结果已注定！`);
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${attackerName}(${attackerWeaponDef.name}) 未完全激活。`);
            }
            break;
        default:
            _logGeneric(localLog, `  未知的攻击方武器被动类型: ${attackerWeaponDef.passiveType} @${attackerName}(${attackerWeaponDef.name})。`);
    }
    return { attackerPower: Math.max(0, Math.round(attackerPower)), defenderPower: Math.max(0, Math.round(defenderPower)), successRateMod, ignoresWounded, logEntries: localLog };
}

/**
 * 应用防守方的武器被动效果。
 * @param {object} defender - 防守方对象 (玩家或NPC)。
 * @param {object} attacker - 攻击方对象 (玩家或NPC)。
 * @param {object} defenderWeaponDef - 防守方武器的完整定义。
 * @param {number} initialAttackerPower - 攻击方应用被动前的基础战力。
 * @param {number} initialDefenderPower - 防守方应用被动前的基础战力。
 * @returns {object} 包含对战力、成功率等的修改。
 */
export function applyDefenderWeaponPassives(defender, attacker, defenderWeaponDef, initialAttackerPower, initialDefenderPower) {
    let attackerPower = initialAttackerPower;
    let defenderPower = initialDefenderPower;
    let successRateMod = 0;
    let ignoresWounded = false;
    let postCombatIgnoreWound = false;
    const localLog = [];
    const defenderName = defender.nickname || '防守方';
    const attackerName = attacker.nickname || '攻击方';


    if (!defenderWeaponDef || !defenderWeaponDef.passiveType || defenderWeaponDef.passiveType === "none") {
        if (defenderWeaponDef && defenderWeaponDef.name !== "制式警棍") {
            _logGeneric(localLog, `防守方 (${defenderName} - ${defenderWeaponDef.name}) 无特殊武器特性。`);
        }
        return { attackerPower, defenderPower, successRateMod, ignoresWounded, postCombatIgnoreWound, logEntries: localLog };
    }

    const passiveName = defenderWeaponDef.passive || defenderWeaponDef.passiveType;
    _logGeneric(localLog, `防守方 (${defenderName} - ${defenderWeaponDef.name}) 武器特性 [${passiveName}] 发动...`);

    switch (defenderWeaponDef.passiveType) {
        case "power_boost_flat":
            defenderPower = _applyPowerBoost(defenderPower, defenderWeaponDef.passiveValue, false, localLog, `${passiveName} (防御强化)`, defenderName, defenderWeaponDef.name);
            break;
        case "power_boost_percentage":
        case "power_boost_percentage_defense_only": // In this context, it's always defense
            defenderPower = _applyPowerBoost(defenderPower, defenderWeaponDef.passiveValue, true, localLog, passiveName, defenderName, defenderWeaponDef.name);
            break;
        case "ignore_self_wounded_status":
            ignoresWounded = true;
            _logGeneric(localLog, `  特性[${passiveName}]@${defenderName}(${defenderWeaponDef.name}): 无视自身损伤，维持标准防御！`);
            break;
        case "evasion_boost": // Lowers attacker's success rate
            successRateMod = _applySuccessRateModifier(successRateMod, -(defenderWeaponDef.passiveValue || 0.15), localLog, `${passiveName} (规避机动)`, defenderName, defenderWeaponDef.name);
            break;
        case "critical_hit_success_boost": // If defender weapon has this, it likely reduces attacker's success
            if (defenderWeaponDef.passiveValue && typeof defenderWeaponDef.passiveValue.successRateBonus === 'number') {
                successRateMod = _applySuccessRateModifier(successRateMod, -defenderWeaponDef.passiveValue.successRateBonus, localLog, `${passiveName} (精确防御)`, defenderName, defenderWeaponDef.name);
            } else {
                _logGeneric(localLog, `  特性[${passiveName}]@${defenderName}(${defenderWeaponDef.name}) 发动失败 (参数配置错误)。`);
            }
            break;
        case "escape_boost_post_combat":
            _logGeneric(localLog, `  特性[${passiveName}]@${defenderName}(${defenderWeaponDef.name}) 准备就绪，战败后更容易脱离。`);
            // Actual effect handled by gameHandler
            break;
        case "post_combat_ignore_wound":
            postCombatIgnoreWound = true;
            _logGeneric(localLog, `  特性[${passiveName}]@${defenderName}(${defenderWeaponDef.name}) 预备应急措施，即使战败也能维持行动力。`);
            break;
        default:
            _logGeneric(localLog, `  未知的防守方武器被动类型: ${defenderWeaponDef.passiveType} @${defenderName}(${defenderWeaponDef.name})。`);
    }
    return { attackerPower: Math.max(0, Math.round(attackerPower)), defenderPower: Math.max(0, Math.round(defenderPower)), successRateMod, ignoresWounded, postCombatIgnoreWound, logEntries: localLog };
}


/**
 * 应用NPC专属的战斗被动效果。
 * @param {object} npc - NPC对象。
 * @param {object} opponent - 对手对象 (玩家或NPC)。
 * @param {boolean} isNpcAttackingContext - NPC是否为当前评估上下文中的攻击方.
 * @param {number} initialNpcPower - NPC应用被动前的基础战力。
 * @param {number} initialOpponentPower - 对手应用被动前的基础战力。
 * @returns {object} 包含对战力、成功率、特殊标志等的修改。
 */
export function applyNpcCombatPassives(npc, opponent, isNpcAttackingContext, initialNpcPower, initialOpponentPower) {
    let npcPower = initialNpcPower;
    let opponentPower = initialOpponentPower;
    let successRateMod = 0;
    let npcSuppressionMaxRate; // This is the max success rate the OPPONENT can achieve against this NPC, or this NPC can achieve if specified.
    const localLog = [];
    const npcName = npc.nickname || 'NPC';

    if (!npc.isNpc || !npc.combatPassive || !npc.combatPassive.type || npc.combatPassive.type === "none") {
        return { npcPower, opponentPower, successRateMod, npcSuppressionMaxRate, logEntries: localLog };
    }

    const passiveName = npc.combatPassive.name || npc.combatPassive.type;
    _logGeneric(localLog, `NPC (${npcName}) 固有能力 [${passiveName}] 发动...`);

    switch (npc.combatPassive.type) {
        case "suppression": // NPC's passive limits opponent's success rate if NPC's base power is higher
            const npcBaseForCondition = npc.weapon?.baseCombatPower || npc.npcDefinition?.baseCombatPower || 0;
            const opponentBaseForCondition = opponent.weapon?.baseCombatPower || (opponent.isNpc ? opponent.npcDefinition?.baseCombatPower : 0) || 0;

            if (opponentBaseForCondition < npcBaseForCondition) {
                // This means the opponent's success rate against this NPC (if NPC is defender)
                // or this NPC's success rate against the opponent (if NPC is attacker and passive is worded that way)
                // is capped. The variable name in combatHelper expects it as "opponent's max success rate".
                npcSuppressionMaxRate = npc.combatPassive.details?.maxSuccessRateForOpponent || 0.4;
                _logGeneric(localLog, `  效果: ${npc.combatPassive.description || `强大的气场压制对手，对手的最终战斗成功率不会超过 ${(npcSuppressionMaxRate*100).toFixed(0)}%`}`);
            } else {
                _logConditionNotMet(localLog, passiveName, npcName, "固有能力", "目标基础战力不低于自身");
            }
            break;
        case "power_surge_on_engage":
            const boost = npc.combatPassive.details?.powerBoost || 0;
            npcPower = _applyPowerBoost(npcPower, boost, false, localLog, passiveName, npcName, "固有能力");
            break;
        case "master_escape": // Pre-combat escape logic is in gameHandler.js
            _logGeneric(localLog, `  效果: ${npc.combatPassive.description || '逃跑大师特性'} (战前已进行判定)`);
            break;
        default:
            _logGeneric(localLog, `  未知的NPC固有能力类型: ${npc.combatPassive.type} @${npcName}。`);
    }
    return { npcPower: Math.max(0, Math.round(npcPower)), opponentPower: Math.max(0, Math.round(opponentPower)), successRateMod, npcSuppressionMaxRate, logEntries: localLog };
}
