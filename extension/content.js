(() => {
  // Only rendered route cards; no private endpoints, app state or cookies.
  const loadedAt = Date.now();
  let lastSignature = '', timer;
  function extract() {
    let route;
    try { route = Commute.route(location.href); } catch { return {error:'Во вкладке изменён маршрут или способ передвижения.'}; }
    const now = [...document.querySelectorAll('[role="button"],button')].some(e => /Отправление\s+сейчас/.test(e.textContent));
    if (!now) return {key:route.key, error:'Выберите в Картах «Отправление сейчас». Если маршрут не загрузился, проверьте вкладку.'};
    const card = document.querySelector('.route-snippet-view._type_auto[aria-current="step"]') || document.querySelector('.route-snippet-view._type_auto._active');
    if (!card || card.getAttribute('aria-hidden') === 'true' || !card.getClientRects().length)
      return {key:route.key, error:'Карты ещё не показали маршрут. Проверьте соединение или сообщение во вкладке.'};
    const duration = card.querySelector('.auto-route-snippet-view__duration')?.textContent?.trim();
    const value = Commute.minutes(duration);
    if (!value) return {key:route.key, error:'Не удалось прочитать время. Возможно, изменилась разметка Карт.'};
    return {key:route.key, minutes:value, duration, distance:card.querySelector('.auto-route-snippet-view__distance')?.textContent?.trim() || '', readAt:loadedAt};
  }
  function report() {
    const data = extract(), signature = JSON.stringify(data);
    if (signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({type:'sample', data}).catch(() => {});
  }
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(report, 600); });
  observer.observe(document.body, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['aria-current','aria-hidden','class']});
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'read') { reply(extract()); }
  });
  report();
})();
