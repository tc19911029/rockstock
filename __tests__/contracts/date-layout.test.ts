import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOTS = ['app', 'components', 'features'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && path.endsWith('.tsx') ? [path] : [];
  });
}

describe('日期列版面契約', () => {
  it('固定 11 欄只允許由共用 DatePicker 明確提供', () => {
    const offenders = SOURCE_ROOTS
      .flatMap(tsxFiles)
      .filter(path => path !== join('components', 'ui', 'DatePicker.tsx'))
      .filter(path => readFileSync(path, 'utf8').includes('grid-cols-11'))
      .map(path => relative('.', path));

    expect(offenders).toEqual([]);
  });
});
