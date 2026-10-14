/* Shared, dependency-free validation. Never guess travel time. */
(function (root) {
  const STALE_MS = 10 * 60 * 1000;
  const CACHE_MS = 24 * 60 * 60 * 1000;
  function route(input) {
    let u;
    try { u = new URL(input); } catch { throw new Error('Вставьте полную ссылку из адресной строки Яндекс Карт.'); }
    if (u.protocol !== 'https:' || !['yandex.ru','www.yandex.ru'].includes(u.hostname) || !u.pathname.startsWith('/maps/') || u.username || u.password || u.port)
      throw new Error('Нужна ссылка https://yandex.ru/maps/ с построенным маршрутом.');
    if (u.searchParams.get('rtt') !== 'auto') throw new Error('Выберите в Картах маршрут на автомобиле.');
    const points = (u.searchParams.get('rtext') || '').split('~');
    if (points.length !== 2) throw new Error('Нужен маршрут из двух точек: работа → дом.');
    const normalized = points.map(p => {
      if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(p)) throw new Error('Дождитесь построения маршрута в Картах и скопируйте адресную строку.');
      const [lat, lon] = p.split(',').map(Number);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Некорректные координаты маршрута.');
      return `${lat},${lon}`;
    });
    if (normalized[0] === normalized[1]) throw new Error('Работа и дом должны быть разными точками.');
    const key = normalized.join('~');
    const clean = new URL('https://yandex.ru/maps/');
    clean.searchParams.set('mode', 'routes'); clean.searchParams.set('rtext', key); clean.searchParams.set('rtt', 'auto');
    return {key, url: clean.href};
  }
  function minutes(input) {
    const t = String(input).replace(/[\u00a0\u202f]/g, ' ').trim();
    const m = /^(?:(\d+)\s*дн\.?\s*)?(?:(\d+)\s*ч(?:ас(?:а|ов)?)?\.?\s*)?(?:(\d+)\s*мин(?:ут(?:а|ы)?)?\.?)?$/.exec(t);
    if (!m || !m.slice(1).some(Boolean)) return null;
    const n = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
    return n > 0 && n <= 43200 ? n : null;
  }
  function stale(sample, now = Date.now()) { return !sample || !Number.isFinite(sample.readAt) || now - sample.readAt >= STALE_MS || now < sample.readAt; }
  function reverse(input) {
    const r = route(input), u = new URL(r.url);
    u.searchParams.set('rtext', r.key.split('~').reverse().join('~'));
    return route(u.href);
  }
  function schedule(input = {}) {
    if (input.enabled !== true) return {enabled:false};
    const validTime = t => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (!validTime(input.start) || !validTime(input.end) || input.start === input.end)
      throw new Error('Задайте разные начало и конец периода обновления.');
    if (!Array.isArray(input.days) || !input.days.length || input.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))
      throw new Error('Выберите хотя бы один день недели.');
    return {enabled:true,start:input.start,end:input.end,days:[...new Set(input.days)].sort()};
  }
  // A window crossing midnight belongs to the selected day on which it starts.
  function inSchedule(input, date = new Date()) {
    if (!input?.enabled) return true;
    let s; try { s = schedule(input); } catch { return false; }
    const t = date.getHours()*60 + date.getMinutes();
    const mins = v => Number(v.slice(0,2))*60 + Number(v.slice(3));
    const start = mins(s.start), end = mins(s.end), day = date.getDay();
    return start < end ? s.days.includes(day) && t >= start && t < end :
      (s.days.includes(day) && t >= start) || (s.days.includes((day+6)%7) && t < end);
  }
  function widgetURL(input, jobId) {
    const r = route(input), u = new URL('https://yandex.ru/map-widget/v1/');
    u.searchParams.set('rtext',r.key); u.searchParams.set('rtt','auto');
    if (jobId) u.hash = `commute-job=${jobId}`;
    return u.href;
  }
  function widgetRoute(input) {
    const u = new URL(input);
    if (u.origin !== 'https://yandex.ru' || u.pathname !== '/map-widget/v1/' || [...u.searchParams.keys()].some(k => !['rtext','rtt'].includes(k))) throw new Error('Неизвестный виджет.');
    const maps = new URL('https://yandex.ru/maps/'); maps.search=u.search;
    return {...route(maps.href),jobId:new URLSearchParams(u.hash.slice(1)).get('commute-job')};
  }
  function widgetSample(header, body) {
    const duration=String(header || '').replace(/[\u00a0\u202f]/g,' ').trim();
    const value=minutes(duration);
    const distance=/^\s*(\d+(?:[,.]\d+)?\s*(?:км|м))(?=\s|,|$)/.exec(String(body || '').replace(/[\u00a0\u202f]/g,' '))?.[1];
    if (!value || !distance) return null;
    // Read traffic-aware header, never the smaller "без пробок" value in body.
    return {minutes:value,duration,distance};
  }
  root.Commute = {route, minutes, stale, STALE_MS, CACHE_MS, reverse, schedule, inSchedule, widgetURL, widgetRoute, widgetSample};
  if (typeof module !== 'undefined') module.exports = root.Commute;
})(globalThis);
