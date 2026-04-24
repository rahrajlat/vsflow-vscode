/**
 * Command execution helpers.
 * Flow: choose a command -> run commands or workflows -> write run logs -> decide notifications.
 */
import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { appendRunLog } from '../logging/runLogStore';
import { type NotificationRule, type RunnerCommand, type RunnerTask } from '../config/commandConfig';

const execAsync = promisify(exec);

type ExecError = Error & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
};

/**
 * Returns a command from YAML.
 * If an id is provided, it tries to find that command directly.
 * If no id is provided, it shows a quick-pick list to the user.
 */
export async function pickCommand(commands: RunnerCommand[], commandId?: string) {
    if (commandId) {
        const matchedCommand = commands.find((command) => command.id === commandId);

        if (matchedCommand) {
            return matchedCommand;
        }

        void vscode.window.showErrorMessage(`Unknown command: ${commandId}`);
        return undefined;
    }

    const quickPickItems = commands.map((command) => {
        const detail = command.kind === 'workflow'
            ? `${command.mode} workflow · ${command.steps.length} steps`
            : command.command;

        return {
            label: command.title,
            description: command.description,
            detail,
            command
        };
    });

    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select a workspace command to run'
    });

    return selectedItem?.command;
}

/**
 * Runs one top-level command and shows notifications based on its rule.
 */
export async function executeCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    command: RunnerCommand,
    source: 'manual' | 'scheduled' | 'on-save'
) {
    try {
        await executeRunnerCommand(workspaceFolder, command);

        const shouldShowSuccess = shouldNotify(command.notifyOn, 'success', source);
        if (shouldShowSuccess) {
            void vscode.window.showInformationMessage(`Finished: ${command.title}`);
        }
    } catch (error: unknown) {
        const shouldShowFailure = shouldNotify(command.notifyOn, 'failed', source);
        if (shouldShowFailure) {
            void vscode.window.showErrorMessage(`Command failed: ${command.title}`);
        }
    }
}

/**
 * Starts execution for a top-level YAML command or workflow.
 */
export async function executeRunnerCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    command: RunnerCommand
) {
    const initialCwd = command.cwd;
    await executeTask(workspaceFolder, command, initialCwd);
}

/**
 * Recursively runs one task.
 * A task can be:
 * - a shell command
 * - a workflow made of more tasks
 */
async function executeTask(
    workspaceFolder: vscode.WorkspaceFolder,
    task: RunnerTask,
    parentCwd: string | undefined
) {
    const currentCwd = task.cwd || parentCwd;

    if (task.kind === 'command') {
        await executeShellCommand(
            workspaceFolder,
            task.id,
            task.title,
            task.command,
            currentCwd
        );
        return;
    }

    try {
        if (task.mode === 'parallel') {
            const stepPromises = task.steps.map((step) => {
                return executeTask(workspaceFolder, step, currentCwd);
            });

            await Promise.all(stepPromises);
        } else {
            for (const step of task.steps) {
                await executeTask(workspaceFolder, step, currentCwd);
            }
        }

        await appendWorkflowLog(workspaceFolder, task.id, task.title, task.mode, 'success', 'N/A');
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await appendWorkflowLog(workspaceFolder, task.id, task.title, task.mode, 'failed', errorMessage);
        throw error;
    }
}

/**
 * Runs one shell command and stores its output in the run log.
 */
async function executeShellCommand(
    workspaceFolder: vscode.WorkspaceFolder,
    id: string,
    title: string,
    shellCommand: string,
    cwdSetting: string | undefined
) {
    const cwd = resolveCommandCwd(workspaceFolder, cwdSetting);

    try {
        const result = await execAsync(shellCommand, { cwd });
        const output = combineCommandOutput(result.stdout, result.stderr);

        await appendRunLog(workspaceFolder, {
            id,
            title,
            command: shellCommand,
            status: 'success',
            error: 'N/A',
            output
        });
    } catch (error: unknown) {
        const execError = error as ExecError;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const output = combineCommandOutput(execError.stdout, execError.stderr);

        await appendRunLog(workspaceFolder, {
            id,
            title,
            command: shellCommand,
            status: 'failed',
            error: errorMessage,
            output
        });

        throw error;
    }
}

/**
 * Writes a workflow-level entry after all its steps finish or fail.
 */
async function appendWorkflowLog(
    workspaceFolder: vscode.WorkspaceFolder,
    id: string,
    title: string,
    mode: 'sequence' | 'parallel',
    status: 'success' | 'failed',
    error: string
) {
    const workflowCommand = `workflow:${mode}`;

    await appendRunLog(workspaceFolder, {
        id,
        title,
        command: workflowCommand,
        status,
        error,
        output: 'N/A'
    });
}

/**
 * Resolves the working directory for a command.
 * If YAML provides a `cwd`, it is resolved relative to the workspace root.
 * Otherwise the workspace root is used.
 */
function resolveCommandCwd(
    workspaceFolder: vscode.WorkspaceFolder,
    cwdSetting: string | undefined
) {
    if (!cwdSetting) {
        return workspaceFolder.uri.fsPath;
    }

    return path.resolve(workspaceFolder.uri.fsPath, cwdSetting);
}

/**
 * Combines stdout and stderr into one string for logging.
 */
function combineCommandOutput(stdout?: string | Buffer, stderr?: string | Buffer) {
    const stdoutText = toText(stdout);
    const stderrText = toText(stderr);
    const outputParts = [stdoutText, stderrText].filter((value): value is string => Boolean(value));
    const output = outputParts.join('\n\n');

    if (!output) {
        return 'N/A';
    }

    return output;
}

/**
 * Converts a string or buffer to a trimmed string.
 */
function toText(value?: string | Buffer) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }

    if (value) {
        const trimmed = value.toString('utf8').trim();
        return trimmed || undefined;
    }

    return undefined;
}

/**
 * Decides whether VS Code should show a notification for this result.
 */
function shouldNotify(
    notifyOn: NotificationRule | undefined,
    result: 'success' | 'failed',
    source: 'manual' | 'scheduled' | 'on-save'
) {
    const defaultRule = source === 'manual' ? 'always' : 'failure';
    const effectiveRule = notifyOn || defaultRule;

    if (effectiveRule === 'never') {
        return false;
    }

    if (effectiveRule === 'always') {
        return true;
    }

    return effectiveRule === result;
}
