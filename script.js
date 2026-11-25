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
const CATEGORIES = ['企画・調査', '設計', '実験・試作', '工作教室準備', 'その他'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;

let appData = createEmptyData();
let editingId = null;          // 編集中の項目ID
let lastDeleted = null;        // 元に戻す用 { item, index }

const $ = (id) => document.getElementById(id);
const els = {};

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

    els.filter.addEventListener('change', renderList);

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
        els.menuList.hidden ? openMenu() : closeMenu();
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
            els.fab.hidden = entry.isIntersecting;
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

function openMenu() {
    els.menuList.hidden = false;
    els.menuBtn.setAttribute('aria-expanded', 'true');
    const first = els.menuList.querySelector('button:not([hidden])');
    if (first) first.focus();
}
function closeMenu() {
    if (els.menuList.hidden) return;
    els.menuList.hidden = true;
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
    renderList();
    const li = els.list.querySelector(`.qa[data-id="${cssEscape(id)}"]`);
    if (!li) return;
    li.querySelectorAll('textarea').forEach(autoGrow);
    const target = li.querySelector(focusField === 'answer' ? '.edit-answer' : '.edit-question');
    if (target) {
        target.focus({ preventScroll: true });
        target.setSelectionRange(target.value.length, target.value.length);
        li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    renderList();
    if (!silent) {
        flashItem(id, true);
        if (changed) toast('更新しました');
    }
}

function cancelEdit() {
    const id = editingId;
    editingId = null;
    renderList();
    const li = id && els.list.querySelector(`.qa[data-id="${cssEscape(id)}"] [data-action="edit"]`);
    if (li) li.focus({ preventScroll: true });
}

function deleteQuestion(id) {
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
    renderList();
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
    if (scroll) li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

    const hasCurrent = appData.questions.length > 0;
    if (hasCurrent) {
        const msg = appData.dirty
            ? '今の内容はファイルに保存されていません。\n読み込むと今の内容は置き換えられます。続けますか？'
            : '今の内容を、読み込んだファイルの内容に置き換えます。よろしいですか？';
        if (!confirm(msg)) return;
    }

    editingId = null;
    lastDeleted = null;
    data.dirty = false;
    appData = data;
    save({ markDirty: false });
    renderAll();

    const un = appData.questions.filter((q) => !q.answer.trim()).length;
    toast(`読み込みました（${appData.questions.length}件${un ? `・未回答${un}件` : ''}）`);

    // 未回答があれば最初の未回答へ
    const first = appData.questions.find((q) => !q.answer.trim());
    if (first) {
        const li = els.list.querySelector(`.qa[data-id="${cssEscape(first.id)}"]`);
        if (li && window.matchMedia('(min-width: 1024px)').matches) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function newDocument() {
    const hasData = appData.questions.length > 0 || appData.session.title.trim();
    if (hasData) {
        const msg = appData.dirty && appData.questions.length > 0
            ? 'ファイルに保存していない内容があります。\nすべて消して新規作成しますか？（この操作は戻せません）'
            : 'すべての入力を消して新規作成しますか？';
        if (!confirm(msg)) return;
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
        b.addEventListener('click', () => { onAction && onAction(); el.remove(); });
        el.appendChild(b);
    }
    // 古いものは消して最大2件まで
    while (els.toastArea.children.length >= 2) els.toastArea.firstElementChild.remove();
    els.toastArea.appendChild(el);
    setTimeout(() => el.remove(), duration);
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
