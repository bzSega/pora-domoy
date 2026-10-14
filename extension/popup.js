const $ = id => document.getElementById(id);
let current, editing = false, scheduleEditing = false;
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type,...extra});
  if (!result?.ok) throw new Error(result?.error || 'Не удалось связаться с расширением.');
  return result.data;
}
let displayedRoute = '';
function showMap(settings, setup) {
  const url = !setup && settings ? Commute.widgetURL(settings.url) : '';
  if (url === displayedRoute) return;
  displayedRoute = url;
  if (url) $('routeMap').src = url;
  else $('routeMap').removeAttribute('src');
}
function render(s) {
  current = s;
  const setup = !s.settings || editing;
  const viewChanged = !$('setup').hidden !== setup;
  $('setup').hidden = !setup; $('dashboard').hidden = setup;
  if (viewChanged) { document.body.scrollTop=0; window.scrollTo(0,0); }
  showMap(s.settings, setup);
  $('cancel').hidden = !s.settings; $('reset').hidden = !s.settings;
  $('directionLabel').textContent = !setup && s.settings?.direction === 'work' ? 'ДОМ → РАБОТА' : 'РАБОТА → ДОМ';
  if (!s.settings) return;
  $('reverse').textContent = s.settings.direction === 'work' ? '⇄ Поехать домой' : '⇄ Поехать на работу';
  $('refresh').disabled = !!s.job;
  $('refresh').textContent = s.job ? 'Обновляю…' : 'Обновить время';
  $('dashboard').setAttribute('aria-busy', String(!!s.job));
  const mode=s.settings.mode==='tab' || !s.backgroundSupported ? 'tab' : 'background';
  $('mode').value=mode;
  $('mode').querySelector('[value="background"]').disabled=!s.backgroundSupported;
  $('modeHint').textContent=mode==='background' ? 'Время обновляется в фоне. Вкладку Карт можно закрыть. Число на значке — минуты в пути.' : 'Оставьте вкладку маршрута открытой. Автообновление работает, когда она в фоне.';
  $('auto').checked = s.settings.auto;
  $('autoStatus').textContent = !s.settings.auto ? 'Автообновление выключено.' : Commute.inSchedule(s.settings.schedule) ? 'Автообновление активно, пока браузер работает.' : 'Пауза до выбранных дней и часов.';
  if (!scheduleEditing) {
    const p = s.settings.schedule || {enabled:false};
    $('scheduleEnabled').checked = !!p.enabled;
    $('scheduleStart').value = p.start || '16:00'; $('scheduleEnd').value = p.end || '21:00';
    document.querySelectorAll('[name="day"]').forEach(el => {el.checked = (p.days || [1,2,3,4,5]).includes(Number(el.value));});
    $('scheduleFields').disabled = !p.enabled;
  }
  const old = Commute.stale(s.sample), ready = (s.sample?.source==='background' || s.tabId !== undefined) && !s.status && !old;
  $('duration').textContent = s.sample ? s.sample.duration : '—';
  $('duration').classList.toggle('last-estimate',!!s.sample && !ready);
  $('detail').textContent = ready ? s.sample.distance : (s.sample ? `${s.sample.distance} · последняя оценка` : 'Работа → дом');
  const date = new Date(s.sample?.readAt);
  const time = Number.isFinite(s.sample?.readAt) ? date.toLocaleString('ru-RU', { ...(date.toDateString() !== new Date().toDateString() ? {day:'numeric',month:'short'} : {}), hour:'2-digit',minute:'2-digit'}) : '';
  $('freshness').textContent = time ? `${ready ? 'Прочитано' : 'Последние данные'} в ${time}` : 'Ожидаю данные';
  $('status').textContent = s.status || (mode==='tab' && s.tabId === undefined ? 'Нажмите «Открыть в Картах», чтобы получить время.' : old ? 'Данные устарели. Обновите время.' : 'Время с учётом дорожной ситуации в Картах.');
}
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    $('error').hidden = true; $(id).disabled = true;
    try { await fn(); } catch (e) { $('error').textContent = e.message; $('error').hidden = false; }
    finally { $(id).disabled = false; if (current) render(current); }
  });
}
action('settingsButton',async () => {
  editing = !editing; $('resetConfirm').hidden=true;
  const settings=current?.settings;
  $('route').value = settings?.direction === 'work' ? Commute.reverse(settings.url).url : settings?.url || '';
  render(current || {});
});
action('cancel',async () => {editing=false; render(current);});
action('import',async () => { const r = await send('import'); $('route').value = r.url; });
action('save',async () => { Commute.route($('route').value.trim()); await send('save',{url:$('route').value.trim(),auto:current?.settings?.auto || false}); editing=false; render(await send('state')); });
action('build',async () => {
  await chrome.storage.local.set({draft:{from:$('from').value,to:$('to').value}});
  await send('build',{from:$('from').value,to:$('to').value});
});
action('refresh',async () => { if (displayedRoute) $('routeMap').src=displayedRoute; await send('refresh'); render(await send('state'));});
action('open',async () => {await send('open');});
action('reverse',async () => { await send('reverse'); render(await send('state')); });
action('reset',async () => { $('resetConfirm').hidden=false; });
action('cancelReset',async () => { $('resetConfirm').hidden=true; });
action('confirmReset',async () => { await send('reset'); editing=false; scheduleEditing=false; $('resetConfirm').hidden=true; $('route').value=''; $('from').value=''; $('to').value=''; render(await send('state')); });
action('diagnostics',async () => { $('diagnosticsText').value=JSON.stringify(await send('diagnostics'),null,2); $('diagnosticsText').hidden=false; });
action('saveSchedule',async () => {
  const value = {enabled:$('scheduleEnabled').checked,start:$('scheduleStart').value,end:$('scheduleEnd').value,
    days:[...document.querySelectorAll('[name="day"]:checked')].map(el => Number(el.value))};
  await send('schedule',{value}); scheduleEditing=false; render(await send('state'));
  $('scheduleFeedback').textContent='Расписание сохранено.';
});
$('schedulePanel').addEventListener('change',() => {
  scheduleEditing=true; $('scheduleFeedback').textContent='Есть несохранённые изменения.';
  $('scheduleFields').disabled=!$('scheduleEnabled').checked;
});
$('auto').addEventListener('change',async () => {
  try { await send('auto',{value:$('auto').checked}); }
  catch(e) { $('error').textContent=e.message; $('error').hidden=false; }
});
$('mode').addEventListener('change',async () => {
  $('mode').disabled=true; $('error').hidden=true;
  try { await send('mode',{value:$('mode').value}); render(await send('state')); }
  catch(e) { $('error').textContent=e.message; $('error').hidden=false; }
  finally { $('mode').disabled=false; }
});
async function load() {
  try {
    $('version').textContent = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;
    const s = await send('state'); render(s);
    const {draft} = await chrome.storage.local.get('draft');
    if (draft) { $('from').value=draft.from || ''; $('to').value=draft.to || ''; }
  } catch(e) { $('error').textContent=e.message; $('error').hidden=false; }
}
chrome.storage.onChanged.addListener(async (_,area) => {
  if (area!=='local' && area!=='session') return;
  try { render(await send('state')); } catch(e) { $('error').textContent=e.message; $('error').hidden=false; }
});
setInterval(() => { if (current) render(current); },15000);
load();
