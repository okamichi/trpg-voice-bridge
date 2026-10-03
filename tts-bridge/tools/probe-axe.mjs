import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({ viewport:{width:1440,height:900} });
page.on('console',m=>{if(m.type()==='error')console.log('console error',m.text().slice(0,180));});
try {
  await page.goto('https://okamichi.github.io/udonarium_axe/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForTimeout(5000);
  console.log(JSON.stringify({url:page.url(),title:await page.title(),body:(await page.locator('body').innerText()).slice(0,4500),buttons:await page.locator('button').allTextContents(),chatRows:await page.locator('chat-message').count(),ngGetComponent:await page.evaluate(()=>typeof globalThis.ng?.getComponent)},null,2));
  console.log('structure',JSON.stringify(await page.evaluate(()=>({chatTabs:document.querySelectorAll('chat-tab').length,visibleChatTabs:[...document.querySelectorAll('chat-tab')].filter(x=>x.getClientRects().length).length,firstRow:document.querySelector('chat-message')?.outerHTML.slice(0,1600),angularGlobals:Object.keys(window).filter(x=>x.toLowerCase().includes('angular')||x==='ng')})),null,2));
  await page.evaluate(()=>{window.__trpgCollectorSettings={adapter:'udonarium',contextId:'probe',channel:'main'};window.__trpgCaptured=[];window.addEventListener('message',e=>{if(e.data?.channel==='trpg-voice-collector-v1')window.__trpgCaptured.push(e.data);});});
  await page.evaluate(readFileSync(new URL('../collector/page.js',import.meta.url),'utf8'));
  await page.waitForTimeout(300);
  console.log('collector',JSON.stringify(await page.evaluate(()=>window.__trpgCaptured),null,2));
  await page.screenshot({path:join(tmpdir(),'trpg-axe-root.png'),fullPage:true});
} finally {await browser.close();}
