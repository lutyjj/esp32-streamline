import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Log narration must stay readable in both themes (issue: the default theme
// shipped 1.47:1 log text). Body text meets WCAG AA for normal text (4.5:1);
// de-emphasized and status colors meet the 3:1 non-text/large threshold so
// they stay distinguishable without competing with the body.
const BODY_MIN = 4.5;
const SECONDARY_MIN = 3.0;

const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

function tokens(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

function themeBlock(selector: RegExp): string {
  const match = css.match(selector);
  if (!match) throw new Error(`theme block not found: ${selector}`);
  return match[0];
}

const light = tokens(themeBlock(/:root\s*\{[^}]+\}/));
const darkExplicit = tokens(themeBlock(/:root\[data-theme="dark"\]\s*\{[^}]+\}/));
const darkSystem = tokens(themeBlock(/:root:not\(\[data-theme="light"\]\)\s*\{[^}]+\}/));

// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function luminance(hex: string): number {
  const rgb = hex.replace('#', '');
  const channel = (i: number) => {
    const c = Number.parseInt(rgb.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function themed(theme: Map<string, string>, name: string): string {
  const value = theme.get(name) ?? light.get(name);
  if (!value?.startsWith('#')) throw new Error(`token --${name} is not a hex color: ${value}`);
  return value;
}

describe.each([
  ['default', light],
  ['dark', darkExplicit],
  ['system dark', darkSystem],
])('log palette in the %s theme', (_name, theme) => {
  const inset = themed(theme, 'inset');

  it('keeps log body text at AA contrast on the log background', () => {
    expect(contrast(themed(theme, 'log-text'), inset)).toBeGreaterThanOrEqual(BODY_MIN);
  });

  it('keeps de-emphasized and status colors distinguishable', () => {
    for (const name of ['faint', 'good', 'bad']) {
      expect(contrast(themed(theme, name), inset), `--${name}`).toBeGreaterThanOrEqual(
        SECONDARY_MIN,
      );
    }
  });
});

it('log styles read colors from theme tokens, not raw values', () => {
  const logBlock = css.match(/\/\* -+ Log -+ \*\/[\s\S]*?\n\n/);
  if (!logBlock) throw new Error('log style section not found');
  expect(logBlock[0]).not.toMatch(/color:\s*#/);
});
