// Central App State
let appData = {
    session: {
        title: "",
        date: "",
        folder: ""
    },
    questions: []
};

// DOM Cache Elements
const sessionTitleInput = document.getElementById('session-title');
const sessionDateInput = document.getElementById('session-date');
const qaForm = document.getElementById('qa-form');
const previewTitle = document.getElementById('preview-title');
const previewDate = document.getElementById('preview-date');
const previewList = document.getElementById('preview-list');
const emptyState = document.getElementById('empty-state');
const printBtn = document.getElementById('print-btn');
const clearBtn = document.getElementById('clear-btn');
const announcement = document.getElementById('announcement');

// Initialize Application
function init() {
    loadFromLocalStorage();
    setupEventListeners();
    renderAll();
}

// 必須入力項目のバリデーションチェック
function checkRequiredFields() {
    const isTitleValid = sessionTitleInput.value.trim() !== "";
    const isDateValid = sessionDateInput.value !== "";
    const hasQuestions = appData.questions.length > 0;

    const qaQuestionInput = document.getElementById('qa-question');
    const qaAnswerInput = document.getElementById('qa-answer');
    const qaTagSelect = document.getElementById('qa-tag');

    const qText = qaQuestionInput.value.trim();
    const aText = qaAnswerInput.value.trim();
    const tagText = qaTagSelect.value;

    const isQAFormEmpty = qText === "" && aText === "" && tagText === "";
    const isQAFormComplete = qText !== "" && aText !== "" && tagText !== "";
    const isQAValid = isQAFormEmpty || isQAFormComplete;

    // すべての条件が満たされていれば有効化
    if (isTitleValid && isDateValid && hasQuestions && isQAValid) {
        printBtn.disabled = false;
    } else {
        printBtn.disabled = true;
    }
}

// Event Listeners Registration
function setupEventListeners() {
    // Realtime Title/Meta Synchronization
    sessionTitleInput.addEventListener('input', (e) => {
        appData.session.title = e.target.value;
        updateMetaPreview();
        checkRequiredFields();
        saveToLocalStorage();
    });

    sessionDateInput.addEventListener('input', (e) => {
        appData.session.date = e.target.value;
        updateMetaPreview();
        checkRequiredFields();
        saveToLocalStorage();
    });

    // Q&A フォームの入力監視イベント
    document.getElementById('qa-question').addEventListener('input', checkRequiredFields);
    document.getElementById('qa-answer').addEventListener('input', checkRequiredFields);
    document.getElementById('qa-tag').addEventListener('change', checkRequiredFields);

    // Form submission for adding dynamic Q&A items
    qaForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const qText = document.getElementById('qa-question').value.trim();
        const aText = document.getElementById('qa-answer').value.trim();
        const tag = document.getElementById('qa-tag').value;

        if (!qText || !aText || !tag) return;

        const newQuestion = {
            id: 'q_' + Date.now(),
            question: qText,
            answer: aText,
            tag: tag
        };

        appData.questions.push(newQuestion);
        
        // Reset form inputs for continuous entry workflow speed
        document.getElementById('qa-question').value = '';
        document.getElementById('qa-answer').value = '';
        document.getElementById('qa-tag').value = '';
        document.getElementById('qa-question').focus();

        // Screen reader announcement for high accessibility status
        announceToScreenReader("新しい質問を追加しました。");

        renderQuestions();
        checkRequiredFields();
        saveToLocalStorage();
    });

    // Print Command Strategy (Uses optimized browser printer system)
    printBtn.addEventListener('click', () => {
        const originalTitle = document.title;
        
        // 入力された日付を取得し、ハイフンを取り除く（例: 2026-06-20 -> 20260620）
        const sessionDate = appData.session.date ? appData.session.date.replace(/-/g, "") : "";
        
        // デフォルトファイル名を「アドバイス_日付」の形式にセット
        document.title = `アドバイス_${sessionDate}`;
        
        // Chrome対策：タイトル変更をブラウザに確実同期させるため、一瞬遅らせてから印刷を実行
        setTimeout(() => {
            window.print();
            
            // 印刷ダイアログにタイトル名が確実に渡るよう、少し遅らせて元のタブ名に戻す
            setTimeout(() => {
                document.title = originalTitle;
            }, 100);
        }, 50);
    });

    // Clear whole dashboard data
    clearBtn.addEventListener('click', () => {
        if (confirm("全ての入力データを削除して初期化しますか？この操作は戻せません。")) {
            localStorage.clear();
            appData = {
                session: { title: "", date: "" },
                questions: []
            };
            // Clear inputs
            sessionTitleInput.value = "";
            sessionDateInput.value = "";
            qaForm.reset();
            
            announceToScreenReader("データを完全にクリアしました。");
            renderAll();
        }
    });
}

// Synchronize text data to metadata view
function updateMetaPreview() {
    previewTitle.textContent = appData.session.title || "タイトルを入力してください";
    previewDate.textContent = appData.session.date ? `発表日：${appData.session.date}` : "発表日：未設定";
}

// Render whole Q&A Array list into document DOM
function renderQuestions() {
    // Clear dynamic list items
    const dynamicItems = previewList.querySelectorAll('.qa-card');
    dynamicItems.forEach(item => item.remove());

    if (appData.questions.length === 0) {
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

    appData.questions.forEach((item, index) => {
        const card = document.createElement('article');
        card.className = "qa-card border-b border-slate-100 !mt-2 pt-2 flex flex-col gap-3 relative";
        card.setAttribute('aria-label', `質問番号 ${index + 1}`);

        card.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                    <span class="text-xs font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">${item.tag}</span>
                </div>
                <button onclick="deleteQuestion('${item.id}')" class="no-print text-xs font-semibold text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400" aria-label="質問 ${index + 1} を削除">
                    削除
                </button>
            </div>
            <div class="space-y-1.5">
                <h4 class="text-sm font-bold text-slate-900 flex gap-2">
                    <span class="text-brand-accent shrink-0">Q.</span>
                    <span class="whitespace-pre-wrap">${escapeHTML(item.question)}</span>
                </h4>
                <div class="text-sm text-slate-700 flex gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <span class="text-slate-400 font-bold shrink-0">A.</span>
                    <p class="whitespace-pre-wrap flex-1">${escapeHTML(item.answer)}</p>
                </div>
            </div>
        `;
        previewList.appendChild(card);
    });
}

// Action logic to eliminate item
window.deleteQuestion = function(id) {
    appData.questions = appData.questions.filter(q => q.id !== id);
    announceToScreenReader("質問を削除しました。");
    renderQuestions();
    checkRequiredFields();
    saveToLocalStorage();
};

// Full layout synchronization
function renderAll() {
    // Set form input states initially
    sessionTitleInput.value = appData.session.title;
    sessionDateInput.value = appData.session.date;

    updateMetaPreview();
    renderQuestions();
    checkRequiredFields(); // 読み込み時にもボタン状態を判定
}

// Local Storage data persistence layers
function saveToLocalStorage() {
    localStorage.setItem('qa_tool_backup', JSON.stringify(appData));
}

function loadFromLocalStorage() {
    const raw = localStorage.getItem('qa_tool_backup');
    if (raw) {
        try {
            appData = JSON.parse(raw);
        } catch(e) {
            console.error("Local storage structure broken", e);
        }
    }
}

// Accessibility helper function to announce state updates
function announceToScreenReader(message) {
    announcement.textContent = message;
    setTimeout(() => { announcement.textContent = ""; }, 1000);
}

// Basic security sanitization helper
function escapeHTML(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Run Core Instance
document.addEventListener('DOMContentLoaded', init);