/**
 * Main extension entrypoint.
 * Flow: activate -> load YAML commands -> run/schedule commands -> append logs -> refresh sidebar.
 */
import * as vscode from 'vscode';
import { loadCommandConfig } from './config/commandConfig';
import { executeCommand, pickCommand } from './execution/commandRunner';
import { openConfig, openLogEntry, setCommandPaused } from './workspace/workspaceHelpers';
import { CronScheduler } from './scheduling/scheduler';
import { SaveWatcher } from './scheduling/saveWatcher';
import { SidebarViewProvider } from './ui/sidebarViewProvider';

type RunCommandSource = 'manual' | 'scheduled' | 'on-save';
type RunNamedCommand = (commandId?: string, source?: RunCommandSource) => Promise<void>;

// This is the command id used when the extension needs to run a YAML command.
const runCommandId = 'vsflow.runCommand';

// This is the command id used when the sidebar needs to refresh itself.
const refreshCommandId = 'vsflow.refreshCommands';

// This is the id of the sidebar webview contributed in package.json.
const viewId = 'vsflowView';

/**
 * Registers commands, the sidebar webview, and the in-process scheduler.
 */
export function activate(context: vscode.ExtensionContext) {
    
    
  


    // Relay running-state updates to the sidebar. Assigned after sidebarProvider is created below.
    let notifyRunning: (commandId: string, running: boolean) => void = () => {};

    // Build the shared command runner first because both the scheduler and sidebar use it.
    const runNamedCommand = createRunNamedCommand((id, running) => notifyRunning(id, running));

    // Create the scheduler and tell it to call the shared runner for scheduled runs.
    const scheduler = new CronScheduler(runNamedCommand);

    // Create the save watcher and tell it to call the shared runner on matching file saves.
    const saveWatcher = new SaveWatcher(runNamedCommand);

    // Create the sidebar provider and pass in all callbacks the UI can trigger.
    const sidebarProvider = new SidebarViewProvider(
        // Run a command when the user clicks the play button.
        runNamedCommand,
        // Toggle the global scheduler pause state from the UI.
        createToggleSchedulerPause(scheduler),
        // Let the UI ask whether the scheduler is currently paused.
        createSchedulerPauseReader(scheduler),
        // Open the YAML config file when the user clicks the config link.
        openConfig,
        // Open a specific log line when the user clicks a run-history dot or log action.
        openLogEntry,
        // Persist paused/unpaused state for one command back into YAML.
        setCommandPaused
    );

    // Register the "run command" command id with VS Code.
    const runCommand = vscode.commands.registerCommand(
        runCommandId,
        createManualRunHandler(runNamedCommand)
    );
   
    // Register the "refresh sidebar" command id with VS Code.
    const refreshCommand = vscode.commands.registerCommand(
        refreshCommandId,
        createRefreshHandler(sidebarProvider)
    );
     
    // Point the relay at the real sidebar now that it exists.
    notifyRunning = (id, running) => sidebarProvider.setCommandRunning(id, running);

    // Start the timer-based scheduler now that the extension is active.
    scheduler.start();

    // Start listening for file saves now that the extension is active.
    saveWatcher.start();

    // Add disposables so VS Code can automatically clean them up when the extension unloads.
    context.subscriptions.push(
        // Dispose the scheduler timer on shutdown.
        scheduler,
        // Dispose the save watcher listener on shutdown.
        saveWatcher,
        // Dispose the command registration for running commands.
        runCommand,
        // Dispose the command registration for refreshing the sidebar.
        refreshCommand,
        // Register the sidebar webview provider and dispose it when the extension unloads.
        vscode.window.registerWebviewViewProvider(viewId, sidebarProvider)
    );
}

/**
 * VS Code calls this during extension shutdown.
 */
export function deactivate() {
    // There is no manual cleanup here because disposables are already tracked in context.subscriptions.
}

/**
 * Creates the shared command runner used by both the UI and the scheduler.
 */
function createRunNamedCommand(
    notifyRunning: (commandId: string, running: boolean) => void
): RunNamedCommand {
    return async function runNamedCommand(
        commandId?: string,
        source: RunCommandSource = 'manual'
    ) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            if (source === 'manual') {
                void vscode.window.showErrorMessage('No workspace folder open');
            }
            return;
        }

        const config = await loadCommandConfig();

        if (config.error) {
            if (source === 'manual') {
                void vscode.window.showErrorMessage(config.error);
            }
            await refreshSidebarView();
            return;
        }

        const command = await pickCommand(config.commands, commandId);

        if (!command) {
            return;
        }

        notifyRunning(command.id, true);
        await executeCommand(workspaceFolder, command, source);
        notifyRunning(command.id, false);
        await refreshSidebarView();
    };
}

/**
 * Creates the manual command handler registered with VS Code.
 */
function createManualRunHandler(runNamedCommand: RunNamedCommand) {
    return async function handleManualRun(commandId?: string) {
        await runNamedCommand(commandId);
    };
}

/**
 * Creates the refresh command handler registered with VS Code.
 */
function createRefreshHandler(sidebarProvider: SidebarViewProvider) {
    return async function handleRefresh() {
        await sidebarProvider.refresh();
    };
}

/**
 * Creates a callback that flips the global scheduler pause state.
 */
function createToggleSchedulerPause(scheduler: CronScheduler) {
    return function toggleSchedulerPause() {
        scheduler.setPaused(!scheduler.isPaused());
    };
}

/**
 * Creates a callback that returns the current scheduler pause state.
 */
function createSchedulerPauseReader(scheduler: CronScheduler) {
    return function readSchedulerPauseState() {
        return scheduler.isPaused();
    };
}

/**
 * Refreshes the registered sidebar view by invoking its command.
 */
async function refreshSidebarView() {
    await vscode.commands.executeCommand(refreshCommandId);
}
