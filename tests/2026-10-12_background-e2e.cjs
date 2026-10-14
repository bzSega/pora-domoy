// Live integration uses an isolated temporary profile and a public test route.
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const routeURL='https://yandex.ru/maps/?rtext=55.751244%2C37.618423~55.790278%2C37.531667&rtt=auto';
const extension=process.env.COMMUTE_TEST_EXTENSION || path.join(root,'extension');
const executable=process.env.COMMUTE_TEST_BROWSER || chromium.executablePath();
const label=executable.includes('Yandex')?'yandex':'chrome';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  await fs.mkdir(path.join(root,'res'),{recursive:true});
  const version=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'),'utf8')).version;
  const stamp=process.env.COMMUTE_TEST_DATE || new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Moscow'});
  const artifact=name=>path.join(root,`res/${stamp}_v${version}_${label}-${name}`);
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'commute-e2e-'));
  let context;
  const report={startedAt:new Date().toISOString(),checks:[]};
  try {
    context=await chromium.launchPersistentContext(profile,{headless:true,executablePath:executable,
      ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
    const cdp=await context.browser().newBrowserCDPSession();
    report.browser=(await cdp.send('Browser.getVersion')).product;
    const {id}=await cdp.send('Extensions.loadUnpacked',{path:extension});
    const popup=await context.newPage();
    await popup.setViewportSize({width:1280,height:800});
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.screenshot({path:artifact('setup.png'),clip:{x:0,y:0,width:380,height:600}});
    await popup.locator('#route').fill(routeURL);
    const worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker');
    await worker.evaluate(()=>{
      globalThis.__testMessages=[];
      chrome.runtime.onMessage.addListener((m,s)=>{
        if(!['widget-sample','offscreen-job','offscreen-timeout'].includes(m.type))return;
        __testMessages.push({type:m.type,hasHash:!!s.url?.includes('#'),hasTab:!!s.tab,frameId:s.frameId,data:m.data,source:s.url?new URL(s.url).origin+new URL(s.url).pathname:null});
      });
    });
    const snapshot=()=>worker.evaluate(async()=>{
      const {sample,status}=await chrome.storage.local.get(['sample','status']);
      const {job}=await chrome.storage.session.get('job');
      const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
      const tabs=await chrome.tabs.query({});
      return {status,sample:sample?{minutes:sample.minutes,duration:sample.duration,distance:sample.distance,source:sample.source,readAt:sample.readAt}:null,hasJob:!!job,offscreen:contexts.length,routeTabs:tabs.filter(t=>/^https:\/\/(?:www\.)?yandex\.ru\/(?:maps|map-widget)\//.test(t.url||'')).length,messages:globalThis.__testMessages};
    });
    async function waitForTime(after=0){
      const start=Date.now();let last,latest;
      while(Date.now()-start<65000){
        latest=await snapshot();
        if(latest.status!==last){console.log(JSON.stringify({elapsed:Date.now()-start,status:latest.status,minutes:latest.sample?.minutes,offscreen:latest.offscreen,routeTabs:latest.routeTabs,messages:latest.messages?.length}));last=latest.status;}
        if(latest.sample?.source==='background'&&latest.sample.readAt>after&&!latest.status&&!latest.hasJob&&latest.offscreen===0)return latest;
        if(Date.now()-start>3000&&!latest.hasJob&&latest.status&&!latest.status.includes('Обновляю')&&latest.status!=='Маршрут сохранён.')break;
        await pause(500);
      }
      report.final=latest;
      assert.fail('Background time did not arrive: '+JSON.stringify(latest));
    }
    await popup.locator('#save').click();
    const first=await waitForTime();
    assert.equal(first.routeTabs,0);report.checks.push('Save → real widget → content script → worker → fresh time, with no route tab');
    await popup.waitForFunction(value=>document.getElementById('duration').textContent===value,first.sample.duration);
    const map = popup.frameLocator('#routeMap');
    await map.locator('.map-widget-routes-content-view').waitFor({timeout:45000});
    const frameURL = await popup.locator('#routeMap').getAttribute('src');
    assert.equal(new URL(frameURL).hash,'');
    const bbox=await popup.locator('#routeMap').boundingBox();assert.ok(bbox.width>=300 && bbox.height>=300);
    await popup.evaluate(()=>render(current));
    assert.equal(await popup.locator('#routeMap').getAttribute('src'),frameURL);
    report.checks.push('Visible real route card in popup, >=300px iframe, no background token, stable URL on rerender');
    // Exercise the exact user action after the first offscreen document was destroyed.
    await popup.locator('#refresh').click();
    const second=await waitForTime(first.sample.readAt);
    assert.equal(second.routeTabs,0);report.checks.push('Refresh creates a new offscreen document and delivers a newer real sample');
    assert.equal(second.offscreen,0);assert.equal(second.hasJob,false);report.checks.push('Background document and job are released after each result');
    await popup.waitForFunction(value=>document.getElementById('duration').textContent===value,second.sample.duration);
    await popup.evaluate(()=>{document.body.scrollTop=0;window.scrollTo(0,0);});
    await popup.screenshot({path:artifact('live.png'),clip:{x:0,y:0,width:380,height:600}});
    await popup.locator('#reverse').click();
    const reversed=await waitForTime(second.sample.readAt);
    const reverseState=await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings);
    assert.equal(reverseState.direction,'work');
    assert.equal(reverseState.key,'55.790278,37.531667~55.751244,37.618423');
    await popup.waitForFunction(()=>document.getElementById('directionLabel').textContent==='ДОМ → РАБОТА');
    report.checks.push('Reverse route delivers a real result for opposite endpoints');
    await popup.locator('#schedulePanel > summary').click();
    await popup.locator('#scheduleEnabled').check();
    const closedDay=(new Date().getDay()+3)%7;
    for(const day of await popup.locator('[name="day"]').all()) await day.setChecked(Number(await day.getAttribute('value'))===closedDay);
    await popup.locator('#saveSchedule').click();
    await popup.waitForFunction(()=>document.getElementById('scheduleFeedback').textContent.includes('сохранено'));
    await popup.locator('#auto').check();
    await worker.evaluate(async()=>{await chrome.alarms.create('refresh',{when:Date.now()+1000});});
    await pause(2500);
    const paused=await snapshot();assert.equal(paused.hasJob,false);assert.equal(paused.sample.readAt,reversed.sample.readAt);
    report.checks.push('Real alarm outside schedule does not issue a new request');
    await popup.locator('#scheduleEnabled').uncheck();await popup.locator('#saveSchedule').click();
    await popup.locator('#schedulePanel > summary').click();
    await popup.locator('footer summary').click();await popup.locator('#diagnostics').click();
    const diagnostic=await popup.locator('#diagnosticsText').inputValue();
    assert.doesNotMatch(diagnostic,/55\.790|55\.751|37\.531|37\.618|rtext|https:/);
    report.checks.push('User-facing diagnostics contain no route or addresses');
    // No popup is required for a scheduled refresh.
    await popup.locator('#auto').check();
    await popup.close();
    await worker.evaluate(async()=>{await chrome.alarms.create('refresh',{when:Date.now()+1500});});
    const third=await waitForTime(reversed.sample.readAt);
    assert.equal(third.routeTabs,0);report.checks.push('Real browser alarm refreshes with popup closed and no Maps tab');
    report.final=third;
    const reopened=await context.newPage();await reopened.setViewportSize({width:1280,height:800});
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    await reopened.locator('#settingsButton').click();
    await reopened.waitForFunction(()=>document.getElementById('route').value.includes('55.751244'));
    const editURL=new URL(await reopened.locator('#route').inputValue());
    assert.equal(editURL.searchParams.get('rtext'),'55.751244,37.618423~55.790278,37.531667');
    await reopened.locator('#route').fill('https://example.com/');await reopened.locator('#save').click();
    await reopened.waitForFunction(()=>!document.getElementById('error').hidden);
    assert.equal((await snapshot()).sample.readAt,third.sample.readAt);
    await reopened.locator('#reset').click();
    assert.equal((await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings)).direction,'work');
    await reopened.locator('#confirmReset').click();
    await reopened.waitForFunction(()=>!document.getElementById('setup').hidden && document.getElementById('cancel').hidden);
    assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(null)),{});
    report.checks.push('Editing opposite direction uses work-to-home order; invalid URL preserves route; reset requires confirmation and clears storage');
    console.log('PASS',JSON.stringify({browser:report.browser,checks:report.checks,minutes:third.sample.minutes,routeTabs:third.routeTabs,offscreen:third.offscreen}));
  }catch(e){report.error=String(e.message).replace(/https?:\/\/[^\s"']+/g,'<URL>');process.exitCode=1;console.log('FAIL',report.error);}
  finally {
    const resultPath=artifact('e2e.json');
    await fs.writeFile(resultPath,JSON.stringify(report,null,2));console.log('Report:',resultPath);
    if(context)await context.close();
    await fs.rm(profile,{recursive:true,force:true});
  }
})();
