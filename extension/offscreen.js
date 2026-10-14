// Only runtime is available in an offscreen extension document.
(async () => {
  const response = await chrome.runtime.sendMessage({type:'offscreen-job'});
  if (!response?.ok || !response.data) return;
  const job=response.data;
  const frame=document.createElement('iframe');
  frame.title='Автомобильный маршрут Яндекс Карт';
  frame.referrerPolicy='no-referrer';
  frame.src=job.url;
  document.body.append(frame);
  // Hard timeout in addition to the service worker's persistent alarm.
  setTimeout(() => chrome.runtime.sendMessage({type:'offscreen-timeout',jobId:job.id}).catch(()=>{}),45000);
})().catch(()=>{});
