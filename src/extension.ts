import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

let timer: NodeJS.Timeout | undefined;
let currentPanelOpen = false;
let isDisabledThisSession = false;
let isPausedManually = false;


function notifyBreak(context: vscode.ExtensionContext) {
    const soundPath = path.join(context.extensionPath, 'media', 'mysound.wav');
    exec(`powershell -c (New-Object Media.SoundPlayer '${soundPath}').PlaySync()`);
}

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

        notifyBreak(context);

        if (!currentPanelOpen) {
            vscode.window.showInformationMessage(
                'Пришло время выбрать перерыв!',
                'Выбрать перерыв'
            ).then(selection => {
                if (selection === 'Выбрать перерыв') {
                    showMainMenu(context);
                }
            });
        } else {
            showMainMenu(context);
        }

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
        } else if (msg.command === 'setWorkTime') {
            panel.dispose();
            currentPanelOpen = false;
            await showSetWorkTime(context);
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

    const recommendations = [
    '👀 Сделай зарядку для глаз.',
    '💧 Обязательно попей воды.',
    '🤸 Встань и разомнись: наклоны, повороты шеи.',
    '🏋️ Не забывай следить за осанкой.',
    '😈 Так уж и быть, разрешаю сбегать в туалет'
    ];

    const panel = vscode.window.createWebviewPanel(
        'breakPanel',
        `Перерыв ${breakMinutes} мин`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const html = `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Перерыв</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; text-align:center; background:#1e1e1e; color:#fff; padding:20px; }
        h2 { font-size: 26px; } 
        #timer { font-size: 48px; margin: 20px 0; } 
        button { padding:10px 14px; margin:10px; border:none; border-radius:8px; cursor:pointer; background:#0e639c; color:#fff; }
        ul { text-align:left; display:inline-block; font-size:16px; } 
    </style>
    </head>
    <body>
      <h2>Перерыв ${breakMinutes} мин</h2>
      <div id="timer">${breakMinutes}:00</div>
      <ul>${recommendations.map(r => `<li>${r}</li>`).join('')}</ul>
      <br>
      <button id="end">Завершить перерыв</button>
      <script>
        const vscode = acquireVsCodeApi();
        let seconds = ${breakMinutes * 60};
        const timerEl = document.getElementById('timer');

        const interval = setInterval(() => {
          seconds--;
          const m = Math.floor(seconds/60);
          const s = seconds % 60;
          timerEl.textContent = m + ':' + (s < 10 ? '0'+s : s);
          if (seconds <= 0) {
            clearInterval(interval);
            vscode.postMessage({ command: 'breakEnded' });
          }
        }, 1000);

        document.getElementById('end').addEventListener('click', () => {
          clearInterval(interval);
          vscode.postMessage({ command: 'breakEnded' });
        });
      </script>
    </body>
    </html>
    `;

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(msg => {
        if (!msg?.command) return;

        if (msg.command === 'breakEnded') {
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

    const panel = vscode.window.createWebviewPanel(
        'snoozeChooser',
        'Отложить перерыв',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'snooze.html');
    let html = '<html><body><h3>Ошибка загрузки панели</h3></body></html>';
    try {
        html = fs.readFileSync(htmlPath, 'utf8');
    } catch(e) {
        console.error(e);
    }

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(msg => {
        if (!msg?.command) return;
        if (msg.command === 'confirmSnooze' && typeof msg.minutes === 'number') {
            const ms = Math.max(1000, Math.round(msg.minutes * 60 * 1000));
            if (timer) { clearTimeout(timer); timer = undefined; }
            timer = setTimeout(() => { showMainMenu(context); }, ms);
            panel.dispose();
            currentPanelOpen = false;
        } else if (msg.command === 'cancelSnooze') {
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

async function showSetWorkTime(context: vscode.ExtensionContext) {
    currentPanelOpen = true;

    const panel = vscode.window.createWebviewPanel(
        'setWorkTime',
        'Настроить рабочее время',
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, 'media', 'setWorkTime.html');
    let html = '<html><body><h3>Ошибка загрузки панели</h3></body></html>';
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch(e){ console.error(e); }

    panel.webview.html = html;

    const sub = panel.webview.onDidReceiveMessage(msg => {
        if (!msg?.command) return;
        if (msg.command === 'workTimeSelected' && typeof msg.minutes === 'number') {
            context.globalState.update('workMinutes', msg.minutes);
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

export function deactivate() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    currentPanelOpen = false;
    isDisabledThisSession = false;
}
