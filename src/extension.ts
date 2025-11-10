import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

let timer: NodeJS.Timeout | undefined;
let currentPanelOpen = false;
let isDisabledThisSession = false;
let isPausedManually = false;


function notifyBreak(context: vscode.ExtensionContext) {
    /*
    Описание:
        Функция отвечает за воспроизведение звукового сигнала при наступлении перерыва.
        Она принимает путь к файлу mysound.wav, хранящемуся в папке media плагина, и воспроизводит его средствами PowerShell.

    Пример работы:   
        Когда заканчивается рабочий таймер, вызывается notifyBreak(context) - пользователь слышит звуковое уведомление, что пора сделать перерыв.
    */
    const soundPath = path.join(context.extensionPath, 'media', 'mysound.wav');
    exec(`powershell -c (New-Object Media.SoundPlayer '${soundPath}').PlaySync()`);
}

export function activate(context: vscode.ExtensionContext) {
    /*
    Описание:
        Главная функция активации расширения VS Code.
        Вызывается автоматически при запуске редактора.
        Инициализирует значения по умолчанию, считывает настройки из settings.json, запускает рабочий таймер, если плагин не отключён пользователем.
        Также регистрирует обработчик деактивации.

    Пример работы:
        После открытия VS Code плагин автоматически запустится и начнёт отсчёт времени до следующего перерыва.
     */
    console.log('Break Reminder activated');

    const cfg = vscode.workspace.getConfiguration('breakReminder');
    const defaultWork = cfg.get<number>('defaultWorkMinutes', 0.166);
    const stored = context.globalState.get<number>('workMinutes');
    if (!stored) context.globalState.update('workMinutes', defaultWork);

    if (!isDisabledThisSession) startWorkTimer(context);

    context.subscriptions.push({ dispose: () => deactivate() });
}

function getWorkMinutes(context: vscode.ExtensionContext): number {
    /*
    Описание:
        Возвращает текущее установленное время рабочего цикла (в минутах).
        Если пользователь не менял настройку, используется значение по умолчанию (30 минут).

    Пример работы:
        Если пользователь не задавал своё время — функция вернёт 30.
        Если пользователь через меню установил 45, функция вернёт 45.
    */ 
    const v = context.globalState.get<number>('workMinutes');
    if (typeof v === 'number' && v > 0) return v;
    return vscode.workspace.getConfiguration('breakReminder').get<number>('defaultWorkMinutes', 30);
}

function startWorkTimer(context: vscode.ExtensionContext) {
    /*
    Описание:
        Запускает таймер рабочего времени.
        После истечения заданного количества минут плагин отправляет пользователю уведомление с предложением сделать перерыв.
        Если в момент срабатывания открыта панель плагина, уведомление не отображается.

    Пример работы:
        Пользователь работает 30 минут — по истечении этого времени на экране появляется уведомление
     */
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
    /*
    Описание:
        Показывает основное меню плагина в виде webview-панели.
        В меню можно выбрать:
        Начать перерыв
        Пропустить перерыв
        Отложить перерыв
        Изменить рабочее время
        Отключить плагин на текущую сессию
        Функция также слушает команды, отправляемые из webview (через postMessage).
    Пример работы:
        Пользователь нажимает «Выбрать перерыв» — открывается основное меню.
        Там он может, например, нажать «Отложить перерыв» и выбрать, на сколько минут отложить.
    */
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
    /*
    Описание:
        Открывает окно выбора длительности перерыва.
        Пользователь выбирает, например, 5, 10 или 15 минут — после выбора открывается панель перерыва с таймером.

    Пример работы:
        После нажатия на кнопку «Начать перерыв» открывается панель с выбором времени для перерыва.
     */
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
    /*
    Описание:
        Отображает панель активного перерыва с таймером обратного отсчёта.
        Показывает полезные рекомендации.
        Если перерыв меньше 1 минуты, заголовок показывает секунды.
        Когда таймер заканчивается, пользователь видит сообщение «Перерыв завершён, работа продолжается».

    Пример работы:
        Если выбран перерыв на 10 секунд, заголовок будет "Перерыв 10 сек", таймер отсчитывает от 10 до 0.
        Если выбран перерыв на 5 минут, заголовок будет "Перерыв 5 мин", таймер отсчитывает от 5:00 до 0:00.
     */
    currentPanelOpen = true;
    isPausedManually = true;

    const recommendations = [
        '👀 Сделай зарядку для глаз.',
        '💧 Обязательно попей воды.',
        '🤸 Встань и разомнись: наклоны, повороты шеи.',
        '🏋️ Не забывай следить за осанкой.'
    ];

    const totalSeconds = Math.round(breakMinutes * 60);

    // Форматируем заголовок: если меньше минуты — показываем секунды, иначе минуты
    const displayTitle = totalSeconds < 60 ? `${totalSeconds} сек` : `${Math.round(breakMinutes)} мин`;

    const panel = vscode.window.createWebviewPanel(
        'breakPanel',
        `Перерыв ${displayTitle}`,
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
      <h2>Перерыв ${displayTitle}</h2>
      <div id="timer">${Math.floor(totalSeconds/60)}:${(totalSeconds%60).toString().padStart(2,'0')}</div>
      <ul>${recommendations.map(r => `<li>${r}</li>`).join('')}</ul>
      <br>
      <button id="end">Завершить перерыв</button>
      <script>
        const vscode = acquireVsCodeApi();
        let seconds = ${totalSeconds};
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
    /*
    Описание:
        Открывает окно, где пользователь может выбрать, на сколько минут отложить перерыв.
        После выбора плагин устанавливает новый таймер, по истечении которого снова предложит сделать перерыв.

    Пример работы:
        Если пользователь выбрал «Отложить перерыв» и указал 10 минут, то новый таймер запустится на 10 минут.
        После этого снова появится уведомление о перерыве.
    */
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
        timer = setTimeout(() => { notifyBreak(context);
            vscode.window.showInformationMessage(
                'Пришло время выбрать перерыв!',
                'Выбрать перерыв'
            ).then(selection => {
                if (selection === 'Выбрать перерыв') {
                    showMainMenu(context);
                }
            });
        }, ms);

        panel.dispose();
        currentPanelOpen = false;
    } else if (msg.command === 'cancelSnooze') {
        panel.dispose();
        currentPanelOpen = false;
        showMainMenu(context);
    }
});
}

async function showSetWorkTime(context: vscode.ExtensionContext) {
    /*
    Описание:
        Позволяет пользователю настроить длительность рабочего периода вручную.
        После выбора времени (например, 25 или 45 минут) это значение сохраняется в глобальном состоянии (globalState)
        и используется при следующих запусках.

    Пример работы:
        Пользователь нажимает «Изменить рабочее время» и выбирает 45 минут.
        Теперь каждый рабочий цикл длится 45 минут до следующего перерыва.
     */
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
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            isPausedManually = false;
            startWorkTimer(context);
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
    /*
    Описание:
        Функция вызывается при отключении или закрытии плагина.
        Очищает таймеры и сбрасывает флаги активности, чтобы предотвратить ошибки при повторной активации.

    Пример работы:
        Если пользователь перезапускает VS Code, перед этим вызывается deactivate() —
        все таймеры сбрасываются, и плагин при следующем запуске начнёт работу заново
     */
    if (timer) { clearTimeout(timer); timer = undefined; }
    currentPanelOpen = false;
    isDisabledThisSession = false;
}
