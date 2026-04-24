/**
 * Helpers for opening workspace files and updating top-level command state.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { loadCommandConfig, updateCommandPaused } from '../config/commandConfig';
import { runLogFileName } from '../logging/runLogStore';

/**
 * Opens the YAML config file in the editor.
 */
export async function openConfig() {
    const config = await loadCommandConfig();
    const configPath = config.configPath;

    if (!configPath) {
        return;
    }

    const document = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Opens the run log and reveals a specific line.
 */
export async function openLogEntry(line: number) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const logPath = path.join(workspacePath, runLogFileName);
    const document = await vscode.workspace.openTextDocument(logPath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    const zeroBasedLine = Math.max(0, line - 1);
    const position = new vscode.Position(zeroBasedLine, 0);
    const selection = new vscode.Selection(position, position);
    const range = new vscode.Range(position, position);

    editor.selection = selection;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/**
 * Persists the pause flag for one top-level command.
 */
export async function setCommandPaused(commandId: string, paused: boolean) {
    const updated = await updateCommandPaused(commandId, paused);

    if (updated) {
        return;
    }

    void vscode.window.showErrorMessage(`Could not update pause state for: ${commandId}`);
}
