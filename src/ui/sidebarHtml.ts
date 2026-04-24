/**
 * Sidebar webview HTML renderer.
 * Flow: render command cards + logs table -> attach browser-side handlers -> post actions back to the provider.
 */
import * as vscode from 'vscode';
import { getConfigFileNames, type CommandConfig } from '../config/commandConfig';
import { type RunLogEntry } from '../logging/runLogStore';
import { getNextRunTime } from '../scheduling/scheduler';

/**
 * Builds the complete sidebar HTML document, including styles and client-side handlers.
 */
export function getSidebarHtml(
    webview: vscode.Webview,
    config: CommandConfig,
    isPaused: boolean,
    runLogs: RunLogEntry[]
) {
    // The HTML is regenerated on each refresh, so the script can bind directly to current DOM nodes.
    const nonce = getNonce();
    const configHint = config.configPath
        ? escapeHtml(config.configPath)
        : getConfigFileNames().map(escapeHtml).join(', ');
    const body = config.commands.length > 0
        ? renderCommandList(config, isPaused, runLogs)
        : renderEmptyState(configHint, config.error);
    const runLogsJson = JSON.stringify(runLogs).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VS Flow ===></title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 14px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
        }

        button {
            border: 0;
            padding: 10px 12px;
            border-radius: 6px;
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        p {
            margin-top: 0;
            margin-bottom: 12px;
            line-height: 1.4;
        }

        .stack {
            display: grid;
            gap: 10px;
        }

        .hero {
            padding: 12px;
            border-radius: 10px;
            border: 1px solid var(--vscode-widget-border, transparent);
            background:
                linear-gradient(180deg, color-mix(in srgb, var(--vscode-button-background) 16%, transparent), transparent 70%),
                var(--vscode-editorWidget-background);
        }

        .hero-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 6px;
        }

        .hero-title {
            margin: 0;
            font-size: 13px;
            font-weight: 700;
            line-height: 1.2;
        }

        .hero-badge {
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        .config-meta {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            line-height: 1.25;
        }

        .config-link {
            display: inline-block;
            margin-top: 6px;
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 10px;
            text-decoration: none;
            color: var(--vscode-textLink-foreground);
            background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent);
        }

        .config-link:hover {
            background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent);
        }

        .command {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 8px;
            align-items: center;
            padding: 8px 10px;
            border-radius: 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border, transparent);
            box-shadow: inset 0 1px 0 color-mix(in srgb, white 6%, transparent);
        }

        .command-copy {
            min-width: 0;
        }

        .run-history {
            display: flex;
            gap: 4px;
            margin-top: 6px;
        }

        .run-dot {
            width: 8px;
            height: 8px;
            padding: 0;
            border-radius: 999px;
            border: 0;
            background: var(--vscode-descriptionForeground);
            opacity: 0.35;
        }

        .run-dot-success {
            background: #1db954;
            opacity: 1;
        }

        .run-dot-failed {
            background: #e5484d;
            opacity: 1;
        }

        .run-dot-clickable {
            cursor: pointer;
            box-shadow: 0 0 0 1px color-mix(in srgb, white 20%, transparent);
        }

        .run-dot-clickable:hover {
            transform: scale(1.15);
        }

        .run-dot-running {
            background: #f5a623;
            opacity: 1;
            animation: running-pulse 0.7s ease-in-out infinite;
        }

        @keyframes running-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50%       { opacity: 0.35; transform: scale(0.7); }
        }

        .command h3, .section-title {
            margin: 0 0 2px;
            font-size: 12px;
            line-height: 1.2;
        }

        .command p {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.25;
        }

        .cron {
            margin-top: 3px;
            color: var(--vscode-textLink-foreground);
            font-size: 10px;
            line-height: 1.2;
        }

        .next-run {
            margin-top: 2px;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            line-height: 1.2;
        }

        .paused {
            margin-top: 2px;
            color: var(--vscode-errorForeground);
            font-size: 10px;
            line-height: 1.2;
        }

        .run-button {
            width: 24px;
            height: 24px;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            line-height: 1;
            border-radius: 999px;
            flex-shrink: 0;
        }

        .command-actions {
            display: grid;
            gap: 6px;
        }

        .pause-button {
            width: 24px;
            height: 24px;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            line-height: 1;
            border-radius: 999px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .pause-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .pause-button.is-paused {
            color: var(--vscode-errorForeground);
        }

        .logs-panel {
            margin-top: 10px;
            display: grid;
            gap: 8px;
            padding: 12px;
            border-radius: 10px;
            border: 1px solid var(--vscode-widget-border, transparent);
            background: var(--vscode-editorWidget-background);
        }

        .logs-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .logs-toolbar {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 8px;
        }

        .logs-toolbar input,
        .logs-toolbar select {
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
            padding: 6px 8px;
            border-radius: 6px;
            border: 1px solid var(--vscode-widget-border, transparent);
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
        }

        .logs-table-wrap {
            overflow: auto;
            border: 1px solid var(--vscode-widget-border, transparent);
            border-radius: 6px;
            background: color-mix(in srgb, var(--vscode-editor-background) 75%, transparent);
        }

        .logs-collapsed .logs-toolbar,
        .logs-collapsed .logs-table-wrap,
        .logs-collapsed .empty-logs {
            display: none;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10px;
        }

        th, td {
            padding: 6px 8px;
            text-align: left;
            vertical-align: top;
            border-bottom: 1px solid var(--vscode-widget-border, transparent);
        }

        th {
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background);
            cursor: pointer;
            user-select: none;
        }

        td.code-cell {
            font-family: var(--vscode-editor-font-family);
            white-space: pre-wrap;
            word-break: break-word;
        }

        .status-pill {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 999px;
            font-weight: 600;
        }

        .status-success {
            color: #1b5e20;
            background: #b9f6ca;
        }

        .status-failed {
            color: #7f0000;
            background: #ffb3b3;
        }

        .empty-logs {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .secondary {
            width: 100%;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        code, pre {
            font-family: var(--vscode-editor-font-family);
        }

        pre {
            white-space: pre-wrap;
            padding: 12px;
            border-radius: 8px;
            background: var(--vscode-textCodeBlock-background);
            overflow-x: auto;
        }
    </style>
</head>
<body>
    ${body}
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const runLogs = ${runLogsJson};
        let sortKey = 'time';
        let sortDirection = 'desc';

        // Command actions post simple messages; the extension decides how to execute or persist them.
        document.querySelectorAll('[data-command-id]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'run',
                    commandId: button.getAttribute('data-command-id')
                });
            });
        });
        document.querySelectorAll('[data-pause-command-id]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'setCommandPaused',
                    commandId: button.getAttribute('data-pause-command-id'),
                    paused: button.getAttribute('data-paused-next') === 'true'
                });
            });
        });

        document.getElementById('refresh-button')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });
        document.getElementById('config-link')?.addEventListener('click', (event) => {
            event.preventDefault();
            vscode.postMessage({ command: 'openConfig' });
        });
        document.querySelectorAll('[data-log-line]').forEach((button) => {
            button.addEventListener('click', () => {
                const line = Number(button.getAttribute('data-log-line'));

                if (!Number.isNaN(line)) {
                    vscode.postMessage({ command: 'openLogEntry', line });
                }
            });
        });

        document.getElementById('log-filter')?.addEventListener('input', renderLogRows);
        document.getElementById('log-filter-column')?.addEventListener('change', renderLogRows);
        document.getElementById('status-filter')?.addEventListener('change', renderLogRows);
        document.getElementById('logs-toggle')?.addEventListener('click', () => {
            const panel = document.getElementById('logs-panel');
            const button = document.getElementById('logs-toggle');

            if (!panel || !button) {
                return;
            }

            panel.classList.toggle('logs-collapsed');
            button.textContent = panel.classList.contains('logs-collapsed') ? 'Show' : 'Hide';
        });

        document.querySelectorAll('[data-sort-key]').forEach((header) => {
            header.addEventListener('click', () => {
                const nextKey = header.getAttribute('data-sort-key');
                if (!nextKey) {
                    return;
                }

                if (sortKey === nextKey) {
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    sortKey = nextKey;
                    sortDirection = nextKey === 'time' ? 'desc' : 'asc';
                }

                renderLogRows();
            });
        });

        function renderLogRows() {
            // Filtering and sorting happen entirely in the webview because the log set is small and already loaded.
            const tableBody = document.getElementById('logs-body');
            const emptyState = document.getElementById('logs-empty');
            const filter = (document.getElementById('log-filter')?.value || '').toLowerCase();
            const filterColumn = document.getElementById('log-filter-column')?.value || 'all';
            const statusFilter = document.getElementById('status-filter')?.value || 'all';

            if (!tableBody || !emptyState) {
                return;
            }

            const filtered = runLogs
                .filter((entry) => {
                    const haystack = filterColumn === 'all'
                        ? [entry.time, entry.id, entry.title, entry.status, entry.error, entry.output]
                            .join(' ')
                            .toLowerCase()
                        : String(entry[filterColumn] || '').toLowerCase();

                    const matchesText = !filter || haystack.includes(filter);
                    const matchesStatus = statusFilter === 'all' || entry.status === statusFilter;
                    return matchesText && matchesStatus;
                })
                .sort((left, right) => compareEntries(left, right));

            tableBody.innerHTML = filtered.map((entry) => {
                const statusClass = entry.status === 'success' ? 'status-success' : 'status-failed';

                return \`
                    <tr>
                        <td>\${escapeHtml(entry.time)}</td>
                        <td class="code-cell">\${escapeHtml(entry.id)}</td>
                        <td>\${escapeHtml(entry.title)}</td>
                        <td><span class="status-pill \${statusClass}">\${escapeHtml(entry.status)}</span></td>
                        <td class="code-cell">\${escapeHtml(entry.error)}</td>
                        <td class="code-cell">\${escapeHtml(entry.output)}</td>
                    </tr>
                \`;
            }).join('');

            emptyState.style.display = filtered.length === 0 ? 'block' : 'none';
        }

        function compareEntries(left, right) {
            const leftValue = getSortValue(left, sortKey);
            const rightValue = getSortValue(right, sortKey);

            if (leftValue < rightValue) {
                return sortDirection === 'asc' ? -1 : 1;
            }

            if (leftValue > rightValue) {
                return sortDirection === 'asc' ? 1 : -1;
            }

            return 0;
        }

        function getSortValue(entry, key) {
            return entry[key] || '';
        }

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // Listen for running-state updates posted from the extension host.
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command !== 'setRunning') {
                return;
            }

            const runButton = document.querySelector('[data-command-id="' + msg.commandId + '"]');
            if (!runButton) {
                return;
            }

            const card = runButton.closest('.command');
            if (!card) {
                return;
            }

            if (msg.running) {
                runButton.disabled = true;
                let historyDiv = card.querySelector('.run-history');
                if (!historyDiv) {
                    historyDiv = document.createElement('div');
                    historyDiv.className = 'run-history';
                    card.querySelector('.command-copy').appendChild(historyDiv);
                }
                if (!historyDiv.querySelector('.run-dot-running')) {
                    const dot = document.createElement('div');
                    dot.className = 'run-dot run-dot-running';
                    dot.title = 'Running…';
                    historyDiv.prepend(dot);
                }
            } else {
                runButton.disabled = false;
                card.querySelector('.run-dot-running')?.remove();
            }
        });

        renderLogRows();
    </script>
</body>
</html>`;
}

/**
 * Renders the main command-card section of the sidebar.
 */
function renderCommandList(config: CommandConfig, isPaused: boolean, runLogs: RunLogEntry[]) {
    // Each card shows config state, recent runs, and direct controls for running or pausing the command.
    const items = config.commands.map((command) => `
        <section class="command">
            <div class="command-copy">
                <h3>${escapeHtml(command.title)}</h3>
                <p>id: ${escapeHtml(command.id)}</p>
                ${command.cron ? `<div class="cron">cron: ${escapeHtml(command.cron)}</div>` : ''}
                ${command.notifyOn ? `<div class="next-run">notify: ${escapeHtml(command.notifyOn)}</div>` : ''}
                ${command.paused ? '<div class="paused">paused in yaml</div>' : ''}
                ${renderNextRun(command.cron, command.paused)}
                ${renderRecentRuns(command.id, runLogs)}
            </div>
            <div class="command-actions">
                <button class="run-button" data-command-id="${escapeHtml(command.id)}" title="Run ${escapeHtml(command.title)}">▶</button>
                <button
                    class="pause-button${command.paused ? ' is-paused' : ''}"
                    data-pause-command-id="${escapeHtml(command.id)}"
                    data-paused-next="${command.paused ? 'false' : 'true'}"
                    title="${command.paused ? `Resume ${escapeHtml(command.title)}` : `Pause ${escapeHtml(command.title)}`}"
                >⏸</button>
            </div>
        </section>
    `).join('');

    return `
        <div class="stack">
            <section class="hero">
                <div class="hero-top">
                    <h2 class="hero-title">VSFlow</h2>
                    <span class="hero-badge">${isPaused ? 'Paused' : 'Active'}</span>
                </div>
                <p class="config-meta">yaml: <code>${escapeHtml(config.configPath || '')}</code>${isPaused ? ' · scheduler paused' : ''}</p>
                <a href="#" id="config-link" class="config-link">Open YAML</a>
            </section>
            ${items}
            ${renderLogSection(runLogs)}
        </div>
    `;
}

/**
 * Renders the collapsible run-log table and its filter controls.
 */
function renderLogSection(runLogs: RunLogEntry[]) {
    // The log panel starts collapsed to keep the command list as the primary view.
    return `
        <section class="logs-panel logs-collapsed" id="logs-panel">
            <div class="logs-header">
                <h3 class="section-title">View History</h3>
                <button class="secondary" id="logs-toggle">Show</button>
            </div>
            <div class="logs-toolbar">
                <select id="log-filter-column">
                    <option value="all">All columns</option>
                    <option value="time">Time</option>
                    <option value="id">Id</option>
                    <option value="title">Title</option>
                    <option value="status">Status</option>
                    <option value="error">Error</option>
                    <option value="output">Output</option>
                </select>
                <input id="log-filter" type="text" placeholder="Filter logs">
                <select id="status-filter">
                    <option value="all">All statuses</option>
                    <option value="success">Success</option>
                    <option value="failed">Failed</option>
                </select>
            </div>
            <div class="logs-table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th data-sort-key="time">Time</th>
                            <th data-sort-key="id">Id</th>
                            <th data-sort-key="title">Title</th>
                            <th data-sort-key="status">Status</th>
                            <th data-sort-key="error">Error</th>
                            <th data-sort-key="output">Output</th>
                        </tr>
                    </thead>
                    <tbody id="logs-body"></tbody>
                </table>
            </div>
            <p id="logs-empty" class="empty-logs"${runLogs.length === 0 ? '' : ' style="display:none"'}>No log entries yet.</p>
        </section>
    `;
}

/**
 * Renders the colored last-five-run dots for one command.
 */
function renderRecentRuns(commandId: string, runLogs: RunLogEntry[]) {
    // Recent-run dots are the compact per-command history view and link back to raw JSONL rows.
    const recentRuns = runLogs
        .filter((entry) => entry.id === commandId)
        .slice(0, 5);

    if (recentRuns.length === 0) {
        return '';
    }

    const dots = recentRuns.map((entry) => {
        const statusClass = entry.status === 'success' ? 'run-dot-success' : 'run-dot-failed';
        const clickableClass = 'run-dot-clickable';
        const statusLabel = entry.status === 'success' ? 'success' : 'failed';
        const attrs = ` data-log-line="${entry.line}" title="Open ${statusLabel} log entry"`;

        return `<button class="run-dot ${statusClass} ${clickableClass}"${attrs}></button>`;
    }).join('');

    return `<div class="run-history">${dots}</div>`;
}

/**
 * Renders the empty-state UI shown when no YAML config can be loaded.
 */
function renderEmptyState(configHint: string, error?: string) {
    return `
        <div class="stack">
            <p>${escapeHtml(error || 'No commands found.')}</p>
            <button class="secondary" id="refresh-button">Refresh</button>
            <pre>${escapeHtml(`commands:
  - id: git-pull
    title: Git Pull
    description: Pull the latest changes
    command: git pull
    cron: "*/30 * * * *"
    paused: true
    notifyOn: failure

  - id: install
    title: Install
    cwd: .
    command: npm install
    notifyOn: never`)}</pre>
            <p>Create the YAML file at <code>${configHint}</code></p>
        </div>
    `;
}

/**
 * Builds the "next run" hint for scheduled commands.
 */
function renderNextRun(cron?: string, paused?: boolean) {
    if (!cron) {
        return '';
    }

    if (paused) {
        return '<div class="next-run">next: paused</div>';
    }

    const nextRun = getNextRunTime(cron);

    if (!nextRun) {
        return '<div class="next-run">next: unavailable</div>';
    }

    return `<div class="next-run">next: ${escapeHtml(formatNextRun(nextRun))}</div>`;
}

function formatNextRun(date: Date) {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(date);
}

/**
 * Escapes text before inserting it into HTML content or attributes.
 */
function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Generates a nonce for the webview's Content Security Policy.
 */
function getNonce() {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';

    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
}
