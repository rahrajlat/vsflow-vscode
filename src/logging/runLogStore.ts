/**
 * JSONL-backed run log storage.
 * Flow: append one entry per command/workflow run -> read entries back for the sidebar table and recent-run dots.
 */
import { appendFile, mkdir, readFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface RunLogEntry {
    line: number;
    time: string;
    id: string;
    title: string;
    command: string;
    status: 'success' | 'failed';
    error: string;
    output: string;
}

export const runLogFileName = 'runner-history.log';

/**
 * Appends one JSON log entry for a completed command or workflow run.
 */
export async function appendRunLog(
    workspaceFolder: vscode.WorkspaceFolder,
    entry: Omit<RunLogEntry, 'line' | 'time' | 'error' | 'output'> & { error?: string; output?: string }
) {
    // Logs live beside the workspace config so they travel with the project context.
    const logPath = path.join(workspaceFolder.uri.fsPath, runLogFileName);

    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(
        logPath,
        `${JSON.stringify({
            time: new Date().toISOString(),
            id: entry.id,
            title: entry.title,
            command: entry.command,
            status: entry.status,
            error: entry.error || 'N/A',
            output: entry.output || 'N/A'
        })}\n`,
        'utf8'
    );
}

/**
 * Reads and parses the workspace run log, returning newest entries first.
 */
export async function readRunLogs(workspaceFolder?: vscode.WorkspaceFolder) {
    if (!workspaceFolder) {
        return [];
    }

    const logPath = path.join(workspaceFolder.uri.fsPath, runLogFileName);

    try {
        const content = await readFile(logPath, 'utf8');

        // Newest entries are shown first in the sidebar, but line numbers still point to the original file.
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line, index) => parseLine(line, index + 1))
            .filter((entry): entry is RunLogEntry => Boolean(entry))
            .reverse();
    } catch {
        return [];
    }
}

/**
 * Parses one JSONL line into a typed run log entry with safe defaults.
 */
function parseLine(line: string, lineNumber: number) {
    // Older log rows can be missing newer fields, so parsing fills safe defaults instead of failing hard.
    try {
        const parsed = JSON.parse(line) as Partial<RunLogEntry>;

        if (
            !parsed.time ||
            !parsed.id ||
            !parsed.title ||
            !parsed.command ||
            !parsed.status
        ) {
            return undefined;
        }

        return {
            line: lineNumber,
            time: parsed.time,
            id: parsed.id,
            title: parsed.title,
            command: parsed.command,
            status: parsed.status,
            error: parsed.error || 'N/A',
            output: parsed.output || 'N/A'
        } satisfies RunLogEntry;
    } catch {
        return undefined;
    }
}
