import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import notifier = require('node-notifier');

let timer: NodeJS.Timeout | undefined;
let isDisabledThisSession = false;
let currentPanelOpen = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('✅ Break Reminder activated');

    const cfg = vscode.workspace.getConfiguration('breakReminder');
    const defaultWork = cfg.get<number>('defaultWorkMinutes', 30);
    const stored = context.globalState.get<number>('workMinutes');
    if (!stored) context.globalState.update('workMinutes', defaultWork);

    const testMode = cfg.get<boolean>('testMode', false);
    if (testMode) context.globalState.update('workMinutes', 0.1666);

    if (!isDisabledThisSession) startWorkTimer(context);
}

function getWorkMinutes(context: vscode.ExtensionContext): number {
    const v = context.globalState.get<number>('workMinutes');
    if (typeof v === 'number' && v > 0) return v;
    return vscode.workspace.getConfiguration('breakReminder').get<number>('defaultWorkMinutes', 30);
}

function startWorkTimer(context: vscode.ExtensionContext) {
    if (isDisabledThisSession) return;
    if (currentPanelOpen) {
        console.log('⏸ Не запускаем таймер: открыто окно.');
        return;
    }

    if (timer) clearTimeout(timer);

    const minutes = getWorkMinutes(context);
    const ms = Math.max(1000, Math.round(minutes * 60 * 1000));
    console.log(`▶️ Запуск рабочего таймера: ${minutes} мин (${ms} мс)`);

    timer = setTimeout(() => {
        clearTimeout(timer);
        timer = undefined;
        showMainMenu(context);
    }, ms);
}

function showMainMenu(context: vscode.ExtensionContext, fromUser = false) {
    if (isDisabledThisSession) return;

    // если уже открыто окно — ничего не делаем
    if (currentPanelOpen) {
        console.log('⚠️ Меню уже открыто');
        return;
    }

    // 🚫 Если мы вернулись вручную (нажал "Назад" или "Отмена") — не показываем уведомление
    if (!fromUser) {
        try {
            notifier.notify({
                title: '☕ Break Reminder',
                message: 'Пора сделать перерыв!',
                sound: true,
            });
        } catch (err) {
            console.error('notifier error', err);
        }
    }

    currentPanelOpen = true;

    const panel = vscode.window.createWebviewPanel(
        'breakReminderMain',
        'Break Reminder',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'panel.html');
    let html = '<html><body><h3>Ошибка загрузки</h3></body></html>';
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch {}

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async msg => {
        switch (msg?.command) {
            case 'startBreak':
                panel.dispose();
                currentPanelOpen = false;
                await showBreakChooser(context);
                break;

            case 'skipBreak':
                panel.dispose();
                currentPanelOpen = false;
                startWorkTimer(context);
                break;

            case 'snoozeBreak':
                panel.dispose();
                currentPanelOpen = false;
                await askSnoozeAndStart(context);
                break;

            case 'disablePlugin':
                panel.dispose();
                currentPanelOpen = false;
                isDisabledThisSession = true;
                if (timer) clearTimeout(timer);
                vscode.window.showInformationMessage('Break Reminder отключён до перезапуска VS Code.');
                break;

            case 'setWorkTime':
                await handleSetWorkTime(context, panel);
                break;
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

async function handleSetWorkTime(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    const options = [
        { label: '10 секунд (тест)', value: 0.1666 },
        { label: '1 минута', value: 1 },
        { label: '5 минут', value: 5 },
        { label: '10 минут', value: 10 },
        { label: '15 минут', value: 15 },
        { label: '20 минут', value: 20 },
        { label: '30 минут', value: 30 },
        { label: '45 минут', value: 45 },
        { label: '60 минут', value: 60 }
    ];
    const choice = await vscode.window.showQuickPick(options.map(o => o.label), {
        placeHolder: 'Выберите длительность рабочего времени'
    });
    const sel = options.find(o => o.label === choice);
    if (sel) {
        await context.globalState.update('workMinutes', sel.value);
        vscode.window.showInformationMessage(`Рабочее время: ${sel.label}`);
        if (timer) clearTimeout(timer);
        startWorkTimer(context);
        panel.dispose();
        currentPanelOpen = false;
    }
}

async function showBreakChooser(context: vscode.ExtensionContext) {
    currentPanelOpen = true;
    if (timer) clearTimeout(timer);

    const panel = vscode.window.createWebviewPanel(
        'breakChooser',
        'Выбор длительности перерыва',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'break.html');
    let html = '<html><body><h3>Ошибка загрузки</h3></body></html>';
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch {}
    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async msg => {
        if (msg?.command === 'breakDurationSelected') {
            panel.dispose();
            currentPanelOpen = false;
            await openBreakPanel(context, msg.minutes);
        } else if (msg?.command === 'backToMain') {
            // просто вернуться в меню, без таймера
            panel.dispose();
            currentPanelOpen = false;
            showMainMenu(context,true);
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

async function openBreakPanel(context: vscode.ExtensionContext, breakMinutes: number) {
    currentPanelOpen = true;

    const recommendations = [
        'Посмотри вдаль 20 секунд.',
        'Выпей воды.',
        'Потянись или походи немного.',
        'Сделай 10 приседаний.',
        'Моргни 20 раз для глаз.'
    ];

    const panel = vscode.window.createWebviewPanel(
        'breakPanel',
        `Перерыв ${breakMinutes} мин`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'break.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('/*__INJECT_PAYLOAD__*/',
        `window.__BR_PAYLOAD__=${JSON.stringify({ minutes: breakMinutes, recommendations })};`);
    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async msg => {
        if (msg?.command === 'breakEnded') {
            panel.dispose();
            currentPanelOpen = false;
            startWorkTimer(context);
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

async function askSnoozeAndStart(context: vscode.ExtensionContext) {
    currentPanelOpen = true;
    if (timer) clearTimeout(timer);

    const panel = vscode.window.createWebviewPanel(
        'snoozeChooser',
        'Отложить перерыв',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const html = `
    <html><body style="background:#1e1e1e;color:white;text-align:center;padding:20px;">
    <h2>Отложить перерыв</h2>
    <select id="snoozeTime" style="padding:8px;background:#333;color:white;border:none;border-radius:6px;">
      <option value="0.1666">10 секунд (тест)</option>
      <option value="1">1 минута</option>
      <option value="5">5 минут</option>
      <option value="10">10 минут</option>
      <option value="15">15 минут</option>
    </select><br><br>
    <button id="apply" style="background:#0e639c;color:white;padding:10px 18px;border:none;border-radius:8px;">Отложить</button>
    <button id="cancel" style="background:#666;color:white;padding:10px 18px;border:none;border-radius:8px;margin-left:8px;">Отмена</button>
    <script>
      const vscode = acquireVsCodeApi();
      document.getElementById('apply').onclick=()=>vscode.postMessage({command:'confirmSnooze',minutes:parseFloat(document.getElementById('snoozeTime').value)});
      document.getElementById('cancel').onclick=()=>vscode.postMessage({command:'cancelSnooze'});
    </script></body></html>`;

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async msg => {
        if (msg?.command === 'confirmSnooze') {
            const ms = Math.max(1000, Math.round(msg.minutes * 60 * 1000));
            vscode.window.showInformationMessage(`Перерыв отложен на ${msg.minutes} мин.`);
            timer = setTimeout(() => showMainMenu(context), ms);
            panel.dispose();
            currentPanelOpen = false;
        } else if (msg?.command === 'cancelSnooze') {
            panel.dispose();
            currentPanelOpen = false;
            showMainMenu(context,true);
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

export function deactivate() {
    console.log('🛑 Break Reminder deactivated');
    if (timer) clearTimeout(timer);
    isDisabledThisSession = false;
}
