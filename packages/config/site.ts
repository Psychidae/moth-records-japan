import { z } from 'zod';
const SiteConfig = z.object({
  name: z.string().min(1).default('日本産蛾類記録データベース（仮称）'),
  nameEn: z.string().min(1).default('Moth Records of Japan (tentative)'),
  publicDomain: z.string().url().optional(),
  contactEmail: z.string().email().optional(),
});
export const parseSiteConfig = (input: unknown) => SiteConfig.parse(input);
export const site = parseSiteConfig({
  ...(process.env.SITE_NAME ? { name: process.env.SITE_NAME } : {}),
  ...(process.env.SITE_NAME_EN ? { nameEn: process.env.SITE_NAME_EN } : {}),
  ...(process.env.PUBLIC_DOMAIN ? { publicDomain: process.env.PUBLIC_DOMAIN } : {}),
  ...(process.env.CONTACT_EMAIL ? { contactEmail: process.env.CONTACT_EMAIL } : {}),
});
