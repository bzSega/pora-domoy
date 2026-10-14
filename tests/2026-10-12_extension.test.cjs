const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'../extension');
const C = require(path.join(root,'core.js'));
const URL1 = 'https://yandex.ru/maps/213/moscow/?rtext=55.751244%2C37.618423~55.790278%2C37.531667&rtt=auto';
const URL2 = 'https://yandex.ru/maps/?rtext=55.76,37.62~55.80,37.53&rtt=auto';
const key = C.route(URL1).key;
test('Schedule handles local weekdays, exact boundaries and windows across midnight', () => {
  const at=(day,hour,minute=0)=>new Date(2026,9,12+day,hour,minute);
  const schedule={enabled:true,days:[1,2,3,4,5],start:'16:00',end:'21:00'};
  assert.equal(C.inSchedule(schedule,at(0,15,59)),false);
  assert.equal(C.inSchedule(schedule,at(0,16)),true);
  assert.equal(C.inSchedule(schedule,at(0,21)),false);
  assert.equal(C.inSchedule(schedule,at(5,17)),false);
  const night={enabled:true,days:[5],start:'22:00',end:'02:00'};
  assert.equal(C.inSchedule(night,at(4,23)),true);
  assert.equal(C.inSchedule(night,at(5,1)),true);
  assert.equal(C.inSchedule(night,at(5,2)),false);
  assert.equal(C.inSchedule(night,at(5,23)),false);
  assert.throws(()=>C.schedule({...schedule,days:[]}));
  assert.throws(()=>C.schedule({...schedule,start:'25:00'}));
  assert.throws(()=>C.schedule({...schedule,start:'21:00'}));
  assert.equal(C.inSchedule({enabled:false},at(5,3)),true);
  assert.equal(C.stale({}),true);
});
test('Reverse canonicalizes, reverses only endpoints and is an involution',()=>{
  const reversed=C.reverse(URL1+'&rtd=123');
  assert.equal(reversed.key,key.split('~').reverse().join('~'));
  assert.deepEqual(C.reverse(reversed.url),C.route(URL1));
});
test('Only two numeric endpoints on trusted HTTPS Maps, auto mode; canonical URL drops scheduled departure', () => {
  assert.equal(C.route(URL1+'&rtd=999999&token=discard').key,key);
  assert.equal(new URL(C.route(URL1+'&rtd=999999&token=discard').url).searchParams.has('rtd'),false);
  for (const url of ['javascript:alert(1)',URL1.replace('yandex.ru','yandex.ru.evil.test'),URL1.replace('https:','http:'),URL1.replace('auto','mt'),URL1.replace('55.751244','95.751244'),URL1.replace('55.751244%2C37.618423','Москва'),URL1.replace('~','~1,2~')]) assert.throws(() => C.route(url));
});
test('Duration parser supports actual Russian formats, rejects unrelated numbers and arrival clocks', () => {
  for (const [value,n] of [['23\u00a0мин',23],['1 ч 5 мин',65],['2 ч',120],['1 дн. 3 ч 4 мин',1624],['7\u202fмин',7],['9,8 км',null],['Прибытие в 15:40',null],['~23 мин',null],['0 мин',null],['',null]]) assert.equal(C.minutes(value),n,value);
});
test('Old or future samples are stale, boundary is exactly ten minutes', () => {
  assert.equal(C.stale(null),true); assert.equal(C.stale({readAt:100},100+C.STALE_MS-1),false);
  assert.equal(C.stale({readAt:100},100+C.STALE_MS),true); assert.equal(C.stale({readAt:200},100),true);
});
function harness(options={}) {
  const event = () => ({listeners:[],addListener(fn){this.listeners.push(fn);}});
  const store = () => {
    let data={};
    return {async get(keys){if(typeof keys==='string')keys=[keys]; return structuredClone(Object.fromEntries((keys || Object.keys(data)).filter(k=>k in data).map(k=>[k,data[k]])));},async set(d){Object.assign(data,structuredClone(d));},async remove(k){delete data[k];},async clear(){data={};}};
  };
  let nextTab=10;
  const tabs=new Map(), alarms=new Map(), effects={reload:[],badge:'',created:[],offscreenCreates:0,offscreenCloses:0};
  const chrome={
    runtime:{id:'test',getManifest:()=>({version:'1.2.0'}),getURL:p=>'chrome-extension://test/'+p,onMessage:event(),onInstalled:event(),onStartup:event()},
    storage:{local:store(),session:store()},
    action:{async setBadgeText(v){effects.badge=v.text;},async setBadgeBackgroundColor(){},async setTitle(){}},
    tabs:{onUpdated:event(),onRemoved:event(),async get(id){if(!tabs.has(id))throw Error('closed');return {...tabs.get(id)};},async create(o){const tab={id:nextTab++,windowId:1,active:o.active??true,...o};tabs.set(tab.id,tab);effects.created.push(tab);return tab;},async update(id,o){Object.assign(tabs.get(id),o);},async reload(id){effects.reload.push(id);},async query(){return [...tabs.values()].filter(t=>t.active);},async sendMessage(){throw Error('not ready');}},
    windows:{async update(){}},
    alarms:{onAlarm:event(),async get(n){return alarms.get(n);},async create(n,o){alarms.set(n,o);},async clear(n){alarms.delete(n);}}
  };
  if (options.background) {
    let offscreen=false;
    chrome.runtime.getContexts=async()=>offscreen?[{documentUrl:'chrome-extension://test/offscreen.html'}]:[];
    chrome.offscreen={async createDocument(){effects.offscreenCreates++;if(options.failCreate)throw Error('unsupported');offscreen=true;},async closeDocument(){effects.offscreenCloses++;offscreen=false;}};
  }
  const ctx=vm.createContext({chrome,URL,console,Date,crypto:require('node:crypto').webcrypto,importScripts:()=>{}}); ctx.Commute=C;
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),ctx);
  const popup={id:'test',url:'chrome-extension://test/popup.html'};
  const msg=(m,s=popup)=>new Promise(resolve=>chrome.runtime.onMessage.listeners[0](m,s,resolve));
  const drain=()=>vm.runInContext('queue',ctx);
  const emit=async(e,...args)=>{e.listeners.forEach(fn=>fn(...args));await drain();};
  const data=()=>({key,minutes:23,duration:'23 мин',distance:'9,8 км',readAt:Date.now()});
  const sample=(d,id=10)=>msg({type:'sample',data:d},{tab:{id},frameId:0});
  return {chrome,tabs,alarms,effects,msg,emit,data,sample,drain};
}
test('Widget always reads traffic duration from the header, never free-flow duration in body',()=>{
  assert.deepEqual(C.widgetSample('22\u00a0мин','9,8\u00a0км, без пробок: 21\u00a0мин'),{minutes:22,duration:'22 мин',distance:'9,8 км'});
  assert.equal(C.widgetSample('Маршрут не найден','9 км'),null);
  assert.equal(C.widgetSample('22 мин','Без данных'),null);
  const u=C.widgetURL(URL1,'test-id');assert.equal(C.widgetRoute(u).key,key);
  assert.throws(()=>C.widgetRoute(u.replace('yandex.ru','evil.test')));
  assert.throws(()=>C.widgetRoute(u.replace('#','&rtd=999#')));
});
test('Background refresh reads widget without creating tabs and releases document after success',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1,auto:true});
  assert.equal(h.effects.created.length,0);assert.equal(h.effects.offscreenCreates,1);
  const job=(await h.chrome.storage.session.get('job')).job;
  const ready=await h.msg({type:'offscreen-job'},{id:'test',url:'chrome-extension://test/offscreen.html'});
  assert.equal(ready.data.id,job.id);
  await h.msg({type:'refresh'});assert.equal(h.effects.offscreenCreates,1);
  const msg={type:'widget-sample',jobId:job.id,key,data:{minutes:22,duration:'22 мин',distance:'9,8 км'}};
  await h.msg({...msg,jobId:'wrong'},{id:'test',url:job.url});assert.equal(h.effects.badge,'—');
  await h.msg(msg,{id:'test',url:job.url.replace('yandex.ru','evil.test')});assert.equal(h.effects.badge,'—');
  await h.msg(msg,{id:'test',url:job.url,frameId:1});
  assert.equal(h.effects.badge,'22');assert.equal(h.effects.offscreenCloses,1);assert.equal(h.effects.created.length,0);
  assert.equal((await h.chrome.storage.local.get('sample')).sample.source,'background');
  assert.equal((await h.chrome.storage.session.get('job')).job,undefined);assert.equal(h.alarms.has('job-timeout'),false);
  await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.equal(h.effects.offscreenCreates,2);assert.equal(h.effects.created.length,0);
});
test('Reversing route discards old jobs, preserves preferences and rejects old replies',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1,auto:true});
  const old=(await h.chrome.storage.session.get('job')).job;
  await h.msg({type:'reverse'});
  let s=(await h.chrome.storage.local.get('settings')).settings;
  assert.equal(s.key,C.reverse(URL1).key);assert.equal(s.direction,'work');assert.equal(s.auto,true);
  await h.msg({type:'widget-sample',jobId:old.id,key,data:{minutes:22,duration:'22 мин',distance:'9 км'}},{id:'test',url:old.url});
  assert.equal((await h.chrome.storage.local.get('sample')).sample,null);
  await h.msg({type:'reverse'});s=(await h.chrome.storage.local.get('settings')).settings;
  assert.equal(s.key,key);assert.equal(s.direction,'home');
});
test('Schedule suppresses automatic network work, manual refresh still works and settings persist on save',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1,auto:true});
  const job=(await h.chrome.storage.session.get('job')).job;
  await h.msg({type:'widget-sample',jobId:job.id,key,data:{minutes:22,duration:'22 мин',distance:'9 км'}},{id:'test',url:job.url});
  const value={enabled:true,days:[(new Date().getDay()+3)%7],start:'16:00',end:'21:00'};
  assert.equal((await h.msg({type:'schedule',value})).ok,true);
  await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.equal(h.effects.offscreenCreates,1);
  await h.msg({type:'refresh'});assert.equal(h.effects.offscreenCreates,2);
  assert.equal((await h.msg({type:'schedule',value:{...value,days:[]}})).ok,false);
  await h.msg({type:'save',url:URL2,auto:true});
  assert.deepEqual((await h.chrome.storage.local.get('settings')).settings.schedule,value);
});
test('Diagnostics have an exact privacy allowlist; freshness alarm recovers orphaned jobs',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1});
  await h.chrome.storage.local.set({draft:{from:'PRIVATE ADDRESS',to:'PRIVATE ADDRESS'},status:'PRIVATE ADDRESS'});
  const d=(await h.msg({type:'diagnostics'})).data;
  assert.deepEqual(Object.keys(d).sort(),['version','backgroundSupported','mode','configured','auto','scheduleEnabled','withinSchedule','pending','hasStatus','sampleAgeMinutes','stale'].sort());
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE|yandex|55\.|37\./);
  const job=(await h.chrome.storage.session.get('job')).job;
  await h.chrome.storage.session.set({job:{...job,deadline:0}});
  await h.chrome.alarms.clear('job-timeout');
  await h.emit(h.chrome.alarms.onAlarm,{name:'freshness'});
  assert.equal(h.effects.offscreenCloses,1);assert.equal((await h.chrome.storage.session.get('job')).job,undefined);
});
test('Background timeout, failure and reset clean up; late messages cannot revive an old job',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1});
  const job=(await h.chrome.storage.session.get('job')).job;
  await h.chrome.storage.session.set({job:{...job,deadline:0}});
  await h.emit(h.chrome.alarms.onAlarm,{name:'job-timeout'});
  assert.equal(h.effects.offscreenCloses,1);assert.equal(h.effects.badge,'—');assert.match((await h.chrome.storage.local.get('status')).status,/не ответили/);
  await h.msg({type:'widget-sample',jobId:job.id,key,data:{minutes:22,duration:'22 мин',distance:'9 км'}},{id:'test',url:job.url});assert.equal(h.effects.badge,'—');
  await h.msg({type:'refresh'});await h.msg({type:'reset'});assert.equal(h.effects.offscreenCloses,2);assert.deepEqual(await h.chrome.storage.local.get(),{});
  const failed=harness({background:true,failCreate:true});await failed.msg({type:'save',url:URL1});
  assert.equal((await failed.chrome.storage.session.get('job')).job,undefined);assert.equal(failed.alarms.has('job-timeout'),false);
  assert.match((await failed.chrome.storage.local.get('status')).status,/не запустил/);assert.equal(failed.effects.created.length,0);
});
test('Changing route invalidates old background result and tab mode remains available',async()=>{
  const h=harness({background:true});await h.msg({type:'save',url:URL1});
  const job=(await h.chrome.storage.session.get('job')).job;
  await h.msg({type:'save',url:URL2});
  await h.msg({type:'widget-sample',jobId:job.id,key,data:{minutes:22,duration:'22 мин',distance:'9 км'}},{id:'test',url:job.url});assert.equal(h.effects.badge,'—');
  await h.msg({type:'mode',value:'tab'});assert.equal(h.effects.created.length,1);assert.equal((await h.chrome.storage.session.get('job')).job,undefined);
  await h.msg({type:'mode',value:'background'});assert.equal(h.effects.created.length,1);assert.ok((await h.chrome.storage.session.get('job')).job);
});
test('Save opens owned tab; only its exact route can set badge; popup source is authenticated', async () => {
  const h=harness(); assert.equal((await h.msg({type:'save',url:URL1,auto:false})).ok,true);
  await h.sample(h.data(),999); assert.equal(h.effects.badge,'—');
  await h.sample({...h.data(),key:C.route(URL2).key}); assert.equal(h.effects.badge,'—');
  await h.sample(h.data()); assert.equal(h.effects.badge,'23');
  await h.sample({...h.data(),minutes:60,duration:'1 ч',readAt:Date.now()-60000}); assert.equal(h.effects.badge,'23');
  assert.equal((await h.msg({type:'reset'},{id:'test',url:'https://yandex.ru/maps/'})).ok,false);
  assert.equal(h.effects.badge,'23');
  await h.sample({...h.data(),minutes:99}); assert.equal(h.effects.badge,'23');
});
test('Stale, error, closed and changed route never retain a fresh badge', async () => {
  const h=harness();await h.msg({type:'save',url:URL1});
  await h.sample({...h.data(),readAt:Date.now()-C.STALE_MS-1});assert.equal(h.effects.badge,'23?');
  await h.sample(h.data());assert.equal(h.effects.badge,'23');
  await h.sample({key,error:'Нет маршрута'});assert.equal(h.effects.badge,'23?');
  await h.sample(h.data());
  h.tabs.get(10).url=URL2;
  await h.emit(h.chrome.tabs.onUpdated,10,{url:URL2});assert.equal(h.effects.badge,'23?');
  await h.sample(h.data());assert.equal(h.effects.badge,'23?');
  await h.msg({type:'open'});assert.equal(h.effects.created.length,2);
  await h.sample(h.data(),11);assert.equal(h.effects.badge,'23');
  h.tabs.delete(11);await h.emit(h.chrome.tabs.onRemoved,11);assert.equal(h.effects.badge,'23?');
});
test('Refresh is opt-in, reloads owned background tab only, never recreates closed tabs automatically',async()=>{
  const h=harness();await h.msg({type:'save',url:URL1,auto:false});assert.equal(h.alarms.has('refresh'),false);
  await h.msg({type:'auto',value:true});assert.equal(h.alarms.get('refresh').periodInMinutes,5);
  await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.deepEqual(h.effects.reload,[]);
  h.tabs.get(10).active=false;await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.deepEqual(h.effects.reload,[10]);
  h.tabs.delete(10);await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.equal(h.effects.created.length,1);
  await h.msg({type:'auto',value:false});assert.equal(h.alarms.has('refresh'),false);
  await h.emit(h.chrome.alarms.onAlarm,{name:'refresh'});assert.deepEqual(h.effects.reload,[10]);
});
test('Restart requires an explicit reopen and reset clears local addresses and route',async()=>{
  const h=harness();await h.msg({type:'save',url:URL1,auto:true});await h.sample(h.data());
  await h.emit(h.chrome.runtime.onStartup);assert.equal(h.effects.badge,'23?');assert.equal((await h.chrome.storage.session.get('tabId')).tabId,undefined);
  await h.chrome.storage.local.set({draft:{from:'work',to:'home'}});await h.msg({type:'reset'});
  assert.deepEqual(await h.chrome.storage.local.get(),{});assert.equal(h.alarms.has('refresh'),false);assert.equal(h.effects.badge,'');
});
test('Content reader uses selected visible car card and requires departure now; never guesses',()=>{
  let departure=true, cardVisible=true, duration='23\u00a0мин', response;
  const card={getAttribute:()=>null,getClientRects:()=>cardVisible?[{}]:[],querySelector:s=>({textContent:s.includes('duration')?duration:'9,8\u00a0км'})};
  const document={body:{},querySelectorAll:()=>departure?[{textContent:'Параметры Отправление сейчас'}]:[],querySelector:()=>card};
  const ctx=vm.createContext({Commute:C,document,location:{href:URL1},Date,JSON,setTimeout,clearTimeout,MutationObserver:class{observe(){}},chrome:{runtime:{sendMessage:()=>Promise.resolve(),onMessage:{addListener:fn=>response=fn}}}});
  vm.runInContext(fs.readFileSync(path.join(root,'content.js'),'utf8'),ctx);
  const read=()=>{let value;response({type:'read'},{},d=>value=d);return value;};
  assert.equal(read().minutes,23);departure=false;assert.match(read().error,/Отправление сейчас/);
  departure=true;cardVisible=false;assert.ok(read().error);cardVisible=true;duration='15:40';assert.ok(read().error);
});
test('Offscreen widget reads complete route text even without visible layout boxes',()=>{
  let ready=false,now=0,nextTimer=1,disconnected=false;
  const timers=new Map(),messages=[];
  const schedule=(fn,delay,interval=false)=>{const id=nextTimer++;timers.set(id,{fn,delay,due:now+delay,interval});return id;};
  function advance(ms) {
    const end=now+ms;
    while(true){const due=[...timers].filter(([,t])=>t.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!due)break;
      const [id,t]=due;now=t.due;if(t.interval)t.due+=t.delay;else timers.delete(id);t.fn();}
    now=end;
  }
  const card={getClientRects:()=>[],querySelector:s=>({textContent:!ready?'':s.includes('header')?'26 мин':'9,7 км, без пробок: 19 мин'})};
  const document={body:{},documentElement:{},querySelector:()=>card};
  const ctx=vm.createContext({Commute:C,document,location:{href:C.widgetURL(URL1,'11111111-1111-4111-8111-111111111111')},
    setTimeout:(f,d)=>schedule(f,d),clearTimeout:id=>timers.delete(id),setInterval:(f,d)=>schedule(f,d,true),clearInterval:id=>timers.delete(id),
    MutationObserver:class{observe(){}disconnect(){disconnected=true;}},
    chrome:{runtime:{sendMessage:m=>{messages.push(m);return Promise.resolve({ok:true});}}}});
  vm.runInContext(fs.readFileSync(path.join(root,'widget.js'),'utf8'),ctx);
  assert.equal(messages.length,0,'Incomplete route text must not be consumed');
  ready=true; // Offscreen rendering never needs to expose visible layout boxes.
  advance(1500);
  assert.equal(messages.length,1,'Complete offscreen route must reach worker without visible layout');
  assert.equal(messages[0].data.minutes,26);assert.equal(disconnected,true);
  advance(60000);assert.equal(messages.length,1);assert.equal(timers.size,0,'No timers after completion');
});

test('Expired result is deleted on next activity, with route settings preserved',async()=>{
  const h=harness();await h.msg({type:'save',url:URL1});
  await h.chrome.storage.local.set({sample:{...h.data(),readAt:Date.now()-C.CACHE_MS}});
  await h.msg({type:'state'});
  assert.equal((await h.chrome.storage.local.get('sample')).sample,undefined);
  assert.ok((await h.chrome.storage.local.get('settings')).settings);
  assert.equal(h.effects.badge,'—');
});
test('Visible map URL has no background job token and preserves the route',()=>{
  const u=C.widgetURL(URL1);assert.equal(new URL(u).hash,'');
  assert.equal(C.widgetRoute(u).key,key);assert.equal(C.widgetRoute(u).jobId,null);
});
