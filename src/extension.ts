import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let timer: NodeJS.Timeout | undefined;
let currentPanelOpen = false;
let isDisabledThisSession = false;
let isPausedManually = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('Break Reminder activated');

    const cfg = vscode.workspace.getConfiguration('breakReminder');
    const defaultWork = cfg.get<number>('defaultWorkMinutes', 30);
    const stored = context.globalState.get<number>('workMinutes');
    if (!stored) context.globalState.update('workMinutes', defaultWork);

    if (!isDisabledThisSession) startWorkTimer(context);

    context.subscriptions.push({ dispose: () => deactivate() });
}

function getWorkMinutes(context: vscode.ExtensionContext): number {
    const v = context.globalState.get<number>('workMinutes');
    if (typeof v === 'number' && v > 0) return v;
    return vscode.workspace.getConfiguration('breakReminder').get<number>('defaultWorkMinutes', 30);
}

function startWorkTimer(context: vscode.ExtensionContext) {
    if (currentPanelOpen || isDisabledThisSession || isPausedManually) return;

    if (timer) { clearTimeout(timer); timer = undefined; }

    const minutes = getWorkMinutes(context);
    const ms = Math.max(1000, Math.round(minutes * 60 * 1000));
    console.log(`Starting work timer: ${minutes} minutes (${ms} ms)`);

    timer = setTimeout(() => {
        if (timer) { clearTimeout(timer); timer = undefined; }
        showMainMenu(context);
    }, ms);
}

function showMainMenu(context: vscode.ExtensionContext) {
    currentPanelOpen = true;
    isPausedManually = true;

    const panel = vscode.window.createWebviewPanel(
        'breakReminderMain',
        'Break Reminder',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'panel.html');
    let html = '<html><body><h3>Ошибка загрузки панели</h3></body></html>';
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch(e){ console.error(e); }
    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg?.command) return;

        if (msg.command === 'startBreak') {
            panel.dispose();
            currentPanelOpen = false;
            await showBreakChooser(context);
        } else if (msg.command === 'skipBreak') {
            panel.dispose();
            currentPanelOpen = false;
            isPausedManually = false;
            startWorkTimer(context);
        } else if (msg.command === 'snoozeBreak') {
            panel.dispose();
            currentPanelOpen = false;
            await askSnoozeAndStart(context);
        } else if (msg.command === 'disablePlugin') {
            panel.dispose();
            currentPanelOpen = false;
            isDisabledThisSession = true;
            if (timer) { clearTimeout(timer); timer = undefined; }
            vscode.window.showInformationMessage('Break Reminder отключён в этой сессии.');
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

async function showBreakChooser(context: vscode.ExtensionContext) {
    currentPanelOpen = true;

    const panel = vscode.window.createWebviewPanel(
        'breakChooser',
        'Выберите длительность перерыва',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'break.html');
    let html = '<html><body><h3>Ошибка загрузки панели</h3></body></html>';
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch(e){ console.error(e); }
    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg?.command) return;

        if (msg.command === 'breakDurationSelected' && typeof msg.minutes === 'number') {
            const minutes = msg.minutes;
            panel.dispose();
            currentPanelOpen = false;
            await openBreakPanel(context, minutes);
        } else if (msg.command === 'backToMain') {
            panel.dispose();
            currentPanelOpen = false;
            showMainMenu(context);
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}

async function openBreakPanel(context: vscode.ExtensionContext, breakMinutes: number) {
    currentPanelOpen = true;
    isPausedManually = true;

    const panel = vscode.window.createWebviewPanel(
        'breakPanel',
        `Перерыв ${breakMinutes} мин`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'snooze.html');
    let html = '<html><body>Ошибка загрузки панели</body></html>';
    try {
        html = fs.readFileSync(htmlPath, 'utf8') + `\n<!-- ${Date.now()} -->`;
    } catch(e) { console.error(e); }

    panel.webview.html = html;

    const breakMs = breakMinutes * 60 * 1000;
    const breakTimer = setTimeout(() => {
        if (panel) panel.dispose();
        vscode.window.showInformationMessage('Перерыв завершён, работа продолжается.');
        currentPanelOpen = false;
        isPausedManually = false;
        startWorkTimer(context);
    }, breakMs);

    const sub = panel.webview.onDidReceiveMessage(msg => {
        if (!msg?.command) return;
        if (msg.command === 'breakEnded') {
            clearTimeout(breakTimer);
            panel.dispose();
            vscode.window.showInformationMessage('Перерыв завершён, работа продолжается.');
            currentPanelOpen = false;
            isPausedManually = false;
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
    isPausedManually = true;

    const panel = vscode.window.createWebviewPanel(
        'snoozeChooser',
        'Отложить перерыв',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    // Читаем файл snooze.html
    const htmlPath = path.join(context.extensionPath, 'media', 'snooze.html');
    let html = '<html><body>Ошибка загрузки панели</body></html>';
    try {
        html = fs.readFileSync(htmlPath, 'utf8') + `\n<!-- ${Date.now()} -->`;
    } catch (e) {
        console.error(e);
    }

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(msg => {
        if (!msg?.command) return;

        if (msg.command === 'confirmSnooze' && typeof msg.minutes === 'number') {
            // Конвертируем минуты в миллисекунды
            const ms = Math.max(1000, Math.round(msg.minutes * 60 * 1000));

            // Отменяем старый таймер, если был
            if (timer) { clearTimeout(timer); timer = undefined; }

            // Устанавливаем таймер на отложенный перерыв
            timer = setTimeout(() => { showMainMenu(context); }, ms);

            panel.dispose();
            currentPanelOpen = false;
        } else if (msg.command === 'cancelSnooze') {
            panel.dispose();
            currentPanelOpen = false;
            // Возвращаемся в главное меню
            showMainMenu(context);
        }
    });

    panel.onDidDispose(() => {
        sub.dispose();
        currentPanelOpen = false;
    });
}


export function deactivate() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    currentPanelOpen = false;
    isDisabledThisSession = false;
}
