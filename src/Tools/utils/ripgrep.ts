import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let cachedRipgrepCommand: string | undefined;

/**
 * Resolve the ripgrep executable used by Grep and Glob.
 *
 * Web/agent processes often inherit a narrower PATH than the interactive shell.
 * On Windows, Codex/VS Code commonly ships rg.exe inside the extension folder,
 * so we probe those known locations after trying normal PATH lookup.
 */
export async function resolveRipgrepCommand(): Promise<string> {
    if (cachedRipgrepCommand) {
        return cachedRipgrepCommand;
    }

    const candidates = unique([
        process.env.OPENCAT_RG_PATH,
        process.env.RIPGREP_PATH,
        "rg",
        ...wellKnownRipgrepCandidates(),
        ...(await discoverVsCodeExtensionRipgrepCandidates()),
    ]);

    for (const candidate of candidates) {
        if (await canRunRipgrep(candidate)) {
            cachedRipgrepCommand = candidate;
            return candidate;
        }
    }

    throw new Error(
        "ripgrep executable not found. Install rg, add it to PATH before starting OpenCat, or set OPENCAT_RG_PATH to rg.exe.",
    );
}

function unique(values: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of values) {
        const value = raw?.trim();
        if (!value || seen.has(value)) {
            continue;
        }

        seen.add(value);
        result.push(value);
    }

    return result;
}

function wellKnownRipgrepCandidates(): string[] {
    if (process.platform !== "win32") {
        return [
            "/usr/local/bin/rg",
            "/opt/homebrew/bin/rg",
            "/usr/bin/rg",
        ];
    }

    const candidates: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;

    if (localAppData) {
        candidates.push(
            path.join(
                localAppData,
                "Programs",
                "Microsoft VS Code",
                "resources",
                "app",
                "node_modules.asar.unpacked",
                "vscode-ripgrep",
                "bin",
                "rg.exe",
            ),
        );
    }

    return candidates;
}

async function discoverVsCodeExtensionRipgrepCandidates(): Promise<string[]> {
    if (process.platform !== "win32") {
        return [];
    }

    const home = os.homedir();
    const extensionRoots = [
        path.join(home, ".vscode", "extensions"),
        path.join(home, ".vscode-insiders", "extensions"),
        path.join(home, ".cursor", "extensions"),
    ];
    const candidates: string[] = [];

    for (const root of extensionRoots) {
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const extensionPath = path.join(root, entry.name);
            candidates.push(
                path.join(extensionPath, "bin", "windows-x86_64", "rg.exe"),
                path.join(extensionPath, "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
            );
        }
    }

    return candidates;
}

function canRunRipgrep(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(command, ["--version"], {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore"],
        });
        const timer = setTimeout(() => {
            child.kill();
            resolve(false);
        }, 3_000);

        child.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });
    });
}
