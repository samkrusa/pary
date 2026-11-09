/* Пары — расписание КНИТУ
   Ванильный JS без зависимостей. */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек"];

  const DESKTOP_MQ = window.matchMedia("(min-width: 1000px)");

  const TYPE_STYLE = {
    "ЛЕКЦ": ["#2f5fe0", "#e9efff"],
    "ПЗ": ["#0b7a55", "#dff3ea"],
    "ЛР": ["#b45309", "#fdf0d5"],
    "КСР": ["#6d28d9", "#efe9fd"],
    "СРС": ["#475569", "#eceff3"],
    "МК": ["#0e7490", "#e0f2f7"],
    "УП": ["#9a3412", "#fdebe0"],
  };

  const state = {
    meta: null,
    institutes: [],
    groupsByInst: new Map(),
    allGroups: null,
    group: null,
    data: null,
    weekOffset: 0,
    day: null,
    loading: false,
    sheetInst: null,
    sheetQuery: "",
  };

  /* ── Утилиты ─────────────────────────────────────────── */

  const pad = (n) => String(n).padStart(2, "0");
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const mondayOf = (d) => {
    const x = new Date(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const safeSlug = (v) => typeof v === "string" && /^[a-z0-9-]+$/.test(v);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function parityOf(dateStr) {
    const anchor = state.meta ? parseISO(state.meta.anchor) : new Date(2026, 10, 2);
    const anchorEven = state.meta ? !!state.meta.anchorEven : true;
    const weeks = Math.round((mondayOf(parseISO(dateStr)) - anchor) / 604800000);
    const even = weeks % 2 === 0 ? anchorEven : !anchorEven;
    return even ? 2 : 1;
  }

  function fmtRange(mon) {
    const sat = addDays(mon, 5);
    const a = mon.getMonth();
    const b = sat.getMonth();
    return a === b
      ? `${mon.getDate()} – ${sat.getDate()} ${MONTHS[a]}`
      : `${mon.getDate()} ${MONTHS_SHORT[a]} – ${sat.getDate()} ${MONTHS_SHORT[b]}`;
  }

  function fmtGenerated(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  const toMin = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("is-on"), 1800);
  }

  /* ── Загрузка данных ─────────────────────────────────── */

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function cachedJSON(url, key) {
    try {
      const data = await fetchJSON(url);
      try {
        localStorage.setItem(key, JSON.stringify({ t: Date.now(), data }));
      } catch (_) { /* переполнение — не страшно */ }
      return data;
    } catch (err) {
      const raw = localStorage.getItem(key);
      if (raw) {
        try { return JSON.parse(raw).data; } catch (_) { /* ignore */ }
      }
      throw err;
    }
  }

  async function boot() {
    wireUI();
    try {
      const idx = await cachedJSON("data/index.json", "idx");
      state.meta = idx.meta;
      state.institutes = idx.institutes || [];
    } catch (_) {
      state.meta = { anchor: "2026-11-02", anchorEven: true, generated: "" };
      state.institutes = [];
    }

    let saved = readSavedGroup();
    if (!saved) {
      const cookieFile = readGroupCookie();
      if (cookieFile) saved = await findGroupByFile(cookieFile);
    }
    if (saved) {
      await selectGroup(saved, { silent: true });
    } else {
      const hash = new URLSearchParams(location.hash.slice(1)).get("g");
      if (hash) {
        const g = await findGroupByFile(hash);
        if (g) await selectGroup(g, { silent: true });
      }
    }

    if (!state.group) openSheet();
    render();
  }

  function readSavedGroup() {
    try {
      const raw = localStorage.getItem("group");
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  const GROUP_COOKIE = "pary_group";

  function writeGroupCookie(file) {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = GROUP_COOKIE + "=" + encodeURIComponent(file) +
      "; Max-Age=31536000; Path=/; SameSite=Lax" + secure;
  }

  function readGroupCookie() {
    const m = document.cookie.match(new RegExp("(?:^|; )" + GROUP_COOKIE + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function findGroupByFile(file) {
    for (const inst of state.institutes) {
      const groups = await loadInstitute(inst.id).catch(() => []);
      const hit = groups.find((g) => g.file === file);
      if (hit) return { ...hit, i: inst.id, in: inst.name };
    }
    return null;
  }

  async function loadInstitute(id) {
    if (state.groupsByInst.has(id)) return state.groupsByInst.get(id);
    const inst = state.institutes.find((x) => x.id === id);
    if (!inst) return [];
    const arr = await cachedJSON(`data/i/${inst.file}.json`, `i:${inst.file}`);
    const withInst = arr.map((g) => ({ ...g, i: id, in: inst.name }));
    state.groupsByInst.set(id, withInst);
    return withInst;
  }

  async function loadAllGroups() {
    if (state.allGroups) return state.allGroups;
    const lists = await Promise.all(
      state.institutes.map((i) => loadInstitute(i.id).catch(() => []))
    );
    state.allGroups = lists.flat();
    return state.allGroups;
  }

  async function selectGroup(g, opts = {}) {
    if (!g || !safeSlug(g.file)) {
      toast("Некорректная группа");
      return;
    }
    state.group = g;
    state.loading = true;
    render();
    try {
      state.data = await cachedJSON(`data/g/${g.file}.json`, `g:${g.file}`);
    } catch (_) {
      state.data = null;
      toast("Не удалось загрузить расписание");
    }
    state.loading = false;
    state.weekOffset = 0;
    state.day = isoOf(new Date());
    try {
      localStorage.setItem("group", JSON.stringify(g));
    } catch (_) { /* ignore */ }
    writeGroupCookie(g.file);
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    history.replaceState(null, "", `#g=${g.file}`);
    render();
    if (!opts.silent) toast(`${g.g} · сохранено`);
  }

  /* ── Рендер ──────────────────────────────────────────── */

  function currentMonday() {
    return addDays(mondayOf(new Date()), state.weekOffset * 7);
  }

  function lessonsFor(dateStr) {
    if (!state.data) return [];
    const wd = ((parseISO(dateStr).getDay() + 6) % 7) + 1;
    const par = parityOf(dateStr);
    return state.data.s
      .filter((l) => l.d === wd && dateStr >= l.f && dateStr <= l.u && (l.w === 0 || l.w === par))
      .sort((a, b) => a.b.localeCompare(b.b));
  }

  function dayHas(dateStr) {
    return lessonsFor(dateStr).length > 0;
  }

  function render() {
    const off = $("#offline");
    if (off) off.hidden = navigator.onLine;
    renderHeader();
    renderWeek();
    renderDays();
    renderContent();
    renderFoot();
    $("#groupBtn").disabled = state.loading && !state.group;
  }

  function renderHeader() {
    const name = state.group ? state.group.g : "Выбрать группу";
    $("#groupName").textContent = name;
    const course = state.group && state.group.k ? ` · ${state.group.k} курс` : "";
    $("#groupSub").textContent = state.group
      ? `${state.group.i}${course}`
      : "КНИТУ · расписание";
    document.title = state.group ? `${state.group.g} — Пары` : "Пары — расписание КНИТУ";
    const share = $("#shareBtn");
    if (share) share.hidden = !state.group;
  }

  function renderWeek() {
    const mon = currentMonday();
    const today = isoOf(new Date());
    const inWeek = today >= isoOf(mon) && today <= isoOf(addDays(mon, 6));
    $("#weekLabel").innerHTML =
      `<span class="week-dates">${esc(fmtRange(mon))}</span>` +
      `<span class="week-parity">${parityOf(isoOf(mon)) === 2 ? "чётная" : "нечётная"} неделя${inWeek ? " · текущая" : ""}</span>`;
  }

  function renderDays() {
    const mon = currentMonday();
    const today = isoOf(new Date());
    if (!state.day || state.day < isoOf(mon) || state.day > isoOf(addDays(mon, 6))) {
      state.day = today >= isoOf(mon) && today <= isoOf(addDays(mon, 6))
        ? today : isoOf(mon);
    }
    const wrap = $("#days");
    wrap.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(mon, i);
      const ds = isoOf(d);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "day";
      b.dataset.date = ds;
      if (ds === today) b.classList.add("is-today");
      if (ds === state.day) {
        b.classList.add("is-active");
        b.setAttribute("aria-current", "date");
      }
      if (state.data && dayHas(ds)) b.classList.add("has");
      b.innerHTML = `<span class="dow">${DOW[i]}</span><span class="num">${d.getDate()}</span><span class="dot"></span>`;
      b.addEventListener("click", () => {
        state.day = ds;
        renderDays();
        renderContent();
      });
      wrap.appendChild(b);
    }
    const active = wrap.querySelector(".is-active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function typeStyle(t) {
    return TYPE_STYLE[t] || ["#64748b", "#eef1f5"];
  }

  function subLabel(x) {
    if (!x) return "";
    const m = x.match(/(\d+([.,]\d+)?\s*(?:подгр|п\/г|гр))/i);
    if (m) return m[1].replace(/\s+/g, " ");
    if (/крзал/i.test(x)) return "";
    return "";
  }

  function renderContent() {
    const box = $("#content");
    if (state.loading) {
      box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
      return;
    }
    if (state.group && !state.data) {
      box.innerHTML = `
        <div class="empty">
          <div class="emoji">📡</div>
          <div class="title">Не удалось загрузить</div>
          <div class="hint">Проверь интернет и попробуй ещё раз.</div>
          <button class="btn-primary" type="button" id="retry">Повторить</button>
        </div>`;
      const r = $("#retry");
      if (r) r.addEventListener("click", () => selectGroup(state.group, { silent: true }));
      return;
    }

    if (!state.group || !state.data) {
      box.innerHTML = `
        <div class="welcome">
          <div class="big">🗓️</div>
          <h2>Расписание под рукой</h2>
          <p>Выбери свою группу — и увидишь пары, преподавателей и аудитории. Работает даже на медленном интернете.</p>
          <button class="btn-primary" type="button" id="pickGroup">Выбрать группу</button>
        </div>`;
      const btn = $("#pickGroup");
      if (btn) btn.addEventListener("click", openSheet);
      return;
    }

    if (DESKTOP_MQ.matches) {
      renderWeekGrid(box);
      return;
    }

    const list = lessonsFor(state.day);
    if (!list.length) {
      box.innerHTML = `
        <div class="empty">
          <div class="emoji">${state.day === isoOf(new Date()) ? "☕" : "🌿"}</div>
          <div class="title">Пар нет</div>
          <div class="hint">${state.day === isoOf(new Date()) ? "Сегодня можно выдохнуть." : "Свободный день — хорошее время для конспектов."}</div>
        </div>`;
      return;
    }

    const today = isoOf(new Date());
    const isToday = state.day === today;
    const now = nowMinutes();
    box.innerHTML = list.map((l) => {
      const [fg, bg] = typeStyle(l.t);
      const start = toMin(l.b);
      const end = toMin(l.e);
      const live = isToday && now >= start && now <= end;
      const past = isToday && now > end;
      const sub = subLabel(l.x);
      return `
        <article class="lesson${live ? " is-now" : ""}${past ? " is-past" : ""}"
                 style="--type-color:${fg};--type-bg:${bg}">
          ${live ? '<span class="now-badge"><i></i>сейчас</span>' : ""}
          <div class="time">
            <div class="start">${esc(l.b)}</div>
            <div class="end">${esc(l.e)}</div>
          </div>
          <div class="body">
            <div class="subject">${esc(l.n)}</div>
            <div class="meta">
              <span class="type">${esc(l.t)}</span>
              ${l.r ? `<span class="room">${esc(l.r)}</span>` : ""}
              ${l.p ? `<span class="teacher">${esc(l.p)}</span>` : ""}
              ${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
            </div>
          </div>
        </article>`;
    }).join("");
  }

  function slotCard(l, isToday) {
    const [fg, bg] = typeStyle(l.t);
    const live = isToday && nowMinutes() >= toMin(l.b) && nowMinutes() <= toMin(l.e);
    const past = isToday && nowMinutes() > toMin(l.e);
    const sub = subLabel(l.x);
    return `
      <article class="slot${live ? " is-now" : ""}${past ? " is-past" : ""}"
               style="--type-color:${fg};--type-bg:${bg}">
        ${live ? '<span class="slot-now">сейчас</span>' : ""}
        <div class="slot-time"><b>${esc(l.b)}</b><span>${esc(l.e)}</span></div>
        <div class="slot-subject">${esc(l.n)}</div>
        <div class="slot-meta">
          <span class="type">${esc(l.t)}</span>
          ${l.r ? `<span class="room">${esc(l.r)}</span>` : ""}
        </div>
        ${l.p ? `<div class="slot-teacher">${esc(l.p)}</div>` : ""}
        ${sub ? `<div class="slot-sub">${esc(sub)}</div>` : ""}
      </article>`;
  }

  function renderWeekGrid(box) {
    const mon = currentMonday();
    const today = isoOf(new Date());
    const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    const showSunday = lessonsFor(isoOf(days[6])).length > 0;
    const count = showSunday ? 7 : 6;

    let html = `<div class="weekgrid" style="--cols:${count}">`;
    for (let i = 0; i < count; i++) {
      const d = days[i];
      const ds = isoOf(d);
      const list = lessonsFor(ds);
      const isToday = ds === today;
      html += `
        <section class="daycol${isToday ? " is-today" : ""}">
          <header class="daycol-head">
            <span class="dow">${DOW[i]}</span>
            <span class="num">${d.getDate()}</span>
            <span class="mon">${MONTHS_SHORT[d.getMonth()]}</span>
          </header>
          ${list.length
            ? list.map((l) => slotCard(l, isToday)).join("")
            : '<div class="daycol-empty">нет пар</div>'}
        </section>`;
    }
    html += "</div>";
    box.innerHTML = html;
  }

  function renderFoot() {
    const g = state.meta && state.meta.generated;
    const upd = g ? ` · обновлено ${esc(fmtGenerated(g))}` : "";
    $("#foot").innerHTML =
      `Данные: <a href="https://www.kstu.ru" target="_blank" rel="noopener">kstu.ru</a>${upd}` +
      `<br><span class="foot-legal">Неофициальный проект · ` +
      `<a href="legal.html">Правовая информация</a> · ` +
      `<a href="privacy.html">Политика ПД</a></span>`;
  }

  /* ── Выбор группы ────────────────────────────────────── */

  let scrollToCurrent = false;

  function openSheet() {
    const sheet = $("#sheet");
    sheet.hidden = false;
    scrollToCurrent = true;
    document.body.style.overflow = "hidden";
    state.sheetInst = state.group ? state.group.i : undefined;
    state.sheetQuery = "";
    $("#searchInput").value = "";
    renderChips();
    renderGroupList();
    sheet._lastFocus = document.activeElement;
    setTimeout(() => {
      const panel = sheet.querySelector(".sheet-panel");
      if (panel) panel.focus();
    }, 120);
  }

  function closeSheet() {
    const sheet = $("#sheet");
    sheet.hidden = true;
    document.body.style.overflow = "";
    const back = sheet._lastFocus;
    if (back && typeof back.focus === "function") back.focus();
  }

  function trapFocus(e) {
    if (e.key !== "Tab") return;
    const sheet = $("#sheet");
    if (sheet.hidden) return;
    const panel = sheet.querySelector(".sheet-panel");
    if (!panel) return;
    const items = [...panel.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function renderChips() {
    const wrap = $("#instChips");
    const chips = [{ id: null, name: "Все" }, ...state.institutes.map((i) => ({ id: i.id, name: i.id }))];
    wrap.innerHTML = chips.map((c) =>
      `<button class="chip${state.sheetInst === c.id ? " is-active" : ""}" type="button" data-inst="${esc(c.id ?? "")}">${esc(c.name)}</button>`
    ).join("");
    wrap.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        state.sheetInst = el.dataset.inst || null;
        renderChips();
        renderGroupList();
      });
    });
    if (scrollToCurrent) {
      const act = wrap.querySelector(".chip.is-active");
      if (act) {
        const ar = act.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        wrap.scrollLeft += ar.left - wr.left - (wr.width - ar.width) / 2;
      }
    }
  }

  async function renderGroupList() {
    const list = $("#groupList");

    // пока институт не выбран и нет запроса — ничего тяжёлого не грузим
    if (state.sheetInst === undefined && !state.sheetQuery.trim()) {
      list.innerHTML = '<div class="pick-hint"><b>Выбери институт</b><span>или введи номер группы — например, 861</span></div>';
      return;
    }

    list.innerHTML = '<div class="course-title">Загрузка…</div>';
    let groups;
    try {
      groups = state.sheetInst ? await loadInstitute(state.sheetInst) : await loadAllGroups();
    } catch (_) {
      list.innerHTML = '<div class="course-title">Не удалось загрузить список групп</div>';
      return;
    }

    const q = state.sheetQuery.trim().toLowerCase();
    if (q) {
      groups = groups.filter((g) =>
        g.g.toLowerCase().includes(q) || (g.in || "").toLowerCase().includes(q));
    }
    if (!groups.length) {
      list.innerHTML = '<div class="course-title">Ничего не нашлось</div>';
      return;
    }

    const byCourse = new Map();
    for (const g of groups) {
      const k = g.k || 0;
      if (!byCourse.has(k)) byCourse.set(k, []);
      byCourse.get(k).push(g);
    }

    let html = "";
    for (const k of [...byCourse.keys()].sort((a, b) => a - b)) {
      html += `<div class="course-title">${k ? k + " курс" : "Другое"}</div>`;
      for (const g of byCourse.get(k)) {
        const badge = g.l === "магистратура" ? "маг" : g.l === "специалитет" ? "спец" : "бак";
        const cur = state.group && state.group.file === g.file;
        html += `
          <button class="group-row${cur ? " is-current" : ""}" type="button" data-file="${esc(g.file)}">
            <span class="g-name">${esc(g.g)}</span>
            <span class="g-badge">${badge}</span>
            <span class="g-sub">${esc(g.f === "заоч" ? "заоч" : "очн")}${state.sheetInst ? "" : " · " + esc(g.i)}</span>
          </button>`;
      }
    }
    list.innerHTML = html;
    if (scrollToCurrent) {
      scrollToCurrent = false;
      const cur = list.querySelector(".group-row.is-current");
      if (cur) {
        const cr = cur.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        const top = cr.top - lr.top + list.scrollTop;
        list.scrollTop = top - list.clientHeight / 2 + cur.offsetHeight / 2;
      }
    }

    list.querySelectorAll(".group-row").forEach((el) => {
      el.addEventListener("click", async () => {
        const file = el.dataset.file;
        let g = groups.find((x) => x.file === file);
        if (!g) return;
        if (!g.i) {
          // при загрузке «Все» институт уже проставлен, иначе ищем
          g = (await findGroupByFile(file)) || g;
        }
        closeSheet();
        await selectGroup(g);
      });
    });
  }

  /* ── События ─────────────────────────────────────────── */

  function wireUI() {
    $("#groupBtn").addEventListener("click", openSheet);
    $("#shareBtn").addEventListener("click", shareGroup);
    $("#todayBtn").addEventListener("click", () => {
      state.weekOffset = 0;
      state.day = isoOf(new Date());
      render();
    });
    $("#prevWeek").addEventListener("click", () => setWeek(-1));
    $("#nextWeek").addEventListener("click", () => setWeek(1));

    let sx = null;
    $("#content").addEventListener("touchstart", (e) => {
      sx = e.touches[0].clientX;
    }, { passive: true });
    $("#content").addEventListener("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 60) setWeek(dx > 0 ? -1 : 1);
      sx = null;
    }, { passive: true });

    $("#searchInput").addEventListener("input", (e) => {
      state.sheetQuery = e.target.value;
      renderGroupList();
    });

    $("#sheet").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) closeSheet();
    });

    setupInstall();

    if (DESKTOP_MQ.addEventListener) DESKTOP_MQ.addEventListener("change", render);
    else if (DESKTOP_MQ.addListener) DESKTOP_MQ.addListener(render);

    addEventListener("online", render);
    addEventListener("offline", render);

    document.addEventListener("keydown", trapFocus);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
      if (e.target.matches("input, textarea")) return;
      if (e.key === "ArrowLeft") setWeek(-1);
      if (e.key === "ArrowRight") setWeek(1);
    });

    const bar = document.querySelector(".topbar");
    addEventListener("scroll", () => {
      bar.classList.toggle("is-scrolled", scrollY > 4);
    }, { passive: true });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  /* ── Установка на телефон ────────────────────────────── */

  function setupInstall() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    let deferred = null;

    const box = $("#install");
    const action = $("#installAction");

    const hide = () => { box.hidden = true; };

    const show = (mode) => {
      if (standalone || box.hidden === false || localStorage.getItem("installOff")) return;
      if (mode === "ios") {
        $("#installTitle").textContent = "Добавить на экран «Домой»";
        $("#installHint").textContent = "Поделиться → На экран «Домой»";
        action.hidden = true;
      } else {
        $("#installTitle").textContent = "Установить на телефон";
        $("#installHint").textContent = "Будет открываться как приложение";
        action.hidden = false;
      }
      box.hidden = false;
    };

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferred = e;
      show("android");
    });

    action.addEventListener("click", async () => {
      if (!deferred) return;
      try {
        deferred.prompt();
        await deferred.userChoice.catch(() => {});
      } catch (_) {}
      deferred = null;
      hide();
    });

    $("#installClose").addEventListener("click", () => {
      try { localStorage.setItem("installOff", "1"); } catch (_) {}
      hide();
    });

    if (isIOS) setTimeout(() => show("ios"), 3500);
  }

  async function shareGroup() {
    if (!state.group) return;
    const url = location.origin + location.pathname + "#g=" + state.group.file;
    const title = "Расписание " + state.group.g + " — КНИТУ";
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (_) { /* отменили — пробуем скопировать */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Ссылка на группу скопирована");
      return;
    } catch (_) { /* нет доступа к буферу — пробуем старый способ */ }

    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (ok) {
        toast("Ссылка на группу скопирована");
        return;
      }
    } catch (_) { /* ignore */ }

    window.prompt("Скопируй ссылку на группу:", url);
  }

  function setWeek(delta) {
    const mon = currentMonday();
    const weekday = state.day
      ? (parseISO(state.day).getDay() + 6) % 7
      : (new Date().getDay() + 6) % 7;
    state.weekOffset += delta;
    const nm = addDays(mon, delta * 7);
    state.day = isoOf(addDays(nm, weekday));
    render();
  }

  boot();
})();
