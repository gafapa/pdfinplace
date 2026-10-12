import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES } from './locales';
import type { TranslationTree } from './translationTree';

const flatten = (tree: TranslationTree, prefix = ''): Map<string, string> => new Map(
    Object.entries(tree).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [[path, value] as const] : [...flatten(value, path)];
    }),
);
const placeholders = (message: string) => [...message.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
});

describe('translations', async () => {
    const locales = await Promise.all(AVAILABLE_LOCALES.map(async locale =>
        [locale, flatten((await import(`./locales/${locale}.ts`)).default as TranslationTree)] as const));
    const spanish = new Map(locales).get('es')!;

    it.each(locales)('%s defines the same keys and placeholders as es', (_locale, messages) => {
        expect([...messages.keys()].sort()).toEqual([...spanish.keys()].sort());
        for (const [key, message] of spanish) {
            expect(placeholders(messages.get(key) ?? ''), key).toEqual(placeholders(message));
        }
    });

    it('defines every literal key passed to t()', () => {
        const used = new Set(sourceFiles('src').flatMap(file =>
            [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)].map(match => match[1])));
        expect([...used].filter(key => !spanish.has(key))).toEqual([]);
    });
});
