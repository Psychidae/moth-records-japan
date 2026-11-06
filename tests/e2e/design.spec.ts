import { test,expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const width of [320,768,1280]) test(`shared design at ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});
 const violations=[];
 for(const path of ['/','/styleguide/','/search/','/data/','/about/']){
  await page.goto(path);await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  violations.push(...report.violations);
 }
 expect(violations).toEqual([]);
 await page.goto('/styleguide/');
 expect(await page.locator('.scientific-name').first().evaluate(el=>getComputedStyle(el).fontFamily)).toContain('Times New Roman');
 await page.screenshot({path:testInfo.outputPath(`styleguide-${width}.png`),fullPage:true});
 await testInfo.attach(`styleguide-${width}`,{path:testInfo.outputPath(`styleguide-${width}.png`),contentType:'image/png'});
});
test('mobile navigation works without JavaScript',async({browser})=>{
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:320,height:900}});const page=await context.newPage();
 await page.goto('http://127.0.0.1:4321/');await page.getByText('メニュー',{exact:true}).click();await expect(page.getByRole('navigation',{name:'モバイルメニュー'})).toBeVisible();await context.close();
});
