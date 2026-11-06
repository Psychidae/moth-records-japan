import { describe, it, expect } from 'vitest';
import { parseSiteConfig } from '../packages/config/site.js';
describe('site settings', () => {
  it('has an English title and Japanese subtitle without enabling services', () => {
    expect(parseSiteConfig({})).toEqual({name:'Japanese Moth Distribution Records Database',nameJa:'日本産蛾類分布記録データベース',nameEn:'Japanese Moth Distribution Records Database'});
  });
  it('validates external settings and supports overrides', () => {
    expect(() => parseSiteConfig({publicDomain:'not a URL'})).toThrow();
    expect(() => parseSiteConfig({contactEmail:'invalid'})).toThrow();
    expect(parseSiteConfig({name:'蛾類の記録'}).name).toBe('蛾類の記録');
  });
});
