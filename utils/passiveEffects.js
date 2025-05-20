// camellia-plugin/utils/passiveEffects.js

/**
 * @file 被动技能效果处理器
 * @description 根据被动类型应用具体效果，并返回对战斗参数的修改。
 */

/**
 * 应用攻击方的武器被动效果。
 * @param {object} attacker - 攻击方对象 (玩家或NPC)。
 * @param {object} defender - 防守方对象 (玩家或NPC)。
 * @param {object} attackerWeaponDef - 攻击方武器的完整定义。
 * @param {number} initialAttackerPower - 攻击方应用被动前的基础战力。
 * @param {number} initialDefenderPower - 防守方应用被动前的基础战力。
 * @param {Array<string>} combatLog - 战斗日志数组 (此函数不直接修改，返回logEntries)。
 * @returns {object} 包含对战力、成功率等的修改。
 * example: { attackerPower: number, defenderPower: number, successRateMod: number, ignoresWounded: boolean, logEntries: string[] }
 */
export function applyAttackerWeaponPassives(attacker, defender, attackerWeaponDef, initialAttackerPower, initialDefenderPower, combatLog) {
    let attackerPower = initialAttackerPower;
    let defenderPower = initialDefenderPower;
    let successRateMod = 0;
    let ignoresWounded = false;
    const localLog = [];

    if (!attackerWeaponDef || !attackerWeaponDef.passiveType || attackerWeaponDef.passiveType === "none") {
        return { attackerPower, defenderPower, successRateMod, ignoresWounded, logEntries: localLog };
    }

    localLog.push(`攻击方 (${attacker.nickname} - ${attackerWeaponDef.name}) 武器特性 [${attackerWeaponDef.passive || attackerWeaponDef.passiveType}] 发动...`);

    switch (attackerWeaponDef.passiveType) {
        case "power_boost_flat":
            attackerPower += (attackerWeaponDef.passiveValue || 0);
            localLog.push(`  效果: 威胁评估提升 ${attackerWeaponDef.passiveValue || 0}。`);
            break;
        case "power_boost_percentage":
            attackerPower *= (1 + (attackerWeaponDef.passiveValue || 0));
            localLog.push(`  效果: 威胁评估提升 ${((attackerWeaponDef.passiveValue || 0) * 100).toFixed(0)}%。`);
            break;
        case "target_power_debuff_flat":
            defenderPower -= (attackerWeaponDef.passiveValue || 0);
            localLog.push(`  效果: 压制目标，其威胁评估降低 ${attackerWeaponDef.passiveValue || 0}。`);
            break;
        case "target_power_debuff_percentage":
            defenderPower *= (1 - (attackerWeaponDef.passiveValue || 0));
            localLog.push(`  效果: 干扰目标，其威胁评估降低 ${((attackerWeaponDef.passiveValue || 0) * 100).toFixed(0)}%。`);
            break;
        case "power_boost_if_target_wounded":
            if (defender.status === 'wounded') {
                const boostValue = attackerWeaponDef.passiveValue || 0.2; // Default 0.2 if not specified
                attackerPower *= (1 + boostValue);
                localLog.push(`  效果: 目标已受创！乘胜追击，威胁评估提升 ${(boostValue * 100).toFixed(0)}%。`);
            } else {
                localLog.push(`  特性条件未满足: 目标状态完好。`);
            }
            break;
        case "power_boost_if_self_wounded":
            if (attacker.status === 'wounded') {
                const boostValue = attackerWeaponDef.passiveValue || 0.25; // Default 0.25 if not specified
                attackerPower *= (1 + boostValue);
                localLog.push(`  效果: 自身受创！激发潜能，威胁评估提升 ${(boostValue * 100).toFixed(0)}%。`);
            } else {
                localLog.push(`  特性条件未满足: 自身状态完好。`);
            }
            break;
        case "ignore_self_wounded_status":
            ignoresWounded = true;
            localLog.push(`  效果: 无视自身损伤，维持标准出力！`);
            break;
        case "direct_success_rate_modifier":
            successRateMod += (attackerWeaponDef.passiveValue || 0);
            localLog.push(`  效果: 战术调整，交战成功率修正 ${((attackerWeaponDef.passiveValue || 0) * 100).toFixed(0)}%。`);
            break;
        case "critical_hit_success_boost": // For passives like Sentinel 7's "精确点射"
            if (attackerWeaponDef.passiveValue && typeof attackerWeaponDef.passiveValue.successRateBonus === 'number') {
                successRateMod += attackerWeaponDef.passiveValue.successRateBonus;
                localLog.push(`  特性[${attackerWeaponDef.passive || '精确打击'}]发动: 交战成功率提升 ${(attackerWeaponDef.passiveValue.successRateBonus * 100).toFixed(0)}%。`);
            } else {
                localLog.push(`  特性[${attackerWeaponDef.passive || '精确打击'}]发动失败 (参数配置错误)。`);
            }
            break;
        case "target_debuff_on_hit_chance": // For passives like "破甲一击"
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.chance || 0)) {
                if (attackerWeaponDef.passiveValue.debuffEffect === "reduce_power_percentage") {
                    const debuffAmount = attackerWeaponDef.passiveValue.debuffAmount || 0;
                    defenderPower *= (1 - debuffAmount);
                    defenderPower = Math.max(0, defenderPower); // Ensure power doesn't go below 0
                    localLog.push(`  特性[${attackerWeaponDef.passive || '削弱打击'}]触发！目标威胁评估临时降低 ${(debuffAmount * 100).toFixed(0)}%。`);
                }
                // Add other debuffEffects here if needed
            } else {
                localLog.push(`  特性[${attackerWeaponDef.passive || '削弱打击'}]未触发。`);
            }
            break;
        case "multi_hit_chance": // Re-interpreted for no-HP system (e.g., player "制式脉冲步枪")
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.chance_per_hit || 0)) {
                // Using 'damage_modifier_per_hit' as a power boost factor
                const boostFactor = attackerWeaponDef.passiveValue.damage_modifier_per_hit || 0.2; // Default 20% boost if not specified
                attackerPower *= (1 + boostFactor);
                localLog.push(`  特性[${attackerWeaponDef.passive || '连环攻击'}]触发！火力增强，威胁评估提升 ${(boostFactor * 100).toFixed(0)}%。`);
            } else {
                localLog.push(`  特性[${attackerWeaponDef.passive || '连环攻击'}]未触发。`);
            }
            break;
        // --- 旧版兼容与特定效果 (ensure consistency with new types or phase out) ---
        case "破片效应": // Equivalent to power_boost_percentage with value 0.15
            attackerPower *= (1 + 0.15);
            localLog.push(`  特性[破片效应]: 威胁评估提升 15%。`);
            break;
        case "不稳定输出":
            // passiveValue: {"boost": 0.3, "debuff": -0.2, "condition_threshold_multiplier": 0.75, "debuff_chance": 0.1}
            if (attackerWeaponDef.passiveValue) {
                const pv = attackerWeaponDef.passiveValue;
                if (initialDefenderPower > initialAttackerPower * (pv.condition_threshold_multiplier || 0.75)) {
                    attackerPower *= (1 + (pv.boost || 0.3));
                    localLog.push(`  特性[不稳定输出]: 威力激增! 威胁评估提升 ${((pv.boost || 0.3) * 100).toFixed(0)}%。`);
                } else if (Math.random() < (pv.debuff_chance || 0.1)) {
                    attackerPower *= (1 + (pv.debuff || -0.2)); // debuff is negative
                    localLog.push(`  特性[不稳定输出]失控: 能量反噬! 威胁评估变化 ${((pv.debuff || -0.2) * 100).toFixed(0)}%。`);
                } else {
                    localLog.push(`  特性[不稳定输出]: 输出稳定，无特殊波动。`);
                }
            } else {
                localLog.push(`  特性[不稳定输出]: 参数缺失，无效果。`);
            }
            break;
        case "精准校准": // Equivalent to power_boost_percentage with value 0.12
            attackerPower *= (1 + 0.12);
            localLog.push(`  特性[精准校准]: 威胁评估提升 12%。`);
            break;
        case "认知干扰": // Equivalent to target_power_debuff_percentage with value 0.15
            defenderPower *= (1 - 0.15);
            localLog.push(`  特性[认知干扰]: 其威胁评估降低 15%。`);
            break;
        case "异界低语": // Equivalent to power_boost_percentage with value 0.22
            attackerPower *= (1 + 0.22);
            localLog.push(`  特性[异界低语]: 威胁评估提升 22%。`);
            break;
        case "存在抹消（概率）": // direct_success_rate_modifier_conditional
            // passiveValue: {"rate_modifier": 1.0, "trigger_chance": 0.05}
            if (attackerWeaponDef.passiveValue && Math.random() < (attackerWeaponDef.passiveValue.trigger_chance || 0.05)) {
                successRateMod += (attackerWeaponDef.passiveValue.rate_modifier || 1.0); // Add to existing mod
                localLog.push(`  特性[存在抹消]激活！交战结果已注定！`);
            } else {
                attackerPower *= 1.1; // Example: 10% boost if not triggered
                localLog.push(`  特性[存在抹消]未完全激活。威胁评估略微提升。`);
            }
            break;
        default:
            localLog.push(`  未知的攻击方武器被动类型: ${attackerWeaponDef.passiveType}。`);
    }
    attackerPower = Math.max(0, Math.round(attackerPower));
    defenderPower = Math.max(0, Math.round(defenderPower));
    return { attackerPower, defenderPower, successRateMod, ignoresWounded, logEntries: localLog };
}

/**
 * 应用防守方的武器被动效果。
 * @param {object} defender - 防守方对象 (玩家或NPC)。
 * @param {object} attacker - 攻击方对象 (玩家或NPC)。
 * @param {object} defenderWeaponDef - 防守方武器的完整定义。
 * @param {number} initialAttackerPower - 攻击方应用被动前的基础战力。
 * @param {number} initialDefenderPower - 防守方应用被动前的基础战力。
 * @param {Array<string>} combatLog - 战斗日志数组。
 * @returns {object} 包含对战力、成功率等的修改。
 */
export function applyDefenderWeaponPassives(defender, attacker, defenderWeaponDef, initialAttackerPower, initialDefenderPower, combatLog) {
    let attackerPower = initialAttackerPower;
    let defenderPower = initialDefenderPower;
    let successRateMod = 0; // Modifies ATTACKER's success rate. Positive for attacker, negative if defender's passive hinders attacker.
    let ignoresWounded = false;
    let postCombatIgnoreWound = false;
    const localLog = [];

    if (!defenderWeaponDef || !defenderWeaponDef.passiveType || defenderWeaponDef.passiveType === "none") {
        return { attackerPower, defenderPower, successRateMod, ignoresWounded, postCombatIgnoreWound, logEntries: localLog };
    }

    localLog.push(`防守方 (${defender.nickname} - ${defenderWeaponDef.name}) 武器特性 [${defenderWeaponDef.passive || defenderWeaponDef.passiveType}] 发动...`);

    switch (defenderWeaponDef.passiveType) {
        case "power_boost_flat":
            defenderPower += (defenderWeaponDef.passiveValue || 0);
            localLog.push(`  效果: 防御强化，威胁评估提升 ${defenderWeaponDef.passiveValue || 0}。`);
            break;
        case "power_boost_percentage":
        case "power_boost_percentage_defense_only": // Applied same as general boost here
            defenderPower *= (1 + (defenderWeaponDef.passiveValue || 0));
            localLog.push(`  效果: 防御系统超载，威胁评估提升 ${((defenderWeaponDef.passiveValue || 0) * 100).toFixed(0)}%。`);
            break;
        case "ignore_self_wounded_status":
            ignoresWounded = true;
            localLog.push(`  效果: 无视自身损伤，维持标准防御！`);
            break;
        case "evasion_boost": // This should reduce attacker's success rate
            successRateMod -= (defenderWeaponDef.passiveValue || 0.15); // Negative mod for attacker's success rate
            localLog.push(`  效果: 采取规避机动，对方交战成功率降低 ${((defenderWeaponDef.passiveValue || 0.15) * 100).toFixed(0)}%。`);
            break;
        case "critical_hit_success_boost": // If defender's weapon has this (e.g. Sentinel 7 defending with its rifle)
            if (defenderWeaponDef.passiveValue && typeof defenderWeaponDef.passiveValue.successRateBonus === 'number') {
                // This passive boosts THE USER'S (defender's) success.
                // For successRateMod (from attacker's perspective), this means a reduction.
                successRateMod -= defenderWeaponDef.passiveValue.successRateBonus;
                localLog.push(`  特性[${defenderWeaponDef.passive || '精确防御'}]发动: 对方交战成功率受到压制，降低 ${(defenderWeaponDef.passiveValue.successRateBonus * 100).toFixed(0)}%。`);
            } else {
                localLog.push(`  特性[${defenderWeaponDef.passive || '精确防御'}]发动失败 (参数配置错误)。`);
            }
            break;
        case "escape_boost_post_combat":
            localLog.push(`  特性[${defenderWeaponDef.passive || '紧急脱离'}]准备就绪，战败后更容易脱离。`);
            // Actual escape chance modification handled in gameHandler's post-combat logic
            break;
        case "post_combat_ignore_wound":
            postCombatIgnoreWound = true;
            localLog.push(`  特性效果: 预备应急措施，即使战败也能维持行动力。`);
            break;
        // --- 旧版兼容 ---
        case "偏折力场": // Equivalent to power_boost_percentage with value 0.15 or 0.20 for defense_only
            const deflectValue = defenderWeaponDef.passiveValue || 0.15; // Default to 0.15 if not specified
            defenderPower *= (1 + deflectValue);
            localLog.push(`  特性[偏折力场]: 威胁评估提升 ${(deflectValue * 100).toFixed(0)}%。`);
            break;
        default:
            localLog.push(`  未知的防守方武器被动类型: ${defenderWeaponDef.passiveType}。`);
    }
    attackerPower = Math.max(0, Math.round(attackerPower));
    defenderPower = Math.max(0, Math.round(defenderPower));
    return { attackerPower, defenderPower, successRateMod, ignoresWounded, postCombatIgnoreWound, logEntries: localLog };
}


/**
 * 应用NPC专属的战斗被动效果。
 * @param {object} npc - NPC对象。
 * @param {object} opponent - 对手对象 (玩家或NPC)。
 * @param {boolean} isNpcAttackingContext - NPC是否为当前评估上下文中的攻击方.
 * @param {number} initialNpcPower - NPC应用被动前的基础战力。
 * @param {number} initialOpponentPower - 对手应用被动前的基础战力。
 * @param {Array<string>} combatLog - 战斗日志数组。
 * @returns {object} 包含对战力、成功率、特殊标志等的修改。
 */
export function applyNpcCombatPassives(npc, opponent, isNpcAttackingContext, initialNpcPower, initialOpponentPower, combatLog) {
    let npcPower = initialNpcPower;
    let opponentPower = initialOpponentPower;
    let successRateMod = 0; // Modifies success rate from the perspective of the NPC.
    let npcSuppressionMaxRate; // For suppression passive, this is the MAX rate for the OPPONENT.
    const localLog = [];

    if (!npc.isNpc || !npc.combatPassive || !npc.combatPassive.type) {
        return { npcPower, opponentPower, successRateMod, npcSuppressionMaxRate, logEntries: localLog };
    }

    localLog.push(`NPC (${npc.nickname}) 固有能力 [${npc.combatPassive.name || npc.combatPassive.type}] 发动...`);

    switch (npc.combatPassive.type) {
        case "suppression":
            const npcBaseForCondition = npc.weapon?.baseCombatPower || npc.baseCombatPower || 0;
            const opponentBaseForCondition = opponent.weapon?.baseCombatPower || opponent.baseCombatPower || 0;

            if (opponentBaseForCondition < npcBaseForCondition) {
                npcSuppressionMaxRate = npc.combatPassive.details?.maxSuccessRateForOpponent || 0.4;
                localLog.push(`  效果: ${npc.combatPassive.description || `强大的气场压制对手，对手的最终战斗成功率不会超过 ${(npcSuppressionMaxRate*100).toFixed(0)}%`}`);
            } else {
                localLog.push(`  效果条件未满足（目标基础战力不低于自身）。`);
            }
            break;
        case "power_surge_on_engage": // e.g., Sentinel 7's "过载核心"
            const boost = npc.combatPassive.details?.powerBoost || 0;
            npcPower += boost;
            localLog.push(`  效果: ${npc.combatPassive.description || `战斗核心过载，威胁评估提升 ${boost}。`}`);
            break;
        case "master_escape":
            localLog.push(`  效果: ${npc.combatPassive.description || '逃跑大师特性'} (战前已进行判定)`);
            // Logic is primarily in gameHandler.js pre-combat
            break;
        // case "retaliation_on_damage": // This type is not used by current NPCs. If added, handle here or in gameHandler.
        //     localLog.push(`  效果: ${npc.combatPassive.description || '受击时可能反击'} (受击后可能触发)`);
        //     break;
        default:
            localLog.push(`  未知的NPC固有能力类型: ${npc.combatPassive.type}。`);
    }
    npcPower = Math.max(0, Math.round(npcPower));
    opponentPower = Math.max(0, Math.round(opponentPower));
    return { npcPower, opponentPower, successRateMod, npcSuppressionMaxRate, logEntries: localLog };
}
