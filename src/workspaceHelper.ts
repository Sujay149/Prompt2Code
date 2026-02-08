import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ────────────────────────────────────────────────────
// Workspace-level helpers: scan files, read them,
// create new files, and build a codebase summary.
// ────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', '.vscode',
  '__pycache__', '.next', 'build', 'coverage',
  '_vsix_extract', '_vsix_extract_101',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.scss',
  '.json', '.md', '.py', '.java', '.c', '.cpp', '.h',
  '.go', '.rs', '.rb', '.php', '.vue', '.svelte',
  '.yaml', '.yml', '.toml', '.xml', '.sh', '.bat',
  '.sql', '.graphql', '.env', '.txt',
]);

/** Recursively list workspace files (relative paths). */
export async function listWorkspaceFiles(maxFiles = 200): Promise<string[]> {
  const root = getWorkspaceRoot();
  if (!root) { return []; }

  const result: string[] = [];
  await walk(root, root, result, maxFiles);
  return result;
}

async function walk(dir: string, root: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) { return; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= max) { return; }

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) { continue; }
      await walk(path.join(dir, entry.name), root, out, max);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) {
        out.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  }
}

/** Read a workspace file by relative path. Returns null on failure. */
export async function readWorkspaceFile(relPath: string): Promise<string | null> {
  const root = getWorkspaceRoot();
  if (!root) { return null; }

  const abs = path.resolve(root, relPath);
  // Prevent path-traversal
  if (!abs.startsWith(root)) { return null; }

  try {
    const uri = vscode.Uri.file(abs);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Create (or overwrite) a file in the workspace, then open it in the editor.
 * Directories are created automatically.
 */
export async function createWorkspaceFile(
  relPath: string,
  content: string
): Promise<vscode.TextEditor | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return undefined;
  }

  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root)) {
    vscode.window.showErrorMessage('Invalid file path.');
    return undefined;
  }

  // Ensure parent directories exist
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });

  // Write file
  const uri = vscode.Uri.file(abs);
  const encoded = new TextEncoder().encode(content);
  await vscode.workspace.fs.writeFile(uri, encoded);

  // Open in editor
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  return editor;
}

/**
 * Build a compact project tree string for the AI prompt
 * so it can understand the project structure.
 */
export async function buildProjectTree(): Promise<string> {
  const files = await listWorkspaceFiles(150);
  if (files.length === 0) { return '(no workspace files found)'; }
  return files.join('\n');
}

/**
 * Read multiple workspace files and format as context sections.
 * Each file is labelled with its path and truncated if too long.
 */
export async function readFilesAsContext(
  relPaths: string[],
  maxCharsPerFile = 10_000
): Promise<string> {
  const sections: string[] = [];

  for (const rp of relPaths) {
    const text = await readWorkspaceFile(rp);
    if (!text) { continue; }

    const clipped = text.length > maxCharsPerFile
      ? text.slice(0, maxCharsPerFile) + '\n/* ...truncated... */\n'
      : text;
    sections.push(`--- FILE: ${rp} ---\n${clipped}`);
  }

  return sections.join('\n\n');
}

/** Resolve `@file path/to/file` references in a message string. */
export function extractFileReferences(message: string): string[] {
  const refs: string[] = [];
  // Match @file path or #file:path
  const re = /(?:@file\s+|#file:)([^\s,]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) {
    refs.push(m[1]);
  }
  return refs;
}

/** Strip all @file / #file: tokens from the message so the AI sees clean text. */
export function stripFileReferences(message: string): string {
  return message.replace(/(?:@file\s+|#file:)[^\s,]+/gi, '').trim();
}

// ────────────────────────────────────────────────────
// AUTO-CONTEXT: gather relevant project files for the AI
// ────────────────────────────────────────────────────

/** Config / manifest files that give the AI project-level awareness. */
const CONFIG_FILES = [
  'package.json', 'tsconfig.json', 'jsconfig.json',
  'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs',
  'webpack.config.js', 'tailwind.config.js', 'tailwind.config.ts',
  '.eslintrc.json', '.prettierrc', 'requirements.txt', 'pyproject.toml',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
];

/** Map VS Code languageId to file extensions the AI should see. */
const LANG_EXTENSIONS: Record<string, string[]> = {
  javascript:       ['.js', '.jsx', '.mjs'],
  typescript:       ['.ts', '.tsx'],
  javascriptreact:  ['.jsx', '.js', '.tsx', '.ts'],
  typescriptreact:  ['.tsx', '.ts', '.jsx', '.js'],
  html:             ['.html', '.css', '.js', '.ts'],
  css:              ['.css', '.scss', '.html'],
  scss:             ['.scss', '.css', '.html'],
  python:           ['.py'],
  java:             ['.java'],
  go:               ['.go'],
  rust:             ['.rs'],
  c:                ['.c', '.h'],
  cpp:              ['.cpp', '.hpp', '.h'],
  vue:              ['.vue', '.ts', '.js'],
  svelte:           ['.svelte', '.ts', '.js'],
};

interface GatherOptions {
  /** VS Code languageId of the current file (e.g. "typescript"). */
  languageId?: string;
  /** Absolute path of the file the user is editing — excluded from results. */
  currentFilePath?: string;
  /** Max total characters across all returned files. Default 50 000. */
  maxChars?: number;
  /** Max files to include. Default 15. */
  maxFiles?: number;
  /** Max characters for any single file. Default 10 000. */
  maxPerFile?: number;
}

export interface ProjectContext {
  /** Formatted context string ready to inject into the prompt. */
  text: string;
  /** Number of files included. */
  fileCount: number;
}

/**
 * Automatically gather relevant project files for the AI prompt:
 *  1. Config / manifest files (package.json, tsconfig, etc.)
 *  2. Same-language sibling files (prioritised by proximity to currentFile)
 *  3. Currently-open editor tabs (even if different language)
 *
 * The result is a structured text block the AI can use to understand the
 * project conventions, dependencies, and existing code patterns.
 */
export async function gatherProjectContext(opts: GatherOptions = {}): Promise<ProjectContext> {
  const root = getWorkspaceRoot();
  if (!root) { return { text: '', fileCount: 0 }; }

  const maxChars     = opts.maxChars  ?? 50_000;
  const maxFiles     = opts.maxFiles  ?? 15;
  const maxPerFile   = opts.maxPerFile ?? 10_000;
  const currentAbs   = opts.currentFilePath ? path.resolve(opts.currentFilePath) : '';
  const langExts     = opts.languageId ? (LANG_EXTENSIONS[opts.languageId] ?? []) : [];

  const sections: string[] = [];
  const included = new Set<string>();
  let totalChars = 0;

  const addFile = async (relPath: string, label?: string): Promise<boolean> => {
    const key = relPath.replace(/\\/g, '/');
    if (included.has(key)) { return false; }
    if (included.size >= maxFiles || totalChars >= maxChars) { return false; }

    const absPath = path.resolve(root, relPath);
    if (absPath === currentAbs) { return false; }

    const content = await readWorkspaceFile(relPath);
    if (!content) { return false; }

    const clipped = content.length > maxPerFile
      ? content.slice(0, maxPerFile) + '\n/* ...truncated... */\n'
      : content;

    included.add(key);
    sections.push(`--- ${label ?? ('FILE: ' + key)} ---\n${clipped}`);
    totalChars += clipped.length;
    return true;
  };

  // ── 1. Config / manifest files (small but high-signal) ──
  for (const cfg of CONFIG_FILES) {
    if (totalChars >= maxChars) { break; }
    await addFile(cfg, `CONFIG: ${cfg}`);
  }

  // ── 2. Project tree (lightweight overview) ──
  const tree = await buildProjectTree();
  if (tree) {
    sections.splice(included.size, 0, `--- PROJECT STRUCTURE ---\n${tree}`);
    totalChars += tree.length;
  }

  // ── 3. Same-language sibling files (sorted by directory proximity) ──
  if (langExts.length > 0) {
    const allFiles = await listWorkspaceFiles(300);
    const currentDir = currentAbs ? path.dirname(currentAbs) : root;

    // Score files: closer to currentFile's directory = higher priority
    const scored = allFiles
      .filter(f => {
        const ext = path.extname(f).toLowerCase();
        return langExts.includes(ext);
      })
      .map(f => {
        const abs = path.resolve(root, f);
        // Count shared path segments for proximity
        const relToDir = path.relative(currentDir, path.dirname(abs));
        const depth = relToDir.split(/[\\/]/).filter(Boolean).length;
        return { file: f, depth };
      })
      .sort((a, b) => a.depth - b.depth);

    for (const { file } of scored) {
      if (totalChars >= maxChars || included.size >= maxFiles) { break; }
      await addFile(file);
    }
  }

  // ── 4. Currently open editors (different language files the user may care about) ──
  for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
    if (totalChars >= maxChars || included.size >= maxFiles) { break; }
    const input = tab.input as { uri?: vscode.Uri } | undefined;
    if (!input?.uri || input.uri.scheme !== 'file') { continue; }
    const abs = input.uri.fsPath;
    if (!abs.startsWith(root)) { continue; }
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    await addFile(rel, `OPEN TAB: ${rel}`);
  }

  return {
    text: sections.join('\n\n'),
    fileCount: included.size,
  };
}

// ── internal ──

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
