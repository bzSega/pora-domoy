(() => {
  let route;
  try { route=Commute.widgetRoute(location.href); } catch { return; }
  if (!/^[0-9a-f-]{36}$/.test(route.jobId || '')) return;
  let sent=false,timer=null,poll,deadline;
  function stop() {
    observer.disconnect(); clearTimeout(timer); clearInterval(poll); clearTimeout(deadline);
  }
  function read() {
    if (sent) return;
    const card=document.querySelector('.map-widget-routes-content-view');
    // This is a fresh, fixed-route offscreen document. Its card can have no
    // layout boxes even when the route text is complete; visibility is not
    // a readiness signal in an offscreen iframe.
    if (!card) return;
    const data=Commute.widgetSample(card.querySelector('.map-widget-routes-content-view__header')?.textContent,card.querySelector('.map-widget-routes-content-view__body')?.textContent);
    if (!data) return;
    sent=true; stop();
    chrome.runtime.sendMessage({type:'widget-sample',jobId:route.jobId,key:route.key,data}).catch(()=>{});
  }
  const observer=new MutationObserver(()=>{
    // Throttle, not debounce: continuous map mutations must not starve the read.
    if(timer!==null || sent)return;
    timer=setTimeout(()=>{timer=null;read();},150);
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
  // Retry independently of DOM mutations while Maps finishes route loading.
  poll=setInterval(read,500);
  deadline=setTimeout(stop,45000);
  read();
})();
