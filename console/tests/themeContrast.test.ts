import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BODY_MIN = 4.5;
const SECONDARY_MIN = 4.5;

const css = readFileSync(resolve(import.meta.dirname, '../src/tokens.css'), 'utf8');

function tokens(theme: 'light' | 'dark'): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, light, dark] of css.matchAll(
    /--([\w-]+):\s*light-dark\((#[\da-f]+),\s*(#[\da-f]+)\)/g,
  )) {
    map.set(name, theme === 'light' ? light : dark);
  }
  return map;
}
const light = tokens('light');
const darkExplicit = tokens('dark');
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

describe.each([
  ['light', light],
  ['dark', darkExplicit],
])('readable %s controls', (_name, theme) => {
  for (const surface of ['bg', 'surface', 'surface-2', 'inset']) {
    it(`keeps all text readable on ${surface}`, () => {
      for (const foreground of ['text', 'muted', 'faint', 'accent']) {
        expect(
          contrast(themed(theme, foreground), themed(theme, surface)),
          foreground,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it('keeps primary labels and focus indicators readable', () => {
    expect(
      contrast(themed(theme, 'primary-text'), themed(theme, 'primary-bg')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themed(theme, 'focus'), themed(theme, 'surface'))).toBeGreaterThanOrEqual(3);
  });
});
