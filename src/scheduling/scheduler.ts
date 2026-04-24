/**
 * In-process cron scheduler for the extension host.
 * Flow: periodic tick -> load YAML -> match cron expressions -> invoke runNamedCommand for due items.
 */
import * as vscode from 'vscode';
import { loadCommandConfig, type RunnerCommand } from '../config/commandConfig';

type RunCommand = (commandId?: string, source?: 'manual' | 'scheduled' | 'on-save') => Promise<void>;
const minuteWindowMs = 24 * 60 * 60 * 1000;

export class CronScheduler implements vscode.Disposable {
    private timer?: NodeJS.Timeout;
    private readonly lastRunByCommand = new Map<string, string>();
    private paused = false;
    private running = false;

    /**
     * Accepts the callback used to run scheduled commands by id.
     */
    constructor(private readonly runCommand: RunCommand) {}

    /**
     * Starts the repeating timer that checks for due cron jobs.
     */
    start() {
        // Run once immediately so due commands do not wait for the first interval.
        this.tick();
        this.timer = setInterval(() => {
            void this.tick();
        }, 30_000);
    }

    /**
     * Stops the repeating timer when the extension is disposed.
     */
    dispose() {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    /**
     * Returns whether the global scheduler pause switch is enabled.
     */
    isPaused() {
        return this.paused;
    }

    /**
     * Sets the global scheduler pause switch for all cron-based runs.
     */
    setPaused(paused: boolean) {
        this.paused = paused;
    }

    private async tick() {
        // A single guard prevents overlapping ticks and honors the global scheduler pause state.
        if (this.running || this.paused) {
            return;
        }

        this.running = true;

        try {
            const config = await loadCommandConfig();

            if (config.error) {
                return;
            }

            const now = new Date();
            const minuteKey = getMinuteKey(now);

            for (const command of config.commands) {
                // Only top-level commands with cron and without YAML pause state participate in scheduling.
                if (!command.cron || command.paused) {
                    continue;
                }

                if (!matchesCronExpression(command.cron, now)) {
                    continue;
                }

                if (this.lastRunByCommand.get(command.id) === minuteKey) {
                    continue;
                }

                // Commands are de-duplicated per minute because the timer checks twice per minute.
                this.lastRunByCommand.set(command.id, minuteKey);
                await this.runCommand(command.id, 'scheduled');
            }
        } finally {
            this.running = false;
        }
    }
}

/**
 * Finds the next minute in the next 24 hours that matches a cron expression.
 */
export function getNextRunTime(expression: string, from = new Date()) {
    // Sidebar next-run hints search up to 24 hours ahead for the next matching minute.
    const start = new Date(from.getTime());
    start.setSeconds(0, 0);

    for (let offset = 1; offset <= minuteWindowMs / 60_000; offset++) {
        const candidate = new Date(start.getTime() + offset * 60_000);

        if (matchesCronExpression(expression, candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/**
 * Builds a stable per-minute key used to prevent duplicate runs within the same minute.
 */
function getMinuteKey(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * Checks whether a specific date matches a standard 5-field cron expression.
 */
export function matchesCronExpression(expression: string, date: Date) {
    // This scheduler implements standard 5-field cron: minute hour day-of-month month day-of-week.
    const parts = expression.trim().split(/\s+/);

    if (parts.length !== 5) {
        return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    return (
        matchesField(minute, date.getMinutes(), 0, 59) &&
        matchesField(hour, date.getHours(), 0, 23) &&
        matchesField(dayOfMonth, date.getDate(), 1, 31) &&
        matchesField(month, date.getMonth() + 1, 1, 12) &&
        matchesField(dayOfWeek, date.getDay(), 0, 6)
    );
}

/**
 * Tests a single cron field that may include lists such as `1,5,10`.
 */
function matchesField(field: string, value: number, min: number, max: number) {
    return field.split(',').some((part) => matchesPart(part.trim(), value, min, max));
}

/**
 * Tests one cron part such as star, step, range, or exact-value syntax.
 */
function matchesPart(part: string, value: number, min: number, max: number) {
    if (part === '*') {
        return true;
    }

    const [base, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : undefined;

    if (stepText && (step === undefined || !Number.isInteger(step) || step < 1)) {
        return false;
    }

    const normalizedStep = step ?? 1;

    if (base === '*') {
        return value >= min && value <= max && (value - min) % normalizedStep === 0;
    }

    const range = parseRange(base, min, max);

    if (!range) {
        return false;
    }

    const [start, end] = range;

    if (value < start || value > end) {
        return false;
    }

    return step ? (value - start) % normalizedStep === 0 : true;
}

/**
 * Parses either a single value or a numeric range from a cron field.
 */
function parseRange(value: string, min: number, max: number) {
    if (value.includes('-')) {
        const [startText, endText] = value.split('-');
        const start = Number(startText);
        const end = Number(endText);

        if (!isValidNumber(start, min, max) || !isValidNumber(end, min, max) || start > end) {
            return undefined;
        }

        return [start, end] as const;
    }

    const exact = Number(value);

    if (!isValidNumber(exact, min, max)) {
        return undefined;
    }

    return [exact, exact] as const;
}

/**
 * Validates that a cron numeric value is an integer within the allowed bounds.
 */
function isValidNumber(value: number, min: number, max: number) {
    return Number.isInteger(value) && value >= min && value <= max;
}
