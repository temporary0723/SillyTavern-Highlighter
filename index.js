import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    chat,
    characters,
    this_chid
} from '../../../../script.js';

import {
    getContext,
    extension_settings
} from '../../../extensions.js';

import {
    executeSlashCommandsWithOptions
} from '../../../../scripts/slash-commands.js';

const extensionName = 'SillyTavern-Highlighter';
const EXT_PATHS = [
    `scripts/extensions/third-party/${extensionName}`,
    `../../../data/default-user/extensions/${extensionName}`, // 상대 경로 고려
];

async function getExtensionFolderPath() {
    for (const path of EXT_PATHS) {
        try {
            await $.get(`${path}/settings.html`); // 존재 확인용
            return path;
        } catch {
            continue;
        }
    }
    console.warn(`[SillyTavern-Highlighter] Could not locate extension folder for "${extensionName}".`);
    return EXT_PATHS[0]; // 기본값
}

// 요술봉 메뉴에 버튼 추가
async function addToWandMenu() {
    try {
        const extensionFolderPath = await getExtensionFolderPath();
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);

        const extensionsMenu = $("#extensionsMenu");
        if (extensionsMenu.length > 0) {
            // 기존 버튼이 있으면 제거 후 추가
            $("#highlighter_wand_button, #highlighter_panel_button").remove();

            extensionsMenu.append(buttonHtml);

            // 형광펜 모드 버튼 클릭 이벤트
            $("#highlighter_wand_button").on("click", function() {
                toggleHighlightMode();
            });

            // 독서노트 패널 버튼 클릭 이벤트
            $("#highlighter_panel_button").on("click", function() {
                openPanel();
            });

            // 설정에 따라 표시/숨김
            updateWandMenuVisibility();
        } else {
            setTimeout(addToWandMenu, 1000);
        }
    } catch (error) {
        // 버튼 로드 실패시 재시도
        setTimeout(addToWandMenu, 1000);
    }
}

// 요술봉 메뉴 버튼 표시/숨김
function updateWandMenuVisibility() {
    if (settings.showWandButton) {
        $("#highlighter_wand_button, #highlighter_panel_button").show();
    } else {
        $("#highlighter_wand_button, #highlighter_panel_button").hide();
    }
}

// 색상 커스터마이저 함수들
function getColors() {
    return settings.customColors || DEFAULT_COLORS;
}

function getColorIndex(color) {
    const colors = getColors();
    for (let i = 0; i < colors.length; i++) {
        if (colors[i].bg === color) {
            return i;
        }
    }
    return undefined;
}

function switchPreset(presetIndex) {
    if (!settings.colorPresets || !settings.colorPresets[presetIndex]) {
        console.error('[SillyTavern-Highlighter] Invalid preset index:', presetIndex);
        return;
    }

    const oldPresetIndex = settings.currentPresetIndex;
    const oldColors = settings.colorPresets[oldPresetIndex].colors;
    const newColors = settings.colorPresets[presetIndex].colors;

    console.log('[DEBUG] Switching preset:', {
        from: oldPresetIndex,
        to: presetIndex,
        oldColors: oldColors.map(c => c.bg),
        newColors: newColors.map(c => c.bg)
    });

    // 색상 매핑 테이블 생성 (이전 프리셋 hex -> colorIndex 추출용)
    const colorToIndexMap = {};
    oldColors.forEach((oldColor, index) => {
        colorToIndexMap[oldColor.bg] = index;
    });

    // 새 프리셋의 색상 -> 인덱스 맵 생성 (colorIndex 업데이트용)
    const newColorToIndexMap = {};
    newColors.forEach((newColor, index) => {
        newColorToIndexMap[newColor.bg] = index;
    });

    // 모든 하이라이트의 색상을 새 프리셋으로 매핑
    for (const charId in settings.highlights) {
        for (const chatFile in settings.highlights[charId]) {
            const chatData = settings.highlights[charId][chatFile];
            if (chatData && chatData.highlights) {
                chatData.highlights.forEach(hl => {
                    const oldColor = hl.color;
                    const savedColorIndex = hl.colorIndex;

                    // ✅ 현재 색상이 현재(old) 프리셋에서 실제로 몇 번 인덱스인지 찾기
                    const actualOldIndex = colorToIndexMap[hl.color];

                    if (actualOldIndex !== undefined) {
                        // 같은 인덱스 위치의 새 프리셋 색상으로 매핑
                        const newColor = newColors[actualOldIndex].bg;
                        hl.color = newColor;

                        // 새 색상이 새 프리셋에서 몇 번 인덱스인지 찾아서 저장
                        const actualNewIndex = newColorToIndexMap[newColor];
                        if (actualNewIndex !== undefined) {
                            hl.colorIndex = actualNewIndex;
                        }

                        console.log('[DEBUG] Color mapping:', {
                            hlId: hl.id,
                            oldColor,
                            savedColorIndex,
                            actualOldIndex,
                            newColor: hl.color,
                            newColorIndex: hl.colorIndex
                        });
                    } else {
                        console.warn('[DEBUG] Color not found in old preset:', hl.color);
                    }
                });
            }
        }
    }

    // 현재 프리셋 인덱스 업데이트
    settings.currentPresetIndex = presetIndex;

    // customColors를 새 프리셋의 colors로 업데이트 (하위 호환성)
    settings.customColors = settings.colorPresets[presetIndex].colors;

    // UI 새로고침
    initColorCustomizer();
    updateDynamicColorStyles();

    // 채팅 내 모든 하이라이트 다시 그리기
    $('.text-highlight').each(function() {
        $(this).contents().unwrap();
    });
    restoreHighlightsInChat();

    // 패널이 열려있으면 새로고침
    if ($('#highlighter-panel').hasClass('visible')) {
        renderView();
    }

    saveSettingsDebounced();
    toastr.success(`${settings.colorPresets[presetIndex].name}(으)로 전환되었습니다`);
}

// 선택된 프리셋 인덱스 (적용 전)
let selectedPresetIndex = null;

function initColorCustomizer() {
    const $container = $('#hl-color-customizer');
    $container.empty();

    const presets = settings.colorPresets;
    const currentIndex = settings.currentPresetIndex || 0;

    // 선택된 프리셋 초기화 (현재 활성 프리셋)
    if (selectedPresetIndex === null) {
        selectedPresetIndex = currentIndex;
    }

    // 탭 네비게이션 생성
    let tabsHtml = '<div class="hl-preset-tabs">';
    presets.forEach((preset, index) => {
        const isActive = index === currentIndex;
        const isSelected = index === selectedPresetIndex;
        const fontWeight = isActive ? '600' : '500';
        tabsHtml += `
            <div class="hl-preset-tab ${isActive ? 'active' : ''} ${isSelected && !isActive ? 'selected' : ''}" data-preset-index="${index}">
                <span class="hl-preset-tab-name" style="font-size: 13px !important; font-weight: ${fontWeight} !important; font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif !important; line-height: 1.4rem !important; -webkit-text-stroke: 0 !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${preset.name}">${preset.name}</span>
            </div>
        `;
    });
    tabsHtml += '</div>';

    $container.append(tabsHtml);

    // 선택된 프리셋의 색상 표시 (편집 가능)
    const selectedPreset = presets[selectedPresetIndex];
    const colors = selectedPreset.colors;
    const isDefaultPreset = selectedPreset.isDefault;

    // 프리셋 관리 버튼
    const showApplyBtn = selectedPresetIndex !== currentIndex;
    const presetControlHtml = `
        <div class="hl-preset-controls">
            <div class="hl-preset-title" title="${selectedPreset.name}">${selectedPreset.name}</div>
            <div class="hl-preset-buttons">
                ${showApplyBtn ? '<button class="hl-preset-apply-btn" title="선택한 프리셋을 채팅에 적용"><i class="fa-solid fa-check"></i> 적용</button>' : ''}
                ${!isDefaultPreset ? '<button class="hl-preset-rename-btn" title="프리셋 이름 변경"><i class="fa-solid fa-pencil"></i> 이름 변경</button>' : ''}
            </div>
        </div>
        ${!isDefaultPreset ? `
        <div class="hl-quick-color-input">
            <div class="hl-quick-color-header">
                <label>빠른 색상 적용</label>
                <button class="hl-quick-color-apply-btn">적용</button>
            </div>
            <input type="text" class="hl-quick-color-field" value="${colors.map(c => c.bg.substring(1)).join(' ')}">
            <small class="hl-quick-color-hint">5개의 HEX 색상 코드를 띄어쓰기로 구분하여 입력하세요</small>
        </div>
        ` : ''}
    `;
    $container.append(presetControlHtml);

    colors.forEach((colorConfig, index) => {
        const previewBg = hexToRgba(colorConfig.bg, colorConfig.opacity);
        const textColor = colorConfig.useDefaultTextColor ? 'inherit' : colorConfig.textColor;

        const item = `
            <div class="hl-color-item" data-index="${index}">
                <div class="hl-color-preview" style="background-color: ${previewBg};">
                    <div class="hl-color-preview-text" style="color: ${textColor};">가</div>
                </div>
                <div class="hl-color-controls">
                    ${!isDefaultPreset ? `
                    <div class="hl-color-control-row">
                        <label>배경색:</label>
                        <input type="color" class="hl-bg-color" value="${colorConfig.bg}">
                        <div style="display: flex; align-items: center; margin-left: 4px;">
                            <span style="margin-right: 4px;">#</span>
                            <input type="text" class="hl-hex-input" value="${colorConfig.bg.substring(1)}" maxlength="6">
                        </div>
                    </div>
                    ` : ''}
                    <div class="hl-color-control-row">
                        <label>불투명도:</label>
                        <input type="range" class="hl-opacity" min="0" max="100" value="${Math.round(colorConfig.opacity * 100)}">
                        <input type="number" class="hl-opacity-input" min="0" max="100" value="${Math.round(colorConfig.opacity * 100)}">
                        <span>%</span>
                    </div>
                    ${!isDefaultPreset ? `
                    <div class="hl-color-control-row">
                        <label>글자색:</label>
                        <input type="color" class="hl-text-color" value="${colorConfig.textColor}" ${colorConfig.useDefaultTextColor ? 'disabled' : ''}>
                        <label class="hl-use-default-label">
                            <input type="checkbox" class="hl-use-default" ${colorConfig.useDefaultTextColor ? 'checked' : ''}>
                            <span class="hl-checkbox-text">원래 색상 사용</span>
                        </label>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;

        $container.append(item);
    });

    bindColorCustomizerEvents();

}

function bindColorCustomizerEvents() {
    // 기존 이벤트 제거 (중복 방지)
    $('.hl-bg-color').off('input');
    $('.hl-opacity').off('input');
    $('.hl-opacity-input').off('input');
    $('.hl-text-color').off('input');
    $('.hl-use-default').off('change');
    $('.hl-hex-input').off('input');
    $('.hl-preset-tab').off('click');
    $('.hl-preset-apply-btn').off('click');
    $('.hl-preset-rename-btn').off('click');
    $('.hl-quick-color-apply-btn').off('click');

    // 프리셋 탭 클릭 이벤트 (선택만, 적용은 X)
    $('.hl-preset-tab').on('click', function() {
        const presetIndex = $(this).data('preset-index');
        if (presetIndex !== selectedPresetIndex) {
            selectedPresetIndex = presetIndex;
            // UI만 업데이트 (탭 강조 + 적용 버튼 표시)
            initColorCustomizer();
        }
    });

    // 프리셋 적용 버튼
    $('.hl-preset-apply-btn').on('click', function() {
        if (selectedPresetIndex !== settings.currentPresetIndex) {
            switchPreset(selectedPresetIndex);
            // 적용 후 선택 상태 초기화
            selectedPresetIndex = settings.currentPresetIndex;
        }
    });

    // 프리셋 이름 변경 버튼
    $('.hl-preset-rename-btn').on('click', function() {
        const preset = settings.colorPresets[selectedPresetIndex];
        const currentName = preset.name;

        const newName = prompt('프리셋 이름을 입력하세요:', currentName);
        if (newName && newName.trim() !== '' && newName !== currentName) {
            preset.name = newName.trim();
            // 탭 이름 업데이트
            $(`.hl-preset-tab[data-preset-index="${selectedPresetIndex}"] .hl-preset-tab-name`).text(newName.trim());
            saveSettingsDebounced();
            toastr.success('프리셋 이름이 변경되었습니다');
        }
    });

    // 빠른 색상 적용 버튼
    $('.hl-quick-color-apply-btn').on('click', function() {
        const input = $('.hl-quick-color-field').val().trim();
        if (!input) {
            toastr.warning('색상 코드를 입력해주세요');
            return;
        }

        // 띄어쓰기로 분리
        const colorCodes = input.split(/\s+/).filter(code => code.length > 0);

        if (colorCodes.length !== 5) {
            toastr.error('정확히 5개의 색상 코드를 입력해주세요');
            return;
        }

        // 각 색상 코드 검증 및 변환
        const hexColors = [];
        for (let i = 0; i < colorCodes.length; i++) {
            let code = colorCodes[i].replace(/^#/, ''); // # 제거

            // 유효성 검사 (6자리 hex)
            if (!/^[0-9A-Fa-f]{6}$/.test(code)) {
                toastr.error(`잘못된 색상 코드: ${colorCodes[i]}`);
                return;
            }

            hexColors.push('#' + code.toUpperCase());
        }

        // 색상 적용
        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;
        const oldColors = selectedColors.map(c => c.bg);

        hexColors.forEach((hexColor, index) => {
            selectedColors[index].bg = hexColor;
        });

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            hexColors.forEach((hexColor, index) => {
                settings.customColors[index].bg = hexColor;
                updateAllHighlightColors(oldColors[index], hexColor);
            });
            updateDynamicColorStyles();
        }

        // UI 새로고침
        initColorCustomizer();
        saveSettingsDebounced();
        toastr.success('색상이 적용되었습니다');
    });

    $('.hl-bg-color').on('input', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;
        const oldColor = selectedColors[index].bg;
        const newColor = $(this).val();

        // 배경색 업데이트 (선택된 프리셋 수정)
        selectedColors[index].bg = newColor;

        // 헥스 인풋도 업데이트
        $item.find('.hl-hex-input').val(newColor.substring(1));

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            settings.customColors[index].bg = newColor; // 참조 동기화
            updateAllHighlightColors(oldColor, newColor);
            updateDynamicColorStyles();
        }

        updateColorPreview($item);
        saveSettingsDebounced();
    });

    $('.hl-opacity').on('input', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        const value = parseInt($(this).val());
        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;

        selectedColors[index].opacity = value / 100;

        $item.find('.hl-opacity-input').val(value);
        updateColorPreview($item);

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            settings.customColors[index].opacity = value / 100; // 참조 동기화
            updateDynamicColorStyles();

            // 채팅 내 해당 색상의 모든 하이라이트 업데이트
            const color = selectedColors[index].bg;
            $(`.text-highlight[data-color="${color}"]`).each(function() {
                const bgColor = getBackgroundColorFromHex(color);
                $(this).css('background-color', bgColor);
            });
        }

        saveSettingsDebounced();
    });

    $('.hl-opacity-input').on('input', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        let value = parseInt($(this).val());

        // 범위 체크
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        if (isNaN(value)) value = 0;

        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;
        selectedColors[index].opacity = value / 100;

        const $range = $item.find('.hl-opacity');
        $range.val(value);
        $(this).val(value);
        updateColorPreview($item);

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            settings.customColors[index].opacity = value / 100; // 참조 동기화
            updateDynamicColorStyles();

            // 채팅 내 해당 색상의 모든 하이라이트 업데이트
            const color = selectedColors[index].bg;
            $(`.text-highlight[data-color="${color}"]`).each(function() {
                const bgColor = getBackgroundColorFromHex(color);
                $(this).css('background-color', bgColor);
            });
        }

        saveSettingsDebounced();
    });

    $('.hl-text-color').on('input', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;

        selectedColors[index].textColor = $(this).val();

        updateColorPreview($item);

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            settings.customColors[index].textColor = $(this).val(); // 참조 동기화
            updateDynamicColorStyles();
        }

        saveSettingsDebounced();
    });

    $('.hl-use-default').on('change', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        const checked = $(this).is(':checked');
        const selectedColors = settings.colorPresets[selectedPresetIndex].colors;

        selectedColors[index].useDefaultTextColor = checked;

        $item.find('.hl-text-color').prop('disabled', checked);
        updateColorPreview($item);

        // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
        if (selectedPresetIndex === settings.currentPresetIndex) {
            settings.customColors[index].useDefaultTextColor = checked; // 참조 동기화
            updateDynamicColorStyles();
        }

        saveSettingsDebounced();
    });

    $('.hl-hex-input').on('input', function() {
        const $item = $(this).closest('.hl-color-item');
        const index = $item.data('index');
        let hexValue = $(this).val().replace(/[^0-9A-Fa-f]/g, ''); // 유효한 문자만 허용

        // 6자리 헥스 코드인 경우에만 색상 업데이트
        if (hexValue.length === 6) {
            const selectedColors = settings.colorPresets[selectedPresetIndex].colors;
            const oldColor = selectedColors[index].bg;
            const newColor = '#' + hexValue.toUpperCase();

            // 배경색 업데이트 (선택된 프리셋 수정)
            selectedColors[index].bg = newColor;

            // 컬러피커도 업데이트
            $item.find('.hl-bg-color').val(newColor);

            // 선택된 프리셋이 현재 활성 프리셋이면 하이라이트도 업데이트
            if (selectedPresetIndex === settings.currentPresetIndex) {
                settings.customColors[index].bg = newColor; // 참조 동기화
                updateAllHighlightColors(oldColor, newColor);
                updateDynamicColorStyles();
            }

            updateColorPreview($item);
            saveSettingsDebounced();
        } else {
            // 6자리가 아닌 경우 인풋 값만 업데이트 (대문자 변환)
            $(this).val(hexValue.toUpperCase());
        }
    });
}

function updateColorPreview($item) {
    const index = $item.data('index');
    const colorConfig = settings.colorPresets[selectedPresetIndex].colors[index];
    const previewBg = hexToRgba(colorConfig.bg, colorConfig.opacity);
    const textColor = colorConfig.useDefaultTextColor ? 'inherit' : colorConfig.textColor;

    $item.find('.hl-color-preview').css('background-color', previewBg);
    $item.find('.hl-color-preview-text').css('color', textColor);
}

function hexToRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function updateDynamicColorStyles() {
    // 동적으로 스타일 업데이트
    $('#hl-dynamic-styles').remove();

    const colors = getColors();
    let styleContent = '';

    colors.forEach((colorConfig) => {
        const rgba = hexToRgba(colorConfig.bg, colorConfig.opacity);
        styleContent += `.text-highlight[data-color="${colorConfig.bg}"] { --hl-bg-color: ${rgba} !important; }\n`;

        if (!colorConfig.useDefaultTextColor) {
            styleContent += `.text-highlight[data-color="${colorConfig.bg}"] { color: ${colorConfig.textColor} !important; }\n`;
        }
    });

    $('<style id="hl-dynamic-styles">' + styleContent + '</style>').appendTo('head');
}

function updateAllHighlightColors(oldColor, newColor) {
    // 모든 캐릭터의 모든 채팅의 모든 하이라이트 색상 업데이트
    for (const charId in settings.highlights) {
        for (const chatFile in settings.highlights[charId]) {
            const chatData = settings.highlights[charId][chatFile];
            if (chatData && chatData.highlights) {
                chatData.highlights.forEach(hl => {
                    if (hl.color === oldColor) {
                        hl.color = newColor;
                    }
                });
            }
        }
    }

    // DOM의 하이라이트도 업데이트 (제거하지 않고 직접 수정)
    $(`.text-highlight[data-color="${oldColor}"]`).each(function() {
        $(this).attr('data-color', newColor);
        const bgColor = getBackgroundColorFromHex(newColor);
        $(this).css('background-color', bgColor);
    });

    // 패널이 열려있으면 새로고침
    if ($('#highlighter-panel').hasClass('visible')) {
        renderView();
    }
}

function exportColors() {
    const currentPreset = settings.colorPresets[settings.currentPresetIndex];
    const data = {
        version: '2.0',
        presetName: currentPreset.name,
        colors: currentPreset.colors
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `highlighter_preset_${currentPreset.name}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`${currentPreset.name} 프리셋이 백업되었습니다`);
}

function importColors(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const data = JSON.parse(event.target.result);

            if (!data.colors || !Array.isArray(data.colors) || data.colors.length !== 5) {
                throw new Error('잘못된 파일 형식입니다');
            }

            // 유효성 검사
            data.colors.forEach(color => {
                if (!color.bg || !color.hasOwnProperty('opacity') || !color.textColor || !color.hasOwnProperty('useDefaultTextColor')) {
                    throw new Error('잘못된 색상 데이터입니다');
                }
            });

            const currentIndex = settings.currentPresetIndex;
            const currentPreset = settings.colorPresets[currentIndex];

            // 기본 프리셋은 불러오기 불가
            if (currentPreset.isDefault) {
                toastr.warning('기본 프리셋은 색상을 불러올 수 없습니다. 다른 프리셋을 선택해주세요.');
                $(e.target).val('');
                return;
            }

            // 기존 색상 -> 인덱스 매핑
            const oldColors = currentPreset.colors.map(c => c.bg);

            // 현재 프리셋의 색상 업데이트
            currentPreset.colors = data.colors;
            settings.customColors = data.colors;

            initColorCustomizer();
            updateDynamicColorStyles();

            // 각 하이라이트의 색상을 새 팔레트로 업데이트
            for (const charId in settings.highlights) {
                for (const chatFile in settings.highlights[charId]) {
                    const chatData = settings.highlights[charId][chatFile];
                    if (chatData && chatData.highlights) {
                        chatData.highlights.forEach(hl => {
                            const oldIndex = oldColors.indexOf(hl.color);
                            if (oldIndex !== -1) {
                                hl.color = settings.customColors[oldIndex].bg;
                            } else {
                                // 색상을 찾지 못한 경우 첫 번째 색상으로 폴백
                                hl.color = settings.customColors[0].bg;
                            }
                        });
                    }
                }
            }

            // 채팅 내 모든 하이라이트 제거하고 다시 그리기
            $('.text-highlight').each(function() {
                $(this).contents().unwrap();
            });

            renderView(); // 패널에 바뀐 색상 적용
            restoreHighlightsInChat(); // 새 색상으로 다시 그리기
            saveSettingsDebounced();
            toastr.success(`${currentPreset.name}에 색상을 불러왔습니다`);
        } catch (error) {
            toastr.error('색상 설정 불러오기 실패: ' + error.message);
        }
    };
    reader.readAsText(file);

    // 파일 입력 초기화
    $(e.target).val('');
}


const VIEW_LEVELS = {
    CHARACTER_LIST: 'character_list',
    CHAT_LIST: 'chat_list',
    HIGHLIGHT_LIST: 'highlight_list'
};

// 밝은 파스텔 톤 기본 색상
const DEFAULT_COLORS = [
    { bg: '#FFE4B5', opacity: 0.8, textColor: '#222', useDefaultTextColor: false },
    { bg: '#D4F1D4', opacity: 0.8, textColor: '#222', useDefaultTextColor: false },
    { bg: '#E6D5F0', opacity: 0.8, textColor: '#222', useDefaultTextColor: false },
    { bg: '#C7EBFF', opacity: 0.8, textColor: '#222', useDefaultTextColor: false },
    { bg: '#FFD4E5', opacity: 0.8, textColor: '#222', useDefaultTextColor: false }
];

// 기본 프리셋 (색상 고정, 불투명도만 커스터마이징 가능)
const DEFAULT_PRESET = {
    name: '기본',
    isDefault: true,
    colors: JSON.parse(JSON.stringify(DEFAULT_COLORS))
};

// 빈 유저 프리셋 생성 함수
function createEmptyPreset(index) {
    return {
        name: `프리셋 ${index}`,
        isDefault: false,
        colors: JSON.parse(JSON.stringify(DEFAULT_COLORS))
    };
}

const GITHUB_REPO = 'saving3899/SillyTavern-Highlighter'; // GitHub 저장소
const UPDATE_CHECK_CACHE_KEY = 'highlighter_update_check';
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24시간 (밀리초)

// ⭐ 로컬 manifest.json에서 버전을 가져올 것임 (초기화 시 로드)
let EXTENSION_VERSION = '1.0.0'; // 기본값 (manifest.json 로드 전)

const DEFAULT_SETTINGS = {
    version: '1.0.0', // 데이터 버전 관리 (manifest에서 자동 업데이트됨)
    enabled: true,
    deleteMode: 'keep',
    darkMode: false,
    buttonPosition: 'bottom-right',
    showFloatingBtn: true, // 플로팅 버튼 표시 여부
    showWandButton: true, // 요술봉 메뉴 버튼 표시 여부
    alwaysHighlightMode: false, // 형광펜 모드 항상 활성화
    panelPosition: null, // { top, left } 저장
    highlights: {},
    characterMemos: {}, // 캐릭터별 메모 { charId: "메모 내용" }
    chatMemos: {}, // 채팅별 메모 { "charId_chatFile": "메모 내용" }
    customColors: null, // 커스텀 색상 배열 (하위 호환성 유지용)
    colorPresets: null, // 색상 프리셋 배열 [기본, 프리셋1, 프리셋2, 프리셋3, 프리셋4, 프리셋5]
    currentPresetIndex: 0, // 현재 활성화된 프리셋 인덱스 (0: 기본)
    sortOptions: {
        characters: 'modified', // 'modified', 'name'
        chats: 'modified', // 'modified', 'name'
        highlights: 'created' // 'created', 'message'
    }
};

let settings;
let currentView = VIEW_LEVELS.CHARACTER_LIST;
let selectedCharacter = null;
let selectedChat = null;
let isHighlightMode = false;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let previousChatFile = null; // 채팅 제목 변경 감지용
let previousCharId = null; // 캐릭터 변경 감지용
let previousChatLength = null; // 채팅 메시지 개수 (같은 채팅인지 확인용)
let previousChatChangeTime = null; // 채팅 변경 시간 (제목 변경과 채팅 이동 구분용)
let previousChatMessages = null; // 첫/마지막 메시지 저장 (제목 변경 검증용)

// ====================================
// 데이터 안정성 및 마이그레이션
// ====================================

// 데이터 검증 및 복구 (안전하게, 기존 데이터 보존)
function validateAndRepairSettings(data) {
    try {
        // 필수 필드 확인 및 기본값 설정
        if (!data || typeof data !== 'object') {
            console.warn('[SillyTavern-Highlighter] Invalid settings, using defaults');
            return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }

        // 필수 필드 존재 확인 (없으면 추가, 기존 값은 유지)
        if (!data.highlights) data.highlights = {};
        if (!data.characterMemos) data.characterMemos = {};
        if (!data.chatMemos) data.chatMemos = {};
        if (!data.deleteMode) data.deleteMode = 'keep';
        if (data.darkMode === undefined) data.darkMode = false;
        if (!data.buttonPosition) data.buttonPosition = 'bottom-right';
        if (data.showFloatingBtn === undefined) data.showFloatingBtn = true;
        if (data.showWandButton === undefined) data.showWandButton = true;
        if (data.alwaysHighlightMode === undefined) data.alwaysHighlightMode = false;
        if (!data.sortOptions) {
            data.sortOptions = {
                characters: 'modified',
                chats: 'modified',
                highlights: 'created'
            };
        }

        // 프리셋 시스템 마이그레이션
        if (!data.colorPresets) {
            console.log('[SillyTavern-Highlighter] Migrating to preset system');

            // 기존 customColors가 있으면 프리셋 1번에 저장
            const existingColors = data.customColors || JSON.parse(JSON.stringify(DEFAULT_COLORS));

            data.colorPresets = [
                JSON.parse(JSON.stringify(DEFAULT_PRESET)), // 0: 기본 프리셋
                {
                    name: '프리셋 1',
                    isDefault: false,
                    colors: JSON.parse(JSON.stringify(existingColors))
                },
                createEmptyPreset(2),
                createEmptyPreset(3),
                createEmptyPreset(4),
                createEmptyPreset(5)
            ];

            // 기존 사용자는 프리셋 1번을 활성화 (기존 색상 유지)
            data.currentPresetIndex = data.customColors ? 1 : 0;

            console.log(`[SillyTavern-Highlighter] Migrated to preset ${data.currentPresetIndex}`);
        }

        // currentPresetIndex 기본값 설정
        if (data.currentPresetIndex === undefined) {
            data.currentPresetIndex = 0;
        }

        // customColors는 현재 활성 프리셋의 colors를 가리키도록 (하위 호환성)
        if (data.colorPresets && data.colorPresets[data.currentPresetIndex]) {
            data.customColors = data.colorPresets[data.currentPresetIndex].colors;
        } else {
            data.customColors = JSON.parse(JSON.stringify(DEFAULT_COLORS));
        }

        // highlights 데이터 경고만 출력 (삭제하지 않음 - 데이터 보존)
        for (const charId in data.highlights) {
            if (!data.highlights[charId] || typeof data.highlights[charId] !== 'object') {
                console.warn(`[SillyTavern-Highlighter] Invalid data for character ${charId}, but keeping it`);
                continue;
            }

            for (const chatFile in data.highlights[charId]) {
                const chatData = data.highlights[charId][chatFile];
                if (!chatData) {
                    console.warn(`[SillyTavern-Highlighter] Invalid chat data for ${charId}/${chatFile}, but keeping it`);
                    continue;
                }

                // highlights 배열 확인
                if (!Array.isArray(chatData.highlights)) {
                    console.warn(`[SillyTavern-Highlighter] highlights is not an array for ${charId}/${chatFile}, converting`);
                    chatData.highlights = [];
                }
            }
        }

        return data;
    } catch (error) {
        console.error('[SillyTavern-Highlighter] Error validating settings:', error);
        // 에러 발생 시에도 원본 데이터 반환 (기본값으로 교체하지 않음)
        return data || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
}

// 데이터 마이그레이션
function migrateSettings(data) {
    try {
        const currentVersion = data.version || null;

        // 버전이 없거나 1.0.0 미만인 경우 마이그레이션
        if (!currentVersion || currentVersion !== EXTENSION_VERSION) {
            console.log(`[SillyTavern-Highlighter] Migrating from ${currentVersion || 'pre-1.0.0'} to ${EXTENSION_VERSION}`);

            // textOffset 필드 추가 (없으면 0으로)
            for (const charId in data.highlights) {
                for (const chatFile in data.highlights[charId]) {
                    const chatData = data.highlights[charId][chatFile];
                    if (chatData && Array.isArray(chatData.highlights)) {
                        chatData.highlights.forEach(hl => {
                            if (hl && hl.textOffset === undefined) {
                                hl.textOffset = 0; // 기본값
                            }
                        });
                    }
                }
            }

            console.log('[SillyTavern-Highlighter] Migration completed');
        } else {
            console.log(`[SillyTavern-Highlighter] Already at version ${EXTENSION_VERSION}, no migration needed`);
        }

        // 버전 업데이트
        data.version = EXTENSION_VERSION;

        return data;
    } catch (error) {
        console.error('[SillyTavern-Highlighter] Migration error:', error);
        // 에러 발생해도 원본 데이터 반환
        return data;
    }
}


function createHighlighterUI() {
    const html = `
        <div id="highlighter-floating-container">
            <button id="highlighter-toggle-btn" title="메뉴 열기">
                <i class="fa-solid fa-bars"></i>
            </button>
            <div id="highlighter-floating-menu" class="hl-floating-menu" style="display: none;">
                <button class="hl-floating-menu-btn" id="hl-floating-panel-btn" title="독서노트 열기">
                    <i class="fa-solid fa-book"></i>
                </button>
                <button class="hl-floating-menu-btn" id="hl-floating-highlight-mode-btn" title="형광펜 모드">
                    <i class="fa-solid fa-highlighter"></i>
                </button>
            </div>
        </div>

        <div id="highlighter-panel">
            <div class="highlighter-header">
                <div class="highlighter-title">
                    <i class="fa-solid fa-book"></i>
                    독서노트
                </div>
                <div class="highlighter-actions">
                    <button class="highlighter-btn hl-text-btn" id="hl-current-chat-btn" title="현재 채팅으로">
                        현재 채팅
                    </button>
                    <button class="highlighter-btn" id="hl-theme-toggle-btn" title="다크모드">
                        <i class="fa-solid fa-moon"></i>
                    </button>
                    <button class="highlighter-btn" id="hl-header-more-btn" title="더보기">
                        <i class="fa-solid fa-ellipsis-vertical"></i>
                    </button>
                    <button class="highlighter-btn" id="hl-close-btn" title="닫기">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            </div>

            <div class="highlighter-tabs">
                <button class="highlighter-tab active" data-tab="all">전체</button>
                <button class="highlighter-tab" data-tab="highlights">형광펜</button>
                <button class="highlighter-tab" data-tab="notes">메모</button>
            </div>

            <div class="highlighter-breadcrumb" id="highlighter-breadcrumb"></div>
            <div class="highlighter-content" id="highlighter-content"></div>
        </div>

        <input type="file" id="hl-import-file-input" accept=".json" style="display: none;">
    `;

    $('body').append(html);
    bindUIEvents();
    bindHighlightClickEvents(); // 하이라이트 클릭 이벤트 위임 설정
    applyDarkMode();
    applyButtonPosition();
}

function bindUIEvents() {
    $('#highlighter-toggle-btn').on('click', toggleFloatingMenu);
    $('#hl-floating-panel-btn').on('click', openPanel);
    $('#hl-floating-highlight-mode-btn').on('click', toggleHighlightMode);
    $('#hl-close-btn').on('click', closePanel);
    $('#hl-current-chat-btn').on('click', navigateToCurrentChat);
    $('#hl-theme-toggle-btn').on('click', toggleDarkMode);
    $('#hl-header-more-btn').on('click', showHeaderMoreMenu);

    $('#hl-import-file-input').on('change', function (e) {
        const file = e.target.files[0];
        if (file) importHighlights(file);
    });

    $('.highlighter-tab').on('click', function () {
        $('.highlighter-tab').removeClass('active');
        $(this).addClass('active');
        renderView();
    });

    if (window.innerWidth > 768) {
        bindDragFunctionality();
    }

    // 외부 클릭 시 플로팅 메뉴 닫기
    $(document).on('click', function(e) {
        const $floatingContainer = $('#highlighter-floating-container');
        const $floatingMenu = $('#highlighter-floating-menu');

        if (!$floatingContainer.is(e.target) && $floatingContainer.has(e.target).length === 0) {
            if ($floatingMenu.is(':visible')) {
                $floatingMenu.slideUp(200);
            }
        }
    });
}

// 하이라이트 클릭 이벤트를 이벤트 위임으로 바인딩 (패널 상태와 무관하게 작동)
function bindHighlightClickEvents() {
    // #chat 컨테이너에 이벤트 위임 설정
    $(document).on('click.hl', '.text-highlight', function (e) {
        e.stopPropagation();
        const hlId = $(this).data('hlId');
        if (hlId) {
            showHighlightContextMenu(hlId, e.clientX, e.clientY);
        }
    });

    console.log('[SillyTavern-Highlighter] Click events bound with delegation');
}

function bindDragFunctionality() {
    const $panel = $('#highlighter-panel');
    const $header = $('.highlighter-header');

    $header.on('mousedown', function (e) {
        if ($(e.target).closest('.highlighter-btn').length) return;

        isDragging = true;
        $panel.addClass('dragging');

        const rect = $panel[0].getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        // 기존 transform 제거하고 left/top으로 정규화
        const panel = $panel[0];
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';

        e.preventDefault();
    });

    $(document).on('mousemove', function (e) {
        if (!isDragging) return;

        requestAnimationFrame(() => {
            const $panel = $('#highlighter-panel');
            const panel = $panel[0];

            // 목표 위치 계산
            let newLeft = e.clientX - dragOffsetX;
            let newTop = e.clientY - dragOffsetY;

            // 화면 경계 체크
            const maxX = window.innerWidth - $panel.width();
            const maxY = window.innerHeight - $panel.height();

            newLeft = Math.max(0, Math.min(newLeft, maxX));
            newTop = Math.max(0, Math.min(newTop, maxY));

            // left/top 직접 변경 (GPU 가속은 CSS의 will-change로 유지)
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });
    });

    $(document).on('mouseup', function () {
        if (isDragging) {
            isDragging = false;
            const $panel = $('#highlighter-panel');
            $panel.removeClass('dragging');

            // 최종 위치 저장
            const rect = $panel[0].getBoundingClientRect();
            settings.panelPosition = {
                top: rect.top,
                left: rect.left
            };
            saveSettingsDebounced();
        }
    });
}

function toggleFloatingMenu() {
    const $menu = $('#highlighter-floating-menu');
    const isVisible = $menu.is(':visible');

    if (isVisible) {
        $menu.slideUp(200);
    } else {
        $menu.slideDown(200);
    }
}

function openPanel() {
    const $panel = $('#highlighter-panel');

    // 플로팅 메뉴 닫기
    $('#highlighter-floating-menu').slideUp(200);

    // 패널 열기
    $panel.addClass('visible');

    // 저장된 위치가 있으면 복원 (모바일 제외)
    if (settings.panelPosition && window.innerWidth > 768) {
        $panel.css({
            top: settings.panelPosition.top + 'px',
            left: settings.panelPosition.left + 'px',
            right: 'auto',
            bottom: 'auto',
            transform: 'none'
        });
    }

    // 모바일에서 body 스크롤 방지
    if (window.innerWidth <= 768) {
        $('body').css('overflow', 'hidden');
    }

    // 캐릭터 정보 캐시 초기화 (실시간 반영용)
    initCharacterCache();

    renderView();
}

function closePanel() {
    $('#highlighter-panel').removeClass('visible');

    // 모바일에서 body 스크롤 복원
    if (window.innerWidth <= 768) {
        $('body').css('overflow', '');
    }
}

function toggleDarkMode() {
    settings.darkMode = !settings.darkMode;
    applyDarkMode();
    saveSettingsDebounced();
}

function applyDarkMode() {
    const $panel = $('#highlighter-panel');
    const $icon = $('#hl-theme-toggle-btn i');

    if (settings.darkMode) {
        $panel.addClass('dark-mode');
        $icon.removeClass('fa-moon').addClass('fa-sun');
    } else {
        $panel.removeClass('dark-mode');
        $icon.removeClass('fa-sun').addClass('fa-moon');
    }
}

function getDarkModeClass() {
    return settings.darkMode ? 'dark-mode' : '';
}

function applyButtonPosition() {
    const $container = $('#highlighter-floating-container');

    // 플로팅 버튼 표시/숨김
    if (settings.showFloatingBtn === false) {
        $container.addClass('hidden');
        return;
    } else {
        $container.removeClass('hidden');
    }

    const positions = {
        'bottom-right': { bottom: '80px', right: '20px', top: 'auto', left: 'auto' },
        'bottom-left': { bottom: '80px', left: '20px', top: 'auto', right: 'auto' },
        'top-right': { top: '80px', right: '20px', bottom: 'auto', left: 'auto' },
        'top-left': { top: '80px', left: '20px', bottom: 'auto', right: 'auto' }
    };

    const pos = positions[settings.buttonPosition] || positions['bottom-right'];
    $container.css(pos);

    // 버튼 위치에 따라 메뉴 방향 결정
    const buttonPos = settings.buttonPosition || 'bottom-right';
    if (buttonPos.startsWith('top-')) {
        $container.addClass('menu-below');
        $container.removeClass('menu-above');
    } else {
        $container.addClass('menu-above');
        $container.removeClass('menu-below');
    }
}

function toggleHighlightMode() {
    // 항상 활성화 모드일 때는 비활성화 방지
    if (settings.alwaysHighlightMode && isHighlightMode) {
        toastr.warning('형광펜 모드 항상 활성화가 설정되어 있습니다');
        return;
    }

    isHighlightMode = !isHighlightMode;
    $('#hl-floating-highlight-mode-btn').toggleClass('active', isHighlightMode);

    // 요술봉 메뉴 상태 업데이트
    const $status = $('#highlighter_mode_status');
    if ($status.length) {
        $status.text(isHighlightMode ? '(켜짐)' : '(꺼짐)');
    }

    if (isHighlightMode) {
        enableHighlightMode();
        toastr.info('형광펜 모드 활성화');
    } else {
        disableHighlightMode();
        toastr.info('형광펜 모드 비활성화');
    }
}

function navigateToCurrentChat() {
    const chatFile = getCurrentChatFile();
    const charId = this_chid;

    if (!chatFile || !charId) {
        toastr.warning('채팅이 열려있지 않습니다');
        return;
    }

    navigateToHighlightList(charId, chatFile);
}

function navigateToCharacterList() {
    currentView = VIEW_LEVELS.CHARACTER_LIST;
    selectedCharacter = null;
    selectedChat = null;
    renderView();
}

function navigateToChatList(characterId) {
    currentView = VIEW_LEVELS.CHAT_LIST;
    selectedCharacter = characterId;
    selectedChat = null;
    renderView();
}

function navigateToHighlightList(characterId, chatFile) {
    currentView = VIEW_LEVELS.HIGHLIGHT_LIST;
    selectedCharacter = characterId;
    selectedChat = chatFile;
    renderView();
}

function updateBreadcrumb() {
    const $breadcrumb = $('#highlighter-breadcrumb');
    $breadcrumb.empty();

    let html = '';

    // 정렬 옵션 초기화
    if (!settings.sortOptions) {
        settings.sortOptions = {
            characters: 'modified',
            chats: 'modified',
            highlights: 'created'
        };
    }

    // 뒤로가기 버튼 방식으로 변경
    if (selectedChat) {
        // 하이라이트 목록 → 채팅 목록
        html = '<button class="hl-back-btn" data-action="back-to-chat"><i class="fa-solid fa-arrow-left"></i> 채팅 목록</button>';
        // 채팅 이름만 표시 (캐릭터 이름 제거)
        html += ` <span class="breadcrumb-current">${selectedChat}</span>`;

        // 정렬 버튼 추가
        const highlightsSortLabel = settings.sortOptions.highlights === 'message' ? '채팅순' : '최근 생성순';
        html += `
            <button class="hl-sort-btn" data-sort-type="highlights">
                ${highlightsSortLabel}
            </button>
        `;

        // More 메뉴 버튼 추가 (하이라이트 목록일 때만)
        html += `
            <button class="hl-more-btn" id="hl-breadcrumb-more-btn" title="더보기">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        `;
    } else if (selectedCharacter) {
        // 채팅 목록 → 캐릭터 목록
        html = '<button class="hl-back-btn" data-action="back-to-home"><i class="fa-solid fa-arrow-left"></i> 모든 캐릭터</button>';
        const charName = getCharacterName(selectedCharacter);
        html += ` <span class="breadcrumb-current">${charName}</span>`;

        // 정렬 버튼 추가
        const chatsSortLabel = settings.sortOptions.chats === 'name' ? '이름순' : '최근 수정순';
        html += `
            <button class="hl-sort-btn" data-sort-type="chats">
                ${chatsSortLabel}
            </button>
        `;

        // More 메뉴 버튼 추가 (채팅 목록일 때만)
        html += `
            <button class="hl-more-btn" id="hl-breadcrumb-more-btn" title="더보기">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        `;
    } else {
        // 캐릭터 목록 (최상위)
        html = '<span class="breadcrumb-current">모든 캐릭터</span>';

        // 정렬 버튼 추가
        const charactersSortLabel = settings.sortOptions.characters === 'name' ? '이름순' : '최근 수정순';
        html += `
            <button class="hl-sort-btn" data-sort-type="characters">
                ${charactersSortLabel}
            </button>
        `;
    }

    $breadcrumb.html(html);

    // 기존 이벤트 제거 후 재바인딩 (중복 방지)
    $('[data-action="back-to-home"]').off('click').on('click', navigateToCharacterList);
    $('[data-action="back-to-chat"]').off('click').on('click', () => navigateToChatList(selectedCharacter));
    $('#hl-breadcrumb-more-btn').off('click').on('click', showBreadcrumbMoreMenu);

    // 정렬 버튼 클릭 이벤트
    $('.hl-sort-btn').off('click').on('click', showSortMenu);
}

function showSortMenu(e) {
    e.stopPropagation();

    // 기존 메뉴 제거
    $('.hl-sort-menu').remove();

    const $btn = $(e.currentTarget);
    const sortType = $btn.data('sortType');
    const rect = $btn[0].getBoundingClientRect();

    let options = [];
    let currentValue = '';

    if (sortType === 'highlights') {
        options = [
            { value: 'created', label: '최근 생성순' },
            { value: 'message', label: '채팅순' }
        ];
        currentValue = settings.sortOptions.highlights;
    } else if (sortType === 'chats') {
        options = [
            { value: 'modified', label: '최근 수정순' },
            { value: 'name', label: '이름순' }
        ];
        currentValue = settings.sortOptions.chats;
    } else if (sortType === 'characters') {
        options = [
            { value: 'modified', label: '최근 수정순' },
            { value: 'name', label: '이름순' }
        ];
        currentValue = settings.sortOptions.characters;
    }

    const menuHtml = options.map(opt => `
        <button class="hl-sort-menu-item ${opt.value === currentValue ? 'active' : ''}" data-value="${opt.value}">
            ${opt.label}
            ${opt.value === currentValue ? '<i class="fa-solid fa-check"></i>' : ''}
        </button>
    `).join('');

    const menu = $(`
        <div class="hl-sort-menu ${getDarkModeClass()}" data-sort-type="${sortType}">
            ${menuHtml}
        </div>
    `);

    $('body').append(menu);

    // 메뉴 위치 설정 (버튼 오른쪽 끝에 맞춤)
    menu.css({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right
    });

    // 메뉴 아이템 클릭
    menu.find('.hl-sort-menu-item').on('click', function() {
        const value = $(this).data('value');

        if (sortType === 'highlights') {
            settings.sortOptions.highlights = value;
        } else if (sortType === 'chats') {
            settings.sortOptions.chats = value;
        } else if (sortType === 'characters') {
            settings.sortOptions.characters = value;
        }

        saveSettingsDebounced();
        renderView();
        menu.remove();
    });

    // 외부 클릭 시 메뉴 닫기
    $(document).one('click', () => menu.remove());
}

function renderView() {
    updateBreadcrumb();

    const $content = $('#highlighter-content');
    $content.empty();

    const activeTab = $('.highlighter-tab.active').data('tab');

    switch (currentView) {
        case VIEW_LEVELS.CHARACTER_LIST:
            renderCharacterList($content);
            resetTabCounts(); // 탭 개수 초기화
            break;
        case VIEW_LEVELS.CHAT_LIST:
            renderChatList($content, selectedCharacter);
            resetTabCounts(); // 탭 개수 초기화
            break;
        case VIEW_LEVELS.HIGHLIGHT_LIST:
            renderHighlightList($content, selectedCharacter, selectedChat, activeTab);
            updateTabCounts(); // 하이라이트 목록에서만 탭 개수 업데이트
            break;
    }
}

function updateTabCounts() {
    // 하이라이트 목록 뷰에서만 작동
    if (currentView !== VIEW_LEVELS.HIGHLIGHT_LIST || !selectedCharacter || !selectedChat) return;

    const highlights = settings.highlights[selectedCharacter]?.[selectedChat]?.highlights || [];

    // 전체 개수
    const totalCount = highlights.length;

    // 메모가 있는 하이라이트 개수
    const noteCount = highlights.filter(h => h.note && h.note.trim()).length;

    // 탭 텍스트 업데이트
    $('[data-tab="all"]').html(`전체 (${totalCount})`);
    $('[data-tab="highlights"]').html(`형광펜 (${totalCount})`);
    $('[data-tab="notes"]').html(`메모 (${noteCount})`);
}

function resetTabCounts() {
    // 탭 개수 표시 제거
    $('[data-tab="all"]').html('전체');
    $('[data-tab="highlights"]').html('형광펜');
    $('[data-tab="notes"]').html('메모');
}

function renderCharacterList($container) {
    // 기존 내용 초기화
    $container.empty();

    let charIds = Object.keys(settings.highlights).filter(charId => {
        const chats = settings.highlights[charId];
        return Object.keys(chats).some(chatFile => chats[chatFile].highlights.length > 0);
    });

    if (charIds.length === 0) {
        $container.html(`
            <div class="hl-empty">
                <div class="hl-empty-icon"><i class="fa-solid fa-book-open"></i></div>
                <div class="hl-empty-text">아직 저장된 형광펜이 없습니다</div>
            </div>
        `);
        return;
    }

    // 정렬
    const sortOption = settings.sortOptions?.characters || 'modified';
    if (sortOption === 'name') {
        // 이름순 (가나다)
        charIds.sort((a, b) => {
            const nameA = getCharacterName(a);
            const nameB = getCharacterName(b);
            return nameA.localeCompare(nameB, 'ko-KR');
        });
    } else {
        // 최근 수정순
        charIds.sort((a, b) => {
            const chatsA = settings.highlights[a];
            const chatsB = settings.highlights[b];
            const lastModifiedA = Math.max(...Object.values(chatsA).map(c => c.lastModified || 0));
            const lastModifiedB = Math.max(...Object.values(chatsB).map(c => c.lastModified || 0));
            return lastModifiedB - lastModifiedA; // 최신이 위로
        });
    }

    // 이미지 캐시 무효화를 위한 타임스탬프
    const timestamp = Date.now();

    charIds.forEach(charId => {
        const charData = characters[charId];
        const charName = charData?.name || 'Unknown';
        const totalHighlights = getTotalHighlightsForCharacter(charId);
        const avatar = charData?.avatar ?
            `/thumbnail?type=avatar&file=${charData.avatar}&t=${timestamp}` :
            '/img/five.png';
        const memo = settings.characterMemos?.[charId] || '';
        const memoDisplay = memo ? `<span class="hl-memo">${memo}</span>` : '';

        const item = `
            <div class="hl-list-item" data-char-id="${charId}">
                <img src="${avatar}" class="hl-icon" onerror="this.src='/img/five.png'">
                <div class="hl-info">
                    <div class="hl-name">${charName}</div>
                    <div class="hl-count-row">
                        <span class="hl-count">${totalHighlights}개</span>
                        ${memoDisplay}
                    </div>
                </div>
                <button class="hl-memo-edit-btn" data-char-id="${charId}" title="메모 편집">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <i class="fa-solid fa-chevron-right hl-chevron"></i>
            </div>
        `;
        $container.append(item);
    });

    // 클릭 이벤트 바인딩 (중복 방지) - 컨테이너 내 아이템만 선택
    $container.find('.hl-list-item').off('click').on('click', function (e) {
        // 메모 편집 버튼 클릭 시 이벤트 전파 방지
        if ($(e.target).closest('.hl-memo-edit-btn').length > 0) {
            return;
        }
        navigateToChatList($(this).data('charId'));
    });

    // 메모 편집 버튼 이벤트 바인딩
    $container.find('.hl-memo-edit-btn').off('click').on('click', function (e) {
        e.stopPropagation();
        const charId = $(this).data('charId');
        openCharacterMemoEditor(charId);
    });
}

function openCharacterMemoEditor(charId) {
    $('#character-memo-modal').remove();

    const charName = getCharacterName(charId);
    const currentMemo = settings.characterMemos?.[charId] || '';

    const modal = `
        <div id="character-memo-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3><i class="fa-solid fa-pencil"></i> 캐릭터 메모</h3>
                    <button class="hl-modal-close"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="hl-modal-body">
                    <div class="hl-memo-modal-info">
                        <span>${charName}</span>
                    </div>
                    <textarea class="hl-note-textarea" placeholder="이 캐릭터를 구분하기 위한 메모를 입력하세요...
예: 페르소나 A, 친구 설정, 연인 루트 등">${currentMemo}</textarea>
                    <small style="display: block; margin-top: 8px; color: #777;">
                        같은 이름의 캐릭터를 구분하는 데 도움이 됩니다.
                    </small>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    ${currentMemo ? '<button class="hl-modal-btn hl-modal-delete">삭제</button>' : ''}
                    <button class="hl-modal-btn hl-modal-save">저장</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    const $textarea = $('.hl-note-textarea');
    $textarea.focus();

    // 저장 버튼
    $('.hl-modal-save').on('click', function () {
        const newMemo = $textarea.val().trim();
        if (!settings.characterMemos) settings.characterMemos = {};

        if (newMemo) {
            settings.characterMemos[charId] = newMemo;
        } else {
            delete settings.characterMemos[charId];
        }

        saveSettingsDebounced();
        renderView();
        $('#character-memo-modal').remove();
        toastr.success('메모 저장됨');
    });

    // 삭제 버튼
    $('.hl-modal-delete').on('click', function () {
        if (confirm('메모를 삭제하시겠습니까?')) {
            if (settings.characterMemos) {
                delete settings.characterMemos[charId];
            }
            saveSettingsDebounced();
            renderView();
            $('#character-memo-modal').remove();
            toastr.info('메모 삭제됨');
        }
    });

    // 닫기/취소 버튼
    const closeMemoModal = function () {
        const newMemo = $textarea.val().trim();
        const hasChanges = newMemo !== currentMemo;

        if (hasChanges && newMemo.length > 0) {
            if (confirm('메모를 취소하시겠습니까?\n저장되지 않은 변경사항이 사라집니다.')) {
                $('#character-memo-modal').remove();
            }
        } else {
            $('#character-memo-modal').remove();
        }
    };

    $('.hl-modal-close, .hl-modal-cancel').on('click', closeMemoModal);

    // 모달 밖 클릭 시 닫기
    $('.hl-modal-overlay').on('click', function (e) {
        if (e.target === this) {
            closeMemoModal();
        }
    });
}

function openChatMemoEditor(charId, chatFile) {
    $('#chat-memo-modal').remove();

    const charName = getCharacterName(charId);
    const memoKey = `${charId}_${chatFile}`;
    const currentMemo = settings.chatMemos?.[memoKey] || '';

    const modal = `
        <div id="chat-memo-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3><i class="fa-solid fa-pencil"></i> 채팅 메모</h3>
                    <button class="hl-modal-close"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="hl-modal-body">
                    <div class="hl-memo-modal-info">
                        <span>${charName}</span> <span style="color: #999;">&gt;</span> <span>${chatFile}</span>
                    </div>
                    <textarea class="hl-note-textarea" placeholder="이 채팅을 구분하기 위한 메모를 입력하세요...
예: 1차 대화, 친구 루트, 연인 루트 등">${currentMemo}</textarea>
                    <small style="display: block; margin-top: 8px; color: #777;">
                        같은 캐릭터의 여러 채팅을 구분하는 데 도움이 됩니다.
                    </small>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    ${currentMemo ? '<button class="hl-modal-btn hl-modal-delete">삭제</button>' : ''}
                    <button class="hl-modal-btn hl-modal-save">저장</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    const $textarea = $('.hl-note-textarea');
    $textarea.focus();

    // 저장 버튼
    $('.hl-modal-save').on('click', function () {
        const newMemo = $textarea.val().trim();
        if (!settings.chatMemos) settings.chatMemos = {};

        if (newMemo) {
            settings.chatMemos[memoKey] = newMemo;
        } else {
            delete settings.chatMemos[memoKey];
        }

        saveSettingsDebounced();
        renderView();
        $('#chat-memo-modal').remove();
        toastr.success('메모 저장됨');
    });

    // 삭제 버튼
    $('.hl-modal-delete').on('click', function () {
        if (confirm('메모를 삭제하시겠습니까?')) {
            if (settings.chatMemos) {
                delete settings.chatMemos[memoKey];
            }
            saveSettingsDebounced();
            renderView();
            $('#chat-memo-modal').remove();
            toastr.info('메모 삭제됨');
        }
    });

    // 닫기/취소 버튼
    const closeChatMemoModal = function () {
        const newMemo = $textarea.val().trim();
        const hasChanges = newMemo !== currentMemo;

        if (hasChanges && newMemo.length > 0) {
            if (confirm('메모를 취소하시겠습니까?\n저장되지 않은 변경사항이 사라집니다.')) {
                $('#chat-memo-modal').remove();
            }
        } else {
            $('#chat-memo-modal').remove();
        }
    };

    $('.hl-modal-close, .hl-modal-cancel').on('click', closeChatMemoModal);

    // 모달 밖 클릭 시 닫기
    $('.hl-modal-overlay').on('click', function (e) {
        if (e.target === this) {
            closeChatMemoModal();
        }
    });
}

function renderChatList($container, characterId) {
    // 기존 내용 초기화
    $container.empty();

    const chats = settings.highlights[characterId];
    let chatFiles = Object.keys(chats).filter(chatFile => chats[chatFile].highlights.length > 0);

    if (chatFiles.length === 0) {
        $container.html(`
            <div class="hl-empty">
                <div class="hl-empty-icon"><i class="fa-solid fa-message"></i></div>
                <div class="hl-empty-text">형광펜이 없습니다</div>
            </div>
        `);
        return;
    }

    // 정렬
    const sortOption = settings.sortOptions?.chats || 'modified';
    if (sortOption === 'name') {
        // 이름순 (가나다)
        chatFiles.sort((a, b) => a.localeCompare(b, 'ko-KR'));
    } else {
        // 최근 수정순
        chatFiles.sort((a, b) => {
            const lastModifiedA = chats[a].lastModified || 0;
            const lastModifiedB = chats[b].lastModified || 0;
            return lastModifiedB - lastModifiedA; // 최신이 위로
        });
    }

    chatFiles.forEach(chatFile => {
        const chatData = chats[chatFile];
        const count = chatData.highlights.length;
        // timestamp 기준 최신 형광펜 찾기 (배열 순서가 아닌 실제 생성 시간 기준)
        const latest = chatData.highlights.reduce((prev, current) => {
            return (current.timestamp > prev.timestamp) ? current : prev;
        });
        const preview = latest ? latest.text.substring(0, 50) + (latest.text.length > 50 ? '...' : '') : '';
        const memoKey = `${characterId}_${chatFile}`;
        const memo = settings.chatMemos?.[memoKey] || '';
        const memoDisplay = memo ? `<span class="hl-memo">${memo}</span>` : '';

        const item = `
            <div class="hl-list-item" data-chat-file="${chatFile}">
                <div class="hl-chat-icon">
                    <i class="fa-solid fa-message"></i>
                </div>
                <div class="hl-info">
                    <div class="hl-name">${chatFile}</div>
                    <div class="hl-count-row">
                        <span class="hl-count">${count}개</span>
                        ${memoDisplay}
                    </div>
                    <div class="hl-preview">${preview}</div>
                </div>
                <button class="hl-memo-edit-btn" data-char-id="${characterId}" data-chat-file="${chatFile}" title="메모 편집">
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <i class="fa-solid fa-chevron-right hl-chevron"></i>
            </div>
        `;
        $container.append(item);
    });

    // 클릭 이벤트 바인딩 (중복 방지) - 컨테이너 내 아이템만 선택
    $container.find('.hl-list-item').off('click').on('click', function (e) {
        // 메모 편집 버튼 클릭 시 이벤트 전파 방지
        if ($(e.target).closest('.hl-memo-edit-btn').length > 0) {
            return;
        }
        navigateToHighlightList(selectedCharacter, $(this).data('chatFile'));
    });

    // 메모 편집 버튼 이벤트 바인딩
    $container.find('.hl-memo-edit-btn').off('click').on('click', function (e) {
        e.stopPropagation();
        const charId = $(this).data('charId');
        const chatFile = $(this).data('chatFile');
        openChatMemoEditor(charId, chatFile);
    });
}

function renderHighlightList($container, characterId, chatFile, activeTab) {
    // 기존 내용 초기화
    $container.empty();

    const highlights = settings.highlights[characterId]?.[chatFile]?.highlights || [];

    let filtered = activeTab === 'notes' ?
        highlights.filter(h => h.note && h.note.trim()) :
        highlights;

    if (filtered.length === 0) {
        const msg = activeTab === 'notes' ? '메모가 없습니다' : '형광펜이 없습니다';
        $container.html(`
            <div class="hl-empty">
                <div class="hl-empty-icon"><i class="fa-solid fa-highlighter"></i></div>
                <div class="hl-empty-text">${msg}</div>
            </div>
        `);
        return;
    }

    // 정렬
    const sortOption = settings.sortOptions?.highlights || 'created';
    if (sortOption === 'message') {
        // 채팅순 (위→아래)
        filtered.sort((a, b) => {
            // 메시지 ID로 먼저 정렬
            if (a.mesId !== b.mesId) {
                return a.mesId - b.mesId;
            }
            // 같은 메시지 내에서는 텍스트 위치 순서대로
            if (a.textOffset !== undefined && b.textOffset !== undefined) {
                return a.textOffset - b.textOffset;
            }
            // textOffset이 없으면 timestamp로 폴백 (하위 호환성)
            return (a.timestamp || 0) - (b.timestamp || 0);
        });
    } else {
        // 최근 생성순 (최신이 위로)
        filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    filtered.forEach(hl => {
        const date = new Date(hl.timestamp).toLocaleDateString('ko-KR');
        // ⭐ 수정: 저장된 라벨이 있으면 사용, 없으면 현재 chat으로부터 가져오기 (하위 호환성)
        const label = hl.label || getMessageLabel(hl.mesId);

        const item = `
            <div class="hl-highlight-item" style="--highlight-color: ${hl.color}" data-mes-id="${hl.mesId}" data-hl-id="${hl.id}">
                <div class="hl-content">
                    <div class="hl-text">${hl.text}</div>
                    ${hl.note ? `<div class="hl-note"><i class="fa-solid fa-note-sticky"></i><span>${hl.note}</span></div>` : ''}
                    <div class="hl-meta">
                        <span>${label}</span>
                        <span>|</span>
                        <span>${date}</span>
                    </div>
                </div>
                <div class="hl-actions">
                    <button class="hl-more-btn hl-item-more-btn" data-mes-id="${hl.mesId}" data-hl-id="${hl.id}" title="더보기">⋮</button>
                </div>
            </div>
        `;
        $container.append(item);
    });

    // 하이라이트 텍스트 클릭 시 이동 - 중복 방지
    $('.hl-highlight-item .hl-text').off('click').on('click', function(e) {
        const $item = $(this).closest('.hl-highlight-item');
        const mesId = $item.data('mesId');
        const hlId = $item.data('hlId');
        jumpToMessage(mesId, hlId);
    });

    // more 버튼 클릭 시 메뉴 표시 - 중복 방지
    $('.hl-item-more-btn').off('click').on('click', function (e) {
        e.stopPropagation(); // 아이템 클릭 이벤트 방지
        showHighlightItemMoreMenu(e);
    });
}

function getMessageLabel(mesId) {
    // mesId는 DOM의 mesid 속성값과 동일함 (chat 배열의 인덱스)
    const message = chat[mesId];
    if (!message) return `메시지#${mesId}`;

    let name = '';
    if (message.is_system) {
        return '시스템';
    } else if (message.is_user) {
        name = message.name || '나';
    } else {
        name = message.name || getCharacterName(this_chid);
    }

    return `${name}#${mesId}`;
}

// ⭐ 모바일 터치 이벤트 안정화를 위한 변수
let touchSelectionTimer = null;
let lastTouchEnd = 0;

function enableHighlightMode() {
    // 이벤트 위임 방식으로 변경 - 동적으로 로드되는 메시지에도 작동
    $(document).off('mouseup.hl touchend.hl', '.mes_text').on('mouseup.hl touchend.hl', '.mes_text', function (e) {
        const element = this;

        // 모바일 터치 이벤트의 경우 약간의 딜레이 추가
        const isTouchEvent = e.type === 'touchend';

        // ⭐ 터치 이벤트 중복 방지 - 같은 터치가 여러 번 발생하는 것 방지
        if (isTouchEvent) {
            const now = Date.now();
            if (now - lastTouchEnd < 300) {
                // 300ms 이내 중복 터치는 무시
                return;
            }
            lastTouchEnd = now;

            // 기존 타이머 제거
            if (touchSelectionTimer) {
                clearTimeout(touchSelectionTimer);
                touchSelectionTimer = null;
            }
        }

        const delay = isTouchEvent ? 150 : 0;

        const processSelection = () => {
            try {
                const sel = window.getSelection();

                // ⭐ 안전장치: range가 없는 경우 처리
                if (!sel || sel.rangeCount === 0) {
                    return;
                }

                let text = sel.toString();

                // 앞뒤 빈줄 제거
                const originalText = text;
                text = text.trim();

                // 선택된 텍스트가 없으면 종료 (단순 클릭)
                if (text.length === 0) {
                    // 하이라이트 요소 클릭 시 컨텍스트 메뉴는 별도 이벤트에서 처리
                    return;
                }

                // ⭐ 텍스트가 너무 짧으면(1자 이하) 무시 (오터치 방지)
                if (text.length < 2 && isTouchEvent) {
                    return;
                }

                // 선택된 텍스트가 있으면 색상 메뉴 표시 (하이라이트 영역 포함해도 OK)

                const range = sel.getRangeAt(0);

                // 터치 이벤트와 마우스 이벤트 모두 지원
                // ⭐ 안전장치: 좌표가 없는 경우 기본값 설정
                let pageX = e.pageX || (e.originalEvent?.changedTouches?.[0]?.pageX) || e.clientX;
                let pageY = e.pageY || (e.originalEvent?.changedTouches?.[0]?.pageY) || e.clientY;

                // 좌표가 여전히 없으면 range 중앙 사용
                if (!pageX || !pageY) {
                    const rangeRect = range.getBoundingClientRect();
                    pageX = rangeRect.left + rangeRect.width / 2 + window.scrollX;
                    pageY = rangeRect.bottom + window.scrollY;
                }

                // trim으로 인해 범위가 변경된 경우 range 조정
                if (originalText !== text) {
                    const startOffset = originalText.indexOf(text);
                    const newRange = document.createRange();

                    try {
                        const startNode = range.startContainer;
                        const endNode = range.endContainer;

                        newRange.setStart(startNode, range.startOffset + startOffset);
                        newRange.setEnd(endNode, range.startOffset + startOffset + text.length);

                        showColorMenu(pageX, pageY, text, newRange, element);
                    } catch (err) {
                        showColorMenu(pageX, pageY, text, range, element);
                    }
                } else {
                    showColorMenu(pageX, pageY, text, range, element);
                }
            } catch (error) {
                console.warn('[SillyTavern-Highlighter] Error processing selection:', error);
            }
        };

        if (isTouchEvent) {
            // ⭐ 모바일: 타이머로 안정화
            touchSelectionTimer = setTimeout(processSelection, delay);
        } else {
            // 데스크탑: 즉시 실행
            setTimeout(processSelection, delay);
        }
    });
}

function disableHighlightMode() {
    $(document).off('mouseup.hl touchend.hl', '.mes_text');

    // ⭐ 대기 중인 터치 타이머 제거
    if (touchSelectionTimer) {
        clearTimeout(touchSelectionTimer);
        touchSelectionTimer = null;
    }
}

// 전역 변수: document click 핸들러 추적
let colorMenuDocClickHandler = null;

function showColorMenu(x, y, text, range, el) {
    // 기존 메뉴와 이벤트 제거
    removeColorMenu();

    const colors = getColors();
    const colorButtons = colors.map(c =>
        `<button class="hl-color-btn" data-color="${c.bg}" style="background: ${c.bg}"></button>`
    ).join('');

    // 선택된 텍스트의 위치 가져오기
    const rangeRect = range.getBoundingClientRect();

    // 커서 위치를 그대로 사용 (X축)
    let menuX = x;
    let menuY = y;

    // Y축: 텍스트 바로 아래로 조정 (텍스트 가리지 않도록)
    menuY = rangeRect.bottom + window.scrollY + 5;

    const menu = `
        <div id="highlight-color-menu" style="left: ${menuX}px; top: ${menuY}px;">
            ${colorButtons}
        </div>
    `;

    $('body').append(menu);

    // 화면 밖으로 나가지 않도록 위치 조정
    const $menu = $('#highlight-color-menu');
    const rect = $menu[0].getBoundingClientRect(); // viewport 좌표계

    // ⭐ page 좌표계를 viewport 좌표계로 변환
    let viewportX = menuX - window.scrollX;
    let viewportY = menuY - window.scrollY;

    const margin = window.innerWidth <= 768 ? 20 : 10;
    const bottomMargin = window.innerWidth <= 768 ? 80 : 60; // 하단은 더 넓게

    // 오른쪽 경계 확인 (viewport 좌표계)
    if (viewportX + rect.width > window.innerWidth - margin) {
        viewportX = window.innerWidth - rect.width - margin;
    }

    // 왼쪽 경계 확인 (viewport 좌표계)
    if (viewportX < margin) {
        viewportX = margin;
    }

    // 하단 경계 확인 - 텍스트 위쪽으로 이동 (viewport 좌표계)
    const viewportTextTop = rangeRect.top; // rangeRect는 이미 viewport 좌표계

    if (viewportY + rect.height > window.innerHeight - bottomMargin) {
        viewportY = viewportTextTop - rect.height - 5;
    }

    // 상단 경계 확인 (viewport 좌표계)
    if (viewportY < margin) {
        viewportY = margin;
    }

    // ⭐ viewport 좌표계를 다시 page 좌표계로 변환하여 적용
    const adjustedX = viewportX + window.scrollX;
    const adjustedY = viewportY + window.scrollY;

    $menu.css({ left: adjustedX + 'px', top: adjustedY + 'px' });

    $('.hl-color-btn').off('click').on('click', function (e) {
        e.stopPropagation();
        createHighlight(text, $(this).data('color'), range, el);
        removeColorMenu();
    });

    // document click 이벤트 등록 (추적 가능하도록)
    colorMenuDocClickHandler = function(e) {
        if (!$(e.target).closest('#highlight-color-menu').length) {
            removeColorMenu();
        }
    };

    setTimeout(() => {
        $(document).on('click.colorMenu', colorMenuDocClickHandler);
    }, 100);
}

function removeColorMenu() {
    $('#highlight-color-menu').remove();
    if (colorMenuDocClickHandler) {
        $(document).off('click.colorMenu', colorMenuDocClickHandler);
        colorMenuDocClickHandler = null;
    }
}

// 메시지 내에서 텍스트의 시작 위치(offset) 계산
function calculateTextOffset(mesElement, range) {
    const walker = document.createTreeWalker(
        mesElement,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    let offset = 0;
    let node;

    while (node = walker.nextNode()) {
        if (node === range.startContainer) {
            return offset + range.startOffset;
        }
        offset += node.textContent.length;
    }

    return 0;
}

function createHighlight(text, color, range, el) {
    const $mes = $(el).closest('.mes');
    const mesId = getMesId($mes);
    const chatFile = getCurrentChatFile();
    const charId = this_chid;

    if (!chatFile || !charId) {
        toastr.error('채팅 정보를 가져올 수 없습니다');
        return;
    }

    const hlId = 'hl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // 텍스트 시작 위치 계산
    const textOffset = calculateTextOffset(el, range);

    // range에서 줄바꿈을 보존하면서 텍스트 추출
    const clonedContents = range.cloneContents();

    // 임시 div에 넣어서 HTML 구조 확인
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(clonedContents);

    // ⭐ 이미지, style, script, 코드 블록 등 불필요한 요소 제거
    const unwantedSelectors = [
        // 미디어 및 코드
        'img', 'style', 'script', 'pre', 'code',
        'svg', 'canvas', 'video', 'audio', 'iframe',
        'object', 'embed', 'picture', 'source',
        // 커스텀 렌더링 컨테이너 (확장/플러그인)
        '.TH-render',              // TavernHelper HTML 렌더링
        '.custom-imageWrapper',    // 커스텀 이미지 래퍼
        '.custom-characterImage',  // 캐릭터 이미지
        '[class*="-render"]',      // 다양한 렌더러 클래스
        '[class*="code-block"]'    // 코드 블록 관련
    ];
    unwantedSelectors.forEach(selector => {
        tempDiv.querySelectorAll(selector).forEach(el => el.remove());
    });

    // innerHTML에서 br과 블록 요소를 줄바꿈으로 변환
    let htmlText = tempDiv.innerHTML;

    // p 태그의 닫는 태그를 문단 구분(줄바꿈 2번)으로 변환
    htmlText = htmlText.replace(/<\/p>/gi, '\n\n');

    // br 태그와 그 뒤의 공백/줄바꿈을 단순 줄바꿈 1개로 변환
    htmlText = htmlText.replace(/<br\s*\/?>\s*/gi, '\n');

    // 다른 블록 요소의 닫는 태그를 단순 줄바꿈으로 변환
    htmlText = htmlText.replace(/<\/(div|li|h[1-6])>/gi, '\n');

    // 모든 HTML 태그 제거
    const textDiv = document.createElement('div');
    textDiv.innerHTML = htmlText;
    let actualText = textDiv.textContent || textDiv.innerText || '';

    // 연속된 줄바꿈 3개 이상을 2개로 정리 (문단 구분 최대화)
    actualText = actualText.replace(/\n{3,}/g, '\n\n');

    // 앞뒤 공백 제거
    actualText = actualText.trim();

    // ⭐ 텍스트가 너무 짧거나 비어있으면 경고
    if (actualText.length === 0) {
        toastr.warning('텍스트만 선택해주세요 (이미지나 HTML 코드는 제외됩니다)');
        return;
    }

    try {
        // 단일 노드인 경우
        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
            const span = document.createElement('span');
            span.className = 'text-highlight';
            span.setAttribute('data-hl-id', hlId);
            span.setAttribute('data-color', color);
            span.style.backgroundColor = getBackgroundColorFromHex(color);
            range.surroundContents(span);

            // 이벤트는 위임으로 처리되므로 여기서는 바인딩 불필요
        } else {
            // 여러 노드에 걸친 경우 - 각 텍스트 노드마다 span 생성
            const fragment = range.cloneContents();
            const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT, null, false);
            const textNodes = [];

            while (walker.nextNode()) {
                if (walker.currentNode.textContent.trim()) {
                    textNodes.push(walker.currentNode);
                }
            }

            // 원본 DOM에서 텍스트 노드 찾아서 span으로 감싸기
            const originalWalker = document.createTreeWalker(
                range.commonAncestorContainer,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );

            const nodesToWrap = [];
            while (originalWalker.nextNode()) {
                const node = originalWalker.currentNode;
                if (range.intersectsNode(node) && node.textContent.trim()) {
                    nodesToWrap.push(node);
                }
            }

            nodesToWrap.forEach((node) => {
                const span = document.createElement('span');
                span.className = 'text-highlight';
                span.setAttribute('data-hl-id', hlId);
                span.setAttribute('data-color', color);
                span.style.backgroundColor = getBackgroundColorFromHex(color);

                const nodeRange = document.createRange();
                nodeRange.selectNodeContents(node);

                // 시작/끝 노드인 경우 오프셋 조정
                if (node === range.startContainer) {
                    nodeRange.setStart(node, range.startOffset);
                }
                if (node === range.endContainer) {
                    nodeRange.setEnd(node, range.endOffset);
                }

                try {
                    nodeRange.surroundContents(span);
                    // 이벤트는 위임으로 처리되므로 여기서는 바인딩 불필요
                } catch (e) {
                    console.warn('[SillyTavern-Highlighter] Failed to wrap node:', e);
                }
            });
        }
    } catch (e) {
        console.error('[SillyTavern-Highlighter] Failed to create highlight:', e);
        toastr.error('형광펜 생성 실패');
        return;
    }

    // actualText 사용 (TreeWalker로 추출한 텍스트)
    // ⭐ 수정: 현재 메시지 라벨도 함께 저장
    saveHighlight(charId, chatFile, {
        id: hlId,
        mesId: mesId,
        swipeId: getCurrentSwipeId(mesId), // 스와이프 ID 저장
        text: actualText,
        color: color,
        colorIndex: getColorIndex(color), // 색상 인덱스 저장 (프리셋 전환 시 정확한 매핑)
        note: '',
        label: getMessageLabel(mesId), // 라벨 저장
        timestamp: Date.now(),
        textOffset: textOffset // 텍스트 시작 위치
    });

    toastr.success('형광펜 추가');

    if ($('#highlighter-panel').hasClass('visible')) {
        renderView();
    }

    // 드래그 해제 - 약간의 딜레이를 줘서 다음 드래그 이벤트가 정상 작동하도록 함
    setTimeout(() => {
        window.getSelection().removeAllRanges();
    }, 50);
}

function getMesId($mes) {
    const index = $mes.attr('mesid');
    if (index !== undefined) return parseInt(index);

    const mes = chat[$mes.index('.mes')];
    return mes?.mes_id || $mes.index('.mes');
}

function getCurrentSwipeId(mesId) {
    const message = chat[mesId];
    if (!message) return 0;

    // swipe_id가 현재 표시 중인 스와이프의 인덱스
    return message.swipe_id || 0;
}

// 16진수 색상 코드를 투명도가 적용된 rgba로 변환
function getBackgroundColorFromHex(hex) {
    const colors = getColors();
    const colorConfig = colors.find(c => c.bg === hex);

    if (colorConfig) {
        return hexToRgba(colorConfig.bg, colorConfig.opacity);
    }

    // 기본값
    return hexToRgba('#FFE4B5', 0.8);
}

function showHighlightContextMenu(hlId, x, y) {
    const result = findHighlightById(hlId);
    if (!result) {
        console.warn('[SillyTavern-Highlighter] Highlight not found:', hlId);
        return;
    }

    const hl = result.highlight;

    $('#highlight-context-menu').remove();

    if (!x) {
        const $el = $(`.text-highlight[data-hl-id="${hlId}"]`);
        if ($el.length) {
            const rect = $el[0].getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.bottom + 5;
        } else {
            x = window.innerWidth / 2;
            y = window.innerHeight / 2;
        }
    }

    const menu = `
        <div id="highlight-context-menu" class="${getDarkModeClass()}" style="left: ${x}px; top: ${y}px;" data-hl-id="${hlId}" data-char-id="${result.charId}" data-chat-file="${result.chatFile}">
            <button class="hl-context-btn" data-action="color">
                <div class="hl-context-color-preview" style="background: ${hl.color}"></div>
                <span>색상 변경</span>
            </button>
            <button class="hl-context-btn" data-action="note">
                <i class="fa-solid fa-pen"></i>
                <span>메모 ${hl.note ? '수정' : '입력'}</span>
            </button>
            <button class="hl-context-btn" data-action="copy">
                <i class="fa-solid fa-copy"></i>
                <span>복사</span>
            </button>
            <button class="hl-context-btn hl-context-delete" data-action="delete">
                <i class="fa-solid fa-trash"></i>
                <span>삭제</span>
            </button>
        </div>
    `;

    $('body').append(menu);

    const $menu = $('#highlight-context-menu');
    const rect = $menu[0].getBoundingClientRect();

    // 메뉴의 좌측 상단이 커서 위치에 오도록 설정
    let finalX = x;
    let finalY = y;

    const margin = window.innerWidth <= 768 ? 20 : 10;

    // 좌우 경계 확인
    if (finalX < margin) finalX = margin;
    if (finalX + rect.width > window.innerWidth - margin) {
        finalX = window.innerWidth - rect.width - margin;
    }

    // 상하 경계 확인 - 공간이 부족하면 위에 표시
    if (finalY + rect.height > window.innerHeight - margin) {
        finalY = y - rect.height;
    }
    if (finalY < margin) finalY = margin;

    $menu.css({ left: finalX + 'px', top: finalY + 'px' });

    $('.hl-context-btn').off('click').on('click', function (e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const $menu = $('#highlight-context-menu');
        const menuHlId = $menu.data('hlId');
        const menuCharId = $menu.data('charId');
        const menuChatFile = $menu.data('chatFile');

        switch (action) {
            case 'color':
                showColorChangeMenu(menuHlId, menuCharId, menuChatFile);
                break;
            case 'note':
                showNoteModal(menuHlId, menuCharId, menuChatFile);
                $('#highlight-context-menu').remove();
                break;
            case 'copy':
                showCopyModal(menuHlId, menuCharId, menuChatFile);
                $('#highlight-context-menu').remove();
                break;
            case 'delete':
                deleteHighlight(menuHlId, menuCharId, menuChatFile);
                $('#highlight-context-menu').remove();
                break;
        }
    });

    // 우클릭 방지
    $menu.on('contextmenu', function(e) {
        e.preventDefault();
    });

    setTimeout(() => $(document).one('click', () => $('#highlight-context-menu').remove()), 100);
}

function showColorChangeMenu(hlId, charId, chatFile) {
    const $menu = $('#highlight-context-menu');

    if ($menu.find('.hl-context-colors').length) {
        $menu.find('.hl-context-colors').remove();
        return;
    }

    const colors = getColors();
    const colorButtons = colors.map(c =>
        `<button class="hl-context-color-btn" data-color="${c.bg}" style="background: ${c.bg}"></button>`
    ).join('');

    const colorsHtml = `
        <div class="hl-context-colors">
            ${colorButtons}
        </div>
    `;

    $menu.find('[data-action="color"]').after(colorsHtml);

    $('.hl-context-color-btn').off('click').on('click', function (e) {
        e.stopPropagation();
        changeHighlightColor(hlId, $(this).data('color'), charId, chatFile);
        $('#highlight-context-menu').remove();
    });
}

function changeHighlightColor(hlId, color, charId, chatFile) {
    const result = findHighlightById(hlId);
    if (!result) return;

    const hl = result.highlight;
    hl.color = color;
    $(`.text-highlight[data-hl-id="${hlId}"]`).attr('data-color', color).css('background-color', getBackgroundColorFromHex(color));

    saveSettingsDebounced();

    if ($('#highlighter-panel').hasClass('visible')) renderView();

    toastr.success('색상 변경됨');
}

function showNoteModal(hlId, charId, chatFile) {
    const result = findHighlightById(hlId);
    if (!result) return;

    const hl = result.highlight;

    $('#highlight-note-modal').remove();

    const modal = `
        <div id="highlight-note-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>메모 ${hl.note ? '수정' : '입력'}</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <textarea class="hl-note-textarea" placeholder="메모를 입력하세요...">${hl.note || ''}</textarea>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    <button class="hl-modal-btn hl-modal-save">저장</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    const $textarea = $('.hl-note-textarea');
    const originalNote = hl.note || '';
    $textarea.focus();

    // 저장 버튼
    $('.hl-modal-save').on('click', function () {
        hl.note = $textarea.val();
        saveSettingsDebounced();

        if ($('#highlighter-panel').hasClass('visible')) renderView();

        $('#highlight-note-modal').remove();
        toastr.success('메모 저장됨');
    });

    // 닫기/취소 버튼 - 변경사항 확인
    const closeNoteModal = function () {
        const currentNote = $textarea.val();
        const hasChanges = currentNote !== originalNote;

        if (hasChanges && currentNote.trim().length > 0) {
            // 변경사항이 있으면 확인
            if (confirm('메모를 취소하시겠습니까?\n저장되지 않은 변경사항이 사라집니다.')) {
                $('#highlight-note-modal').remove();
            }
        } else {
            // 변경사항이 없거나 빈 메모면 바로 닫기
            $('#highlight-note-modal').remove();
        }
    };

    $('.hl-modal-close, .hl-modal-cancel').on('click', closeNoteModal);

    // 모달 밖 클릭 시 닫기
    $('.hl-modal-overlay').on('click', function (e) {
        if (e.target === this) {
            closeNoteModal();
        }
    });
}

function showCopyModal(hlId, charId, chatFile) {
    const result = findHighlightById(hlId);
    if (!result) return;

    const hl = result.highlight;
    const text = hl.note ? `${hl.text}\n\n메모: ${hl.note}` : hl.text;

    $('#highlight-copy-modal').remove();

    const modal = `
        <div id="highlight-copy-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>텍스트 복사</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <textarea class="hl-copy-textarea" readonly>${text}</textarea>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-select">전체 선택</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-select').on('click', function () {
        $('.hl-copy-textarea').select();
    });

    $('.hl-modal-close, .hl-modal-overlay').on('click', function (e) {
        if (e.target === this) $('#highlight-copy-modal').remove();
    });

    setTimeout(() => $('.hl-copy-textarea').select(), 100);
}

function saveHighlight(charId, chatFile, hlData) {
    if (!settings.highlights[charId]) settings.highlights[charId] = {};
    if (!settings.highlights[charId][chatFile]) {
        settings.highlights[charId][chatFile] = {
            lastModified: Date.now(),
            highlights: []
        };
    }

    settings.highlights[charId][chatFile].highlights.push(hlData);
    settings.highlights[charId][chatFile].lastModified = Date.now();

    saveSettingsDebounced();
}

function deleteHighlight(hlId, charId, chatFile) {
    const result = findHighlightById(hlId);
    if (!result) return;

    const hl = result.highlight;
    const hlCharId = charId || result.charId;
    const hlChatFile = chatFile || result.chatFile;

    // 모달 생성
    $('#highlight-delete-modal').remove();

    const isDark = settings.darkMode;
    const textColor = isDark ? '#e0e0e0' : '#222';
    const bgColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    const noteColor = isDark ? '#b0b0b0' : '#666';

    const modal = `
        <div id="highlight-delete-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>형광펜 삭제</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <p style="margin: 0; padding: 10px; background: ${bgColor}; border-radius: 8px; line-height: 1.6; color: ${textColor} !important;">
                        <strong style="color: ${textColor} !important;">삭제할 형광펜:</strong><br>
                        ${hl.text.substring(0, 100)}${hl.text.length > 100 ? '...' : ''}
                    </p>
                    ${hl.note ? `<p style="margin-top: 10px; color: ${noteColor} !important;"><strong style="color: ${textColor} !important;">메모:</strong> ${hl.note}</p>` : ''}
                    <p style="margin-top: 15px; color: #e74c3c !important; font-weight: 500;">정말로 삭제하시겠습니까?</p>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    <button class="hl-modal-btn hl-modal-delete" style="background: #e74c3c; color: white;">삭제</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-delete').on('click', function() {
        const chatData = settings.highlights[hlCharId]?.[hlChatFile];
        if (!chatData) return;

        chatData.highlights = chatData.highlights.filter(h => h.id !== hlId);
        chatData.lastModified = Date.now();

        $(`.text-highlight[data-hl-id="${hlId}"]`).contents().unwrap();

        saveSettingsDebounced();

        if ($('#highlighter-panel').hasClass('visible')) renderView();

        $('#highlight-delete-modal').remove();
        toastr.success('삭제됨');
    });

    $('.hl-modal-close, .hl-modal-cancel').on('click', function() {
        $('#highlight-delete-modal').remove();
    });

    $('.hl-modal-overlay').on('click', function(e) {
        if (e.target === this) $(this).remove();
    });
}

function deleteCharacterHighlights() {
    const charName = getCharacterName(selectedCharacter);
    const totalCount = getTotalHighlightsForCharacter(selectedCharacter);

    // 모달 생성
    $('#highlight-delete-all-modal').remove();

    const isDark = settings.darkMode;
    const textColor = isDark ? '#e0e0e0' : '#222';
    const secondaryColor = isDark ? '#b0b0b0' : '#666';
    const warningBg = isDark ? 'rgba(231, 76, 60, 0.2)' : 'rgba(231, 76, 60, 0.1)';
    const warningBorder = isDark ? 'rgba(231, 76, 60, 0.4)' : 'rgba(231, 76, 60, 0.3)';

    const modal = `
        <div id="highlight-delete-all-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>캐릭터 형광펜 전체 삭제</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <p style="margin: 0; padding: 15px; background: ${warningBg}; border-radius: 8px; line-height: 1.6; border: 1px solid ${warningBorder}; color: ${textColor} !important;">
                        <i class="fa-solid fa-exclamation-triangle" style="color: #e74c3c; margin-right: 8px;"></i>
                        <strong style="color: #e74c3c !important;">${charName}</strong> 캐릭터의 모든 형광펜 <strong style="color: #e74c3c !important;">${totalCount}개</strong>가 삭제됩니다.
                    </p>
                    <p style="margin-top: 15px; color: ${secondaryColor} !important; text-align: center;">
                        이 작업은 되돌릴 수 없습니다.<br>정말로 삭제하시겠습니까?
                    </p>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    <button class="hl-modal-btn hl-modal-delete" style="background: #e74c3c; color: white;">전체 삭제</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-delete').on('click', function() {
        // DOM에서 하이라이트 제거
        const charHighlights = settings.highlights[selectedCharacter];
        if (charHighlights) {
            // 캐릭터의 모든 채팅에 대해 반복
            Object.values(charHighlights).forEach(chatData => {
                if (chatData && chatData.highlights) {
                    chatData.highlights.forEach(hl => {
                        const $highlights = $(`.text-highlight[data-hl-id="${hl.id}"]`);
                        $highlights.each(function() {
                            $(this).contents().unwrap();
                        });
                    });
                }
            });
        }

        delete settings.highlights[selectedCharacter];
        saveSettingsDebounced();

        navigateToCharacterList();
        $('#highlight-delete-all-modal').remove();
        toastr.success('캐릭터 형광펜 전체 삭제됨');
    });

    $('.hl-modal-close, .hl-modal-cancel').on('click', function() {
        $('#highlight-delete-all-modal').remove();
    });

    $('.hl-modal-overlay').on('click', function(e) {
        if (e.target === this) $(this).remove();
    });
}

function deleteChatHighlights() {
    const chatData = settings.highlights[selectedCharacter]?.[selectedChat];
    if (!chatData) return;

    const highlightCount = chatData.highlights.length;

    // 모달 생성
    $('#highlight-delete-chat-modal').remove();

    const isDark = settings.darkMode;
    const textColor = isDark ? '#e0e0e0' : '#222';
    const secondaryColor = isDark ? '#b0b0b0' : '#666';
    const warningBg = isDark ? 'rgba(231, 76, 60, 0.2)' : 'rgba(231, 76, 60, 0.1)';
    const warningBorder = isDark ? 'rgba(231, 76, 60, 0.4)' : 'rgba(231, 76, 60, 0.3)';

    const modal = `
        <div id="highlight-delete-chat-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>채팅 형광펜 전체 삭제</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <p style="margin: 0; padding: 15px; background: ${warningBg}; border-radius: 8px; line-height: 1.6; border: 1px solid ${warningBorder}; color: ${textColor} !important;">
                        <i class="fa-solid fa-exclamation-triangle" style="color: #e74c3c; margin-right: 8px;"></i>
                        <strong style="color: #e74c3c !important;">${selectedChat}</strong> 채팅의 모든 형광펜 <strong style="color: #e74c3c !important;">${highlightCount}개</strong>가 삭제됩니다.
                    </p>
                    <p style="margin-top: 15px; color: ${secondaryColor} !important; text-align: center;">
                        이 작업은 되돌릴 수 없습니다.<br>정말로 삭제하시겠습니까?
                    </p>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    <button class="hl-modal-btn hl-modal-delete" style="background: #e74c3c; color: white;">전체 삭제</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-delete').on('click', function() {
        // DOM에서 하이라이트 제거
        chatData.highlights.forEach(hl => {
            const $highlights = $(`.text-highlight[data-hl-id="${hl.id}"]`);
            $highlights.each(function() {
                $(this).contents().unwrap();
            });
        });

        delete settings.highlights[selectedCharacter][selectedChat];
        saveSettingsDebounced();

        navigateToChatList(selectedCharacter);
        $('#highlight-delete-chat-modal').remove();
        toastr.success('채팅 형광펜 전체 삭제됨');
    });

    $('.hl-modal-close, .hl-modal-cancel').on('click', function() {
        $('#highlight-delete-chat-modal').remove();
    });

    $('.hl-modal-overlay').on('click', function(e) {
        if (e.target === this) $(this).remove();
    });
}

async function jumpToMessage(mesId, hlId) {
    // 모바일에서 패널 닫기
    if (window.innerWidth <= 768) {
        closePanel();
    }

    // hlId로 하이라이트가 속한 캐릭터/채팅 찾기
    const result = hlId ? findHighlightById(hlId) : null;
    const targetCharId = result ? result.charId : selectedCharacter;
    const targetChatFile = result ? result.chatFile : selectedChat;

    const currentCharId = this_chid;
    const currentChatFile = getCurrentChatFile();

    // 타입 변환 (문자열로 통일)
    const targetCharIdStr = targetCharId !== null && targetCharId !== undefined ? String(targetCharId) : null;
    const currentCharIdStr = currentCharId !== null && currentCharId !== undefined ? String(currentCharId) : null;

    // 같은 캐릭터이고 같은 채팅인 경우 바로 점프 (불필요한 이동 방지)
    if (targetCharIdStr === currentCharIdStr && targetChatFile === currentChatFile) {
        jumpToMessageInternal(mesId, hlId);
        return;
    }

    // 캐릭터가 다른 경우 캐릭터 변경
    if (targetCharIdStr !== currentCharIdStr && targetCharId !== null) {
        const charName = getCharacterName(targetCharId);

        // 캐릭터가 삭제되었는지 확인
        if (charName === 'Unknown' || !characters[targetCharId]) {
            showDeletedChatAlert('character', charName || '알 수 없음', targetChatFile);
            return;
        }

        toastr.info(`${charName} 캐릭터로 이동 중...`);

        try {
            let success = false;

            // 방법 1: 다양한 선택자로 charId 버튼 찾기
            let $charButton = null;
            const selectors = [
                `.select_rm_characters[chid="${targetCharId}"]`,
                `.select_rm_characters[data-chid="${targetCharId}"]`,
                `#rm_button_selected_ch${targetCharId}`,
                `.character_select[chid="${targetCharId}"]`
            ];

            for (const selector of selectors) {
                $charButton = $(selector);
                if ($charButton.length > 0) {
                    console.log(`[SillyTavern-Highlighter] Found character button with selector: ${selector}`);
                    break;
                }
            }

            if ($charButton && $charButton.length > 0) {
                $charButton.trigger('click');
                await new Promise(resolve => setTimeout(resolve, 600));

                // 캐릭터 변경 확인
                if (String(this_chid) === targetCharIdStr) {
                    success = true;
                    console.log('[SillyTavern-Highlighter] Character changed successfully via button click');
                }
            }

            // 방법 2: SillyTavern 내부 API 직접 호출
            if (!success && typeof SillyTavern !== 'undefined') {
                try {
                    const context = SillyTavern.getContext();
                    if (context && typeof context.selectCharacterById === 'function') {
                        await context.selectCharacterById(String(targetCharId));
                        await new Promise(resolve => setTimeout(resolve, 600));

                        if (String(this_chid) === targetCharIdStr) {
                            success = true;
                            console.log('[SillyTavern-Highlighter] Character changed successfully via selectCharacterById');
                        }
                    }
                } catch (e) {
                    console.log('[SillyTavern-Highlighter] selectCharacterById failed:', e);
                }
            }

            // 방법 3: 폴백 - 슬래시 명령어 사용 (동일 이름 캐릭터는 구분 불가능)
            if (!success) {
                console.log('[SillyTavern-Highlighter] Falling back to /char command');

                // 동일 이름 캐릭터가 여러 개 있는지 확인
                const sameNameChars = Object.keys(characters).filter(id =>
                    characters[id]?.name === charName
                );

                if (sameNameChars.length > 1) {
                    // 동일 이름 캐릭터가 있을 경우, 사용자에게 수동 전환 안내
                    toastr.error(
                        `"${charName}" 이름의 캐릭터가 ${sameNameChars.length}개 있어 자동 이동이 불가능합니다.<br><br>` +
                        '<strong>해결 방법:</strong><br>' +
                        '1. 수동으로 올바른 캐릭터를 선택하세요<br>' +
                        '2. 형광펜을 다시 클릭하면 올바른 채팅으로 이동합니다<br>' +
                        '3. 또는 캐릭터 메모 기능을 사용하여 구분하세요',
                        '자동 이동 불가',
                        {
                            timeOut: 10000,
                            extendedTimeOut: 5000,
                            escapeHtml: false
                        }
                    );
                    return; // 이동 중단
                }

                // 동일 이름이 없으면 정상적으로 이동
                await executeSlashCommandsWithOptions(`/char ${charName}`);
                await new Promise(resolve => setTimeout(resolve, 600));

                if (String(this_chid) === targetCharIdStr) {
                    success = true;
                    console.log('[SillyTavern-Highlighter] Character changed successfully via /char command');
                }
            }

            if (!success) {
                throw new Error('캐릭터 변경이 완료되지 않았습니다');
            }
        } catch (error) {
            console.error('[SillyTavern-Highlighter] Character change error:', error);
            toastr.error('캐릭터 변경 실패: ' + error.message);
            return;
        }
    }

    // 채팅이 다른 경우 - 자동으로 채팅 전환
    if (targetChatFile && targetChatFile !== getCurrentChatFile()) {
        toastr.info(`${targetChatFile} 채팅으로 전환 중...`);

        try {
            const context = getContext();

            // SillyTavern API 가져오기
            const { openCharacterChat, openGroupChat } = SillyTavern.getContext();

            // 그룹 채팅인 경우
            if (context.groupId && typeof openGroupChat === 'function') {
                await openGroupChat(context.groupId, targetChatFile);
            }
            // 캐릭터 채팅인 경우
            else if (context.characterId !== undefined && typeof openCharacterChat === 'function') {
                await openCharacterChat(targetChatFile);
            }
            else {
                throw new Error('채팅 전환 API를 사용할 수 없습니다');
            }

            // 채팅 전환 대기
            await new Promise(resolve => setTimeout(resolve, 400));

            // 전환 성공 확인
            if (getCurrentChatFile() === targetChatFile) {
                jumpToMessageInternal(mesId, hlId);
                return;
            } else {
                throw new Error('채팅 전환이 완료되지 않았습니다');
            }
        } catch (error) {
            console.error('[SillyTavern-Highlighter] Chat switch error:', error);
            toastr.warning(
                `다른 채팅의 형광펜입니다.<br>` +
                `<strong>${targetChatFile}</strong> 채팅으로 수동으로 전환한 후<br>` +
                `다시 시도해주세요.`,
                '채팅 전환 실패',
                {
                    timeOut: 8000,
                    extendedTimeOut: 3000,
                    escapeHtml: false
                }
            );
            return;
        }
    }

    // 같은 캐릭터/채팅인 경우 바로 점프
    jumpToMessageInternal(mesId, hlId);
}


function showDeletedChatAlert(type, charName, chatFile) {
    $('#highlight-deleted-alert-modal').remove();

    const title = type === 'character' ? '캐릭터가 삭제되었습니다' : '채팅이 삭제되었습니다';
    const message = type === 'character'
        ? `<p>이 형광펜이 속한 캐릭터 <strong>"${charName}"</strong>가 삭제되었거나 찾을 수 없습니다.</p>
           <p>형광펜은 독서노트 패널에 보관되어 있으며, 원하시면 삭제할 수 있습니다.</p>`
        : `<p>이 형광펜이 속한 채팅 <strong>"${chatFile}"</strong>이 삭제되었거나 찾을 수 없습니다.</p>
           <p>형광펜은 독서노트 패널에 보관되어 있으며, 원하시면 삭제할 수 있습니다.</p>`;

    const modal = `
        <div id="highlight-deleted-alert-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}" style="max-width: 500px;">
                <div class="hl-modal-header">
                    <h3><i class="fa-solid fa-triangle-exclamation" style="color: #ff9800;"></i> ${title}</h3>
                    <button class="hl-modal-close"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="hl-modal-body">
                    ${message}
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-confirm">확인</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-close, .hl-modal-confirm').on('click', function() {
        $('#highlight-deleted-alert-modal').remove();
    });

    $('.hl-modal-overlay').on('click', function (e) {
        if (e.target === this) $(this).remove();
    });
}

async function jumpToMessageInternal(mesId, hlId) {
    const $mes = $(`.mes[mesid="${mesId}"]`);

    if ($mes.length) {
        // hlId가 있으면 먼저 하이라이트 데이터 검증
        if (hlId) {
            const result = findHighlightById(hlId);

            if (result) {
                const hlText = result.highlight.text;

                // ⭐ 이미지/HTML 제거 후 텍스트 추출 (createHighlight와 동일한 방식)
                const mesHtml = $mes.find('.mes_text').html();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = mesHtml;

                // 이미지, style, script 등 불필요한 요소 제거
                const unwantedSelectors = [
                    'img', 'style', 'script', 'svg', 'canvas', 'video', 'audio', 'iframe',
                    '.custom-imageWrapper', '.custom-characterImage',
                    '[class*="image"]', '[class*="media"]'
                ];
                unwantedSelectors.forEach(selector => {
                    tempDiv.querySelectorAll(selector).forEach(el => el.remove());
                });

                const mesText = tempDiv.textContent || tempDiv.innerText || '';

                // 줄바꿈 정규화 후 비교
                const normalizedHlText = hlText.replace(/\n+/g, ' ').trim();
                const normalizedMesText = mesText.replace(/\s+/g, ' ').trim();

                // 메시지에 하이라이트 텍스트가 존재하는지 확인
                if (!normalizedMesText.includes(normalizedHlText)) {
                    // 메시지가 변경되었거나 삭제됨
                    toastr.warning(
                        '이 형광펜이 저장된 메시지가 삭제되었거나 내용이 변경되었습니다.<br>' +
                        '형광펜을 삭제하는 것을 권장합니다.',
                        '형광펜 불일치',
                        {
                            timeOut: 8000,
                            extendedTimeOut: 3000,
                            escapeHtml: false
                        }
                    );

                    // 메시지로 이동은 하되 플래시 효과는 약하게
                    $mes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                    return;
                }
            }

            // 하이라이트가 유효한 경우 해당 하이라이트로 스크롤
            const $highlight = $mes.find(`.text-highlight[data-hl-id="${hlId}"]`).first();
            if ($highlight.length) {
                $highlight[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                $highlight.addClass('flash-highlight');
                setTimeout(() => $highlight.removeClass('flash-highlight'), 2000);
            } else {
                // 하이라이트를 찾지 못하면 메시지로 스크롤
                $mes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                $mes.addClass('flash-highlight');
                setTimeout(() => $mes.removeClass('flash-highlight'), 2000);
            }
        } else {
            $mes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
            $mes.addClass('flash-highlight');
            setTimeout(() => $mes.removeClass('flash-highlight'), 2000);
        }
        toastr.info('메시지로 이동');
    } else {
        // 메시지가 로드되지 않은 경우 /chat-jump 명령어 사용
        toastr.info('메시지를 불러오는 중...');

        try {
            // executeSlashCommandsWithOptions를 사용하여 명령어 실행
            await executeSlashCommandsWithOptions(`/chat-jump ${mesId}`);

            // 약간의 지연 후 스크롤 시도
            setTimeout(() => {
                const $retryMes = $(`.mes[mesid="${mesId}"]`);
                if ($retryMes.length) {
                    if (hlId) {
                        // 하이라이트 데이터 검증
                        const result = findHighlightById(hlId);

                        if (result) {
                            const hlText = result.highlight.text;

                            // ⭐ 이미지/HTML 제거 후 텍스트 추출 (createHighlight와 동일한 방식)
                            const mesHtml = $retryMes.find('.mes_text').html();
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = mesHtml;

                            // 이미지, style, script 등 불필요한 요소 제거
                            const unwantedSelectors = [
                                'img', 'style', 'script', 'svg', 'canvas', 'video', 'audio', 'iframe',
                                '.custom-imageWrapper', '.custom-characterImage',
                                '[class*="image"]', '[class*="media"]'
                            ];
                            unwantedSelectors.forEach(selector => {
                                tempDiv.querySelectorAll(selector).forEach(el => el.remove());
                            });

                            const mesText = tempDiv.textContent || tempDiv.innerText || '';

                            // 줄바꿈 정규화 후 비교
                            const normalizedHlText = hlText.replace(/\n+/g, ' ').trim();
                            const normalizedMesText = mesText.replace(/\s+/g, ' ').trim();

                            // 메시지에 하이라이트 텍스트가 존재하는지 확인
                            if (!normalizedMesText.includes(normalizedHlText)) {
                                toastr.warning(
                                    '이 형광펜이 저장된 메시지가 삭제되었거나 내용이 변경되었습니다.<br>' +
                                    '형광펜을 삭제하는 것을 권장합니다.',
                                    '형광펜 불일치',
                                    {
                                        timeOut: 8000,
                                        extendedTimeOut: 3000,
                                        escapeHtml: false
                                    }
                                );
                                $retryMes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                                return;
                            }
                        }

                        const $highlight = $retryMes.find(`.text-highlight[data-hl-id="${hlId}"]`).first();
                        if ($highlight.length) {
                            $highlight[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                            $highlight.addClass('flash-highlight');
                            setTimeout(() => $highlight.removeClass('flash-highlight'), 2000);
                        } else {
                            $retryMes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                            $retryMes.addClass('flash-highlight');
                            setTimeout(() => $retryMes.removeClass('flash-highlight'), 2000);
                        }
                    } else {
                        $retryMes[0].scrollIntoView({ behavior: 'auto', block: 'center' });
                        $retryMes.addClass('flash-highlight');
                        setTimeout(() => $retryMes.removeClass('flash-highlight'), 2000);
                    }
                    toastr.info('메시지로 이동');
                } else {
                    toastr.warning('메시지를 찾을 수 없습니다');
                }
            }, 1000);
        } catch (error) {
            console.error('[SillyTavern-Highlighter] Jump error:', error);
            toastr.error('/chat-jump 명령어 실패: ' + error.message);
        }
    }
}

function showBackupModal() {
    $('#highlight-backup-modal').remove();

    const modal = `
        <div id="highlight-backup-modal" class="hl-modal-overlay">
            <div class="hl-modal ${getDarkModeClass()}">
                <div class="hl-modal-header">
                    <h3>형광펜 백업</h3>
                    <button class="hl-modal-close">&times;</button>
                </div>
                <div class="hl-modal-body">
                    <div style="margin-bottom: 20px;">
                        <label class="hl-modal-label-title">파일 형식:</label>
                        <label class="hl-modal-label-option">
                            <input type="radio" name="backup-format" value="json" checked style="margin-right: 8px;">
                            JSON (복원 가능)
                        </label>
                        <label class="hl-modal-label-option">
                            <input type="radio" name="backup-format" value="txt" style="margin-right: 8px;">
                            TXT (감상용, 복원 불가)
                        </label>
                    </div>
                    <div>
                        <label class="hl-modal-label-title">백업 범위:</label>
                        <label class="hl-modal-label-option">
                            <input type="radio" name="backup-scope" value="all" checked style="margin-right: 8px;">
                            전체
                        </label>
                        <label class="hl-modal-label-option">
                            <input type="radio" name="backup-scope" value="character" ${!selectedCharacter ? 'disabled' : ''} style="margin-right: 8px;">
                            현재 캐릭터만 ${!selectedCharacter ? '(선택된 캐릭터 없음)' : ''}
                        </label>
                        <label class="hl-modal-label-option">
                            <input type="radio" name="backup-scope" value="chat" ${!selectedChat ? 'disabled' : ''} style="margin-right: 8px;">
                            현재 채팅만 ${!selectedChat ? '(선택된 채팅 없음)' : ''}
                        </label>
                    </div>
                </div>
                <div class="hl-modal-footer">
                    <button class="hl-modal-btn hl-modal-cancel">취소</button>
                    <button class="hl-modal-btn hl-modal-save">백업하기</button>
                </div>
            </div>
        </div>
    `;

    $('body').append(modal);

    $('.hl-modal-save').on('click', function() {
        const format = $('input[name="backup-format"]:checked').val();
        const scope = $('input[name="backup-scope"]:checked').val();

        if (format === 'json') {
            exportHighlightsJSON(scope);
        } else {
            exportHighlightsTXT(scope);
        }

        $('#highlight-backup-modal').remove();
    });

    $('.hl-modal-close, .hl-modal-cancel').on('click', function() {
        $('#highlight-backup-modal').remove();
    });

    $('.hl-modal-overlay').on('click', function(e) {
        if (e.target === this) $(this).remove();
    });
}

function exportHighlightsJSON(scope) {
    let dataToExport = {};
    let scopeName = '전체';

    if (scope === 'all') {
        dataToExport = settings.highlights;
        scopeName = '전체';
    } else if (scope === 'character' && selectedCharacter) {
        dataToExport[selectedCharacter] = settings.highlights[selectedCharacter];
        scopeName = getCharacterName(selectedCharacter);
    } else if (scope === 'chat' && selectedCharacter && selectedChat) {
        dataToExport[selectedCharacter] = {
            [selectedChat]: settings.highlights[selectedCharacter]?.[selectedChat]
        };
        scopeName = `${getCharacterName(selectedCharacter)}_${selectedChat}`;
    }

    const data = {
        version: '1.0.0',
        exportDate: Date.now(),
        scope: scope,
        highlights: dataToExport
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const a = document.createElement('a');
    a.href = url;
    a.download = `highlights_${scopeName}_${timestamp}.json`;
    a.click();

    URL.revokeObjectURL(url);
    toastr.success('JSON 백업 완료');
}

function exportHighlightsTXT(scope) {
    let content = '';
    const now = new Date();
    const dateStr = now.toLocaleString('ko-KR');

    let scopeName = '전체';
    let totalHighlights = 0;
    let totalCharacters = 0;
    let totalChats = 0;

    // 헤더
    content += '===========================================\n';
    content += '독서노트 형광펜 모음\n';
    content += `생성일: ${dateStr}\n`;

    // 데이터 수집
    let dataToExport = {};

    if (scope === 'all') {
        dataToExport = settings.highlights;
        scopeName = '전체';
    } else if (scope === 'character' && selectedCharacter) {
        dataToExport[selectedCharacter] = settings.highlights[selectedCharacter];
        scopeName = getCharacterName(selectedCharacter);
    } else if (scope === 'chat' && selectedCharacter && selectedChat) {
        dataToExport[selectedCharacter] = {
            [selectedChat]: settings.highlights[selectedCharacter]?.[selectedChat]
        };
        scopeName = `${getCharacterName(selectedCharacter)} > ${selectedChat}`;
    }

    content += `범위: ${scopeName}\n`;
    content += '===========================================\n\n';

    // 하이라이트 내용
    let charIds = Object.keys(dataToExport);

    // 캐릭터 정렬
    const charSortOption = settings.sortOptions?.characters || 'modified';
    if (charSortOption === 'name') {
        charIds.sort((a, b) => {
            const nameA = getCharacterName(a);
            const nameB = getCharacterName(b);
            return nameA.localeCompare(nameB, 'ko-KR');
        });
    } else {
        charIds.sort((a, b) => {
            const chatsA = dataToExport[a];
            const chatsB = dataToExport[b];
            const lastModifiedA = Math.max(...Object.values(chatsA).map(c => c.lastModified || 0));
            const lastModifiedB = Math.max(...Object.values(chatsB).map(c => c.lastModified || 0));
            return lastModifiedB - lastModifiedA;
        });
    }

    charIds.forEach(charId => {
        const charName = getCharacterName(charId);
        const chatData = dataToExport[charId];

        if (!chatData) return;

        let charHasHighlights = false; // 캐릭터에 형광펜이 있는지 체크

        let chatFiles = Object.keys(chatData);

        // 채팅 정렬
        const chatSortOption = settings.sortOptions?.chats || 'modified';
        if (chatSortOption === 'name') {
            chatFiles.sort((a, b) => a.localeCompare(b, 'ko-KR'));
        } else {
            chatFiles.sort((a, b) => {
                const lastModifiedA = chatData[a].lastModified || 0;
                const lastModifiedB = chatData[b].lastModified || 0;
                return lastModifiedB - lastModifiedA;
            });
        }

        chatFiles.forEach(chatFile => {
            let highlights = chatData[chatFile]?.highlights || [];

            if (highlights.length === 0) return;

            if (!charHasHighlights) {
                charHasHighlights = true;
                totalCharacters++; // 이 캐릭터의 첫 형광펜 발견 시 카운트
            }

            totalChats++;

            // 하이라이트 정렬
            const hlSortOption = settings.sortOptions?.highlights || 'created';
            if (hlSortOption === 'message') {
                highlights = [...highlights].sort((a, b) => {
                    // 같은 메시지 내에서는 생성 시간 순서(텍스트 순서)대로
                    if (a.mesId !== b.mesId) {
                        return a.mesId - b.mesId;
                    }
                    return (a.timestamp || 0) - (b.timestamp || 0);
                });
            } else {
                highlights = [...highlights].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            }

            content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            content += `[${charName} > ${chatFile}]\n`;
            content += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

            highlights.forEach(hl => {
                totalHighlights++;

                const date = new Date(hl.timestamp).toLocaleDateString('ko-KR');
                const label = hl.label || `메시지#${hl.mesId}`;

                content += `▌ ${label} | ${date}\n`;
                content += `${hl.text}\n`;

                if (hl.note && hl.note.trim()) {
                    content += `\n📝 메모: ${hl.note}\n`;
                }

                content += '\n──────────────────────────────────────────\n\n';
            });

            content += '\n';
        });
    });

    // 푸터
    content += '===========================================\n';
    content += `총 형광펜: ${totalHighlights}개\n`;
    content += `총 캐릭터: ${totalCharacters}개\n`;
    content += `총 채팅: ${totalChats}개\n`;
    content += '===========================================\n';

    // 파일 다운로드
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const fileName = scopeName.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `highlights_${fileName}_${timestamp}.txt`;
    a.click();

    URL.revokeObjectURL(url);
    toastr.success('TXT 백업 완료');
}

// 기존 함수 호환성을 위해 유지
function exportHighlights() {
    showBackupModal();
}

function importHighlights(file) {
    const reader = new FileReader();

    reader.onload = function (e) {
        try {
            const data = JSON.parse(e.target.result);

            if (!data.version || !data.highlights) {
                throw new Error('잘못된 파일');
            }

            if (confirm('기존 데이터와 병합하시겠습니까?\n취소를 누르면 덮어씁니다.')) {
                settings.highlights = deepMerge(settings.highlights, data.highlights);
            } else {
                settings.highlights = data.highlights;
            }

            saveSettingsDebounced();
            renderView();

            // 채팅 내 하이라이트 복원 (약간의 딜레이로 확실하게)
            setTimeout(() => {
                restoreHighlightsInChat();
            }, 300);

            toastr.success('불러오기 완료');

        } catch (error) {
            toastr.error('파일 오류: ' + error.message);
        }
    };

    reader.readAsText(file);
    $('#hl-import-file-input').val('');
}

function getCurrentChatFile() {
    const context = getContext();
    return context.chatId || context.chat_metadata?.file_name || null;
}

function getCharacterName(charId) {
    return characters[charId]?.name || 'Unknown';
}

function getTotalHighlightsForCharacter(charId) {
    const chats = settings.highlights[charId];
    if (!chats) return 0;

    return Object.values(chats).reduce((total, chatData) => {
        return total + (chatData.highlights?.length || 0);
    }, 0);
}

function findHighlightById(hlId) {
    // 먼저 현재 선택된 캐릭터/채팅에서 찾기
    if (selectedCharacter && selectedChat) {
        const chatData = settings.highlights[selectedCharacter]?.[selectedChat];
        if (chatData) {
            const found = chatData.highlights.find(h => h.id === hlId);
            if (found) return { highlight: found, charId: selectedCharacter, chatFile: selectedChat };
        }
    }

    // 현재 열린 채팅에서 찾기
    const currentCharId = this_chid;
    const currentChatFile = getCurrentChatFile();

    if (currentCharId && currentChatFile) {
        const chatData = settings.highlights[currentCharId]?.[currentChatFile];
        if (chatData) {
            const found = chatData.highlights.find(h => h.id === hlId);
            if (found) return { highlight: found, charId: currentCharId, chatFile: currentChatFile };
        }
    }

    // 그래도 없으면 모든 캐릭터와 채팅을 검색
    for (const charId in settings.highlights) {
        for (const chatFile in settings.highlights[charId]) {
            const chatData = settings.highlights[charId][chatFile];
            if (chatData && chatData.highlights) {
                const found = chatData.highlights.find(h => h.id === hlId);
                if (found) {
                    return { highlight: found, charId: charId, chatFile: chatFile };
                }
            }
        }
    }

    return null;
}

function deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = deepMerge(result[key] || {}, source[key]);
            } else {
                result[key] = source[key];
            }
        }
    }

    return result;
}

function restoreHighlightsInChat() {
    const chatFile = getCurrentChatFile();
    const charId = this_chid;

    if (!chatFile || !charId) return;

    // ⭐ 현재 채팅 파일의 형광펜만 복원 (자동 복사 기능 제거됨)
    let currentChatHighlights = settings.highlights[charId]?.[chatFile]?.highlights || [];

    // ⭐ 화면에 하이라이트 표시
    const allHighlights = [...currentChatHighlights];

    allHighlights.forEach(hl => {
        const $mes = $(`.mes[mesid="${hl.mesId}"]`);
        if ($mes.length) {
            // 스와이프 ID 확인 - 현재 표시 중인 스와이프와 일치하는 경우만 하이라이트
            const currentSwipeId = getCurrentSwipeId(hl.mesId);
            const hlSwipeId = hl.swipeId !== undefined ? hl.swipeId : 0; // 하위 호환성

            if (currentSwipeId !== hlSwipeId) {
                return; // 다른 스와이프는 스킵
            }

            const $text = $mes.find('.mes_text');

            const content = $text.html();
            if (!content) return;

            // ⭐ 성능 최적화: 이미 하이라이트가 적용된 경우 스킵
            if ($text.find(`.text-highlight[data-hl-id="${hl.id}"]`).length > 0) {
                return;
            }

            // ⭐ 이미지/HTML 제거 후 텍스트 추출 (createHighlight와 동일한 방식)
            const mesHtml = $text.html();
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = mesHtml;

            // 이미지, style, script 등 불필요한 요소 제거
            const unwantedSelectors = [
                'img', 'style', 'script', 'svg', 'canvas', 'video', 'audio', 'iframe',
                '.custom-imageWrapper', '.custom-characterImage',
                '[class*="image"]', '[class*="media"]'
            ];
            unwantedSelectors.forEach(selector => {
                tempDiv.querySelectorAll(selector).forEach(el => el.remove());
            });

            const textContent = tempDiv.textContent || tempDiv.innerText || '';
            const normalizedHlText = hl.text.replace(/\n+/g, ' ').trim();
            const normalizedMesText = textContent.replace(/\s+/g, ' ').trim();

            // 정규화된 텍스트로 매칭 확인
            if (normalizedMesText.includes(normalizedHlText)) {
                try {
                    highlightTextInElement($text[0], hl.text, hl.id, hl.color);
                } catch (e) {
                    console.warn('[SillyTavern-Highlighter] Failed to restore highlight:', e);
                }
            }
        }
    });

    // 이벤트는 위임으로 처리되므로 여기서는 바인딩 불필요
}

// 여러 문단에 걸친 텍스트를 하이라이트하는 헬퍼 함수
function highlightTextInElement(element, searchText, hlId, color) {
    const bgColor = getBackgroundColorFromHex(color);

    // ⭐ 불필요한 요소 선택자
    const unwantedSelectors = [
        // 미디어 및 코드
        'img', 'style', 'script', 'pre', 'code',
        'svg', 'canvas', 'video', 'audio', 'iframe',
        'object', 'embed', 'picture', 'source',
        // 커스텀 렌더링 컨테이너 (확장/플러그인)
        '.TH-render',              // TavernHelper HTML 렌더링
        '.custom-imageWrapper',    // 커스텀 이미지 래퍼
        '.custom-characterImage',  // 캐릭터 이미지
        '[class*="-render"]',      // 다양한 렌더러 클래스
        '[class*="code-block"]'    // 코드 블록 관련
    ];

    const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );

    const textNodes = [];
    let fullText = '';

    while (walker.nextNode()) {
        // ⭐ 불필요한 요소의 자식 텍스트 노드는 제외
        let shouldSkip = false;
        let parent = walker.currentNode.parentElement;

        while (parent && parent !== element) {
            for (const selector of unwantedSelectors) {
                if (parent.matches && parent.matches(selector)) {
                    shouldSkip = true;
                    break;
                }
            }
            if (shouldSkip) break;
            parent = parent.parentElement;
        }

        if (!shouldSkip) {
            textNodes.push(walker.currentNode);
            fullText += walker.currentNode.textContent;
        }
    }

    // 줄바꿈 정규화 및 매핑 테이블 생성
    const normalizedSearchText = searchText.replace(/\s+/g, ' ').trim();
    let normalizedFullText = '';
    const indexMap = []; // normalizedFullText의 각 문자가 fullText의 어느 인덱스에 해당하는지

    let inWhitespace = false;
    for (let i = 0; i < fullText.length; i++) {
        const char = fullText[i];
        if (/\s/.test(char)) {
            if (!inWhitespace && normalizedFullText.length > 0) {
                normalizedFullText += ' ';
                indexMap.push(i);
                inWhitespace = true;
            }
        } else {
            normalizedFullText += char;
            indexMap.push(i);
            inWhitespace = false;
        }
    }
    normalizedFullText = normalizedFullText.trim();

    // 정규화된 텍스트에서 시작 위치 찾기
    const normalizedStartIndex = normalizedFullText.indexOf(normalizedSearchText);
    if (normalizedStartIndex === -1) return;

    const normalizedEndIndex = normalizedStartIndex + normalizedSearchText.length;

    // 매핑 테이블을 사용해 실제 인덱스 계산
    const startIndex = indexMap[normalizedStartIndex] || 0;
    const endIndex = indexMap[normalizedEndIndex - 1] + 1 || fullText.length;

    let currentIndex = 0;

    textNodes.forEach(node => {
        const nodeStart = currentIndex;
        const nodeEnd = currentIndex + node.textContent.length;

        if (nodeEnd <= startIndex || nodeStart >= endIndex) {
            currentIndex = nodeEnd;
            return; // 이 노드는 범위 밖
        }

        // 이 노드가 하이라이트 범위에 포함됨
        const overlapStart = Math.max(0, startIndex - nodeStart);
        const overlapEnd = Math.min(node.textContent.length, endIndex - nodeStart);

        if (overlapStart > 0 || overlapEnd < node.textContent.length) {
            // 노드를 분할해야 함
            const before = node.textContent.substring(0, overlapStart);
            const highlight = node.textContent.substring(overlapStart, overlapEnd);
            const after = node.textContent.substring(overlapEnd);

            const span = document.createElement('span');
            span.className = 'text-highlight';
            span.setAttribute('data-hl-id', hlId);
            span.setAttribute('data-color', color);
            span.style.backgroundColor = bgColor;
            span.textContent = highlight;

            const parent = node.parentNode;
            const fragment = document.createDocumentFragment();

            if (before) fragment.appendChild(document.createTextNode(before));
            fragment.appendChild(span);
            if (after) fragment.appendChild(document.createTextNode(after));

            parent.replaceChild(fragment, node);
        } else {
            // 노드 전체를 하이라이트
            const span = document.createElement('span');
            span.className = 'text-highlight';
            span.setAttribute('data-hl-id', hlId);
            span.setAttribute('data-color', color);
            span.style.backgroundColor = bgColor;
            span.textContent = node.textContent;

            node.parentNode.replaceChild(span, node);
        }

        currentIndex = nodeEnd;
    });
}

function onCharacterChange() {
    // 형광펜 모드가 활성화되어 있으면 비활성화 후 대기
    if (isHighlightMode) {
        disableHighlightMode();
    }

    // DOM 업데이트 대기 후 하이라이트 복원 및 형광펜 모드 재활성화
    setTimeout(() => {
        // 캐릭터 변경 시 이전 상태 업데이트
        previousCharId = this_chid;
        previousChatFile = getCurrentChatFile();
        previousChatLength = chat ? chat.length : 0;
        previousChatChangeTime = Date.now();

        // 현재 채팅의 첫/마지막 메시지 저장
        if (chat && chat.length >= 1) { // ⭐ 3 → 1
            previousChatMessages = {
                first3: chat.slice(0, 3).map(m => (m.mes || '').substring(0, 100)),
                last3: chat.slice(-3).map(m => (m.mes || '').substring(0, 100))
            };
        } else {
            previousChatMessages = null;
        }

        restoreHighlightsInChat();

        if (isHighlightMode) {
            enableHighlightMode();
        }
    }, 500);
}

function onChatChange() {
    // 형광펜 모드가 활성화되어 있으면 비활성화 후 대기
    if (isHighlightMode) {
        disableHighlightMode();
    }

    // DOM 업데이트 대기 후 하이라이트 복원 및 형광펜 모드 재활성화
    setTimeout(() => {
        // 채팅 제목 변경 감지 및 데이터 동기화
        const currentCharId = this_chid;
        const currentChatFile = getCurrentChatFile();
        const currentChatLength = chat ? chat.length : 0;
        const currentTime = Date.now();

        // ⭐⭐ 더 엄격한 채팅 제목 변경 감지
        // 1. 기본 조건: 같은 캐릭터, 같은 메시지 개수, 다른 파일 이름
        const basicCondition =
            previousCharId !== null &&
            currentCharId === previousCharId &&
            previousChatFile !== null &&
            currentChatFile !== null &&
            previousChatFile !== currentChatFile &&
            previousChatLength !== null &&
            currentChatLength === previousChatLength &&
            currentChatLength >= 1; // ⭐ 최소 1개 이상의 메시지 (3 → 1)

        let isChatRenamed = false;

        if (basicCondition) {
            // 2. 메시지 내용 비교: 첫 3개와 마지막 3개 메시지가 동일한가?
            let messagesMatch = false;

            if (chat && previousChatMessages) {
                const currentFirst3 = chat.slice(0, 3).map(m => (m.mes || '').substring(0, 100));
                const currentLast3 = chat.slice(-3).map(m => (m.mes || '').substring(0, 100));

                const prevFirst3 = previousChatMessages.first3;
                const prevLast3 = previousChatMessages.last3;

                // 모든 메시지가 일치하는지 확인
                const first3Match = currentFirst3.every((msg, i) => msg === prevFirst3[i]);
                const last3Match = currentLast3.every((msg, i) => msg === prevLast3[i]);

                messagesMatch = first3Match && last3Match;
            }

            if (messagesMatch) {
                // 3. 체크포인트/분기 키워드 체크
                const checkpointKeywords = ['branch', 'checkpoint', 'fork', 'split'];
                const isCheckpointOrBranch = checkpointKeywords.some(keyword =>
                    currentChatFile.toLowerCase().includes(keyword) &&
                    !previousChatFile.toLowerCase().includes(keyword)
                );

                if (!isCheckpointOrBranch) {
                    // 모든 조건을 만족: 진짜 채팅 제목 변경!
                    isChatRenamed = true;
                }
            }
        }

        if (isChatRenamed) {
            // ⭐ checkChatFileChanges에서 이미 처리했을 수 있으니 확인
            const alreadyMoved = !settings.highlights[currentCharId]?.[previousChatFile] &&
                                 settings.highlights[currentCharId]?.[currentChatFile];

            // 실제 채팅 제목 변경 - 데이터 이동
            if (settings.highlights[currentCharId]?.[previousChatFile]) {
                // 새 파일 이름에 데이터가 없는 경우에만 이동
                if (!settings.highlights[currentCharId][currentChatFile]) {
                    console.log(`[SillyTavern-Highlighter] Chat title changed (onChatChange): "${previousChatFile}" -> "${currentChatFile}"`);

                    // 형광펜 데이터를 새 키로 이동
                    settings.highlights[currentCharId][currentChatFile] = settings.highlights[currentCharId][previousChatFile];

                    // 이전 키 삭제
                    delete settings.highlights[currentCharId][previousChatFile];

                    // ⭐ 채팅 메모도 함께 이동
                    const oldMemoKey = `${currentCharId}_${previousChatFile}`;
                    const newMemoKey = `${currentCharId}_${currentChatFile}`;
                    if (settings.chatMemos?.[oldMemoKey]) {
                        if (!settings.chatMemos) settings.chatMemos = {};
                        settings.chatMemos[newMemoKey] = settings.chatMemos[oldMemoKey];
                        delete settings.chatMemos[oldMemoKey];
                        console.log(`[SillyTavern-Highlighter] Chat memo moved: "${oldMemoKey}" -> "${newMemoKey}"`);
                    }

                    // 저장
                    saveSettingsDebounced();

                    toastr.success('형광펜이 변경된 채팅 제목과 동기화되었습니다');
                }
            } else if (alreadyMoved) {
                // checkChatFileChanges에서 이미 처리됨, UI만 업데이트
                console.log(`[SillyTavern-Highlighter] Chat rename already processed, updating UI only`);
            }

            // ⭐ 데이터 이동 여부와 상관없이 UI는 업데이트
            // selectedChat 업데이트 (breadcrumb에서 사용)
            if (selectedChat === previousChatFile) {
                selectedChat = currentChatFile;
            }

            // 패널이 열려있으면 즉시 업데이트
            const $panel = $('#highlighter-panel');
            if ($panel.length > 0 && $panel.hasClass('visible')) {
                const $content = $('#highlighter-content');

                if (currentView === VIEW_LEVELS.CHARACTER_LIST) {
                    // 캐릭터 리스트 뷰 - 전체 리스트 새로고침
                    renderCharacterList($content);
                } else if (currentView === VIEW_LEVELS.CHAT_LIST) {
                    // 채팅 리스트 뷰 - 현재 캐릭터의 채팅 리스트만
                    renderChatList($content, currentCharId);
                } else if (currentView === VIEW_LEVELS.HIGHLIGHT_LIST) {
                    // 형광펜 리스트 뷰 - breadcrumb 업데이트 (채팅 제목 반영)
                    updateBreadcrumb();
                    // 형광펜 리스트도 다시 렌더링 (chatFile 기준)
                    renderHighlightList($content, currentCharId, currentChatFile);
                }
            }
        }

        // 현재 상태 저장 (다음 비교를 위해)
        previousCharId = currentCharId;
        previousChatFile = currentChatFile;
        previousChatLength = currentChatLength;
        previousChatChangeTime = currentTime;

        // 현재 채팅의 첫/마지막 메시지 저장
        if (chat && chat.length >= 1) { // ⭐ 3 → 1
            previousChatMessages = {
                first3: chat.slice(0, 3).map(m => (m.mes || '').substring(0, 100)),
                last3: chat.slice(-3).map(m => (m.mes || '').substring(0, 100))
            };
        } else {
            previousChatMessages = null;
        }

        restoreHighlightsInChat();

        if (isHighlightMode) {
            enableHighlightMode();
        }
    }, 500);
}

// 캐릭터 정보 캐시 (변경 감지용)
let characterCache = {};

// 채팅 파일명 변경 실시간 감지
function checkChatFileChanges() {
    // 현재 채팅이 있을 때만 체크
    const currentCharId = this_chid;
    const currentChatFile = getCurrentChatFile();

    if (!currentCharId || !currentChatFile) {
        return;
    }

    // 이전 정보와 비교
    if (previousChatFile !== null &&
        previousChatFile !== currentChatFile &&
        previousCharId === currentCharId) {

        // 채팅 파일이 변경되었음 (제목 변경 가능성)
        console.log(`[SillyTavern-Highlighter] Chat file changed detected: "${previousChatFile}" -> "${currentChatFile}"`);

        // onChatChange의 제목 변경 감지 로직을 강제로 트리거
        const currentChatLength = chat ? chat.length : 0;

        // 기본 조건 체크
        if (previousChatLength !== null &&
            currentChatLength === previousChatLength &&
            currentChatLength >= 1) { // ⭐ 3 → 1로 변경 (메시지 1개 이상이면 OK)

            // 메시지 내용 비교
            let messagesMatch = false;
            if (chat && previousChatMessages) {
                const currentFirst3 = chat.slice(0, 3).map(m => (m.mes || '').substring(0, 100));
                const currentLast3 = chat.slice(-3).map(m => (m.mes || '').substring(0, 100));
                const prevFirst3 = previousChatMessages.first3;
                const prevLast3 = previousChatMessages.last3;
                const first3Match = currentFirst3.every((msg, i) => msg === prevFirst3[i]);
                const last3Match = currentLast3.every((msg, i) => msg === prevLast3[i]);
                messagesMatch = first3Match && last3Match;
            }

            if (messagesMatch) {
                // 체크포인트/분기 키워드 체크
                const checkpointKeywords = ['branch', 'checkpoint', 'fork', 'split'];
                const isCheckpointOrBranch = checkpointKeywords.some(keyword =>
                    currentChatFile.toLowerCase().includes(keyword) &&
                    !previousChatFile.toLowerCase().includes(keyword)
                );

                if (!isCheckpointOrBranch) {
                    // 진짜 제목 변경 감지!
                    if (settings.highlights[currentCharId]?.[previousChatFile] &&
                        !settings.highlights[currentCharId][currentChatFile]) {

                        console.log(`[SillyTavern-Highlighter] Real-time chat title change detected!`);

                        // 형광펜 데이터 이동
                        settings.highlights[currentCharId][currentChatFile] = settings.highlights[currentCharId][previousChatFile];
                        delete settings.highlights[currentCharId][previousChatFile];

                        // 채팅 메모 이동
                        const oldMemoKey = `${currentCharId}_${previousChatFile}`;
                        const newMemoKey = `${currentCharId}_${currentChatFile}`;
                        if (settings.chatMemos?.[oldMemoKey]) {
                            if (!settings.chatMemos) settings.chatMemos = {};
                            settings.chatMemos[newMemoKey] = settings.chatMemos[oldMemoKey];
                            delete settings.chatMemos[oldMemoKey];
                        }

                        saveSettingsDebounced();
                        toastr.success('형광펜이 변경된 채팅 제목과 동기화되었습니다');

                        // ⭐ selectedChat 업데이트 (breadcrumb에서 사용)
                        if (selectedChat === previousChatFile) {
                            selectedChat = currentChatFile;
                        }

                        // 패널 업데이트
                        const $panel = $('#highlighter-panel');
                        if ($panel.length > 0 && $panel.hasClass('visible')) {
                            const $content = $('#highlighter-content');
                            if (currentView === VIEW_LEVELS.CHARACTER_LIST) {
                                renderCharacterList($content);
                            } else if (currentView === VIEW_LEVELS.CHAT_LIST) {
                                renderChatList($content, currentCharId);
                            } else if (currentView === VIEW_LEVELS.HIGHLIGHT_LIST) {
                                updateBreadcrumb();
                                // 형광펜 리스트도 다시 렌더링 (chatFile 기준)
                                renderHighlightList($content, currentCharId, currentChatFile);
                            }
                        }
                    }
                }
            }
        }

        // ⭐ 상태 업데이트 하지 않음 - onChatChange에서 처리
        // previousChatFile 등을 여기서 업데이트하면 onChatChange에서 감지 못함
    }
}

// 캐릭터 정보 변경 감지
function checkCharacterChanges() {
    // 패널이 열려있을 때만 체크
    if (!$('#highlighter-panel').hasClass('visible')) {
        return;
    }

    let hasChanges = false;

    // 현재 화면에 표시된 캐릭터들만 체크
    if (currentView === VIEW_LEVELS.CHARACTER_LIST) {
        // 캐릭터 리스트에 있는 모든 캐릭터 체크
        const charIds = Object.keys(settings.highlights);
        for (const charId of charIds) {
            const currentData = characters[charId];
            if (!currentData) continue;

            const cached = characterCache[charId];
            const currentHash = `${currentData.name}|${currentData.avatar}`;

            if (cached !== currentHash) {
                characterCache[charId] = currentHash;
                hasChanges = true;
            }
        }

        if (hasChanges) {
            const $content = $('#highlighter-content');
            renderCharacterList($content);
        }
    } else if (currentView === VIEW_LEVELS.CHAT_LIST || currentView === VIEW_LEVELS.HIGHLIGHT_LIST) {
        // breadcrumb의 캐릭터 이름만 체크
        if (selectedCharacter !== null) {
            const currentData = characters[selectedCharacter];
            if (currentData) {
                const cached = characterCache[selectedCharacter];
                const currentHash = `${currentData.name}|${currentData.avatar}`;

                if (cached !== currentHash) {
                    characterCache[selectedCharacter] = currentHash;
                    updateBreadcrumb();
                }
            }
        }
    }
}

// 캐릭터 정보 캐시 초기화
function initCharacterCache() {
    characterCache = {};
    const charIds = Object.keys(settings.highlights);
    for (const charId of charIds) {
        const charData = characters[charId];
        if (charData) {
            characterCache[charId] = `${charData.name}|${charData.avatar}`;
        }
    }
}

// 캐릭터 정보 수정 시 리스트 업데이트 (이벤트 기반 - 작동하면 사용)
function onCharacterEdited() {
    // 패널이 열려있을 때 현재 뷰 업데이트
    if ($('#highlighter-panel').hasClass('visible')) {
        // 캐릭터 리스트 뷰면 리스트 업데이트
        if (currentView === VIEW_LEVELS.CHARACTER_LIST) {
            const $content = $('#highlighter-content');
            renderCharacterList($content);
            initCharacterCache(); // 캐시 갱신
        }
        // 채팅 리스트나 하이라이트 리스트 뷰면 breadcrumb만 업데이트 (캐릭터 이름 변경 반영)
        else if (currentView === VIEW_LEVELS.CHAT_LIST || currentView === VIEW_LEVELS.HIGHLIGHT_LIST) {
            updateBreadcrumb();
            initCharacterCache(); // 캐시 갱신
        }
    }
}

function onChatDeleted(chatFile) {
    const charId = this_chid;

    if (settings.deleteMode === 'delete') {
        if (settings.highlights[charId]?.[chatFile]) {
            delete settings.highlights[charId][chatFile];
            toastr.info('형광펜 삭제됨');
            saveSettingsDebounced();
        }
    } else {
        toastr.info('형광펜 보관됨');
    }
}

// Breadcrumb More 메뉴 표시
function showHighlightItemMoreMenu(e) {
    e.stopPropagation();

    const $existingMenu = $('#hl-item-more-menu');
    if ($existingMenu.length) {
        $existingMenu.remove();
        return;
    }

    const $btn = $(e.currentTarget);
    const mesId = $btn.data('mesId');
    const hlId = $btn.data('hlId');
    const rect = $btn[0].getBoundingClientRect();

    const menuHtml = `
        <div id="hl-item-more-menu" class="hl-more-menu ${getDarkModeClass()}" data-mes-id="${mesId}" data-hl-id="${hlId}">
            <button class="hl-more-menu-item" data-action="copy">
                <i class="fa-solid fa-copy"></i>
                <span>복사</span>
            </button>
            <button class="hl-more-menu-item" data-action="edit">
                <i class="fa-solid fa-pen"></i>
                <span>메모 수정</span>
            </button>
            <button class="hl-more-menu-item" data-action="delete">
                <i class="fa-solid fa-trash"></i>
                <span>삭제</span>
            </button>
        </div>
    `;

    $('body').append(menuHtml);

    const $newMenu = $('#hl-item-more-menu');
    const $panel = $('#highlighter-panel');
    const panelRect = $panel[0].getBoundingClientRect();

    // 메뉴 실제 크기 측정
    const menuRect = $newMenu[0].getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;
    const margin = 10;

    // 기본 위치: 버튼 아래, 오른쪽 정렬
    let top = rect.bottom + 5;
    let left = rect.right - menuWidth;

    // 오른쪽으로 나가면 왼쪽으로
    if (left + menuWidth > panelRect.right - margin) {
        left = panelRect.right - menuWidth - margin;
    }
    // 왼쪽으로 나가면 오른쪽으로
    if (left < panelRect.left + margin) {
        left = panelRect.left + margin;
    }
    // 아래로 나가면 위로
    if (top + menuHeight > panelRect.bottom - margin) {
        top = rect.top - menuHeight - 5;
    }
    // 위로도 나가면 패널 상단에
    if (top < panelRect.top + margin) {
        top = panelRect.top + margin;
    }
    // 여전히 아래로 나가면 패널 하단에
    if (top + menuHeight > panelRect.bottom - margin) {
        top = panelRect.bottom - menuHeight - margin;
    }

    $newMenu.css({
        position: 'fixed',
        top: top + 'px',
        left: left + 'px',
        zIndex: 100002
    });

    // 이벤트 바인딩
    $newMenu.find('.hl-more-menu-item').off('click').on('click', function (e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const menuMesId = $newMenu.data('mesId');
        const menuHlId = $newMenu.data('hlId');

        switch (action) {
            case 'copy':
                showCopyModal(menuHlId);
                break;
            case 'edit':
                showNoteModal(menuHlId);
                break;
            case 'delete':
                deleteHighlight(menuHlId);
                break;
        }

        $newMenu.remove();
    });

    // 외부 클릭 시 닫기
    setTimeout(() => {
        $(document).one('click', () => $('#hl-item-more-menu').remove());
    }, 100);
}

function showBreadcrumbMoreMenu(e) {
    e.stopPropagation();

    const $existingMenu = $('#hl-breadcrumb-more-menu');
    if ($existingMenu.length) {
        $existingMenu.remove();
        return;
    }

    const $btn = $(e.currentTarget);
    const rect = $btn[0].getBoundingClientRect();

    let menuHtml = '';

    if (selectedChat) {
        // 하이라이트 목록 뷰
        menuHtml = `
            <div id="hl-breadcrumb-more-menu" class="hl-more-menu ${getDarkModeClass()}">
                <button class="hl-more-menu-item" data-action="delete-chat">
                    <i class="fa-solid fa-trash"></i>
                    <span>이 채팅의 모든 형광펜 삭제</span>
                </button>
            </div>
        `;
    } else if (selectedCharacter) {
        // 채팅 목록 뷰
        menuHtml = `
            <div id="hl-breadcrumb-more-menu" class="hl-more-menu ${getDarkModeClass()}">
                <button class="hl-more-menu-item" data-action="delete-character">
                    <i class="fa-solid fa-trash"></i>
                    <span>이 캐릭터의 모든 형광펜 삭제</span>
                </button>
            </div>
        `;
    }

    $('body').append(menuHtml);

    const $breadcrumbMenu = $('#hl-breadcrumb-more-menu');
    const $panel = $('#highlighter-panel');
    const panelRect = $panel[0].getBoundingClientRect();

    // 메뉴 실제 크기 측정
    const menuRect = $breadcrumbMenu[0].getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;
    const margin = 10;

    // 기본 위치: 버튼 아래, 오른쪽 정렬
    let top = rect.bottom + 5;
    let left = rect.right - menuWidth;

    // 오른쪽으로 나가면 왼쪽으로
    if (left + menuWidth > panelRect.right - margin) {
        left = panelRect.right - menuWidth - margin;
    }
    // 왼쪽으로 나가면 오른쪽으로
    if (left < panelRect.left + margin) {
        left = panelRect.left + margin;
    }
    // 아래로 나가면 위로
    if (top + menuHeight > panelRect.bottom - margin) {
        top = rect.top - menuHeight - 5;
    }
    // 위로도 나가면 패널 상단에
    if (top < panelRect.top + margin) {
        top = panelRect.top + margin;
    }
    // 여전히 아래로 나가면 패널 하단에
    if (top + menuHeight > panelRect.bottom - margin) {
        top = panelRect.bottom - menuHeight - margin;
    }

    $breadcrumbMenu.css({
        position: 'fixed',
        top: top + 'px',
        left: left + 'px',
        zIndex: 100002
    });

    // 이벤트 바인딩
    $('[data-action="delete-chat"]').on('click', function() {
        $('#hl-breadcrumb-more-menu').remove();
        deleteChatHighlights();
    });

    $('[data-action="delete-character"]').on('click', function() {
        $('#hl-breadcrumb-more-menu').remove();
        deleteCharacterHighlights();
    });

    // 외부 클릭 시 닫기
    setTimeout(() => {
        $(document).one('click', () => $('#hl-breadcrumb-more-menu').remove());
    }, 100);
}

// Header More 메뉴 표시
function showHeaderMoreMenu(e) {
    e.stopPropagation();

    const $existingMenu = $('#hl-header-more-menu');
    if ($existingMenu.length) {
        $existingMenu.remove();
        return;
    }

    const $btn = $(e.currentTarget);
    const rect = $btn[0].getBoundingClientRect();

    const menuHtml = `
        <div id="hl-header-more-menu" class="hl-more-menu ${getDarkModeClass()}">
            <button class="hl-more-menu-item" data-action="export">
                <i class="fa-solid fa-download"></i>
                <span>백업</span>
            </button>
            <button class="hl-more-menu-item" data-action="import">
                <i class="fa-solid fa-upload"></i>
                <span>불러오기</span>
            </button>
        </div>
    `;

    $('body').append(menuHtml);

    const $headerMenu = $('#hl-header-more-menu');
    const $panel = $('#highlighter-panel');
    const panelRect = $panel[0].getBoundingClientRect();

    // 메뉴 실제 크기 측정
    const menuRect = $headerMenu[0].getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;
    const margin = 10;

    // 기본 위치: 버튼 아래, 오른쪽 정렬
    let top = rect.bottom + 5;
    let left = rect.right - menuWidth;

    // 오른쪽으로 나가면 왼쪽으로
    if (left + menuWidth > panelRect.right - margin) {
        left = panelRect.right - menuWidth - margin;
    }
    // 왼쪽으로 나가면 오른쪽으로
    if (left < panelRect.left + margin) {
        left = panelRect.left + margin;
    }
    // 아래로 나가면 위로
    if (top + menuHeight > panelRect.bottom - margin) {
        top = rect.top - menuHeight - 5;
    }
    // 위로도 나가면 패널 상단에
    if (top < panelRect.top + margin) {
        top = panelRect.top + margin;
    }
    // 여전히 아래로 나가면 패널 하단에
    if (top + menuHeight > panelRect.bottom - margin) {
        top = panelRect.bottom - menuHeight - margin;
    }

    $headerMenu.css({
        position: 'fixed',
        top: top + 'px',
        left: left + 'px',
        zIndex: 100002
    });

    // 이벤트 바인딩
    $('[data-action="export"]').on('click', function() {
        $('#hl-header-more-menu').remove();
        exportHighlights();
    });

    $('[data-action="import"]').on('click', function() {
        $('#hl-header-more-menu').remove();
        $('#hl-import-file-input').click();
    });

    // 외부 클릭 시 닫기
    setTimeout(() => {
        $(document).one('click', () => $('#hl-header-more-menu').remove());
    }, 100);
}

// 과거 메시지 로딩 감지를 위한 MutationObserver 설정
function setupChatObserver() {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        console.warn('[SillyTavern-Highlighter] Chat container not found, retrying...');
        setTimeout(setupChatObserver, 1000);
        return;
    }

    const observer = new MutationObserver((mutations) => {
        let shouldRestore = false;

        mutations.forEach((mutation) => {
            // 새로운 메시지가 추가되었는지 확인
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach((node) => {
                    if (node.classList && node.classList.contains('mes')) {
                        shouldRestore = true;
                    }
                });
            }
        });

        // 새 메시지가 추가되면 하이라이트 복원
        if (shouldRestore) {
            setTimeout(() => {
                restoreHighlightsInChat();
            }, 300);
        }
    });

    observer.observe(chatContainer, {
        childList: true,
        subtree: true
    });

    console.log('[SillyTavern-Highlighter] Chat observer set up');
}

// ====================================
// 업데이트 체크 기능
// ====================================

// 버전 비교 함수 (semantic versioning)
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;

        if (p1 > p2) return 1;  // v1이 더 최신
        if (p1 < p2) return -1; // v2가 더 최신
    }

    return 0; // 같음
}

// GitHub에서 최신 버전 확인
async function checkForUpdates(forceCheck = false) {
    try {
        // 강제 체크가 아닌 경우에만 캐시 확인
        if (!forceCheck) {
            // 세션 캐시 확인 (같은 세션 내에서는 한 번만 체크)
            const sessionCached = sessionStorage.getItem(UPDATE_CHECK_CACHE_KEY);
            if (sessionCached) {
                const sessionData = JSON.parse(sessionCached);
                console.log('[SillyTavern-Highlighter] Using session cached update check');
                // ⭐ 캐시된 버전과 현재 버전 비교 (업데이트 후 캐시 무효화)
                const comparison = compareVersions(sessionData.latestVersion, EXTENSION_VERSION);
                return comparison > 0 ?
                    { version: sessionData.latestVersion, updateMessage: sessionData.updateMessage || '' } :
                    { version: null, updateMessage: sessionData.updateMessage || '' };
            }

            // localStorage 캐시 확인 (24시간마다만 체크)
            const cached = localStorage.getItem(UPDATE_CHECK_CACHE_KEY);
            if (cached) {
                const cacheData = JSON.parse(cached);
                const now = Date.now();

                if (now - cacheData.timestamp < UPDATE_CHECK_INTERVAL) {
                    console.log('[SillyTavern-Highlighter] Using localStorage cached update check');
                    // ⭐ 캐시된 버전과 현재 버전 비교 (업데이트 후 캐시 무효화)
                    const comparison = compareVersions(cacheData.latestVersion, EXTENSION_VERSION);
                    const hasUpdate = comparison > 0;
                    // sessionStorage에도 저장 (세션 내 중복 체크 방지)
                    sessionStorage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify(cacheData));
                    return hasUpdate ?
                        { version: cacheData.latestVersion, updateMessage: cacheData.updateMessage || '' } :
                        { version: null, updateMessage: cacheData.updateMessage || '' };
                }
            }
        }

        console.log('[SillyTavern-Highlighter] Checking for updates...');

        // GitHub raw URL로 manifest.json 가져오기 (master 브랜치만 사용)
        const timestamp = Date.now(); // 캐시 무효화용 타임스탬프
        const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/master/manifest.json?t=${timestamp}`;

        let remoteManifest = null;

        try {
            // 쿼리 파라미터로 캐시 우회하므로 헤더는 최소화 (CORS 오류 방지)
            const response = await fetch(url, {
                cache: 'no-store'
            });

            if (response.ok) {
                remoteManifest = await response.json();
            } else {
                console.warn(`[SillyTavern-Highlighter] Failed to fetch: HTTP ${response.status}`);
            }
        } catch (err) {
            console.warn(`[SillyTavern-Highlighter] Failed to fetch from ${url}:`, err);
        }

        if (!remoteManifest || !remoteManifest.version) {
            console.warn('[SillyTavern-Highlighter] Could not fetch remote version');
            return null;
        }

        const latestVersion = remoteManifest.version;
        const currentVersion = EXTENSION_VERSION;

        console.log(`[SillyTavern-Highlighter] Current: ${currentVersion}, Latest: ${latestVersion}`);

        const comparison = compareVersions(latestVersion, currentVersion);
        const hasUpdate = comparison > 0;

        // 캐시 데이터
        const cacheData = {
            timestamp: Date.now(),
            latestVersion: latestVersion,
            updateMessage: remoteManifest.updateMessage || '',
            hasUpdate: hasUpdate
        };

        // localStorage에 저장 (24시간 캐시)
        localStorage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify(cacheData));

        // sessionStorage에도 저장 (세션 내 중복 체크 방지)
        sessionStorage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify(cacheData));

        if (hasUpdate) {
            console.log(`[SillyTavern-Highlighter] ✨ Update available: ${latestVersion}`);
            return { version: latestVersion, updateMessage: remoteManifest.updateMessage || '' };
        } else {
            console.log('[SillyTavern-Highlighter] You are up to date!');
            return { version: null, updateMessage: remoteManifest.updateMessage || '' };
        }

    } catch (error) {
        console.warn('[SillyTavern-Highlighter] Update check failed:', error);
        return null; // 오류 시 조용히 실패
    }
}

// 업데이트 버전 저장 (DOM 준비 전에도 기억)
let pendingUpdateVersion = null;

// 업데이트 알림 표시
function showUpdateNotification(latestVersion) {
    try {
        // 버전 저장 (나중에 다시 시도하기 위해)
        pendingUpdateVersion = latestVersion;

        // settings.html의 헤더 찾기
        const $header = $('.highlighter-settings .inline-drawer-header b');

        if ($header.length) {
            // 이미 UPDATE 표시가 있으면 중복 방지
            if ($header.find('.hl-update-badge').length > 0) return;

            // UPDATE 배지 추가 (클릭 불가, 표시만)
            const badge = `<span class="hl-update-badge" style="
                display: inline-block;
                margin-left: 8px;
                padding: 2px 8px;
                background: linear-gradient(135deg, #ff6b6b, #ee5a6f);
                color: white;
                font-size: 11px;
                font-weight: 700;
                border-radius: 4px;
                animation: pulse 2s ease-in-out infinite;
                box-shadow: 0 2px 8px rgba(255, 107, 107, 0.3);
                vertical-align: middle;
            " title="새 버전 ${latestVersion} 사용 가능">UPDATE!</span>`;

            $header.append(badge);

            // CSS 애니메이션 추가
            if (!$('#hl-update-animation').length) {
                $('<style id="hl-update-animation">@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.8; transform: scale(1.05); } }</style>').appendTo('head');
            }

            console.log('[SillyTavern-Highlighter] Update notification displayed');

            // 사용자에게 토스트 알림
            toastr.info(`새 버전 ${latestVersion}이(가) 출시되었습니다!<br>설정 페이지에서 확인하세요.`, '형광펜 업데이트', {
                timeOut: 10000,
                extendedTimeOut: 5000,
                escapeHtml: false
            });

            pendingUpdateVersion = null; // 성공했으면 초기화
        } else {
            console.log('[SillyTavern-Highlighter] Settings panel not ready, will retry later');
        }
    } catch (error) {
        console.warn('[SillyTavern-Highlighter] Failed to show update notification:', error);
    }
}

(async function () {
    console.log('[SillyTavern-Highlighter] Loading...');

    const extensionFolderPath = await getExtensionFolderPath();

    // ⭐ manifest.json에서 버전 로드
    try {
        const manifestResponse = await fetch(`${extensionFolderPath}/manifest.json`);
        if (manifestResponse.ok) {
            const manifest = await manifestResponse.json();
            if (manifest.version) {
                EXTENSION_VERSION = manifest.version;
                console.log(`[SillyTavern-Highlighter] Version loaded from manifest: ${EXTENSION_VERSION}`);
            }
        }
    } catch (error) {
        console.warn('[SillyTavern-Highlighter] Could not load manifest.json, using default version');
    }

    // 설정 로드 및 초기화
    let loadedSettings = extension_settings[extensionName];

    if (!loadedSettings) {
        // 최초 실행: 기본 설정 사용
        console.log('[SillyTavern-Highlighter] First run, initializing with defaults');
        settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    } else {
        // 기존 데이터 존재: 검증 → 마이그레이션
        console.log('[SillyTavern-Highlighter] Loading existing data');
        settings = validateAndRepairSettings(loadedSettings);
        settings = migrateSettings(settings);
    }

    // extension_settings에 반영
    extension_settings[extensionName] = settings;

    // 마이그레이션이 발생했으면 저장 (버전 필드 업데이트)
    if (!loadedSettings || loadedSettings.version !== EXTENSION_VERSION) {
        console.log('[SillyTavern-Highlighter] Saving migrated data');
        saveSettingsDebounced();
    }

    createHighlighterUI();

    // 요술봉 메뉴에 버튼 추가 (항상 추가하되, 설정에 따라 표시/숨김)
    addToWandMenu();

    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(html);

        $('#hl_setting_delete_mode').val(settings.deleteMode).on('change', function () {
            settings.deleteMode = $(this).val();
            saveSettingsDebounced();
        });

        $('#hl_setting_button_position').val(settings.buttonPosition).on('change', function () {
            settings.buttonPosition = $(this).val();
            applyButtonPosition();
            saveSettingsDebounced();
        });

        $('#hl_setting_show_floating_btn').prop('checked', settings.showFloatingBtn !== false).on('change', function () {
            settings.showFloatingBtn = $(this).is(':checked');
            applyButtonPosition();
            saveSettingsDebounced();
        });

        $('#hl_setting_show_wand_button').prop('checked', settings.showWandButton !== false).on('change', function () {
            settings.showWandButton = $(this).is(':checked');

            // 요술봉 메뉴 버튼 표시/숨김
            updateWandMenuVisibility();

            if (settings.showWandButton) {
                toastr.success('요술봉 메뉴 버튼이 표시됩니다');
            } else {
                toastr.info('요술봉 메뉴 버튼이 숨겨집니다');
            }

            saveSettingsDebounced();
        });

        $('#hl_setting_always_highlight_mode').prop('checked', settings.alwaysHighlightMode || false).on('change', function () {
            settings.alwaysHighlightMode = $(this).is(':checked');

            // 항상 활성화를 체크하면 즉시 형광펜 모드 활성화
            if (settings.alwaysHighlightMode && !isHighlightMode) {
                isHighlightMode = true;
                $('#hl-floating-highlight-mode-btn').addClass('active');
                enableHighlightMode();
                toastr.info('형광펜 모드 활성화');

                // 요술봉 메뉴 상태 업데이트
                const $status = $('#highlighter_mode_status');
                if ($status.length) {
                    $status.text('(켜짐)');
                }
            }

            saveSettingsDebounced();
        });

        // 색상 커스터마이저 초기화
        initColorCustomizer();

        $('#hl-export-colors').on('click', exportColors);
        $('#hl-import-colors').on('click', () => $('#hl-color-import-input').click());
        $('#hl-color-import-input').on('change', importColors);

        // 업데이트 확인 버튼
        $('#hl-check-update-btn').on('click', async function() {
            const $btn = $(this);
            const $status = $('#hl-update-status');

            // 버튼 비활성화 및 로딩 표시
            $btn.prop('disabled', true);
            $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 확인 중...');
            $status.hide();

            try {
                // 캐시 강제 무시
                localStorage.removeItem(UPDATE_CHECK_CACHE_KEY);
                sessionStorage.removeItem(UPDATE_CHECK_CACHE_KEY);

                const updateInfo = await checkForUpdates(true); // 강제 체크

                if (updateInfo && updateInfo.version) {
                    // 업데이트 있음
                    const updateMessage = updateInfo.updateMessage ?
                        `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 107, 107, 0.2); font-size: 12px; color: #666;">
                            업데이트 예정 내용: ${updateInfo.updateMessage}
                        </div>` : '';

                    $status.css({
                        'background': 'rgba(255, 107, 107, 0.1)',
                        'border': '1px solid rgba(255, 107, 107, 0.3)',
                        'color': '#ff6b6b'
                    }).html(`
                        <i class="fa-solid fa-circle-exclamation" style="margin-right: 2px;"></i>
                        <strong>새 버전 ${updateInfo.version}이(가) 출시되었습니다!</strong><br>
                        <span style="font-size: 12px !important;">확장 프로그램 관리에서 업데이트할 수 있습니다.</span>
                        ${updateMessage}
                    `).show();

                    // 헤더에 UPDATE! 배지 표시
                    showUpdateNotification(updateInfo.version);
                } else {
                    // 최신 버전
                    $status.css({
                        'background': 'rgba(76, 175, 80, 0.1)',
                        'border': '1px solid rgba(76, 175, 80, 0.3)',
                        'color': '#4caf50'
                    }).html(`
                        <i class="fa-solid fa-circle-check" style="margin-right: 2px;"></i>
                        <strong>최신 버전을 사용 중입니다!</strong> (v${EXTENSION_VERSION})
                    `).show();
                }
            } catch (error) {
                console.error('[SillyTavern-Highlighter] Update check failed:', error);
                $status.css({
                    'background': 'rgba(255, 152, 0, 0.1)',
                    'border': '1px solid rgba(255, 152, 0, 0.3)',
                    'color': '#ff9800'
                }).html(`
                    <i class="fa-solid fa-circle-xmark"></i>
                    <strong>업데이트 확인 실패</strong><br>
                    <span style="font-size: 12px;">네트워크 연결을 확인해주세요.</span>
                `).show();
            } finally {
                // 버튼 복원
                $btn.prop('disabled', false);
                $btn.html('<i class="fa-solid fa-sync"></i> 업데이트 확인');
            }
        });

    } catch (error) {
        console.warn('[SillyTavern-Highlighter] Settings HTML load failed:', error);
    }

    // ⭐ Settings HTML 로드 완료 후, 대기 중인 업데이트 알림이 있으면 표시
    if (pendingUpdateVersion) {
        console.log('[SillyTavern-Highlighter] Showing pending update notification');
        showUpdateNotification(pendingUpdateVersion);
    }

    eventSource.on(event_types.CHARACTER_SELECTED, onCharacterChange);
    eventSource.on(event_types.CHAT_CHANGED, onChatChange);
    eventSource.on(event_types.MESSAGE_RECEIVED, restoreHighlightsInChat);
    eventSource.on(event_types.MESSAGE_SENT, restoreHighlightsInChat);
    eventSource.on(event_types.MESSAGE_UPDATED, restoreHighlightsInChat);
    eventSource.on(event_types.MESSAGE_SWIPED, restoreHighlightsInChat);
    eventSource.on(event_types.CHARACTER_EDITED, onCharacterEdited);

    // 과거 메시지 로딩 감지를 위한 MutationObserver 설정
    setupChatObserver();

    // 동적 색상 스타일 적용
    updateDynamicColorStyles();

    // 초기 상태 저장 (채팅 제목 변경 감지를 위해)
    previousCharId = this_chid;
    previousChatFile = getCurrentChatFile();
    previousChatLength = chat ? chat.length : 0;

    restoreHighlightsInChat();

    // 캐릭터 정보 캐시 초기화
    initCharacterCache();

    // 캐릭터 정보 변경 감지 타이머 (2초마다 체크)
    setInterval(checkCharacterChanges, 2000);

    // 채팅 파일명 변경 실시간 감지 타이머 (1초마다 체크)
    setInterval(checkChatFileChanges, 1000);

    // 항상 활성화 모드가 켜져 있으면 초기화 시 자동 활성화
    if (settings.alwaysHighlightMode) {
        setTimeout(() => {
            isHighlightMode = true;
            $('#hl-floating-highlight-mode-btn').addClass('active');
            enableHighlightMode();

            // 요술봉 메뉴 상태 업데이트
            const $status = $('#highlighter_mode_status');
            if ($status.length) {
                $status.text('(켜짐)');
            }

            console.log('[SillyTavern-Highlighter] Auto-enabled highlight mode (always on setting)');
        }, 500); // DOM이 준비될 때까지 약간의 딜레이
    }

    console.log('[SillyTavern-Highlighter] Loaded');

    // ⭐ 업데이트 체크 (비동기, 백그라운드 실행)
    setTimeout(async () => {
        try {
            const updateInfo = await checkForUpdates();
            if (updateInfo && updateInfo.version) {
                showUpdateNotification(updateInfo.version);
            }
        } catch (error) {
            console.warn('[SillyTavern-Highlighter] Update check failed silently:', error);
        }
    }, 2000); // 2초 후 실행 (다른 초기화 완료 후)
})();
