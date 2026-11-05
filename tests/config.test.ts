import { describe, it, expect } from 'vitest';
import { parseSiteConfig } from '../packages/config/site.js';
describe('site settings', () => {
  it('has Japanese provisional defaults without enabling services', () => {
    expect(parseSiteConfig({})).toEqual({name:'日本産蛾類記録データベース（仮称）',nameEn:'Moth Records of Japan (tentative)'});
  });
  it('validates external settings and supports overrides', () => {
    expect(() => parseSiteConfig({publicDomain:'not a URL'})).toThrow();
    expect(() => parseSiteConfig({contactEmail:'invalid'})).toThrow();
    expect(parseSiteConfig({name:'蛾類の記録'}).name).toBe('蛾類の記録');
  });
});
