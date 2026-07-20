import { readdir, readFile, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { getCwd } from "./cwd.js";
import { ToolUseContext, SkillRuntimeState, SkillCommand } from "../types.js";

type dynamicSkills = Map<string, SkillCommand>

export async function discoverSkillsForReadPath(
    fullFilePath: string,
    context: ToolUseContext,
): Promise<void> {
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd, context.skillRuntime)

    for (const dir of newSkillDirs) {
        context.dynamicSkillDirTriggers?.add(dir)
    }

    if (newSkillDirs.length > 0) {
        await addSkillDirectories(newSkillDirs, context.skillRuntime)
    }

    activateConditionalSkillsForPaths([fullFilePath], cwd, context.skillRuntime)
}


export async function discoverSkillDirsForPaths(
    filePaths: string[],
    cwd: string,
    SkillRuntimeState: SkillRuntimeState
): Promise<string[]> {
    const root = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd
    const discovered: string[] = []

    for (const filePath of filePaths) {
        let currentDir = dirname(filePath)

        while (currentDir === root || currentDir.startsWith(root + sep)) {
            const skillDir = join(currentDir, '.claude', 'skills')

            if (!SkillRuntimeState.checkedSkillDirs.has(skillDir)) {
                SkillRuntimeState.checkedSkillDirs.add(skillDir)

                try {
                    const stats = await stat(skillDir)
                    if (stats.isDirectory()) {
                        discovered.push(skillDir)
                    }
                } catch {
                    // No skills directory here.
                }
            }

            const parent = dirname(currentDir)
            if (parent === currentDir) break
            currentDir = parent
        }
    }

    return discovered.sort((a, b) => b.split(sep).length - a.split(sep).length)
}

export async function addSkillDirectories(dirs: string[], SkillRuntimeState: SkillRuntimeState): Promise<void> {
    if (dirs.length === 0) return

    const loaded = await Promise.all(dirs.map(loadSkillsFromDirectory))

    for (let i = loaded.length - 1; i >= 0; i--) {
        for (const skill of loaded[i] ?? []) {
            if (skill.paths?.length) {
                SkillRuntimeState.conditionalSkills.set(skill.name, skill)
            } else {
                SkillRuntimeState.dynamicSkills.set(skill.name, skill)
            }
        }
    }
}

export function activateConditionalSkillsForPaths(
    filePaths: string[],
    cwd: string,
    SkillRuntimeState: SkillRuntimeState
): string[] {
    const activated: string[] = []

    for (const [name, skill] of SkillRuntimeState.conditionalSkills) {
        if (!skill.paths?.length) continue

        for (const filePath of filePaths) {
            const relativePath = normalizePathForSkillMatch(
                isAbsolute(filePath) ? relative(cwd, filePath) : filePath,
            )
            if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
                continue
            }

            if (matchesAnyPattern(relativePath, skill.paths)) {
                SkillRuntimeState.dynamicSkills.set(name, skill)
                SkillRuntimeState.conditionalSkills.delete(name)
                SkillRuntimeState.activatedConditionalSkillNames.add(name)
                activated.push(name)
                break
            }
        }
    }

    return activated
}

export function getDynamicSkills(context: ToolUseContext): SkillCommand[] {
    return [...context.skillRuntime.dynamicSkills.values()]
}

async function loadSkillsFromDirectory(dir: string): Promise<SkillCommand[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const skills: SkillCommand[] = []

    for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillName = entry.name
        const skillDir = join(dir, skillName)
        const skillFile = join(skillDir, 'SKILL.md')

        try {
            const content = await readFile(skillFile, 'utf8')
            skills.push(parseSkillFile(skillName, content, skillDir, skillFile))
        } catch {
            // Directory without SKILL.md is not a skill.
        }
    }

    return skills
}

function parseSkillFile(
    name: string,
    raw: string,
    skillDir: string,
    skillPath: string,
): SkillCommand {
    const { frontmatter, body } = parseFrontmatter(raw)

    return {
        name,
        description: frontmatter.description ?? name,
        content: body.trim(),
        allowedTools: parseFrontmatterList(frontmatter["allowed-tools"]),
        executionContext: frontmatter.context === "fork" ? "fork" : undefined,
        paths: frontmatter.paths?.split(',').map(p => p.trim()).filter(Boolean),
        skillDir,
        skillPath,
    }
}

function parseFrontmatterList(value: string | undefined): string[] | undefined {
    if (!value) {
        return undefined
    }

    const parsed = value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)

    return parsed.length > 0 ? parsed : undefined
}

function parseFrontmatter(raw: string): {
    frontmatter: Record<string, string>
    body: string
} {
    if (!raw.startsWith('---')) {
        return { frontmatter: {}, body: raw }
    }

    const end = raw.indexOf('\n---', 3)
    if (end === -1) {
        return { frontmatter: {}, body: raw }
    }

    const header = raw.slice(3, end).trim()
    const body = raw.slice(end + 4)

    const frontmatter: Record<string, string> = {}
    for (const line of header.split('\n')) {
        const index = line.indexOf(':')
        if (index === -1) continue

        const key = line.slice(0, index).trim()
        const value = line.slice(index + 1).trim()
        frontmatter[key] = value
    }

    return { frontmatter, body }
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
        const normalizedPattern = normalizePathForSkillMatch(pattern)

        if (normalizedPattern === filePath) return true
        if (normalizedPattern.endsWith('/**')) {
            return filePath.startsWith(normalizedPattern.slice(0, -3))
        }
        if (normalizedPattern.endsWith('*')) {
            return filePath.startsWith(normalizedPattern.slice(0, -1))
        }
        return filePath.includes(normalizedPattern)
    })
}

function normalizePathForSkillMatch(filePath: string): string {
    return filePath.replaceAll('\\', '/')
}
