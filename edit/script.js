document.addEventListener('DOMContentLoaded', () => {
    const fileLoader = document.getElementById('fileLoader');
    const downloadJsonButton = document.getElementById('downloadJson');
    const clearEditorButton = document.getElementById('clearEditor');
    const mercenaryListDiv = document.getElementById('mercenaryList');
    const showAddMercenaryFormButton = document.getElementById('showAddMercenaryForm');
    const mercenaryFormContainer = document.getElementById('mercenaryFormContainer');
    const mercenaryForm = document.getElementById('mercenaryForm');
    const formTitle = document.getElementById('formTitle');
    const saveMercenaryButton = document.getElementById('saveMercenaryButton');
    const cancelEditButton = document.getElementById('cancelEditButton');
    const skillsContainer = document.getElementById('skillsContainer');
    const addSkillButton = document.getElementById('addSkillButton');

    let mercenariesData = []; // Array to hold mercenary objects
    let editingIndex = -1; // Index of mercenary being edited, -1 for new

    // --- File Operations ---
    fileLoader.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const jsonData = JSON.parse(e.target.result);
                    if (Array.isArray(jsonData)) {
                        mercenariesData = jsonData;
                        renderMercenaryList();
                        alert('JSON文件已成功加载！');
                    } else {
                        alert('文件内容不是一个有效的JSON数组。');
                    }
                } catch (error) {
                    alert('加载或解析JSON文件失败: ' + error.message);
                    console.error(error);
                }
            };
            reader.readAsText(file);
        }
    });

    downloadJsonButton.addEventListener('click', () => {
        if (mercenariesData.length === 0) {
            alert('没有数据可以下载。请先加载或添加佣兵。');
            return;
        }
        const jsonDataString = JSON.stringify(mercenariesData, null, 2); // Pretty print JSON
        const blob = new Blob([jsonDataString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mercenaries.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    clearEditorButton.addEventListener('click', () => {
        if (confirm('确定要清空编辑器中的所有佣兵数据吗？此操作不可撤销。')) {
            mercenariesData = [];
            renderMercenaryList();
            hideMercenaryForm();
        }
    });


    // --- UI Rendering ---
    function renderMercenaryList() {
        mercenaryListDiv.innerHTML = ''; // Clear existing list
        if (mercenariesData.length === 0) {
            mercenaryListDiv.innerHTML = '<p>暂无佣兵数据。请加载文件或添加新佣兵。</p>';
            return;
        }

        mercenariesData.forEach((merc, index) => {
            const mercDiv = document.createElement('div');
            mercDiv.classList.add('mercenary-item');
            mercDiv.innerHTML = `
                <div class="mercenary-item-details">
                    <h4>${merc.name} (★${merc.rarity})</h4>
                    <p><strong>ID:</strong> ${merc.id || '未设置'}</p>
                    <p><strong>图片:</strong> ${merc.imageUrl || '未设置'}</p>
                    <p><strong>简介:</strong> ${merc.description || '无'}</p>
                    ${merc.skills && merc.skills.length > 0 ? `
                        <p><strong>技能:</strong></p>
                        <ul class="skills-list">
                            ${merc.skills.map(skill => `<li>Lvl ${skill.levelRequired}: ${skill.description}</li>`).join('')}
                        </ul>
                    ` : '<p><strong>技能:</strong> 无</p>'}
                </div>
                <div class="mercenary-item-actions">
                    <button class="edit-btn" data-index="${index}">编辑</button>
                    <button class="delete-btn" data-index="${index}">删除</button>
                </div>
            `;
            mercenaryListDiv.appendChild(mercDiv);
        });

        // Add event listeners for edit and delete buttons
        document.querySelectorAll('.edit-btn').forEach(button => {
            button.addEventListener('click', handleEditMercenary);
        });
        document.querySelectorAll('.delete-btn').forEach(button => {
            button.addEventListener('click', handleDeleteMercenary);
        });
    }

    // --- Form Handling ---
    showAddMercenaryFormButton.addEventListener('click', () => {
        editingIndex = -1; // Signal new mercenary
        formTitle.textContent = '添加新佣兵';
        mercenaryForm.reset();
        skillsContainer.innerHTML = ''; // Clear skills
        document.getElementById('mercId').value = `merc${Date.now()}${Math.floor(Math.random()*100)}`; // Auto-generate ID
        addSkillField(); // Add one default skill field
        showMercenaryForm();
        cancelEditButton.style.display = 'none';
    });

    function handleEditMercenary(event) {
        const index = parseInt(event.target.dataset.index);
        editingIndex = index;
        const merc = mercenariesData[index];

        formTitle.textContent = '编辑佣兵';
        mercenaryForm.reset(); // Reset first
        skillsContainer.innerHTML = '';

        document.getElementById('mercId').value = merc.id || `merc${Date.now()}${Math.floor(Math.random()*100)}`;
        document.getElementById('mercArrayIndex').value = index; // Store original index for update
        document.getElementById('name').value = merc.name;
        document.getElementById('rarity').value = merc.rarity;
        document.getElementById('imageUrl').value = merc.imageUrl || '';
        document.getElementById('description').value = merc.description || '';

        if (merc.skills && merc.skills.length > 0) {
            merc.skills.forEach(skill => addSkillField(skill.levelRequired, skill.description));
        } else {
            addSkillField(); // Add one empty skill field if none exist
        }

        showMercenaryForm();
        cancelEditButton.style.display = 'inline-block';
    }

    mercenaryForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(mercenaryForm);
        const merc = {
            id: formData.get('id'),
            name: formData.get('name'),
            rarity: parseInt(formData.get('rarity')),
            imageUrl: formData.get('imageUrl') || null,
            description: formData.get('description') || null,
            skills: []
        };

        // Collect skills
        const skillLevels = formData.getAll('skillLevelRequired[]');
        const skillDescriptions = formData.getAll('skillDescription[]');
        for (let i = 0; i < skillLevels.length; i++) {
            if (skillDescriptions[i].trim() !== '') { // Only add if description is not empty
                merc.skills.push({
                    levelRequired: parseInt(skillLevels[i]),
                    description: skillDescriptions[i].trim()
                });
            }
        }
        // Sort skills by levelRequired
        merc.skills.sort((a, b) => a.levelRequired - b.levelRequired);


        if (editingIndex > -1) { // Editing existing
            const originalIndex = parseInt(document.getElementById('mercArrayIndex').value);
            mercenariesData[originalIndex] = merc;
        } else { // Adding new
            // Check for ID conflict (simple check, real app might need more robust UUIDs)
            if (mercenariesData.some(m => m.id === merc.id)) {
                alert(`错误：佣兵ID "${merc.id}" 已存在。请修改ID或让其自动生成。`);
                document.getElementById('mercId').value = `merc${Date.now()}${Math.floor(Math.random()*100)}`;
                return;
            }
            mercenariesData.push(merc);
        }

        renderMercenaryList();
        hideMercenaryForm();
        mercenaryForm.reset();
        editingIndex = -1;
    });

    cancelEditButton.addEventListener('click', () => {
        hideMercenaryForm();
        mercenaryForm.reset();
        editingIndex = -1;
    });

    function handleDeleteMercenary(event) {
        const index = parseInt(event.target.dataset.index);
        if (confirm(`确定要删除佣兵 "${mercenariesData[index].name}" 吗？`)) {
            mercenariesData.splice(index, 1);
            renderMercenaryList();
        }
    }

    function showMercenaryForm() {
        mercenaryFormContainer.style.display = 'block';
        window.scrollTo(0, document.body.scrollHeight); // Scroll to form
    }

    function hideMercenaryForm() {
        mercenaryFormContainer.style.display = 'none';
    }

    // --- Skill Fields Management ---
    addSkillButton.addEventListener('click', () => addSkillField());

    function addSkillField(level = 1, desc = '') {
        const skillDiv = document.createElement('div');
        skillDiv.classList.add('skill-entry');

        const levelLabel = document.createElement('label');
        levelLabel.textContent = '等级要求:';
        const levelInput = document.createElement('input');
        levelInput.type = 'number';
        levelInput.name = 'skillLevelRequired[]';
        levelInput.min = '1';
        levelInput.max = '5'; // Assuming max evolution 5
        levelInput.value = level;
        levelInput.required = true;

        const descLabel = document.createElement('label');
        descLabel.textContent = '技能描述:';
        const descInput = document.createElement('input');
        descInput.type = 'text';
        descInput.name = 'skillDescription[]';
        descInput.value = desc;
        descInput.placeholder = '技能描述';
        // descInput.required = true; // Make it optional if some skills are empty initially

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.textContent = '移除技能';
        removeButton.onclick = () => {
            skillDiv.remove();
        };

        skillDiv.appendChild(levelLabel);
        skillDiv.appendChild(levelInput);
        skillDiv.appendChild(descLabel);
        skillDiv.appendChild(descInput);
        skillDiv.appendChild(removeButton);
        skillsContainer.appendChild(skillDiv);
    }

    // Initial render
    renderMercenaryList();
});