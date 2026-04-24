/**
 * Webview bridge for the sidebar.
 * Flow: load config + logs -> render HTML -> route webview messages back into extension actions.
 */
import * as vscode from 'vscode';
import { getSidebarHtml } from './sidebarHtml';
import { loadCommandConfig } from '../config/commandConfig';
import { readRunLogs } from '../logging/runLogStore';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

    /**
     * Accepts the callbacks that back the sidebar's run, open, log, and pause actions.
     */
    constructor(
        private readonly runCommand: (commandId?: string) => Promise<void>,
        private readonly togglePause: () => void,
        private readonly isPaused: () => boolean,
        private readonly openConfig: () => Promise<void>,
        private readonly openLogEntry: (line: number) => Promise<void>,
        private readonly setCommandPaused: (commandId: string, paused: boolean) => Promise<void>
    ) {}

    /**
     * Attaches the webview, wires incoming messages, and renders the initial UI.
     */
    async resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        // The webview stays intentionally dumb: it posts simple actions and the extension does the real work.
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message?.command === 'refresh') {
                await this.refresh();
            }

            if (message?.command === 'run') {
                await this.runCommand(message.commandId);
            }

            if (message?.command === 'togglePause') {
                this.togglePause();
                await this.refresh();
            }

            if (message?.command === 'openConfig') {
                await this.openConfig();
            }

            if (message?.command === 'openLogEntry' && typeof message.line === 'number') {
                await this.openLogEntry(message.line);
            }

            if (
                message?.command === 'setCommandPaused' &&
                typeof message.commandId === 'string' &&
                typeof message.paused === 'boolean'
            ) {
                await this.setCommandPaused(message.commandId, message.paused);
                await this.refresh();
            }
        });

        await this.refresh();
    }

    /**
     * Posts a running-state update directly to the webview without a full refresh.
     * The webview JS adds/removes the yellow dot and disables/enables the run button.
     */
    setCommandRunning(commandId: string, running: boolean) {
        void this.view?.webview.postMessage({ command: 'setRunning', commandId, running });
    }

    /**
     * Rebuilds the sidebar using the latest YAML config and run-log state.
     */
    async refresh() {
        if (!this.view) {
            return;
        }

        // Every refresh rebuilds the full HTML from current YAML and log state.
        const config = await loadCommandConfig();
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const runLogs = await readRunLogs(workspaceFolder);
        this.view.webview.html = getSidebarHtml(this.view.webview, config, this.isPaused(), runLogs);
    }
}
