importScripts('core.js');
let queue = Promise.resolve();
const serial = job => { const next = queue.then(job); queue = next.catch(() => {}); return next; };
const backgroundSupported = () => !!chrome.offscreen?.createDocument;
const mode = s => s.settings?.mode === 'tab' || !backgroundSupported() ? 'tab' : 'background';
const state = async () => {
  const local = await chrome.storage.local.get(['settings','sample','status']);
  // Purge on the first extension activity after expiry, including startup.
  if (local.sample && (!Number.isFinite(local.sample.readAt) || Date.now() - local.sample.readAt >= Commute.CACHE_MS || local.sample.readAt > Date.now() || local.sample.key !== local.settings?.key)) {
    await chrome.storage.local.remove('sample'); delete local.sample;
  }
  return {...local,...(await chrome.storage.session.get(['tabId','job'])),backgroundSupported:backgroundSupported()};
};
async function badge() {
  const s = await state();
  const known = s.sample && s.settings && s.sample.key === s.settings.key;
  const fresh = known && (s.sample.source === 'background' || s.tabId !== undefined) && !s.status && !Commute.stale(s.sample);
  const minutes = known ? (s.sample.minutes > 999 ? '999+' : String(s.sample.minutes)) : '';
  const text = fresh ? minutes : known ? `${s.sample.minutes > 99 ? '99+' : minutes}?` : s.settings ? '—' : '';
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color:fresh ? '#235e46' : known ? '#916025' : '#77766e'});
  await chrome.action.setTitle({title:known ? `${s.settings.direction === 'work' ? 'На работу' : 'Домой'}: ${s.sample.duration}${fresh ? '' : ' — последняя оценка, обновите данные'} · Яндекс Карты${s.status ? ' · '+s.status : ''}` : (s.status || 'Пора домой · обновите данные')});
}
async function unavailable(status) { await chrome.storage.local.set({status}); await badge(); }
async function hasOffscreen() {
  if (!backgroundSupported()) return false;
  if (chrome.runtime.getContexts) return (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('offscreen.html')]})).length > 0;
  return (await clients.matchAll()).some(c=>c.url === chrome.runtime.getURL('offscreen.html'));
}
async function stopBackground() {
  await chrome.storage.session.remove('job');
  await chrome.alarms.clear('job-timeout');
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}
async function startBackground() {
  const s=await state();
  if (!s.settings) throw new Error('Сначала сохраните маршрут.');
  if (s.job?.key === s.settings.key && Date.now() < s.job.deadline) return;
  await stopBackground();
  const id=crypto.randomUUID(), now=Date.now();
  const job={id,key:s.settings.key,url:Commute.widgetURL(s.settings.url,id),startedAt:now,deadline:now+60000};
  await chrome.storage.session.set({job});
  await unavailable('Обновляю время в фоне…');
  await chrome.alarms.create('job-timeout',{when:job.deadline});
  try {
    await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['DOM_SCRAPING'],justification:'Read current travel time from the Yandex Maps route widget without keeping a user tab open.'});
  } catch {
    await stopBackground();
    await unavailable('Браузер не запустил фоновое чтение. Попробуйте обновить или выберите режим «Открытая вкладка».');
  }
}
async function backgroundTimeout(jobId) {
  const s=await state(); if (!s.job || s.job.id!==jobId) return;
  await stopBackground();
  await unavailable('Карты не ответили в фоне. Повторите обновление или выберите режим «Открытая вкладка».');
}
async function acceptWidget(message,sender) {
  const s=await state(), job=s.job;
  if (sender.id!==chrome.runtime.id || !job || message.jobId!==job.id || mode(s)!=='background' || Date.now()>job.deadline) return;
  let route; try {route=Commute.widgetRoute(sender.url);} catch{return;}
  if (route.jobId!==job.id || route.key!==job.key || message.key!==job.key || s.settings?.key!==job.key) return;
  const d=message.data;
  if (!d || !Number.isInteger(d.minutes) || d.minutes!==Commute.minutes(d.duration) || !/^\d+(?:[,.]\d+)?\s*(?:км|м)$/.test(d.distance)) return;
  await chrome.storage.local.set({sample:{key:job.key,minutes:d.minutes,duration:String(d.duration).slice(0,40),distance:d.distance,readAt:Date.now(),source:'background'},status:''});
  await stopBackground(); await badge();
}
async function accept(data, tabId, url) {
  const s = await state();
  if (!s.settings || mode(s)!=='tab' || s.tabId !== tabId) return;
  let actual;
  try { actual = Commute.route(url); } catch { return; }
  if (actual.key !== s.settings.key || data.key !== s.settings.key) return;
  if (data.error) { await unavailable(String(data.error).slice(0,240)); return; }
  if (!Number.isInteger(data.minutes) || data.minutes !== Commute.minutes(data.duration) || !Number.isFinite(data.readAt) || data.readAt > Date.now() + 1000 || data.readAt < Date.now() - 24*3600000) return;
  if (s.sample && data.readAt < s.sample.readAt) return;
  await chrome.storage.local.set({sample:{key:data.key, minutes:data.minutes, duration:String(data.duration).slice(0,40), distance:String(data.distance || '').slice(0,40), readAt:data.readAt}, status:''});
  await badge();
}
async function tracked() {
  const s = await state();
  if (!s.tabId || !s.settings) return null;
  try {
    const tab = await chrome.tabs.get(s.tabId);
    if (Commute.route(tab.url).key === s.settings.key) return tab;
  } catch { /* closed or navigated away */ }
  await chrome.storage.session.remove('tabId');
  await unavailable('Вкладка маршрута закрыта или изменена. Нажмите «Открыть маршрут».');
  return null;
}
async function read(tab) {
  try { await accept(await chrome.tabs.sendMessage(tab.id,{type:'read'}), tab.id, tab.url); }
  catch { await unavailable('Ожидаю Яндекс Карты. Если время не появится, откройте вкладку маршрута.'); }
}
async function open() {
  const s = await state();
  if (!s.settings) throw new Error('Сначала сохраните маршрут.');
  if (mode(s)==='background') { await chrome.tabs.create({url:s.settings.url,active:true}); return; }
  let tab = await tracked();
  if (tab) { await chrome.tabs.update(tab.id,{active:true}); await chrome.windows.update(tab.windowId,{focused:true}); await read(tab); }
  else {
    await unavailable('Загружаю маршрут…');
    tab = await chrome.tabs.create({url:s.settings.url, active:true});
    await chrome.storage.session.set({tabId:tab.id});
  }
}
async function refresh(manual) {
  const s=await state();
  if (!manual && !Commute.inSchedule(s.settings?.schedule)) return;
  if (mode(s)==='background') {await startBackground(); return;}
  const tab = await tracked();
  if (!tab) { if (manual) await open(); return; }
  // Automatic updates do not disrupt someone currently using the route tab.
  if (!manual && tab.active) return;
  await unavailable('Обновляю маршрут…');
  await chrome.tabs.reload(tab.id);
}
async function alarms() {
  const s = await state();
  if (!(await chrome.alarms.get('freshness'))) await chrome.alarms.create('freshness',{periodInMinutes:1});
  if (s.settings?.auto) {
    if (!(await chrome.alarms.get('refresh'))) await chrome.alarms.create('refresh',{periodInMinutes:5});
  } else await chrome.alarms.clear('refresh');
}
async function handle(message, sender) {
  if (message.type==='widget-sample') return acceptWidget(message,sender);
  if (message.type==='offscreen-job' || message.type==='offscreen-timeout') {
    if (sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('offscreen.html')) throw new Error('Недопустимый фоновый документ.');
    if (message.type==='offscreen-job') return (await state()).job;
    return backgroundTimeout(message.jobId);
  }
  if (message.type === 'sample') {
    if (sender.frameId !== 0 || !sender.tab) return;
    // Check live tab URL too: a late message from a previous page must not win.
    const tab = await tracked();
    if (tab?.id === sender.tab.id && tab.status !== 'loading') await accept(message.data || {}, tab.id, tab.url);
    return;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Недопустимый источник команды.');
  switch (message.type) {
    case 'state': await badge(); return state();
    case 'save': {
      const r = Commute.route(message.url);
      const old=await state(); await stopBackground();
      await chrome.storage.local.set({settings:{...r,auto:message.auto === true,mode:mode(old),direction:'home',schedule:old.settings?.schedule || {enabled:false}},sample:null,status:'Маршрут сохранён.'});
      await chrome.storage.local.remove('draft');
      await chrome.storage.session.remove('tabId');
      await alarms(); await refresh(true); return;
    }
    case 'auto': {
      const s = await state();
      if (s.settings) await chrome.storage.local.set({settings:{...s.settings,auto:message.value === true}});
      await alarms(); return;
    }
    case 'schedule': {
      const value = Commute.schedule(message.value), s = await state();
      if (s.settings) await chrome.storage.local.set({settings:{...s.settings,schedule:value}});
      return;
    }
    case 'reverse': {
      const s = await state();
      if (!s.settings) throw new Error('Сначала сохраните маршрут.');
      const r = Commute.reverse(s.settings.url);
      await stopBackground(); await chrome.storage.session.remove('tabId');
      await chrome.storage.local.set({settings:{...s.settings,...r,direction:s.settings.direction === 'work' ? 'home' : 'work'},sample:null,status:''});
      await refresh(true); return;
    }
    case 'diagnostics': {
      const s = await state();
      // Explicit allowlist: no raw status, URLs, coordinates, addresses, UUIDs or tab IDs.
      return {version:chrome.runtime.getManifest().version,backgroundSupported:backgroundSupported(),mode:mode(s),
        configured:!!s.settings,auto:s.settings?.auto === true,scheduleEnabled:s.settings?.schedule?.enabled === true,
        withinSchedule:Commute.inSchedule(s.settings?.schedule),pending:!!s.job,hasStatus:!!s.status,
        sampleAgeMinutes:Number.isFinite(s.sample?.readAt) ? Math.max(0,Math.floor((Date.now()-s.sample.readAt)/60000)) : null,
        stale:Commute.stale(s.sample)};
    }
    case 'mode': {
      if (!['background','tab'].includes(message.value)) throw new Error('Неизвестный режим.');
      if (message.value==='background' && !backgroundSupported()) throw new Error('В этой версии браузера фоновый режим недоступен.');
      const s=await state(); if (!s.settings) return;
      await stopBackground(); await chrome.storage.session.remove('tabId');
      await chrome.storage.local.set({settings:{...s.settings,mode:message.value},sample:null,status:''});
      await refresh(true); return;
    }
    case 'import': {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
      return Commute.route(tab?.url || '');
    }
    case 'build': {
      const from = String(message.from || '').trim(), to = String(message.to || '').trim();
      if (!from || !to || from.length > 300 || to.length > 300 || /[~]/.test(from+to)) throw new Error('Введите адреса работы и дома (до 300 символов каждый).');
      const u = new URL('https://yandex.ru/maps/');
      u.searchParams.set('rtext',`${from}~${to}`); u.searchParams.set('rtt','auto');
      await chrome.tabs.create({url:u.href}); return;
    }
    case 'open': await open(); return;
    case 'refresh': await refresh(true); return;
    case 'reset':
      await stopBackground(); await chrome.storage.local.clear(); await chrome.storage.session.clear(); await alarms(); await badge(); return;
    default: throw new Error('Неизвестная команда.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message,sender)).then(data => reply({ok:true,data}), error => reply({ok:false,error:error.message}));
  return true;
});
chrome.tabs.onUpdated.addListener((id, change) => {
  serial(async () => {
    const s = await state(); if (s.tabId !== id) return;
    if (change.status === 'loading') await unavailable('Обновляю маршрут…');
    if (change.status === 'complete' || change.url) {
      const tab = await tracked(); if (tab && change.status === 'complete') await read(tab);
    }
  });
});
chrome.tabs.onRemoved.addListener(id => serial(async () => {
  if ((await state()).tabId === id) { await chrome.storage.session.remove('tabId'); await unavailable('Вкладка маршрута закрыта. Нажмите «Открыть маршрут».'); }
}));
chrome.alarms.onAlarm.addListener(a => serial(async () => {
  const s=await state();
  if (s.job && Date.now()>=s.job.deadline) await backgroundTimeout(s.job.id);
  await badge(); if (a.name === 'refresh' && s.settings?.auto) await refresh(false);
}));
chrome.runtime.onInstalled.addListener(() => serial(async () => {
  await stopBackground(); await alarms();
  const s=await state();
  if (s.settings && mode(s)==='background') {await chrome.storage.session.remove('tabId'); await refresh(true);}
  else await badge();
}));
chrome.runtime.onStartup.addListener(() => serial(async () => {
  await chrome.storage.session.remove('tabId'); await stopBackground();
  const s=await state();
  await unavailable(mode(s)==='background' ? 'Обновите время маршрута.' : 'После запуска браузера откройте маршрут заново.');
  await alarms(); if (s.settings?.auto && mode(s)==='background') await refresh(false);
}));
serial(async () => {
  // Page content scripts only send parsed route data; they never need the stored route.
  await chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  await alarms();
});
