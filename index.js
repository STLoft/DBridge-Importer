/**
 * SillyTavern Extension — Discord Bridge Importer
 *
 * discord-bridge 봇의 채널 대화 기록을 골라서 현재 채팅의 원하는 위치에 넣는다.
 * - 기록 조회는 서버 플러그인 dbridge-history 가 담당 (/api/plugins/dbridge-history)
 * - 형식: 일반 텍스트 / 스타일 프리셋(메신저 느낌, CSS 저장 가능)
 * - 스타일 적용 시 AI에게는 mes(순수 텍스트)만, 화면에는 extra.display_text(HTML)가 보인다.
 * - ST에서 수정해도 수정된 mes 기준으로 display_text를 다시 만들어 스타일을 유지한다.
 * - 기존 대화 사이에 넣으면 앞뒤 메시지 시간 사이의 임의 시간으로 맞춘다.
 */

const MODULE = 'dbridge_importer';
const API = '/api/plugins/dbridge-history';
const STYLE_EL_ID = 'dbi_preset_styles';

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------------------
// 기본 프리셋. CSS는 프리셋 루트(.dbi-p-<id>) 안에 중첩(nesting)으로 들어간다.
// 루트 자체 스타일은 '&' 로, 안쪽 요소는 .dbi-row / .dbi-name / .dbi-bubble 등으로 지정.
// ---------------------------------------------------------------------------
const DEFAULT_PRESETS = [
    {
        id: 'kakao',
        name: '카톡 느낌',
        css: `& { background: #b2c7d9; padding: 10px 8px; border-radius: 12px; }
.dbi-date { text-align: center; font-size: .72em; color: #fff; background: rgba(0,0,0,.18); border-radius: 10px; padding: 2px 10px; width: fit-content; margin: 6px auto; }
.dbi-row { display: flex; flex-direction: column; align-items: flex-start; margin: 5px 0; }
.dbi-row.dbi-user { align-items: flex-end; }
.dbi-name { font-size: .75em; color: #2d3a45; margin: 0 4px 2px; }
.dbi-user .dbi-name { display: none; }
.dbi-line { display: flex; align-items: flex-end; gap: 4px; max-width: 85%; }
.dbi-user .dbi-line { flex-direction: row-reverse; }
.dbi-bubble { background: #fff; color: #111; padding: 6px 10px; border-radius: 4px 14px 14px 14px; line-height: 1.45; word-break: break-word; }
.dbi-user .dbi-bubble { background: #fee500; border-radius: 14px 4px 14px 14px; }
.dbi-time { font-size: .62em; color: #4a5866; white-space: nowrap; }
.dbi-line + .dbi-line { margin-top: 6px; }
.dbi-line + .dbi-line .dbi-bubble { border-radius: 14px; }`,
    },
    {
        id: 'discord',
        name: '디스코드 느낌',
        css: `& { background: #313338; color: #dbdee1; padding: 8px 12px; border-radius: 8px; }
.dbi-date { display: flex; align-items: center; gap: 8px; font-size: .7em; color: #949ba4; margin: 8px 0; }
.dbi-date::before, .dbi-date::after { content: ''; flex: 1; border-top: 1px solid #3f4147; }
.dbi-row { margin: 6px 0; }
.dbi-name { font-weight: 600; color: #f2a3c4; display: inline; margin-right: 6px; }
.dbi-user .dbi-name { color: #8fc6ff; }
.dbi-line { display: flex; flex-direction: column-reverse; }
.dbi-time { font-size: .7em; color: #949ba4; }
.dbi-bubble { line-height: 1.45; word-break: break-word; }`,
    },
    {
        id: 'imessage',
        name: '아이메시지 느낌',
        css: `& { background: #fff; padding: 10px; border-radius: 14px; }
.dbi-date { text-align: center; font-size: .7em; color: #8e8e93; margin: 6px 0; }
.dbi-row { display: flex; flex-direction: column; align-items: flex-start; margin: 3px 0; }
.dbi-row.dbi-user { align-items: flex-end; }
.dbi-name { display: none; }
.dbi-line { display: flex; flex-direction: column; max-width: 78%; }
.dbi-user .dbi-line { align-items: flex-end; }
.dbi-bubble { background: #e9e9eb; color: #000; padding: 7px 12px; border-radius: 18px; line-height: 1.4; word-break: break-word; }
.dbi-user .dbi-bubble { background: #0a84ff; color: #fff; }
.dbi-line + .dbi-line { margin-top: 4px; }
.dbi-time { display: none; }`,
    },
];

const DEFAULT_SETTINGS = {
    presets: DEFAULT_PRESETS,
    format: 'kakao',        // 'plain' 또는 프리셋 id
    unit: 'each',           // 'each' 메시지별 / 'bundle' 하나로 묶기
    split: 'line',          // 말풍선 나누기: 'line' 줄마다 / 'para' 빈 줄 기준 / 'none' 안 나눔
    nameMode: 'st',         // 'st' ST 이름 / 'discord' 디코 이름
    timeMode: 'auto',       // 'auto' 주변에 맞춤 / 'original' 디코 원래 시간
    bundleSender: 'char',   // 묶음 메시지를 보낸 쪽: 'char' | 'user'
    hideFromAI: false,
    showAllChannels: false,
};

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = structuredClone(DEFAULT_SETTINGS);
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (s[k] === undefined) s[k] = structuredClone(v);
    if (!Array.isArray(s.presets) || !s.presets.length) s.presets = structuredClone(DEFAULT_PRESETS);
    return s;
}
const save = () => ctx().saveSettingsDebounced();

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const fmtTime = (d) => `${d.getHours() < 12 ? '오전' : '오후'} ${((d.getHours() + 11) % 12) + 1}:${pad(d.getMinutes())}`;
const fmtShort = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDateLine = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const safeId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '');

async function api(pathname) {
    const resp = await fetch(API + pathname, { headers: ctx().getRequestHeaders() });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `${pathname} → ${resp.status}`);
    return data;
}

// ---------------------------------------------------------------------------
// send_date 파싱/포맷 — ST 버전마다 형식이 달라서 이웃 메시지 형식을 따라간다.
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseSendDate(v) {
    if (v === undefined || v === null || v === '') return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (/^\d{10,}$/.test(s)) return Number(s);
    // "September 21, 2026 3:05pm"
    let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (m) {
        const mon = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
        let h = Number(m[4]) % 12;
        if (m[6].toLowerCase() === 'pm') h += 12;
        if (mon >= 0) return new Date(Number(m[3]), mon, Number(m[2]), h, Number(m[5])).getTime();
    }
    // "2026-9-21 @15h 05m 12s 345ms" 류
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
}

function formatSendDate(ms, sample) {
    const d = new Date(ms);
    if (typeof sample === 'number') return Math.round(ms);
    const s = String(sample ?? '');
    if (/^\d{10,}$/.test(s)) return String(Math.round(ms));
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return d.toISOString();
    // 기본: ST 표준 표기
    const h = d.getHours();
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${((h + 11) % 12) + 1}:${pad(d.getMinutes())}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * 넣을 메시지들의 시간(ms)을 정한다.
 * @param {number[]} orig 디코 원래 시간들 (정렬됨)
 * @param {number} insertAt chat 배열에 끼워 넣을 인덱스
 */
function planTimes(orig, insertAt, mode) {
    const chat = ctx().chat;
    const n = orig.length;
    const origOk = orig.every((t) => !Number.isNaN(t));
    const fallbackOrig = origOk ? orig : orig.map((_, i) => Date.now() - (n - i) * 60000);
    if (mode === 'original') return fallbackOrig;

    const prev = parseSendDate(chat[insertAt - 1]?.send_date);
    const next = parseSendDate(chat[insertAt]?.send_date);
    const hasPrev = !Number.isNaN(prev);
    const hasNext = !Number.isNaN(next);

    if (hasPrev && hasNext && next > prev) {
        // 앞뒤 시간 사이의 임의 시간 (정렬해서 순서 유지)
        const span = next - prev;
        const times = Array.from({ length: n }, () => prev + span * (0.05 + Math.random() * 0.9)).sort((a, b) => a - b);
        // 같은 시각이 겹치지 않게 최소 간격 보정 (공간이 허락하는 만큼)
        const gap = Math.min(1000, span / (n + 1));
        for (let i = 1; i < n; i++) if (times[i] - times[i - 1] < gap) times[i] = times[i - 1] + gap;
        return times.map((t) => Math.min(t, next - 1));
    }
    const base = fallbackOrig;
    if (hasPrev && !hasNext) {
        // 맨 끝: 원래 시간이 이미 앞 메시지보다 뒤면 그대로, 아니면 간격만 유지해서 뒤로 민다
        if (base[0] > prev) return base;
        return base.map((t) => prev + 60000 + (t - base[0]));
    }
    if (!hasPrev && hasNext) {
        if (base[n - 1] < next) return base;
        return base.map((t) => next - 60000 - (base[n - 1] - t));
    }
    return base;
}

// ---------------------------------------------------------------------------
// 스타일 프리셋 → <style> 주입
// ST는 메시지 안의 class 이름에 'custom-' 접두사를 붙일 수 있으므로 두 형태 모두 대응한다.
// ---------------------------------------------------------------------------
function presetCss(p) {
    const css = `.dbi-p-${safeId(p.id)} {\n${p.css}\n}`;
    return `${css}\n${css.replace(/\.dbi-/g, '.custom-dbi-')}`;
}
function applyPresetStyles() {
    let el = document.getElementById(STYLE_EL_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = STYLE_EL_ID;
        document.head.appendChild(el);
    }
    el.textContent = settings().presets.map(presetCss).join('\n\n');
}
const getPreset = (id) => settings().presets.find((p) => p.id === id);

// ---------------------------------------------------------------------------
// 렌더링 (HTML은 한 줄로 — 들여쓰기가 있으면 마크다운 코드블록으로 바뀔 수 있음)
// ---------------------------------------------------------------------------
function displayName(m, opt) {
    const c = ctx();
    if (opt.nameMode === 'discord' && m.author) return m.author;
    return m.role === 'user' ? (c.name1 || m.author) : (c.name2 || m.author);
}
function splitBubbles(text, mode) {
    const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
    let parts;
    if (mode === 'none') parts = [t];
    else if (mode === 'para') parts = t.split(/\n\s*\n/);
    else parts = t.split('\n');
    parts = parts.map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : [t];
}
function rowHtml(m, opt) {
    const d = new Date(m.timestamp);
    const time = Number.isNaN(d.getTime()) ? '' : fmtTime(d);
    const who = m.role === 'user' ? 'dbi-user' : 'dbi-char';
    const parts = splitBubbles(m.content, opt.split || 'line');
    // 줄마다 말풍선 하나, 시간은 마지막 말풍선에만
    const lines = parts.map((part, k) => {
        const body = esc(part).replace(/\n/g, '<br>');
        const t = k === parts.length - 1 ? `<div class="dbi-time">${time}</div>` : '';
        return `<div class="dbi-line"><div class="dbi-bubble">${body}</div>${t}</div>`;
    }).join('');
    return `<div class="dbi-row ${who}"><div class="dbi-name">${esc(displayName(m, opt))}</div>${lines}</div>`;
}
function bundleHtml(msgs, preset, opt) {
    let html = '';
    let lastDay = '';
    for (const m of msgs) {
        const d = new Date(m.timestamp);
        if (!Number.isNaN(d.getTime()) && dayKey(d) !== lastDay) {
            lastDay = dayKey(d);
            html += `<div class="dbi-date">${fmtDateLine(d)}</div>`;
        }
        html += rowHtml(m, opt);
    }
    return `<div class="dbi-chat dbi-p-${safeId(preset.id)}">${html}</div>`;
}
function singleHtml(m, preset, opt) {
    return `<div class="dbi-chat dbi-single dbi-p-${safeId(preset.id)}">${rowHtml(m, opt)}</div>`;
}
function bundleText(msgs, opt) {
    const lines = msgs.map((m) => {
        const d = new Date(m.timestamp);
        const t = Number.isNaN(d.getTime()) ? '' : `[${fmtShort(d)}] `;
        return `${t}${displayName(m, opt)}: ${m.content}`;
    });
    return `[메신저 대화 기록]\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// 삽입
// ---------------------------------------------------------------------------
async function insertMessages(selected, afterIndex, opt) {
    const c = ctx();
    const chat = c.chat;
    if (!Array.isArray(chat)) throw new Error('열린 채팅이 없습니다.');
    const insertAt = Math.max(0, Math.min(chat.length, afterIndex + 1));
    const preset = opt.format === 'plain' ? null : getPreset(opt.format);
    const sample = chat[insertAt - 1]?.send_date ?? chat[insertAt]?.send_date ?? chat[chat.length - 1]?.send_date;
    const orig = selected.map((m) => Date.parse(m.timestamp));

    const baseMsg = (isUser, name) => ({
        name,
        is_user: isUser,
        is_system: !!opt.hideFromAI,
        send_date: '',
        mes: '',
        extra: {},
    });

    const out = [];
    if (opt.unit === 'bundle') {
        const lastOrig = [orig[orig.length - 1]];
        const [t] = planTimes(lastOrig, insertAt, opt.timeMode);
        const isUser = opt.bundleSender === 'user';
        const msg = baseMsg(isUser, isUser ? c.name1 : c.name2);
        msg.send_date = formatSendDate(t, sample);
        msg.mes = bundleText(selected, opt);
        if (preset) msg.extra.display_text = bundleHtml(selected, preset, opt);
        // 원본 목록도 같이 저장 → 다른 확장(제타 뷰어 등)이 CSS와 무관하게 대화를 다시 풀 수 있음
        msg.extra.dbi = {
            channelId: opt.channelId,
            from: selected[0].timestamp,
            to: selected[selected.length - 1].timestamp,
            count: selected.length,
            split: opt.split || 'line',
            preset: preset ? preset.id : 'plain',
            items: selected.map((m) => ({ role: m.role, name: displayName(m, opt), author: m.author, content: m.content, timestamp: m.timestamp })),
        };
        out.push(msg);
    } else {
        const times = planTimes(orig, insertAt, opt.timeMode);
        selected.forEach((m, i) => {
            const isUser = m.role === 'user';
            const msg = baseMsg(isUser, displayName(m, opt));
            msg.send_date = formatSendDate(times[i], sample);
            msg.mes = m.content;
            if (preset) msg.extra.display_text = singleHtml(m, preset, opt);
            msg.extra.dbi = { channelId: opt.channelId, i: m.i, ts: m.timestamp, role: m.role, split: opt.split || 'line', preset: preset ? preset.id : 'plain' };
            out.push(msg);
        });
    }

    chat.splice(insertAt, 0, ...out);
    await (c.saveChat || c.saveChatConditional)();
    if (typeof c.reloadCurrentChat === 'function') await c.reloadCurrentChat();
    else toastr.info('채팅을 다시 열면 반영된 내용이 보입니다.');
    return out.length;
}

// ---------------------------------------------------------------------------
// 불러오기 창
// ---------------------------------------------------------------------------
const view = { channels: [], messages: [], checked: new Set(), lastClick: -1, channelId: '' };

function currentCharName() {
    const c = ctx();
    if (c.characterId === undefined || c.characterId === null) return '';
    return (c.characters?.[c.characterId]?.name || '').trim();
}

// 실제 보이는 화면 높이(주소창·키보드 제외)를 창 높이로 사용
function syncViewportHeight() {
    const el = document.getElementById('dbi_overlay');
    if (!el) return;
    const h = Math.round(window.visualViewport?.height || window.innerHeight || 720);
    el.style.setProperty('--dbi-vh', `${h}px`);
}
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.addEventListener('resize', syncViewportHeight);

function closeDialog() {
    $('#dbi_overlay').remove();
    $(document).off('keydown.dbi');
}

async function openDialog(afterIndex) {
    const c = ctx();
    if (!Array.isArray(c.chat) || ((c.characterId === undefined || c.characterId === null) && !c.groupId)) {
        toastr.warning('먼저 캐릭터 채팅을 열어 주세요.');
        return;
    }
    closeDialog();
    const s = settings();
    const lastIdx = c.chat.length - 1;
    const after = Number.isInteger(afterIndex) ? afterIndex : lastIdx;

    const formatOptions = [`<option value="plain">일반 텍스트</option>`]
        .concat(s.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)).join('');

    const $o = $(`
<div id="dbi_overlay">
  <div id="dbi_dialog" role="dialog" aria-label="디코 대화 불러오기">
    <div class="dbi_head">
      <b><i class="fa-brands fa-discord"></i> 디코 대화 불러오기</b>
      <div class="menu_button dbi_icon_btn" id="dbi_close" title="닫기"><i class="fa-solid fa-xmark"></i></div>
    </div>
    <div class="dbi_bar">
      <select id="dbi_channel" class="text_pole"></select>
      <div class="menu_button dbi_icon_btn" id="dbi_reload" title="새로고침"><i class="fa-solid fa-rotate"></i></div>
    </div>
    <label class="dbi_check"><input type="checkbox" id="dbi_allch"> 다른 캐릭터 채널도 보기</label>
    <div class="dbi_bar dbi_selbar">
      <div class="menu_button" id="dbi_selall">전체 선택</div>
      <div class="menu_button" id="dbi_selnone">선택 해제</div>
      <span id="dbi_count" class="dbi_muted">0개 선택</span>
    </div>
    <div class="dbi_hint">메시지를 누르면 선택돼요. 하나 누르고 Shift+클릭(또는 '범위' 버튼)으로 구간 선택.</div>
    <div id="dbi_list"><div class="dbi_muted dbi_pad">불러오는 중...</div></div>

    <details class="dbi_opts" open>
      <summary>넣는 방식</summary>
      <div class="dbi_grid">
        <label>단위<select id="dbi_unit" class="text_pole">
          <option value="each">메시지별로 따로</option>
          <option value="bundle">하나의 메시지로 묶기</option>
        </select></label>
        <label>형식<select id="dbi_format" class="text_pole">${formatOptions}</select></label>
        <label id="dbi_split_wrap">말풍선 나누기<select id="dbi_split" class="text_pole">
          <option value="line">줄바꿈마다</option>
          <option value="para">빈 줄 기준 (문단)</option>
          <option value="none">안 나눔</option>
        </select></label>
        <label>이름<select id="dbi_name" class="text_pole">
          <option value="st">ST 이름 (${esc(c.name1)} / ${esc(c.name2)})</option>
          <option value="discord">디코 이름 그대로</option>
        </select></label>
        <label>시간<select id="dbi_time" class="text_pole">
          <option value="auto">앞뒤 대화 사이로 맞추기</option>
          <option value="original">디코 원래 시간</option>
        </select></label>
        <label id="dbi_sender_wrap">묶음 보낸 쪽<select id="dbi_sender" class="text_pole">
          <option value="char">캐릭터 (${esc(c.name2)})</option>
          <option value="user">나 (${esc(c.name1)})</option>
        </select></label>
        <label>위치: 몇 번 메시지 다음<input type="number" id="dbi_after" class="text_pole" min="-1" max="${lastIdx}" value="${after}"></label>
      </div>
      <div id="dbi_after_peek" class="dbi_muted"></div>
      <label class="dbi_check"><input type="checkbox" id="dbi_hide"> AI에게 숨기기 (화면에만 보이고 프롬프트에는 안 들어감)</label>
    </details>

    <details class="dbi_opts">
      <summary>미리보기</summary>
      <div id="dbi_preview"></div>
    </details>

    <div class="dbi_foot">
      <div class="menu_button" id="dbi_cancel">취소</div>
      <div class="menu_button dbi_primary" id="dbi_insert"><i class="fa-solid fa-file-import"></i> 넣기</div>
    </div>
  </div>
</div>`);
    $('body').append($o);
    syncViewportHeight();

    $('#dbi_unit').val(s.unit);
    $('#dbi_format').val(getPreset(s.format) || s.format === 'plain' ? s.format : 'plain');
    $('#dbi_name').val(s.nameMode);
    $('#dbi_split').val(s.split);
    $('#dbi_time').val(s.timeMode);
    $('#dbi_sender').val(s.bundleSender);
    $('#dbi_hide').prop('checked', s.hideFromAI);
    $('#dbi_allch').prop('checked', s.showAllChannels);
    syncOptVisibility();
    peekAfter();

    $o.on('click', (e) => { if (e.target.id === 'dbi_overlay') closeDialog(); });
    $('#dbi_close, #dbi_cancel').on('click', closeDialog);
    $('#dbi_reload').on('click', () => loadChannels(true));
    $('#dbi_allch').on('change', function () { s.showAllChannels = this.checked; save(); renderChannelSelect(); });
    $('#dbi_channel').on('change', function () { loadMessages(this.value); });
    $('#dbi_selall').on('click', () => { view.messages.forEach((m) => view.checked.add(m.i)); renderList(); });
    $('#dbi_selnone').on('click', () => { view.checked.clear(); renderList(); });
    $('#dbi_after').on('input', peekAfter);
    $('#dbi_unit, #dbi_format, #dbi_split, #dbi_name, #dbi_time, #dbi_sender, #dbi_hide').on('change', () => {
        s.unit = $('#dbi_unit').val();
        s.format = $('#dbi_format').val();
        s.nameMode = $('#dbi_name').val();
        s.split = $('#dbi_split').val();
        s.timeMode = $('#dbi_time').val();
        s.bundleSender = $('#dbi_sender').val();
        s.hideFromAI = $('#dbi_hide').prop('checked');
        save();
        syncOptVisibility();
        renderPreview();
    });
    $('#dbi_list').on('click', '.dbi_item', onItemClick);
    $('#dbi_list').on('click', '.dbi_range', onRangeClick);
    $('#dbi_insert').on('click', onInsert);
    $(document).on('keydown.dbi', (e) => { if (e.key === 'Escape') closeDialog(); });

    await loadChannels(false);
}

function syncOptVisibility() {
    $('#dbi_sender_wrap').toggle($('#dbi_unit').val() === 'bundle');
    $('#dbi_split_wrap').toggle($('#dbi_format').val() !== 'plain');
}

function peekAfter() {
    const chat = ctx().chat || [];
    const k = parseInt($('#dbi_after').val(), 10);
    if (Number.isNaN(k)) return $('#dbi_after_peek').text('');
    if (k < 0) return $('#dbi_after_peek').text('→ 맨 앞에 넣기');
    const m = chat[Math.min(k, chat.length - 1)];
    if (!m) return $('#dbi_after_peek').text('');
    const where = k >= chat.length - 1 ? '맨 끝 ' : '';
    $('#dbi_after_peek').text(`→ ${where}#${Math.min(k, chat.length - 1)} ${m.name}: ${String(m.mes || '').replace(/\s+/g, ' ').slice(0, 50)}`);
}

async function loadChannels(refresh) {
    try {
        const res = await api(`/list${refresh ? '?refresh=1' : ''}`);
        view.channels = res.channels || [];
        renderChannelSelect();
    } catch (e) {
        $('#dbi_list').html(`<div class="dbi_err dbi_pad">채널 목록을 못 불러왔어요: ${esc(e.message)}<br>서버 플러그인(dbridge-history) 설치 후 ST를 재시작했는지 확인해 주세요.</div>`);
    }
}

function renderChannelSelect() {
    const name = currentCharName().toLowerCase();
    const showAll = settings().showAllChannels || !name;
    let list = view.channels.filter((ch) => !ch.summaryOnly && ch.count > 0);
    const mine = list.filter((ch) => (ch.character || '').trim().toLowerCase() === name);
    if (!showAll && mine.length) list = mine;

    if (!list.length) {
        $('#dbi_channel').html('');
        $('#dbi_list').html('<div class="dbi_muted dbi_pad">불러올 채널 기록이 없어요.</div>');
        return;
    }
    const opts = list.map((ch) => {
        const last = ch.last ? fmtShort(new Date(ch.last)) : '-';
        const label = `${ch.character || '(매핑 없음)'}${ch.npcGroup ? ' [단톡]' : ''} / ${ch.persona || '기본'} (${ch.count}개, 최근 ${last})`;
        return `<option value="${esc(ch.channelId)}">${esc(label)}</option>`;
    }).join('');
    $('#dbi_channel').html(opts);
    const keep = list.some((ch) => ch.channelId === view.channelId) ? view.channelId : list[0].channelId;
    $('#dbi_channel').val(keep);
    loadMessages(keep);
}

async function loadMessages(channelId) {
    view.channelId = channelId;
    view.checked.clear();
    view.lastClick = -1;
    $('#dbi_list').html('<div class="dbi_muted dbi_pad">불러오는 중...</div>');
    try {
        const res = await api(`/messages?channel=${encodeURIComponent(channelId)}`);
        view.messages = res.messages || [];
        renderList();
        const el = document.getElementById('dbi_list');
        if (el) el.scrollTop = el.scrollHeight; // 최근 대화가 아래
    } catch (e) {
        $('#dbi_list').html(`<div class="dbi_err dbi_pad">${esc(e.message)}</div>`);
    }
}

function renderList() {
    if (!view.messages.length) {
        $('#dbi_list').html('<div class="dbi_muted dbi_pad">메시지가 없어요.</div>');
        updateCount();
        return;
    }
    let html = '';
    let lastDay = '';
    for (const m of view.messages) {
        const d = new Date(m.timestamp);
        const ok = !Number.isNaN(d.getTime());
        if (ok && dayKey(d) !== lastDay) {
            lastDay = dayKey(d);
            html += `<div class="dbi_day">${fmtDateLine(d)}</div>`;
        }
        const on = view.checked.has(m.i);
        html += `<div class="dbi_item ${m.role === 'user' ? 'dbi_is_user' : ''} ${on ? 'dbi_on' : ''}" data-i="${m.i}">
<input type="checkbox" tabindex="-1" ${on ? 'checked' : ''}>
<div class="dbi_item_body"><div class="dbi_item_meta"><b>${esc(m.author || (m.role === 'user' ? '나' : '캐릭터'))}</b> <span>${ok ? fmtTime(d) : ''}</span></div>
<div class="dbi_item_text">${esc(m.content)}</div></div>
<div class="menu_button dbi_range" title="마지막으로 누른 메시지부터 여기까지 선택"><i class="fa-solid fa-arrows-up-down"></i></div></div>`;
    }
    $('#dbi_list').html(html);
    updateCount();
}

function selectRange(i) {
    const from = view.messages.findIndex((m) => m.i === view.lastClick);
    const to = view.messages.findIndex((m) => m.i === i);
    if (from < 0 || to < 0) return false;
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let k = a; k <= b; k++) view.checked.add(view.messages[k].i);
    return true;
}

function onItemClick(e) {
    if ($(e.target).closest('.dbi_range').length) return;
    const i = Number($(this).data('i'));
    if (e.shiftKey && view.lastClick >= 0 && selectRange(i)) {
        // 범위 선택
    } else if (view.checked.has(i)) view.checked.delete(i);
    else view.checked.add(i);
    view.lastClick = i;
    renderListKeepScroll();
}

function onRangeClick(e) {
    e.stopPropagation();
    const i = Number($(this).closest('.dbi_item').data('i'));
    if (view.lastClick < 0) { view.checked.add(i); view.lastClick = i; }
    else { selectRange(i); view.lastClick = i; }
    renderListKeepScroll();
}

function renderListKeepScroll() {
    const el = document.getElementById('dbi_list');
    const top = el ? el.scrollTop : 0;
    renderList();
    if (el) el.scrollTop = top;
}

function selectedMessages() {
    return view.messages.filter((m) => view.checked.has(m.i));
}

function updateCount() {
    $('#dbi_count').text(`${view.checked.size}개 선택`);
    renderPreview();
}

function currentOpts() {
    return {
        channelId: view.channelId,
        unit: $('#dbi_unit').val(),
        format: $('#dbi_format').val(),
        nameMode: $('#dbi_name').val(),
        split: $('#dbi_split').val(),
        timeMode: $('#dbi_time').val(),
        bundleSender: $('#dbi_sender').val(),
        hideFromAI: $('#dbi_hide').prop('checked'),
    };
}

function renderPreview() {
    const $p = $('#dbi_preview');
    if (!$p.length) return;
    const sel = selectedMessages();
    if (!sel.length) return $p.html('<div class="dbi_muted">메시지를 선택하면 여기에 보여요.</div>');
    const opt = currentOpts();
    const preset = opt.format === 'plain' ? null : getPreset(opt.format);
    const shown = sel.slice(0, 12);
    let html;
    if (!preset) {
        html = opt.unit === 'bundle'
            ? `<div class="dbi_plain">${esc(bundleText(shown, opt))}</div>`
            : shown.map((m) => `<div class="dbi_plain"><b>${esc(displayName(m, opt))}</b>\n${esc(m.content)}</div>`).join('');
    } else {
        html = opt.unit === 'bundle' ? bundleHtml(shown, preset, opt) : shown.map((m) => singleHtml(m, preset, opt)).join('<div style="height:8px"></div>');
    }
    if (sel.length > shown.length) html += `<div class="dbi_muted">… 외 ${sel.length - shown.length}개</div>`;
    $p.html(html);
}

async function onInsert() {
    const sel = selectedMessages();
    if (!sel.length) return toastr.warning('넣을 메시지를 선택해 주세요.');
    const k = parseInt($('#dbi_after').val(), 10);
    const chat = ctx().chat || [];
    const after = Number.isNaN(k) ? chat.length - 1 : Math.max(-1, Math.min(k, chat.length - 1));
    const $btn = $('#dbi_insert').addClass('disabled');
    try {
        const n = await insertMessages(sel, after, currentOpts());
        toastr.success(`${n}개 메시지를 넣었어요.`);
        closeDialog();
    } catch (e) {
        console.error('[DBI] 삽입 실패', e);
        toastr.error(`넣기 실패: ${e.message}`);
        $btn.removeClass('disabled');
    }
}

// ---------------------------------------------------------------------------
// 설정 패널 (프리셋 관리)
// ---------------------------------------------------------------------------
const PREVIEW_SAMPLE = [
    { i: 0, role: 'assistant', author: '캐릭터', content: '오늘 뭐 했어?', timestamp: '2026-09-21T09:40:00Z' },
    { i: 1, role: 'user', author: '나', content: '그냥 집에 있었지\n너는?', timestamp: '2026-09-21T09:41:00Z' },
    { i: 2, role: 'assistant', author: '캐릭터', content: '나는 너 생각했지롱', timestamp: '2026-09-21T09:41:30Z' },
];

function settingsHtml() {
    return `
<div class="dbi-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b><i class="fa-brands fa-discord"></i>🎮 디코 대화 불러오기</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="menu_button dbi_wide" id="dbi_open_from_settings"><i class="fa-solid fa-file-import"></i> 불러오기 창 열기</div>
      <hr>
      <label>스타일 프리셋</label>
      <div class="dbi_bar">
        <select id="dbi_preset_sel" class="text_pole"></select>
        <div class="menu_button dbi_icon_btn" id="dbi_preset_new" title="새로 만들기"><i class="fa-solid fa-plus"></i></div>
        <div class="menu_button dbi_icon_btn" id="dbi_preset_dup" title="복제"><i class="fa-solid fa-copy"></i></div>
        <div class="menu_button dbi_icon_btn" id="dbi_preset_del" title="삭제"><i class="fa-solid fa-trash"></i></div>
      </div>
      <label>이름</label>
      <input type="text" id="dbi_preset_name" class="text_pole">
      <label>CSS</label>
      <textarea id="dbi_preset_css" class="text_pole" rows="10" spellcheck="false"></textarea>
      <div class="dbi_hint">
        프리셋 루트 안에 자동으로 감싸져요. 루트 자체는 <code>&amp; { }</code>, 안쪽은
        <code>.dbi-date</code> <code>.dbi-row</code> (<code>.dbi-user</code>/<code>.dbi-char</code>)
        <code>.dbi-name</code> <code>.dbi-line</code> <code>.dbi-bubble</code> <code>.dbi-time</code> 로 꾸미면 돼요.
        메시지별로 넣을 땐 루트에 <code>.dbi-single</code> 클래스가 추가돼요.
      </div>
      <label>미리보기</label>
      <div id="dbi_preset_preview"></div>
      <div class="menu_button dbi_wide" id="dbi_preset_reset" title="기본 프리셋 3개를 다시 추가"><i class="fa-solid fa-rotate-left"></i> 기본 프리셋 복구</div>
    </div>
  </div>
</div>`;
}

let editingId = '';

function renderPresetEditor() {
    const s = settings();
    if (!getPreset(editingId)) editingId = s.presets[0]?.id || '';
    $('#dbi_preset_sel').html(s.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')).val(editingId);
    const p = getPreset(editingId);
    $('#dbi_preset_name').val(p?.name || '');
    $('#dbi_preset_css').val(p?.css || '');
    renderPresetPreview();
}

function renderPresetPreview() {
    const p = getPreset(editingId);
    const opt = { nameMode: 'discord', split: settings().split };
    $('#dbi_preset_preview').html(p ? bundleHtml(PREVIEW_SAMPLE, p, opt) : '');
}

function newId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function bindSettings() {
    const s = settings();
    $('#dbi_open_from_settings').on('click', () => openDialog());
    $('#dbi_preset_sel').on('change', function () { editingId = this.value; renderPresetEditor(); });
    $('#dbi_preset_name').on('input', function () {
        const p = getPreset(editingId); if (!p) return;
        p.name = this.value || '이름 없음';
        $('#dbi_preset_sel option:selected').text(p.name);
        save();
    });
    $('#dbi_preset_css').on('input', function () {
        const p = getPreset(editingId); if (!p) return;
        p.css = this.value;
        applyPresetStyles();
        renderPresetPreview();
        save();
    });
    $('#dbi_preset_new').on('click', () => {
        const p = { id: newId(), name: '새 프리셋', css: `& { padding: 8px; border-radius: 10px; }\n.dbi-row { margin: 4px 0; }\n.dbi-name { font-weight: 600; }\n.dbi-bubble { }\n.dbi-time { font-size: .7em; opacity: .6; }` };
        s.presets.push(p); editingId = p.id;
        applyPresetStyles(); renderPresetEditor(); save();
    });
    $('#dbi_preset_dup').on('click', () => {
        const src = getPreset(editingId); if (!src) return;
        const p = { id: newId(), name: `${src.name} 복사본`, css: src.css };
        s.presets.push(p); editingId = p.id;
        applyPresetStyles(); renderPresetEditor(); save();
    });
    $('#dbi_preset_del').on('click', () => {
        if (s.presets.length <= 1) return toastr.warning('프리셋은 최소 1개 있어야 해요.');
        const p = getPreset(editingId);
        if (!p || !confirm(`"${p.name}" 프리셋을 삭제할까요?\n이미 넣은 메시지는 이 스타일을 잃게 돼요.`)) return;
        s.presets = s.presets.filter((x) => x.id !== editingId);
        if (s.format === editingId) s.format = 'plain';
        editingId = s.presets[0].id;
        applyPresetStyles(); renderPresetEditor(); save();
    });
    $('#dbi_preset_reset').on('click', () => {
        for (const d of DEFAULT_PRESETS) {
            if (!getPreset(d.id)) s.presets.push(structuredClone(d));
        }
        applyPresetStyles(); renderPresetEditor(); save();
        toastr.info('기본 프리셋을 복구했어요 (같은 이름의 수정본은 그대로 둬요).');
    });
}


// ---------------------------------------------------------------------------
// 디코 금칙어 · 치환 (봇 쪽 word-filter.js 가 data/word-filter.json 을 매번 읽음)
// ---------------------------------------------------------------------------
function filterHtml() {
    return `
<div class="dbi-settings dbi-filter">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🚫 디코 금칙어 · 치환</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div id="dbi_f_status" class="dbi_hint">상태 확인 중...</div>
      <div class="dbi_bar" id="dbi_f_connect_bar" style="display:none">
        <div class="menu_button dbi_wide" id="dbi_f_connect"><i class="fa-solid fa-plug"></i> 봇에 연결하기</div>
      </div>
      <label class="dbi_check"><input type="checkbox" id="dbi_f_enabled"> 필터 사용</label>

      <label>금지 프롬프트</label>
      <textarea id="dbi_f_prompt" class="text_pole" rows="4" placeholder="예) 과한 신체 묘사, 설명조 말투 금지. 답은 짧게."></textarea>
      <div class="dbi_hint">답을 만들 때마다 대화 맨 뒤에 붙어요.</div>

      <label>금칙어 <span class="dbi_muted">(한 줄에 하나)</span></label>
      <textarea id="dbi_f_bans" class="text_pole" rows="4" placeholder="입꼬리\n/씩\\s?웃/"></textarea>
      <div class="dbi_hint">일반 단어는 AI에게도 "쓰지 마"라고 알려줘요. <code>/정규식/</code>은 답이 나온 뒤 검사에만 쓰여요. <code>#</code>으로 시작하는 줄은 무시돼요.</div>
      <label>금칙어가 나오면</label>
      <select id="dbi_f_action" class="text_pole">
        <option value="retry">한 번 다시 생성 → 그래도 있으면 지우기</option>
        <option value="remove">바로 지우기</option>
        <option value="none">프롬프트로만 막기 (안 지움)</option>
      </select>

      <label>치환 <span class="dbi_muted">(원문 =&gt; 바꿀 말)</span></label>
      <textarea id="dbi_f_reps" class="text_pole" rows="4" placeholder="자기야 => 이서야\n/!{2,}/ => !"></textarea>
      <div class="dbi_hint">답이 디코에 보내지기 전에 바뀌어요. <code>[SEND_PHOTO: ...]</code> 같은 봇 명령 태그는 건드리지 않아요.</div>

      <label>프롬프트 넣는 방식</label>
      <select id="dbi_f_role" class="text_pole">
        <option value="user">user 메시지로 (대부분 모델 권장)</option>
        <option value="system">system 메시지로</option>
      </select>

      <div class="menu_button dbi_wide" id="dbi_f_save"><i class="fa-solid fa-floppy-disk"></i> 저장 (봇 재시작 없이 바로 적용)</div>

      <label>테스트</label>
      <textarea id="dbi_f_test" class="text_pole" rows="2" placeholder="문장을 넣어 보면 치환·금칙어 결과를 보여줘요"></textarea>
      <div id="dbi_f_test_out" class="dbi_plain"></div>
    </div>
  </div>
</div>`;
}

const F_TAG = /(\[\s*[A-Za-z][A-Za-z_]{2,}\b[^\]]*\])/g;
function fRegex(src) {
    const s = String(src || '').trim();
    if (!s) return null;
    const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
    try {
        if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`);
        return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    } catch { return null; }
}
const fLines = (t) => String(t || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function filterPreview() {
    const text = String($('#dbi_f_test').val() || '');
    if (!text.trim()) return $('#dbi_f_test_out').text('');
    const bans = fLines($('#dbi_f_bans').val()).map(fRegex).filter(Boolean);
    const reps = fLines($('#dbi_f_reps').val()).map((l) => {
        const i = l.indexOf('=>');
        const re = i >= 0 ? fRegex(l.slice(0, i)) : null;
        return re ? { re, to: l.slice(i + 2).trim() } : null;
    }).filter(Boolean);
    const found = [];
    let out = text.split(F_TAG).map((part, i) => {
        if (i % 2 === 1) return part;
        for (const re of bans) {
            re.lastIndex = 0;
            const m = part.match(re);
            if (m) found.push(...m);
            if ($('#dbi_f_action').val() !== 'none') part = part.replace(re, '');
        }
        return part;
    }).join('').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?~、。])/g, '$1').replace(/^[ \t]+|[ \t]+$/gm, '');
    out = out.split(F_TAG).map((part, i) => {
        if (i % 2 === 1) return part;
        for (const r of reps) part = part.replace(r.re, r.to);
        return part;
    }).join('');
    const note = found.length ? `⚠ 금칙어 ${found.length}개: ${[...new Set(found)].join(', ')}\n` : '';
    $('#dbi_f_test_out').text(`${note}→ ${out}`);
}

function renderFilterStatus(st) {
    let msg;
    if (st.connected) msg = '✅ 봇에 연결됨 — 저장하면 다음 답부터 바로 적용돼요.';
    else if (st.hooked && !st.moduleOk) msg = '⚠ 필터 파일이 없거나 오래됐어요. 다시 연결해 주세요.';
    else msg = '⚠ 봇에 아직 연결되지 않았어요. (디코 브릿지를 업데이트하면 연결이 풀려요)';
    $('#dbi_f_status').text(msg);
    $('#dbi_f_connect_bar').toggle(!st.connected);
}

async function loadFilter() {
    try {
        const res = await api('/filter');
        const r = res.rules || {};
        $('#dbi_f_enabled').prop('checked', r.enabled !== false);
        $('#dbi_f_prompt').val(r.banPrompt || '');
        $('#dbi_f_bans').val(r.banWords || '');
        $('#dbi_f_reps').val(r.replacements || '');
        $('#dbi_f_action').val(r.banAction || 'retry');
        $('#dbi_f_role').val(r.role || 'user');
        renderFilterStatus(res);
    } catch (e) {
        $('#dbi_f_status').text(`불러오기 실패: ${e.message} (서버 플러그인 업데이트 후 ST를 재시작했는지 확인)`);
    }
}

async function apiPost(pathname, body) {
    const resp = await fetch(API + pathname, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body || {}) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `${pathname} → ${resp.status}`);
    return data;
}

function bindFilter() {
    $('#dbi_f_save').on('click', async () => {
        try {
            const res = await apiPost('/filter', {
                enabled: $('#dbi_f_enabled').prop('checked'),
                banPrompt: $('#dbi_f_prompt').val(),
                banWords: $('#dbi_f_bans').val(),
                replacements: $('#dbi_f_reps').val(),
                banAction: $('#dbi_f_action').val(),
                role: $('#dbi_f_role').val(),
            });
            renderFilterStatus(res);
            toastr.success(res.connected ? '저장했어요. 다음 답부터 적용돼요.' : '저장했어요. 봇에 연결하면 적용돼요.');
        } catch (e) {
            toastr.error(`저장 실패: ${e.message}`);
        }
    });
    $('#dbi_f_connect').on('click', async () => {
        if (!confirm('디코 브릿지 bot.js에 필터 연결 한 줄을 추가할까요?\n(원본은 bot.js.before-word-filter 로 백업돼요)')) return;
        try {
            const res = await apiPost('/filter/connect');
            renderFilterStatus(res);
            // 설정 플러그인의 재시작 기능이 있으면 이어서 봇 재시작
            try {
                const r = await fetch('/api/plugins/discord-bridge-config/restart', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}' });
                toastr.success(r.ok ? '연결하고 봇을 재시작했어요.' : '연결했어요. Discord Bridge 패널에서 봇을 재시작해 주세요.');
            } catch {
                toastr.success('연결했어요. Discord Bridge 패널에서 봇을 재시작해 주세요.');
            }
        } catch (e) {
            toastr.error(`연결 실패: ${e.message}`);
        }
    });
    $('#dbi_f_test, #dbi_f_bans, #dbi_f_reps, #dbi_f_action').on('input change', filterPreview);
}


// ---------------------------------------------------------------------------
// 수정 후 스타일 유지
// ST에서 메시지를 수정하면 mes(순수 텍스트)만 바뀌고 display_text(HTML)는
// 그대로 남거나 무시되어 스타일이 풀린다. 수정된 mes를 기준으로 HTML을 다시 만든다.
// ---------------------------------------------------------------------------
const STAMP_RE = /^\[(\d{2})\/(\d{2}) (\d{2}):(\d{2})\] (.+?): (.*)$/;
const NOSTAMP_RE = /^([^:\n]{1,60}): (.*)$/;

// bundleText() 형식의 텍스트를 다시 항목 목록으로 푼다
function parseBundleText(text, oldItems) {
    const c = ctx();
    const old = Array.isArray(oldItems) ? oldItems : [];
    const known = new Set([...old.map((o) => o.name), c.name1, c.name2].filter(Boolean));
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    if (lines[0]?.trim() === '[메신저 대화 기록]') lines.shift();

    const items = [];
    for (const line of lines) {
        let m = line.match(STAMP_RE);
        let stamp = null, name, content;
        if (m) {
            stamp = { mo: +m[1], d: +m[2], h: +m[3], mi: +m[4], str: `${m[1]}/${m[2]} ${m[3]}:${m[4]}` };
            name = m[5]; content = m[6];
        } else if ((m = line.match(NOSTAMP_RE)) && known.has(m[1].trim())) {
            name = m[1].trim(); content = m[2];
        } else {
            // 이전 항목의 이어지는 줄
            if (items.length) items[items.length - 1].content += `\n${line}`;
            else if (line.trim()) items.push({ name: old[0]?.name || c.name2, content: line, stamp: null });
            continue;
        }
        items.push({ name, content, stamp });
    }

    return items.map((it, k) => {
        const same = old.find((o) => o.name === it.name);
        const role = same?.role ?? (it.name === c.name1 ? 'user' : 'char');
        const author = same?.author ?? it.name;
        const ref = old[k] ?? old[old.length - 1];
        let timestamp = ref?.timestamp ?? items[k - 1]?.timestamp ?? new Date().toISOString();
        if (it.stamp) {
            const hit = [old[k], ...old].find((o) => {
                const d = new Date(o?.timestamp);
                return o && !Number.isNaN(d.getTime()) && fmtShort(d) === it.stamp.str;
            });
            if (hit) timestamp = hit.timestamp;
            else {
                const y = new Date(ref?.timestamp).getFullYear();
                const d = new Date(Number.isNaN(y) ? new Date().getFullYear() : y, it.stamp.mo - 1, it.stamp.d, it.stamp.h, it.stamp.mi);
                timestamp = d.toISOString();
            }
        }
        it.timestamp = timestamp;
        return { role, name: it.name, author, content: it.content.trim(), timestamp };
    }).filter((it) => it.content);
}

function presetFor(d) {
    const s = settings();
    if (d.preset === 'plain') return null;
    // 이전 버전으로 넣은 메시지는 프리셋 id가 없어서 현재 기본 형식 → 첫 프리셋 순으로 대신 쓴다
    return getPreset(d.preset) || getPreset(s.format) || s.presets[0] || null;
}

/** 메시지 하나의 display_text를 mes 기준으로 다시 만든다. 바뀌었으면 true */
function restyleMessage(msg) {
    const d = msg?.extra?.dbi;
    if (!d || typeof msg.mes !== 'string') return false;
    const preset = presetFor(d);
    if (!preset) return false;
    const opt = { split: d.split || 'line', nameMode: 'discord' };
    let html;
    if (Array.isArray(d.items)) {
        const items = parseBundleText(msg.mes, d.items);
        if (!items.length) return false;
        d.items = items;
        d.count = items.length;
        d.from = items[0].timestamp;
        d.to = items[items.length - 1].timestamp;
        html = bundleHtml(items.map((it) => ({ ...it, author: it.name })), preset, opt);
    } else {
        const m = { role: d.role || (msg.is_user ? 'user' : 'char'), author: msg.name, content: msg.mes, timestamp: d.ts };
        html = singleHtml(m, preset, opt);
    }
    d.preset = preset.id;
    if (msg.extra.display_text === html) return false;
    msg.extra.display_text = html;
    return true;
}

function rerenderMessage(id) {
    const c = ctx();
    const msg = c.chat?.[id];
    if (!msg) return;
    if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(id, msg);
    else {
        const text = msg.extra?.display_text ?? msg.mes;
        $(`#chat .mes[mesid="${id}"] .mes_text`).html(c.messageFormatting(text, msg.name, msg.is_system, msg.is_user, id));
    }
}

const saveChatNow = () => { const c = ctx(); return (c.saveChatConditional || c.saveChat)?.(); };

// 수정 직후: 데이터만 갱신 (ST가 이 뒤에 mes로 화면을 다시 그림)
function onMessageEdited(id) {
    restyleMessage(ctx().chat?.[Number(id)]);
}
// 화면 갱신까지 끝난 뒤: 스타일 HTML로 다시 그림
async function onMessageUpdated(id) {
    id = Number(id);
    const msg = ctx().chat?.[id];
    if (!msg?.extra?.dbi) return;
    restyleMessage(msg);
    if (!msg.extra.display_text) return;
    rerenderMessage(id);
    await saveChatNow();
}
// 채팅을 열 때: 이미 스타일이 풀려 있는 메시지 복구
async function repairChat() {
    const chat = ctx().chat;
    if (!Array.isArray(chat)) return;
    let changed = false;
    chat.forEach((msg, id) => {
        if (msg?.extra?.dbi && !msg.extra.display_text && restyleMessage(msg)) {
            rerenderMessage(id);
            changed = true;
        }
    });
    if (changed) await saveChatNow();
}

// ---------------------------------------------------------------------------
// 진입점: 마법봉 메뉴 + 메시지 버튼 + 설정 패널
// ---------------------------------------------------------------------------
const MES_BTN = '<div title="여기 아래에 디코 대화 넣기" class="mes_button dbi_mes_btn fa-brands fa-discord interactable" tabindex="0"></div>';

function addMessageButtons() {
    // 템플릿에 넣어 두면 새로 그려지는 메시지에 자동으로 붙는다
    const $tpl = $('#message_template .extraMesButtons');
    if ($tpl.length && !$tpl.find('.dbi_mes_btn').length) $tpl.prepend(MES_BTN);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.dbi_mes_btn').length) $(this).prepend(MES_BTN);
    });
}

jQuery(() => {
    settings();
    applyPresetStyles();

    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    renderPresetEditor();

    $('#extensions_settings2').append(filterHtml());
    bindFilter();
    loadFilter();

    $('#extensionsMenu').append(`<div id="dbi_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
<div class="fa-brands fa-discord extensionsMenuExtensionButton"></div>디코 대화 불러오기</div>`);
    $('#dbi_wand').on('click', () => openDialog());

    addMessageButtons();
    $(document).on('click', '.dbi_mes_btn', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        openDialog(Number.isInteger(id) ? id : undefined);
    });

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.CHAT_CHANGED, () => { closeDialog(); addMessageButtons(); repairChat(); });
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdated);
});
