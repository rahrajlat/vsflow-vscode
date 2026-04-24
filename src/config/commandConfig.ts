/**
 * YAML config loading and lightweight mutation helpers.
 * Flow: find config -> parse commands/workflows into runtime objects -> optionally persist small YAML edits.
 */
import * as vscode from 'vscode';

interface RunnerTaskBase {
    id: string;
    title: string;
    description?: string;
    cwd?: string;
}

export type NotificationRule = 'success' | 'failure' | 'always' | 'never';

export interface RunnerShellCommand extends RunnerTaskBase {
    kind: 'command';
    command: string;
}

export interface RunnerWorkflow extends RunnerTaskBase {
    kind: 'workflow';
    mode: 'sequence' | 'parallel';
    steps: RunnerTask[];
}

export type RunnerTask = RunnerShellCommand | RunnerWorkflow;

export type RunnerCommand = RunnerTask & {
    cron?: string;
    onSave?: string;
    paused?: boolean;
    notifyOn?: NotificationRule;
};

export interface CommandConfig {
    commands: RunnerCommand[];
    configPath?: string;
    error?: string;
}

type MutableTask = {
    id?: string;
    title?: string;
    description?: string;
    cwd?: string;
    command?: string;
    cron?: string;
    onSave?: string;
    paused?: boolean;
    notifyOn?: NotificationRule;
    mode?: 'sequence' | 'parallel';
    steps?: MutableTask[];
};

const configFileNames = [
    'vsflow.yaml',
    'vsflow.yml',
    '.vsflow.yaml',
    '.vsflow.yml'
];

/**
 * Loads the VSFlow YAML file and converts it into runtime command objects.
 */
export async function loadCommandConfig(): Promise<CommandConfig> {
    // The extension always reads from the first workspace folder and keeps the YAML shape intentionally simple.
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        return {
            commands: [],
            error: 'Open a workspace folder to load vsflow.yaml.'
        };
    }

    const configUri = await findConfigUri(workspaceFolder.uri);

    if (!configUri) {
        return {
            commands: [],
            error: `No YAML config found. Create one of: ${configFileNames.join(', ')}`,
            configPath: vscode.Uri.joinPath(workspaceFolder.uri, configFileNames[0]).fsPath
        };
    }

    const bytes = await vscode.workspace.fs.readFile(configUri);
    const content = Buffer.from(bytes).toString('utf8');
    const commands = parseCommandsYaml(content);

    if (commands.length === 0) {
        return {
            commands: [],
            configPath: configUri.fsPath,
            error: 'No commands found. Add entries under "commands:" in your YAML file.'
        };
    }

    return {
        commands,
        configPath: configUri.fsPath
    };
}

/**
 * Persists a top-level command's `paused` flag back into the YAML file.
 */
export async function updateCommandPaused(commandId: string, paused: boolean) {
    // Pause toggles edit the YAML in place so schedule state survives reloads and restarts.
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        return false;
    }

    const configUri = await findConfigUri(workspaceFolder.uri);

    if (!configUri) {
        return false;
    }

    const bytes = await vscode.workspace.fs.readFile(configUri);
    const content = Buffer.from(bytes).toString('utf8');
    const updatedContent = setPausedInYaml(content, commandId, paused);

    if (!updatedContent || updatedContent === content) {
        return false;
    }

    await vscode.workspace.fs.writeFile(configUri, Buffer.from(updatedContent, 'utf8'));
    return true;
}

/**
 * Finds the first supported config filename in the workspace root.
 */
async function findConfigUri(workspaceUri: vscode.Uri) {
    for (const fileName of configFileNames) {
        const candidate = vscode.Uri.joinPath(workspaceUri, fileName);

        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            continue;
        }
    }

    return undefined;
}

/**
 * Parses the supported YAML subset into top-level command definitions.
 */
function parseCommandsYaml(content: string) {
    // The parser supports a constrained subset of YAML tailored to the extension's command model.
    const preparedLines = content
        .split(/\r?\n/)
        .map((raw) => stripComments(raw))
        .map((raw) => ({ raw, trimmed: raw.trim(), indent: getIndent(raw) }));

    const commandsIndex = preparedLines.findIndex((line) => line.trimmed === 'commands:');

    if (commandsIndex === -1) {
        return [];
    }

    const { items } = parseList(preparedLines, commandsIndex + 1, 2);
    return items.map(toRunnerCommand).filter((command): command is RunnerCommand => Boolean(command));
}

/**
 * Rewrites only the matching command block to update or insert `paused: ...`.
 */
function setPausedInYaml(content: string, commandId: string, paused: boolean) {
    // This rewrite is intentionally narrow: it updates only top-level command blocks by id.
    const lines = content.split(/\r?\n/);
    const blocks = getTopLevelCommandBlocks(lines);
    const targetBlock = blocks.find((block) => block.commandId === commandId);

    if (!targetBlock) {
        return undefined;
    }

    const pausedLineIndex = findFieldLine(lines, targetBlock.start, targetBlock.end, 'paused');

    if (pausedLineIndex !== -1) {
        lines[pausedLineIndex] = `${getLineIndent(lines[pausedLineIndex])}paused: ${paused}`;
    } else {
        const insertAt = findInsertIndex(lines, targetBlock.start, targetBlock.end);
        lines.splice(insertAt, 0, `    paused: ${paused}`);
    }

    return lines.join('\n');
}

/**
 * Splits the YAML into top-level `commands:` blocks so pause edits stay scoped.
 */
function getTopLevelCommandBlocks(lines: string[]) {
    // Top-level blocks are used for pause updates; nested workflow steps are runtime-only and not independently toggled.
    const blocks: Array<{ start: number; end: number; commandId?: string }> = [];
    let currentStart = -1;

    for (let index = 0; index < lines.length; index++) {
        if (/^  - /.test(lines[index])) {
            if (currentStart !== -1) {
                blocks.push(buildCommandBlock(lines, currentStart, index));
            }

            currentStart = index;
        }
    }

    if (currentStart !== -1) {
        blocks.push(buildCommandBlock(lines, currentStart, lines.length));
    }

    return blocks;
}

/**
 * Builds metadata for one top-level command block, including the derived id.
 */
function buildCommandBlock(lines: string[], start: number, end: number) {
    const id = readFieldValue(lines[start].replace(/^  - /, ''), 'id')
        || findFieldValue(lines, start + 1, end, 'id');
    const title = readFieldValue(lines[start].replace(/^  - /, ''), 'title')
        || findFieldValue(lines, start + 1, end, 'title');

    return {
        start,
        end,
        commandId: id || (title ? slugify(title) : undefined)
    };
}

/**
 * Searches a line range for a simple `key: value` field.
 */
function findFieldValue(lines: string[], start: number, end: number, field: string) {
    for (let index = start; index < end; index++) {
        const value = readFieldValue(lines[index].trim(), field);

        if (value) {
            return value;
        }
    }

    return undefined;
}

/**
 * Reads a field value from a single trimmed YAML line when the key matches.
 */
function readFieldValue(line: string, field: string) {
    const prefix = `${field}:`;

    if (!line.startsWith(prefix)) {
        return undefined;
    }

    return unquote(line.slice(prefix.length).trim());
}

/**
 * Finds the line index of a field inside a specific top-level command block.
 */
function findFieldLine(lines: string[], start: number, end: number, field: string) {
    for (let index = start; index < end; index++) {
        if (lines[index].trim().startsWith(`${field}:`)) {
            return index;
        }
    }

    return -1;
}

/**
 * Chooses where a newly inserted `paused` line should be placed in a block.
 */
function findInsertIndex(lines: string[], start: number, end: number) {
    for (let index = start + 1; index < end; index++) {
        const trimmed = lines[index].trim();

        if (!trimmed) {
            return index;
        }
    }

    return end;
}

/**
 * Returns the leading whitespace for a line so rewritten YAML keeps indentation.
 */
function getLineIndent(line: string) {
    return line.match(/^\s*/)?.[0] || '';
}

/**
 * Parses one YAML list at a specific indentation level into mutable task nodes.
 */
function parseList(
    lines: Array<{ raw: string; trimmed: string; indent: number }>,
    startIndex: number,
    itemIndent: number
) {
    // Indentation drives the lightweight parser: list items at this level become sibling commands or steps.
    const items: MutableTask[] = [];
    let index = startIndex;

    while (index < lines.length) {
        const line = lines[index];

        if (!line.trimmed) {
            index++;
            continue;
        }

        if (line.indent < itemIndent) {
            break;
        }

        if (line.indent !== itemIndent || !line.trimmed.startsWith('- ')) {
            index++;
            continue;
        }

        const item: MutableTask = {};
        assignField(item, line.trimmed.slice(2).trim());
        index++;

        while (index < lines.length) {
            const childLine = lines[index];

            if (!childLine.trimmed) {
                index++;
                continue;
            }

            if (childLine.indent <= itemIndent) {
                break;
            }

            if (childLine.trimmed === 'steps:' && childLine.indent === itemIndent + 2) {
                const parsed = parseList(lines, index + 1, itemIndent + 4);
                item.steps = parsed.items;
                index = parsed.nextIndex;
                continue;
            }

            if (childLine.indent === itemIndent + 2) {
                assignField(item, childLine.trimmed);
            }

            index++;
        }

        items.push(item);
    }

    return { items, nextIndex: index };
}

/**
 * Applies a single supported `key: value` pair onto a mutable YAML task object.
 */
function assignField(item: MutableTask, line: string) {
    // Only the extension's known keys are recognized; everything else is ignored.
    const separatorIndex = line.indexOf(':');

    if (separatorIndex === -1) {
        return;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = unquote(line.slice(separatorIndex + 1).trim());

    if (
        key === 'id' ||
        key === 'title' ||
        key === 'description' ||
        key === 'cwd' ||
        key === 'command' ||
        key === 'cron' ||
        key === 'onSave'
    ) {
        item[key] = value;
        return;
    }

    if (key === 'mode' && (value === 'sequence' || value === 'parallel')) {
        item.mode = value;
        return;
    }

    if (key === 'paused') {
        item.paused = value.toLowerCase() === 'true';
        return;
    }

    if (
        key === 'notifyOn' &&
        (value === 'success' || value === 'failure' || value === 'always' || value === 'never')
    ) {
        item.notifyOn = value;
    }
}

/**
 * Converts a parsed top-level YAML node into a runnable command definition.
 */
function toRunnerCommand(item: MutableTask): RunnerCommand | undefined {
    // Top-level commands are tasks plus scheduler and notification metadata.
    const task = toRunnerTask(item);

    if (!task) {
        return undefined;
    }

    return {
        ...task,
        cron: item.cron,
        onSave: item.onSave,
        paused: item.paused,
        notifyOn: item.notifyOn
    };
}

/**
 * Converts a parsed YAML node into either a workflow or a shell command.
 */
function toRunnerTask(item: MutableTask): RunnerTask | undefined {
    // Any node with steps becomes a workflow; otherwise it must resolve to a shell command.
    if (!item.title) {
        return undefined;
    }

    const id = item.id || slugify(item.title);

    if (item.steps && item.steps.length > 0) {
        const steps = item.steps
            .map(toRunnerTask)
            .filter((step): step is RunnerTask => Boolean(step));

        if (steps.length === 0) {
            return undefined;
        }

        return {
            kind: 'workflow',
            id,
            title: item.title,
            description: item.description,
            cwd: item.cwd,
            mode: item.mode || 'sequence',
            steps
        };
    }

    if (!item.command) {
        return undefined;
    }

    return {
        kind: 'command',
        id,
        title: item.title,
        description: item.description,
        cwd: item.cwd,
        command: item.command
    };
}

/**
 * Returns the indentation width for a raw YAML line.
 */
function getIndent(line: string) {
    return line.length - line.trimStart().length;
}

/**
 * Removes matching single or double quotes around a scalar value.
 */
function unquote(value: string) {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith('\'') && value.endsWith('\''))
    ) {
        return value.slice(1, -1);
    }

    return value;
}

/**
 * Removes YAML comments while preserving `#` characters inside quoted strings.
 */
function stripComments(value: string) {
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let index = 0; index < value.length; index++) {
        const char = value[index];

        if (char === '\'' && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }

        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }

        if (char === '#' && !inSingleQuote && !inDoubleQuote) {
            return value.slice(0, index);
        }
    }

    return value;
}

/**
 * Generates a stable id from a title when the YAML omits an explicit `id`.
 */
function slugify(value: string) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'command';
}

/**
 * Returns the supported config filenames for display in the empty state.
 */
export function getConfigFileNames() {
    return [...configFileNames];
}
