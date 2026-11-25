'use strict';

/* =========================================================
   AdLog - アドバイス・質疑応答まとめツール
   - 回答は任意（あとから追加・編集できる）
   - ファイル（.json）への書き出し／読み込み
   - ブラウザ内に自動保存（このアプリ専用のキーのみ使用）
   ========================================================= */

const STORAGE_KEY = 'qa_tool_backup';          // 旧バージョンと同じキー（データを引き継ぐ）
const FILE_FORMAT = 'adlog';
const FILE_VERSION = 2;
const CATEGORIES = ['企画・調査', '設計', '実験・試作', '工作教室準備', '工作教室本番', 'その他'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

let appData = createEmptyData();
let editingId = null;          // 編集中の項目ID
let lastDeleted = null;        // 元に戻す用 { item, index }

const $ = (id) => document.getElementById(id);
const els = {};

/* ---------------- アニメーション ---------------- */

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const liById = (id) => id && els.list.querySelector(`.qa[data-id="${cssEscape(id)}"]`);

/** 要素を高さ0から開くように表示 */
function expandIn(el, duration = 280) {
    if (!el || !motionOK() || !el.animate) return;
    const cs = getComputedStyle(el);
    const h = el.offsetHeight;
    el.style.overflow = 'hidden';
    const a = el.animate([
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' },
        { height: h + 'px', opacity: 1, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom }
    ], { duration, easing: EASE });
    a.onfinish = a.oncancel = () => { el.style.overflow = ''; };
}

/** 要素を高さ0へ閉じるように消す（終わったら resolve） */
function collapseOut(el, duration = 220) {
    return new Promise((resolve) => {
        if (!el || !motionOK() || !el.animate) return resolve();
        const cs = getComputedStyle(el);
        el.style.overflow = 'hidden';
        el.style.pointerEvents = 'none';
        const a = el.animate([
            { height: el.offsetHeight + 'px', opacity: 1, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
            { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' }
        ], { duration, easing: EASE, fill: 'forwards' });
        a.onfinish = a.oncancel = () => resolve();
    });
}

/** 描画の前後で高さが変わる要素をなめらかに伸び縮みさせる（編集の開閉） */
function morphItem(id, fn) {
    const before = liById(id);
    const fromH = before ? before.offsetHeight : null;
    fn();
    const el = liById(id);
    if (!el || fromH == null || !motionOK() || !el.animate) return;
    const toH = el.offsetHeight;
    if (Math.abs(toH - fromH) < 2) return;
    el.style.overflow = 'hidden';
    const a = el.animate([{ height: fromH + 'px' }, { height: toH + 'px' }], { duration: 280, easing: EASE });
    a.onfinish = a.oncancel = () => { el.style.overflow = ''; };
}

/** 並べ替えの前後で位置をなめらかに移動（FLIP） */
function flip(fn, movingId) {
    const before = new Map();
    els.list.querySelectorAll('.qa').forEach((li) => before.set(li.dataset.id, li.getBoundingClientRect().top));
    fn();
    if (!motionOK()) return;
    els.list.querySelectorAll('.qa').forEach((li) => {
        const top = before.get(li.dataset.id);
        if (top == null || !li.animate) return;
        const dy = top - li.getBoundingClientRect().top;
        if (!dy) return;
        if (li.dataset.id === movingId) li.classList.add('moving');
        const a = li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE });
        a.onfinish = a.oncancel = () => li.classList.remove('moving');
    });
}

/** <details> をなめらかに開閉する */
function setupAccordion(details) {
    const summary = details.querySelector('summary');
    const body = details.querySelector('.details-body');
    let anim = null;
    details.classList.toggle('is-open', details.open);
    summary.addEventListener('click', (e) => {
        e.preventDefault();
        const opening = !details.classList.contains('is-open');
        details.classList.toggle('is-open', opening);
        if (!motionOK() || !body.animate) { details.open = opening; return; }
        const startH = body.getBoundingClientRect().height;
        if (anim) anim.cancel();
        if (opening) details.open = true;
        const endH = opening ? body.scrollHeight : 0;
        anim = body.animate([
            { height: startH + 'px', opacity: opening ? (startH ? 1 : 0) : 1 },
            { height: endH + 'px', opacity: opening ? 1 : 0 }
        ], { duration: 320, easing: EASE });
        anim.onfinish = () => {
            anim = null;
            if (!opening) details.open = false;
        };
    });
}

/* ---------------- データ ---------------- */

function createEmptyData() {
    return {
        session: { title: '', date: todayISO() },
        questions: [],
        dirty: false               // ファイルに書き出していない変更があるか
    };
}

function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function newId() {
    if (window.crypto && crypto.randomUUID) return 'q_' + crypto.randomUUID();
    return 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 読み込んだデータ（旧形式・ファイル・localStorage）を安全な形に整える */
function normalizeData(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('データの形式が正しくありません');
    const session = raw.session && typeof raw.session === 'object' ? raw.session : {};
    const list = Array.isArray(raw.questions) ? raw.questions : null;
    if (!list) throw new Error('AdLogのファイルではないようです');

    const seen = new Set();
    const questions = list
        .filter((q) => q && typeof q === 'object' && str(q.question).trim() !== '')
        .map((q) => {
            let id = str(q.id);
            if (!id || seen.has(id)) id = newId();
            seen.add(id);
            return {
                id,
                question: str(q.question),
                answer: str(q.answer),
                tag: str(q.tag),
                createdAt: str(q.createdAt) || new Date().toISOString(),
                updatedAt: str(q.updatedAt) || str(q.createdAt) || new Date().toISOString()
            };
        });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(str(session.date)) ? str(session.date) : '';
    return {
        session: { title: str(session.title), date },
        questions,
        dirty: !!raw.dirty
    };
}

function save({ markDirty = true } = {}) {
    if (markDirty) appData.dirty = true;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    } catch (e) {
        console.warn('自動保存に失敗しました', e);
    }
    updateDirtyIndicator();
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) appData = normalizeData(JSON.parse(raw));
    } catch (e) {
        console.warn('保存データを読み込めませんでした', e);
        appData = createEmptyData();
    }
}

/* ---------------- 初期化 ---------------- */

function init() {
    Object.assign(els, {
        title: $('session-title'),
        date: $('session-date'),
        form: $('qa-form'),
        question: $('qa-question'),
        questionError: $('qa-question-error'),
        answer: $('qa-answer'),
        tags: $('qa-tags'),
        list: $('qa-list'),
        empty: $('empty-state'),
        filterEmpty: $('filter-empty'),
        stats: $('stats'),
        filter: $('filter-unanswered'),
        filterWrap: $('filter-wrap'),
        paper: $('document-paper'),
        previewTitle: $('preview-title'),
        previewDate: $('preview-date'),
        fileInput: $('file-input'),
        dirtyDot: $('dirty-dot'),
        menu: $('menu'),
        menuBtn: $('menu-btn'),
        menuList: $('menu-list'),
        shareBtn: $('share-btn'),
        fab: $('fab'),
        addCard: $('add-card'),
        toastArea: $('toast-area'),
        dropOverlay: $('drop-overlay'),
        guide: $('guide-details')
    });

    load();
    els.tags.innerHTML = chipsHTML('qa-tag', '');

    // 初回（質問ゼロ）はガイドを開いておく
    els.guide.open = appData.questions.length === 0;
    setupAccordion(els.guide);

    // ファイル共有に対応している端末（主にスマホ）だけ共有ボタンを出す
    try {
        if (navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'a.json', { type: 'application/json' })] })) {
            els.shareBtn.hidden = false;
        }
    } catch (_) { /* 非対応 */ }

    bindEvents();
    renderAll();
    autoGrow(els.question);
    autoGrow(els.answer);
}

function chipsHTML(name, selected) {
    // ファイル由来で一覧にないカテゴリも選択肢として残す（編集時に消えないように）
    const cats = selected && !CATEGORIES.includes(selected) ? [...CATEGORIES, selected] : CATEGORIES;
    return cats.map((c) => `
        <label class="chip">
            <input type="radio" name="${name}" value="${escapeHTML(c)}" ${c === selected ? 'checked' : ''}>
            <span>${escapeHTML(c)}</span>
        </label>`).join('');
}

/** ラジオボタンをもう一度押すと選択解除できるようにする */
function makeChipsToggleable(container) {
    container.addEventListener('pointerdown', (e) => {
        const label = e.target.closest('.chip');
        if (!label) return;
        const input = label.querySelector('input');
        input.dataset.wasChecked = input.checked ? '1' : '';
    });
    container.addEventListener('click', (e) => {
        const input = e.target.closest('.chip input');
        if (!input) return;
        if (input.dataset.wasChecked === '1') input.checked = false;
        input.dataset.wasChecked = '';
    });
}

function getCheckedTag(container) {
    const c = container.querySelector('input:checked');
    return c ? c.value : '';
}

/* ---------------- イベント ---------------- */

function bindEvents() {
    // 基本情報
    els.title.addEventListener('input', () => {
        appData.session.title = els.title.value;
        renderMeta();
        save();
    });
    els.date.addEventListener('change', () => {
        appData.session.date = els.date.value;
        renderMeta();
        save();
    });

    // 追加フォーム
    makeChipsToggleable(els.tags);
    els.form.addEventListener('submit', (e) => {
        e.preventDefault();
        addQuestion();
    });
    [els.question, els.answer].forEach((ta) => {
        ta.addEventListener('input', () => autoGrow(ta));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                addQuestion();
            }
        });
    });
    els.question.addEventListener('input', () => setQuestionError(false));

    // 一覧の操作（イベント委譲）
    els.list.addEventListener('click', onListClick);
    els.list.addEventListener('keydown', (e) => {
        if (!e.target.closest('.qa-edit')) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commitEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    });
    els.list.addEventListener('input', (e) => {
        if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
    });

    els.filter.addEventListener('change', () => {
        renderList();
        els.list.classList.remove('fade');
        void els.list.offsetWidth;
        els.list.classList.add('fade');
    });

    // ヘッダー
    $('open-btn').addEventListener('click', openFile);
    $('save-btn').addEventListener('click', exportFile);
    $('print-btn').addEventListener('click', printPDF);
    els.shareBtn.addEventListener('click', () => { closeMenu(); shareFile(); });
    $('new-btn').addEventListener('click', () => { closeMenu(); newDocument(); });
    els.fileInput.addEventListener('change', () => {
        const file = els.fileInput.files && els.fileInput.files[0];
        els.fileInput.value = '';
        if (file) importFile(file);
    });

    // メニュー
    els.menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        els.menuList.classList.contains('open') ? closeMenu() : openMenu(e.detail === 0);
    });
    document.addEventListener('click', (e) => {
        if (!els.menu.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
        // Ctrl/⌘+S でファイル保存
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            exportFile();
        }
        // Ctrl/⌘+O でファイルを開く
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'o') {
            e.preventDefault();
            openFile();
        }
    });

    // スマホ：フォームが画面外のときだけ「＋」ボタンを表示
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(([entry]) => {
            els.fab.classList.toggle('show', !entry.isIntersecting);
        }).observe(els.addCard);
    }
    els.fab.addEventListener('click', () => {
        els.addCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(() => els.question.focus({ preventScroll: true }), 350);
    });

    // ドラッグ＆ドロップでファイル読み込み
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        els.dropOverlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) els.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        els.dropOverlay.hidden = true;
        const file = e.dataTransfer.files[0];
        if (file) importFile(file);
    });

    // 別タブで変更されたら同期
    window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY || editingId) return;
        load();
        renderAll();
    });
}

function openMenu(byKeyboard = false) {
    els.menuList.classList.add('open');
    els.menuBtn.setAttribute('aria-expanded', 'true');
    const first = els.menuList.querySelector('button:not([hidden])');
    if (first && byKeyboard) first.focus();
}
function closeMenu() {
    if (!els.menuList.classList.contains('open')) return;
    els.menuList.classList.remove('open');
    els.menuBtn.setAttribute('aria-expanded', 'false');
}

/* ---------------- 質問の追加・編集・削除 ---------------- */

function setQuestionError(on) {
    els.question.classList.toggle('is-invalid', on);
    els.questionError.hidden = !on;
}

function addQuestion() {
    const question = els.question.value.trim();
    if (!question) {
        setQuestionError(true);
        els.question.focus();
        return;
    }
    const now = new Date().toISOString();
    const item = {
        id: newId(),
        question,
        answer: els.answer.value.trim(),
        tag: getCheckedTag(els.tags),
        createdAt: now,
        updatedAt: now
    };
    appData.questions.push(item);

    // 連続入力しやすいようにリセット（カテゴリは残す）
    els.question.value = '';
    els.answer.value = '';
    autoGrow(els.question);
    autoGrow(els.answer);
    els.question.focus({ preventScroll: true });

    save();
    renderList();
    expandIn(liById(item.id));
    flashItem(item.id, false);
    toast(item.answer ? '追加しました' : '追加しました（回答はあとで追加できます）');
}

function onListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = btn.closest('.qa');
    const id = li && li.dataset.id;
    switch (btn.dataset.action) {
        case 'edit': startEdit(id, 'question'); break;
        case 'answer': startEdit(id, 'answer'); break;
        case 'delete': deleteQuestion(id); break;
        case 'up': moveQuestion(id, -1); break;
        case 'down': moveQuestion(id, 1); break;
        case 'save': commitEdit(); break;
        case 'cancel': cancelEdit(); break;
    }
}

function startEdit(id, focusField) {
    if (editingId && editingId !== id) {
        // 他を編集中なら内容を保存してから切り替え
        commitEdit({ silent: true });
    }
    editingId = id;
    morphItem(id, () => {
        renderList();
        const el = liById(id);
        if (el) el.querySelectorAll('textarea').forEach(autoGrow);
    });
    const li = liById(id);
    if (!li) return;
    const target = li.querySelector(focusField === 'answer' ? '.edit-answer' : '.edit-question');
    if (target) {
        target.focus({ preventScroll: true });
        target.setSelectionRange(target.value.length, target.value.length);
        setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
    }
}

function commitEdit({ silent = false } = {}) {
    if (!editingId) return;
    const li = els.list.querySelector(`.qa[data-id="${cssEscape(editingId)}"]`);
    const item = appData.questions.find((q) => q.id === editingId);
    if (!li || !item) { editingId = null; renderList(); return; }

    const qInput = li.querySelector('.edit-question');
    const question = qInput.value.trim();
    if (!question) {
        if (silent) { editingId = null; return; }
        qInput.classList.add('is-invalid');
        qInput.focus();
        toast('質問・アドバイスは空にできません', { type: 'error' });
        return;
    }
    const answer = li.querySelector('.edit-answer').value.trim();
    const tag = getCheckedTag(li.querySelector('.chips'));
    const changed = item.question !== question || item.answer !== answer || item.tag !== tag;

    const id = editingId;
    editingId = null;
    if (changed) {
        Object.assign(item, { question, answer, tag, updatedAt: new Date().toISOString() });
        save();
    }
    if (silent) renderList();
    else morphItem(id, renderList);
    if (!silent) {
        flashItem(id, true);
        if (changed) toast('更新しました');
    }
}

function cancelEdit() {
    const id = editingId;
    editingId = null;
    morphItem(id, renderList);
    const li = id && els.list.querySelector(`.qa[data-id="${cssEscape(id)}"] [data-action="edit"]`);
    if (li) li.focus({ preventScroll: true });
}

async function deleteQuestion(id) {
    if (!appData.questions.some((q) => q.id === id)) return;
    await collapseOut(liById(id));
    const index = appData.questions.findIndex((q) => q.id === id);
    if (index < 0) return;
    const [item] = appData.questions.splice(index, 1);
    if (editingId === id) editingId = null;
    lastDeleted = { item, index };
    save();
    renderList();
    toast('削除しました', {
        actionLabel: '元に戻す',
        duration: 6000,
        onAction: () => {
            if (!lastDeleted) return;
            appData.questions.splice(Math.min(lastDeleted.index, appData.questions.length), 0, lastDeleted.item);
            const restoredId = lastDeleted.item.id;
            lastDeleted = null;
            save();
            renderList();
            expandIn(liById(restoredId));
            flashItem(restoredId, true);
        }
    });
}

function moveQuestion(id, dir) {
    if (editingId) commitEdit({ silent: true });
    const i = appData.questions.findIndex((q) => q.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= appData.questions.length) return;
    const list = appData.questions;
    [list[i], list[j]] = [list[j], list[i]];
    save();
    flip(renderList, id);
    const btn = els.list.querySelector(`.qa[data-id="${cssEscape(id)}"] [data-action="${dir < 0 ? 'up' : 'down'}"]`);
    if (btn && !btn.disabled) btn.focus({ preventScroll: true });
    else {
        const edit = els.list.querySelector(`.qa[data-id="${cssEscape(id)}"] [data-action="edit"]`);
        if (edit) edit.focus({ preventScroll: true });
    }
}

/* ---------------- 描画 ---------------- */

function renderAll() {
    els.title.value = appData.session.title;
    els.date.value = appData.session.date;
    renderMeta();
    renderList();
    updateDirtyIndicator();
}

function renderMeta() {
    const { title, date } = appData.session;
    els.previewTitle.textContent = title.trim() || 'タイトル未入力';
    els.previewTitle.classList.toggle('placeholder', !title.trim());
    els.previewDate.textContent = date ? `発表日：${formatDateJP(date)}` : '発表日：未設定';
    els.previewDate.classList.toggle('placeholder', !date);
}

function renderList() {
    const qs = appData.questions;
    const unanswered = qs.filter((q) => !q.answer.trim()).length;
    const filterOn = els.filter.checked;

    els.paper.classList.toggle('filter-on', filterOn);
    els.empty.hidden = qs.length > 0;
    els.filterEmpty.hidden = !(filterOn && qs.length > 0 && unanswered === 0);
    els.filterWrap.hidden = qs.length === 0;

    // 統計
    if (qs.length === 0) {
        els.stats.innerHTML = '';
    } else {
        els.stats.innerHTML = `
            <span class="stat">全 <b>${qs.length}</b> 件</span>
            ${unanswered > 0
                ? `<span class="stat stat-warn">未回答 <b>${unanswered}</b> 件</span>`
                : '<span class="stat stat-ok">すべて回答済み</span>'}`;
    }

    els.list.innerHTML = qs.map((item, i) => (
        item.id === editingId ? editItemHTML(item, i) : viewItemHTML(item, i, qs.length)
    )).join('');

    if (editingId) {
        const chips = els.list.querySelector('.qa.editing .chips');
        if (chips) makeChipsToggleable(chips);
    }
}

function viewItemHTML(item, i, total) {
    const answered = item.answer.trim() !== '';
    return `
    <li class="qa ${answered ? 'answered' : 'unanswered'}" data-id="${escapeHTML(item.id)}">
        <div class="qa-head">
            <span class="qa-num">#${i + 1}</span>
            ${item.tag ? `<span class="tag">${escapeHTML(item.tag)}</span>` : ''}
            ${answered ? '' : '<span class="badge-unanswered">未回答</span>'}
            <div class="qa-actions">
                <button type="button" class="ibtn" data-action="up" aria-label="#${i + 1} を上へ移動" title="上へ" ${i === 0 ? 'disabled' : ''}><svg class="icon"><use href="#i-up"/></svg></button>
                <button type="button" class="ibtn" data-action="down" aria-label="#${i + 1} を下へ移動" title="下へ" ${i === total - 1 ? 'disabled' : ''}><svg class="icon"><use href="#i-down"/></svg></button>
                <button type="button" class="ibtn" data-action="edit" aria-label="#${i + 1} を編集" title="編集"><svg class="icon"><use href="#i-edit"/></svg><span class="lbl">編集</span></button>
                <button type="button" class="ibtn danger" data-action="delete" aria-label="#${i + 1} を削除" title="削除"><svg class="icon"><use href="#i-trash"/></svg><span class="lbl">削除</span></button>
            </div>
        </div>
        <div class="qa-q"><span class="mark">Q.</span><p class="qa-text">${escapeHTML(item.question)}</p></div>
        ${answered
            ? `<div class="qa-a"><span class="mark">A.</span><p class="qa-text">${escapeHTML(item.answer)}</p></div>`
            : `<button type="button" class="add-answer" data-action="answer"><svg class="icon"><use href="#i-plus"/></svg>回答を追加</button>
               <div class="blank-answer" aria-hidden="true"><span class="mark">A.</span><div class="lines"></div></div>`}
    </li>`;
}

function editItemHTML(item, i) {
    const uid = escapeHTML(item.id);
    return `
    <li class="qa editing" data-id="${uid}">
        <div class="qa-head"><span class="qa-num">#${i + 1} を編集中</span></div>
        <div class="qa-edit">
            <div class="field">
                <label for="eq-${uid}">質問・アドバイス <span class="req">必須</span></label>
                <textarea id="eq-${uid}" class="edit-question" rows="2">${escapeHTML(item.question)}</textarea>
            </div>
            <div class="field">
                <label for="ea-${uid}">回答・今後の対応</label>
                <textarea id="ea-${uid}" class="edit-answer" rows="3" placeholder="回答や今後の対応を入力">${escapeHTML(item.answer)}</textarea>
            </div>
            <fieldset class="field">
                <legend>カテゴリ</legend>
                <div class="chips">${chipsHTML('tag-' + uid, item.tag)}</div>
            </fieldset>
            <div class="edit-actions">
                <button type="button" class="btn btn-ghost" data-action="cancel">キャンセル</button>
                <button type="button" class="btn btn-primary" data-action="save">保存</button>
            </div>
        </div>
    </li>`;
}

function flashItem(id, scroll) {
    const li = els.list.querySelector(`.qa[data-id="${cssEscape(id)}"]`);
    if (!li) return;
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
    // スマホで追加したとき、一覧が見えていなければスクロールしない（入力を続けやすくする）
    if (scroll) setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 280);
}

function updateDirtyIndicator() {
    const show = appData.dirty && appData.questions.length > 0;
    els.dirtyDot.hidden = !show;
    $('save-btn').title = show
        ? 'ファイルに保存していない変更があります（クリックで保存）'
        : 'ファイルとして保存（あとで続きを書けます）';
}

/* ---------------- ファイル入出力 ---------------- */

function baseFileName() {
    const title = appData.session.title.trim();
    const date = appData.session.date.replace(/-/g, '');
    const name = title || `アドバイス_${date || todayISO().replace(/-/g, '')}`;
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
}

function buildExportData() {
    return {
        format: FILE_FORMAT,
        version: FILE_VERSION,
        exportedAt: new Date().toISOString(),
        session: { ...appData.session },
        questions: appData.questions.map(({ id, question, answer, tag, createdAt, updatedAt }) =>
            ({ id, question, answer, tag, createdAt, updatedAt }))
    };
}

function buildFile() {
    if (editingId) commitEdit({ silent: true });
    const json = JSON.stringify(buildExportData(), null, 2);
    return new File([json], `${baseFileName()}.json`, { type: 'application/json' });
}

function exportFile() {
    if (appData.questions.length === 0 && !appData.session.title.trim()) {
        toast('保存する内容がありません', { type: 'error' });
        return;
    }
    const file = buildFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    appData.dirty = false;
    save({ markDirty: false });
    toast(`「${file.name}」を保存しました`);
}

async function shareFile() {
    if (appData.questions.length === 0) {
        toast('共有する内容がありません', { type: 'error' });
        return;
    }
    const file = buildFile();
    try {
        await navigator.share({ files: [file], title: file.name });
        appData.dirty = false;
        save({ markDirty: false });
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        toast('共有できませんでした。［保存］をお試しください', { type: 'error' });
    }
}

function openFile() {
    if (editingId) commitEdit({ silent: true });
    els.fileInput.click();
}

async function importFile(file) {
    if (file.size > MAX_FILE_SIZE) {
        toast('ファイルが大きすぎます', { type: 'error' });
        return;
    }
    let data;
    try {
        const text = await file.text();
        data = normalizeData(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (e) {
        toast(`読み込めませんでした：${e instanceof SyntaxError ? 'JSONファイルではありません' : e.message}`, { type: 'error' });
        return;
    }

    if (appData.questions.length > 0) {
        const unsaved = appData.dirty;
        const choice = await askDialog({
            title: `「${file.name}」を開く`,
            message: unsaved
                ? '今の内容はファイルに保存されていません。\n開くと今の内容は置き換えられます。'
                : '今の内容を、開いたファイルの内容に置き換えます。',
            buttons: unsaved
                ? [
                    { label: '今の内容を保存してから開く', value: 'save', variant: 'primary' },
                    { label: '保存せずに開く', value: 'discard', variant: 'danger' },
                    { label: 'キャンセル', value: 'cancel', variant: 'plain' }
                ]
                : [
                    { label: '開く', value: 'discard', variant: 'primary' },
                    { label: 'キャンセル', value: 'cancel', variant: 'plain' }
                ]
        });
        if (choice === 'cancel') return;
        if (choice === 'save') exportFile();
    }

    editingId = null;
    lastDeleted = null;
    data.dirty = false;
    appData = data;
    save({ markDirty: false });
    renderAll();
    if (motionOK() && els.paper.animate) {
        els.paper.animate([{ opacity: .3, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    }

    const un = appData.questions.filter((q) => !q.answer.trim()).length;
    toast(`読み込みました（${appData.questions.length}件${un ? `・未回答${un}件` : ''}）`);

    // 未回答があれば最初の未回答へ
    const first = appData.questions.find((q) => !q.answer.trim());
    if (first) {
        const li = els.list.querySelector(`.qa[data-id="${cssEscape(first.id)}"]`);
        if (li && window.matchMedia('(min-width: 1024px)').matches) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

async function newDocument() {
    const hasData = appData.questions.length > 0 || appData.session.title.trim();
    if (hasData) {
        const unsaved = appData.dirty && appData.questions.length > 0;
        const choice = await askDialog({
            title: '新規作成',
            message: unsaved
                ? 'ファイルに保存していない内容があります。\n新規作成すると、今の内容は消えます。'
                : '今の内容を消して、新しく始めます。\n（保存済みのファイルはそのまま残ります）',
            buttons: unsaved
                ? [
                    { label: '保存してから新規作成', value: 'save', variant: 'primary' },
                    { label: '保存せずに新規作成', value: 'discard', variant: 'danger' },
                    { label: 'キャンセル', value: 'cancel', variant: 'plain' }
                ]
                : [
                    { label: '新規作成する', value: 'discard', variant: 'danger-solid' },
                    { label: 'キャンセル', value: 'cancel', variant: 'plain' }
                ]
        });
        if (choice === 'cancel') return;
        if (choice === 'save') exportFile();
    }
    // このアプリのデータだけを消す（同じドメインの他ツールのデータは消さない）
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* noop */ }
    appData = createEmptyData();
    editingId = null;
    lastDeleted = null;
    els.form.reset();
    els.tags.querySelectorAll('input').forEach((i) => { i.checked = false; });
    setQuestionError(false);
    els.filter.checked = false;
    renderAll();
    autoGrow(els.question);
    autoGrow(els.answer);
    if (motionOK() && els.paper.animate) {
        els.paper.animate([{ opacity: .3, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    }
    window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' });
    toast('新規作成しました');
}

/* ---------------- PDF（印刷） ---------------- */

function printPDF() {
    if (editingId) commitEdit({ silent: true });
    if (appData.questions.length === 0) {
        toast('質問を1件以上追加してください', { type: 'error' });
        els.question.focus();
        return;
    }
    if (!appData.session.title.trim()) {
        toast('タイトルを入力してください', { type: 'error' });
        els.title.focus();
        els.title.classList.add('is-invalid');
        els.title.addEventListener('input', () => els.title.classList.remove('is-invalid'), { once: true });
        return;
    }
    if (!appData.session.date) {
        toast('発表日を入力してください', { type: 'error' });
        els.date.focus();
        return;
    }

    const originalTitle = document.title;
    document.title = baseFileName();       // PDFのファイル名の初期値になる
    const restore = () => { document.title = originalTitle; };
    window.addEventListener('afterprint', restore, { once: true });
    // Chrome対策：タイトル変更を反映させてから印刷
    setTimeout(() => {
        window.print();
        setTimeout(restore, 1000);
    }, 50);
}

/* ---------------- ユーティリティ ---------------- */

function toast(message, { type = 'info', actionLabel, onAction, duration = 3000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' error' : ''}`;
    el.innerHTML = `<span class="toast-msg"></span>`;
    el.querySelector('.toast-msg').textContent = message;
    if (actionLabel) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = actionLabel;
        b.addEventListener('click', () => { onAction && onAction(); dismissToast(el); });
        el.appendChild(b);
    }
    // 前のトーストは消して、常に最新の1件だけ表示
    [...els.toastArea.children].forEach(dismissToast);
    els.toastArea.appendChild(el);
    setTimeout(() => dismissToast(el), duration);
}

function dismissToast(el) {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    if (!motionOK()) { el.remove(); return; }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
}

/**
 * 確認ダイアログ（スマホは下からのシート、PCは中央）
 * buttons: [{ label, value, variant }] → 押したボタンの value を返す。閉じたら 'cancel'
 */
function askDialog({ title, message, buttons }) {
    const dlg = $('dialog');
    if (!dlg || typeof dlg.showModal !== 'function') {
        // 古いブラウザ用
        const main = buttons[0];
        return Promise.resolve(confirm(`${title}\n\n${message}`) ? main.value : 'cancel');
    }
    return new Promise((resolve) => {
        $('dlg-title').textContent = title;
        $('dlg-msg').textContent = message;
        const actions = $('dlg-actions');
        actions.innerHTML = '';
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            dlg.classList.remove('visible');
            setTimeout(() => { dlg.close(); resolve(value); }, motionOK() ? 240 : 0);
        };
        buttons.forEach((b) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn btn-${b.variant || 'ghost'}`;
            btn.textContent = b.label;
            btn.addEventListener('click', () => finish(b.value));
            actions.appendChild(btn);
        });
        dlg.oncancel = (e) => { e.preventDefault(); finish('cancel'); };
        dlg.onclick = (e) => { if (e.target === dlg) finish('cancel'); };
        dlg.showModal();
        requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.add('visible')));
    });
}

function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 480) + 'px';
    ta.style.overflowY = ta.scrollHeight > 480 ? 'auto' : 'hidden';
}

function formatDateJP(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    const w = '日月火水木金土'[d.getDay()];
    return `${+m[1]}年${+m[2]}月${+m[3]}日（${w}）`;
}

function escapeHTML(s) {
    return str(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

document.addEventListener('DOMContentLoaded', init);
