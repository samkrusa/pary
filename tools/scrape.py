#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборщик расписания КНИТУ (kstu.ru) для приложения «Пары».

Источник: https://www.kstu.ru/www_F22grid.jsp
  d = дата (определяет чётность недели)
  f = институт, k = курс, l = уровень, t = форма

Страница отдаёт всю сетку на семестр для выбранной чётности недели,
поэтому достаточно двух запросов на институт+курс: чётная и нечётная.

Запуск:
    python tools/scrape.py                 # всё, с кэшем
    python tools/scrape.py --refresh       # заново скачать
    python tools/scrape.py --only 320      # один институт
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import ssl
import sys
import time
import urllib.request
from html.parser import HTMLParser

BASE = "https://www.kstu.ru/www_F22grid.jsp"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Институты: id сайта -> короткое и полное имя
INSTITUTES = {
    210: ("ИХТИ", "Инженерный химико-технологический институт"),
    224: ("ИХНМ", "Институт химического и нефтяного машиностроения"),
    243: ("ИУИ", "Институт управления инновациями"),
    256: ("ИНХН", "Институт нефти, химии и нанотехнологий"),
    283: ("ИП", "Институт полимеров"),
    297: ("ИППБ", "Институт пищевых производств и биотехнологии"),
    306: ("ИТЛПМД", "Институт технологии лёгкой промышленности, моды и дизайна"),
    320: ("ИУАИТ", "Институт управления, автоматизации и информационных технологий"),
    331: ("ИДПО", "Институт дополнительного профессионального образования"),
    453: ("БФ", "Учебно-методический отдел БФ"),
}
COURSES = [1, 2, 3, 4, 5]

# 2 ноября 2026 — чётная учебная неделя (проверено по сайту)
ANCHOR_MONDAY = dt.date(2026, 11, 2)
ANCHOR_EVEN = True

MONTHS = {
    "янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5,
    "июн": 6, "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12,
}
DAY_MAP = {"ПH": 1, "ПН": 1, "ВТ": 2, "СР": 3, "ЧТ": 4, "ПТ": 5, "СБ": 6, "ВС": 7}
TYPE_RE = re.compile(r"^(.*?)\s*\((ЛЕКЦ|ПЗ|ЛР|КСР|СРС|МК|УП)\)\s*$")
DATE_RE = re.compile(r"(\d{1,2})\s+([а-яё]{3,4})\s*[-–]\s*(\d{1,2})\s+([а-яё]{3,4})", re.I)
SUBGROUP_RE = re.compile(r"^\*?\s*(\d+([.,]\d+)?\s*(подгр|п/г)|подгр)", re.I)
ROOM_RE = re.compile(r"^[А-ЯЁA-Z]{1,3}\s*[-–]\s*\S")

TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name):
    out = []
    for ch in name.lower():
        out.append(TRANSLIT.get(ch, ch))
    s = "".join(out)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "group"


def http_get(url, timeout=45, attempts=4):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    # сервер вуза не умеет TLS 1.3 с некоторыми клиентами
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Accept-Language": "ru-RU,ru;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


class TableParser(HTMLParser):
    """Достаёт <tr>/<td> с переводом <br> в \\n."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append("\n")

    def handle_endtag(self, tag):
        if tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag in ("td", "th") and self.cell is not None:
            text = "".join(self.cell)
            text = re.sub(r"[ \t\r]+", " ", text)
            text = re.sub(r"\n\s*\n+", "\n", text).strip()
            if self.row is not None:
                self.row.append(text)
            self.cell = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def html_parity(html):
    """Чётность недели из заголовка страницы: 1 — нечётная, 2 — чётная."""
    m = re.search(r"(неч[её]тн|ч[её]тн)ая\s+неделя", html, re.I)
    if not m:
        return None
    return 1 if m.group(1).lower().startswith("неч") else 2


def parse_table(html):
    start = html.find('<table   border="0" class="brstu-table"')
    if start < 0:
        return []
    end = html.find("</table>", start)
    p = TableParser()
    p.feed(html[start:end + 8])
    return p.rows


def iso_date(day, month_word, year):
    m = MONTHS.get(month_word.lower()[:3])
    if not m:
        return None
    return dt.date(year, m, int(day)).isoformat()


def academic_year_for(month):
    """Сентябрь–декабрь — текущий год, январь–август — следующий."""
    y = ANCHOR_MONDAY.year if month >= 8 else ANCHOR_MONDAY.year + 1
    return y


def parse_cell(text):
    """Возвращает список занятий из одной ячейки."""
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    lessons = []
    cur = None
    prev = ""
    for ln in lines:
        m = TYPE_RE.match(ln)
        if m and len(m.group(1)) > 1:
            if cur:
                lessons.append(cur)
            cur = {"n": m.group(1).strip(), "t": m.group(2), "r": "",
                   "f": None, "u": None, "p": "", "x": ""}
            # комната — предыдущая строка, если это не служебный текст
            if prev and ROOM_RE.match(prev):
                cur["r"] = prev
            prev = ln
            continue

        if cur is None:
            prev = ln
            continue

        dm = DATE_RE.search(ln)
        if dm and not cur["f"]:
            mon1 = MONTHS.get(dm.group(2).lower()[:3])
            mon2 = MONTHS.get(dm.group(4).lower()[:3])
            if mon1:
                cur["f"] = iso_date(dm.group(1), dm.group(2), academic_year_for(mon1))
            if mon2:
                cur["u"] = iso_date(dm.group(3), dm.group(4), academic_year_for(mon2))
        elif ln.startswith("*") or SUBGROUP_RE.match(ln):
            cur["x"] = (cur["x"] + " " + ln).strip()
        elif cur["f"] and not cur["p"]:
            cur["p"] = re.sub(r"\s+", " ", ln)
        elif cur["f"] and cur["p"]:
            cur["p"] += ", " + re.sub(r"\s+", " ", ln)
        prev = ln

    if cur:
        lessons.append(cur)

    low = text.lower()
    if "отмен" in low:
        status = "Отменено"
    elif "перенос" in low:
        status = "Перенесено"
    else:
        status = ""
    for l in lessons:
        l["st"] = status

    return [l for l in lessons if l["n"] and l["f"] and l["u"]]


def parse_group_header(text):
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    if not lines:
        return None
    name = lines[0].replace("\xa0", " ").strip()
    # отсекаем служебные ячейки вроде «Время»/«День»
    if not re.match(r"^\d[\wА-Яа-я.]*\s*[-–]\s*\S", name):
        return None
    course = None
    form = "очн"
    level = "бакалавриат"
    for ln in lines[1:]:
        ln = ln.replace("\xa0", " ").strip()
        m = re.match(r"(\d)\s*курс", ln)
        if m:
            course = int(m.group(1))
        elif "очн" in ln and "заоч" not in ln:
            form = "очн"
        elif "заоч" in ln:
            form = "заоч"
        elif "магистр" in ln:
            level = "магистратура"
        elif "специалитет" in ln:
            level = "специалитет"
        elif "бакалавриат" in ln:
            level = "бакалавриат"
    return {"name": name, "course": course, "form": form, "level": level}


def parity_of(date):
    weeks = (date - ANCHOR_MONDAY).days // 7
    even = ANCHOR_EVEN if weeks % 2 == 0 else not ANCHOR_EVEN
    return 2 if even else 1


def fetch_grid(f, k, date, cache_dir, refresh=False):
    tag = "even" if parity_of(date) == 2 else "odd"
    path = os.path.join(cache_dir, f"f{f}_k{k}_{tag}.html")
    if os.path.exists(path) and not refresh:
        return open(path, "rb").read()
    url = f"{BASE}?d={date.isoformat()}&f={f}&l=0&t=0&k={k}&x=www_GF1grid"
    body = http_get(url)
    with open(path, "wb") as fh:
        fh.write(body)
    time.sleep(0.3)
    return body


def merge_lessons(odd, even):
    """Склеивает занятия чётной и нечётной недели."""
    key = lambda l: (l["d"], l["b"], l["e"], l["r"], l["n"], l["t"],
                     l["p"], l["f"], l["u"], l["x"], l.get("st", ""))
    odd_map = {key(l): l for l in odd}
    even_map = {key(l): l for l in even}
    out = []
    for k in odd_map.keys() & even_map.keys():
        l = dict(odd_map[k])
        l["w"] = 0  # каждая неделя
        out.append(l)
    for k in odd_map.keys() - even_map.keys():
        l = dict(odd_map[k])
        l["w"] = 1
        out.append(l)
    for k in even_map.keys() - odd_map.keys():
        l = dict(even_map[k])
        l["w"] = 2
        out.append(l)
    out.sort(key=lambda l: (l["d"], l["b"], l["n"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--cache", default="tools/.cache")
    ap.add_argument("--only", type=int, default=None, help="id института")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="записать данные, даже если групп стало сильно меньше")
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(here, args.out)
    cache_dir = os.path.join(here, args.cache)
    g_dir = os.path.join(out_dir, "g")
    os.makedirs(g_dir, exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)

    # сколько групп было в прошлой сборке — для защиты от затирания
    old_total = 0
    old_index_path = os.path.join(out_dir, "index.json")
    if os.path.exists(old_index_path):
        try:
            with open(old_index_path, encoding="utf-8") as fh:
                old_meta = json.load(fh)
            old_total = sum(int(i.get("n", 0)) for i in old_meta.get("institutes", []))
        except Exception:  # noqa: BLE001
            old_total = 0

    # две даты с разной чётностью
    today = dt.date.today()
    parity_today = parity_of(today)
    # ближайший понедельник нужной чётности
    monday = today - dt.timedelta(days=today.weekday())
    if parity_of(monday) != parity_today:
        monday -= dt.timedelta(days=7)
    other = monday - dt.timedelta(days=7)
    dates = {parity_of(monday): monday, parity_of(other): other}
    even_date, odd_date = dates[2], dates[1]

    ids = [args.only] if args.only else list(INSTITUTES.keys())
    index = []
    total_lessons = 0
    by_slug = {}
    p_even, p_odd = 2, 1

    for f in ids:
        short, full = INSTITUTES[f]
        for k in COURSES:
            try:
                even_html = fetch_grid(f, k, even_date, cache_dir, args.refresh).decode("utf-8", "replace")
                odd_html = fetch_grid(f, k, odd_date, cache_dir, args.refresh).decode("utf-8", "replace")
            except Exception as e:  # noqa: BLE001
                print(f"  ! {short} курс {k}: {e}", file=sys.stderr)
                continue

            p_even = html_parity(even_html) or 2
            p_odd = html_parity(odd_html) or 1
            if p_even == p_odd:
                p_even, p_odd = 2, 1
            even_rows = parse_table(even_html)
            odd_rows = parse_table(odd_html)
            if not even_rows or not odd_rows:
                continue

            groups = [parse_group_header(c) for c in even_rows[0][3:]]
            if not groups or not any(groups):
                continue

            per_group = {i: {"odd": [], "even": []} for i in range(len(groups))}

            for parity, rows in ((p_odd, odd_rows), (p_even, even_rows)):
                for row in rows[1:]:
                    if len(row) < 4 or row[0] == "День":
                        continue
                    day = DAY_MAP.get(row[0].strip())
                    tm = re.match(r"(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})", row[1])
                    if not day or not tm:
                        continue
                    for gi, cell in enumerate(row[3:]):
                        if gi >= len(groups) or not cell:
                            continue
                        for l in parse_cell(cell):
                            l.update({"d": day, "b": tm.group(1), "e": tm.group(2)})
                            per_group[gi]["odd" if parity == 1 else "even"].append(l)

            for gi, g in enumerate(groups):
                if not g:
                    continue
                lessons = merge_lessons(per_group[gi]["odd"], per_group[gi]["even"])
                if not lessons:
                    continue
                slug = slugify(g["name"])
                if slug in by_slug:
                    slug = f"{slug}-{f}-{k}"
                by_slug[slug] = True
                data = {
                    "g": g["name"], "i": short, "k": g["course"], "l": g["level"],
                    "f": g["form"], "s": lessons,
                }
                with open(os.path.join(g_dir, slug + ".json"), "w", encoding="utf-8") as fh:
                    json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
                index.append({
                    "g": g["name"], "i": short, "k": g["course"],
                    "l": g["level"], "f": g["form"], "file": slug,
                })
                total_lessons += len(lessons)
        print(f"{short}: готово ({len(index)} групп, {total_lessons} занятий)", flush=True)

    # защита от сбоя: если групп стало резко меньше — не перезаписываем данные
    if not args.only and not args.force and old_total >= 50:
        if len(index) < old_total * 0.7:
            print(f"! Похоже на сбой: было {old_total} групп, стало {len(index)}. "
                  f"Данные не изменены (--force, чтобы перезаписать).", file=sys.stderr)
            sys.exit(2)

    # удаляем устаревшие файлы групп, которых больше нет
    for old in glob.glob(os.path.join(g_dir, "*.json")):
        name = os.path.basename(old)[:-5]
        if name not in by_slug:
            os.remove(old)

    # индекс по институтам: приложение грузит только нужный
    i_dir = os.path.join(out_dir, "i")
    os.makedirs(i_dir, exist_ok=True)
    anchor_date = even_date if p_even == 2 else odd_date
    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "semester": "1 семестр 2026-2027",
        "anchor": anchor_date.isoformat(),
        "anchorEven": ANCHOR_EVEN,
        "source": "https://www.kstu.ru",
    }
    institutes = []
    for f, (short, full) in INSTITUTES.items():
        groups = sorted([x for x in index if x["i"] == short],
                        key=lambda x: (x["k"] or 0, x["g"]))
        if not groups:
            continue
        inst_slug = slugify(short)
        with open(os.path.join(i_dir, inst_slug + ".json"), "w", encoding="utf-8") as fh:
            json.dump([{k: v for k, v in x.items() if k != "i"} for x in groups],
                      fh, ensure_ascii=False, separators=(",", ":"))
        institutes.append({"id": short, "name": full, "file": inst_slug,
                           "n": len(groups)})

    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "institutes": institutes}, fh,
                  ensure_ascii=False, separators=(",", ":"))

    print(f"\nИтого: {len(index)} групп, {total_lessons} занятий, "
          f"{len(institutes)} институтов")
    print(f"Индекс: {os.path.join(out_dir, 'index.json')}")


if __name__ == "__main__":
    main()
