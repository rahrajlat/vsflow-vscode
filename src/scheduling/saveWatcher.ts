/**
 * File-save trigger for on-save command execution.
 * Flow: onDidSaveTextDocument -> resolve relative path -> match onSave glob -> invoke runCommand.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { loadCommandConfig } from '../config/commandConfig';

type RunCommand = (commandId?: string, source?: 'manual' | 'scheduled' | 'on-save') => Promise<void>;

export class SaveWatcher implements vscode.Disposable {
    private listener?: vscode.Disposable;

    constructor(private readonly runCommand: RunCommand) {}

    /**
     * Registers the document-save listener.
     */
    start() {
        this.listener = vscode.workspace.onDidSaveTextDocument((document) => {
            void this.onSave(document);
        });
    }

    /**
     * Removes the document-save listener when the extension is disposed.
     */
    dispose() {
        this.listener?.dispose();
    }

    private async onSave(document: vscode.TextDocument) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        if (!workspaceFolder) {
            return;
        }

        const config = await loadCommandConfig();

        if (config.error) {
            return;
        }

        // Normalize to forward slashes so glob patterns work identically on Windows and Unix.
        const relativePath = path
            .relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
            .replace(/\\/g, '/');

        for (const command of config.commands) {
            if (!command.onSave || command.paused) {
                continue;
            }

            if (matchesGlob(command.onSave, relativePath)) {
                await this.runCommand(command.id, 'on-save');
            }
        }
    }
}

/**
 * Tests whether a relative file path matches a glob pattern.
 * Supports * (within one path segment), ** (across segments), and ? (single character).
 */
function matchesGlob(pattern: string, filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Escape regex metacharacters first, then expand glob tokens in order of specificity.
    const regexSource = normalizedPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars (not * or ?)
        .replace(/\*\*\//g, '(?:.+/)?')          // **/ → zero or more path segments with trailing slash
        .replace(/\*\*/g, '.*')                   // ** alone → anything
        .replace(/\*/g, '[^/]*')                  // * → any characters within one segment
        .replace(/\?/g, '[^/]');                  // ? → single non-separator character

    return new RegExp(`^${regexSource}$`).test(normalizedPath);
}
