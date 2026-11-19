// I-net 共通ロジック v2（料金計算・空席生成・座席レイアウト）
// 料金表は今急電鉄の公式サイト「乗換案内」と同じものを使用

// 運賃表 [最大km, 運賃]
const FARE_TABLE = [
  [3,150],[6,180],[10,210],[15,250],[20,330],[25,420],[30,500],[35,580],[40,660],
  [45,740],[50,820],[60,940],[70,1060],[80,1180],[90,1300],[100,1420],[120,1640],
  [140,1860],[160,2080],[180,2300],[200,2520],[220,2740],[240,2960],[260,3180],
  [280,3400],[300,3620],[320,3900],[340,4180],[360,4460],[380,4740],[400,5020],
  [420,5300],[440,5580],[460,5860],[480,6140],[500,6420],[520,6740],[540,7060],
  [560,7380],[580,7700],[600,8020],[620,8340],[640,8660],[650,8980],
  [700,9780],[750,10580],[800,11380],[850,12180],[900,12980],[950,13780],[1000,14580]
];
// 高速線料金 [最大km, 自由席, 指定席]
const EXPRESS_TABLE = [
  [50,800,1100],[100,1200,1600],[150,1600,2100],[200,2000,2500],[250,2400,2900],
  [300,2800,3300],[400,3200,3700],[500,3600,4100],[600,4000,4500],[650,4300,4800],[750,4700,5200],[850,5100,5600],[950,5500,6000],[1000,5800,6300]
];
// 特急料金（指定席）[最大km, 料金]
const LIMITED_RESERVED_TABLE = [
  [50,800],[100,1200],[150,1600],[200,1900],[250,2200],[300,2500],
  [400,2800],[500,3000],[600,3200],[650,3400],[750,3600],[850,3800],[950,4000],[1000,4200]
];
// ノーブルカー追加料金（高速線）[最大km, 料金]
const NOBLE_TABLE = [[100,1500],[200,2000],[300,2500],[400,3000],[500,3500],[600,4000],[650,4300],[750,4800],[850,5300],[950,5800],[1000,6100]];
// ノーブルカー追加料金（在来線特急・300kmまで）[最大km, 料金]
const LIMITED_NOBLE_TABLE = [[100,800],[200,1200],[300,1500]];
// セレストクラス追加料金 [最大km, 料金]
const CELESTE_TABLE = [[100,4000],[200,5000],[300,6000],[400,7000],[500,8000],[600,9000],[650,9500],[750,10500],[850,11500],[950,12500],[1000,13000]];
// 個室料金（寝台料金・特急料金に上乗せ）
const ROOM_FEES = {
  "ナイトエクスプレス秋川": { "B個室": 6000, "A個室": 9000 },
  "銀鳥": { "B個室": 8000, "A個室": 13000, "S個室": 20000 },
  "天空": { "B個室": 9000, "A個室": 15000, "S個室": 23000 }
};
const LINER_FEE = 600;
const HS_LINES = ["中央高速線", "今宮高速線", "河津高速線・拠点高速線"];
const LIMITED_TYPES = ["特急", "臨特急", "寝特", "臨寝特"];
const LINER_TYPES = ["ライ", "ライナー"];
const ROOM_CLASSES = ["B個室", "A個室", "S個室"];
// 同名・別駅の乗換可否（公式サイト乗換案内と同じ判定）
const SPLIT_STATION_GROUPS = {
  "上田": [["黒崎小岩ライン"], ["今宮本線", "大川線"], ["吉田線"]],
  "高田": [["松代線"], ["吉田線"]],
  "石川": [["吉田線"], ["水上線・西田線"]],
  "西吉田": [["大川線"], ["水上線・西田線"]],
  "小島": [["朝日線・小出線"], ["水上線・西田線"]],
  "飯田": [["中央線"], ["中央高速線"]]
};

function tierRow(table, km) {
  for (const row of table) if (km <= row[0]) return row;
  return table[table.length - 1];
}
function canTransferAt(station, lineA, lineB) {
  if (lineA === lineB) return true;
  const groups = SPLIT_STATION_GROUPS[station];
  if (!groups) return true;
  return groups.some(g => g.includes(lineA) && g.includes(lineB));
}
function stationLines(name) {
  return Object.keys(INET_STATIONS).filter(line => INET_STATIONS[line].some(s => s.name === name));
}

// ---- 料金計算 ----
// 列車の区間（セグメント）ごとの累積km範囲（境界駅が通過駅でも正しく分割できるようkmで判定）
function segmentRanges(train) {
  const ranges = [];
  let startKm = train.kms[0];
  train.segments.forEach((seg, i) => {
    const endKm = i === train.segments.length - 1 ? train.kms[train.kms.length - 1] : startKm + seg.km;
    ranges.push({ seg, startKm, endKm });
    startKm = endKm;
  });
  return ranges;
}
// 1乗車（1列車）分の料金内訳。運賃は含まない（乗換時は通算するため）
function legPrice(train, from, to, cls) {
  const fi = train.times.findIndex(([s]) => s === from);
  const ti = train.times.findIndex(([s]) => s === to);
  if (fi === -1 || ti === -1 || fi >= ti) return null;
  const totalKm = train.kms[ti] - train.kms[fi];
  const items = [];
  const add = (label, amount) => {
    const hit = items.find(i => i.label === label);
    if (hit) hit.amount += amount; else items.push({ label, amount });
  };
  let linerCharged = false;
  const nobleSegs = [], celesteSegs = [];
  for (const { seg, startKm, endKm } of segmentRanges(train)) {
    const oKm = Math.min(train.kms[ti], endKm) - Math.max(train.kms[fi], startKm);
    if (oKm <= 0) continue;
    if (HS_LINES.includes(seg.line)) {
      add("高速線料金（指定席）", tierRow(EXPRESS_TABLE, oKm)[2]);
      nobleSegs.push({ hs: true, km: oKm });
      if (seg.line !== "河津高速線・拠点高速線") celesteSegs.push(oKm); // この路線にセレストはない
    } else if (LINER_TYPES.includes(seg.type)) {
      if (!linerCharged) { add("ライナー料金", LINER_FEE); linerCharged = true; }
    } else if (LIMITED_TYPES.includes(seg.type)) {
      add("特急料金（指定席）", tierRow(LIMITED_RESERVED_TABLE, oKm)[1]);
      nobleSegs.push({ hs: false, km: oKm });
    }
  }
  if (cls === "ノーブルカー" || cls === "グリーン車") {
    let noble = 0;
    for (const s of nobleSegs) {
      if (s.hs) noble += tierRow(NOBLE_TABLE, s.km)[1];
      else {
        if (s.km > 300) return null; // 在来線特急のノーブルカーは300kmまで
        noble += tierRow(LIMITED_NOBLE_TABLE, s.km)[1];
      }
    }
    if (noble > 0) add(cls + "料金", noble);
  }
  if (cls === "セレストクラス") {
    let cel = 0;
    for (const km of celesteSegs) cel += tierRow(CELESTE_TABLE, km)[1];
    if (cel > 0) add("セレストクラス料金", cel);
  }
  if (ROOM_CLASSES.includes(cls)) {
    const fees = ROOM_FEES[train.name];
    if (!fees || !(cls in fees)) return null;
    add("個室料金（" + cls + "・寝台料金）", fees[cls]);
  }
  const charges = items.reduce((a, i) => a + i.amount, 0);
  return { km: totalKm, items, charges };
}

// ---- 会社別運賃（2026-11-19 悠征の決定：会社ごとに初乗り運賃） ----
const INET_LINE_COMPANY = {
  "中央線":"今急","今宮本線":"今急","松代線":"今急","中央高速線":"今急",
  "今宮高速線":"今急","吉田線":"今急","吉野線":"今急","大川線":"今急",
  "大野線":"今急","朝日線・小出線":"今急","水上線・西田線":"今急","青山線":"今急",
  "秋川本線":"今急","横倉空港線・河合本線・横倉スカイアクセス線":"今急",
  "黒崎小岩ライン":"今急",
  "田原線":"西中","北倉線":"西中","多田本線":"西中","新沢線":"西中",
  "河田線":"西中","山北線":"西中",
  "和阪線":"横倉","浜田本線":"横倉","扶桑本線":"横倉","浜見線":"横倉",
  "森浜線":"横倉","赤倉本線":"横倉","赤倉港線":"横倉","新拠点線":"横倉",
  "小岩線・小阪線":"横倉","拠点本線":"横倉","都心環状線":"横倉","吹雪環状線":"横倉",
  "赤津線":"横倉","河津高速線・拠点高速線":"横倉","横倉空港線（横倉）":"横倉",
  "磯電線・技輪ドーム線・拠点小岩ライン":"磯急",
  "臨海線":"臨海"
};
// 路線の中に会社境界がある路線の駅間判定（kmOf はその路線の駅→km軸）
const INET_SPLIT_PAIR = {
  // 赤倉都市線区間（新赤倉〜有坂・km 0〜59）は横倉電鉄
  "黒崎小岩ライン": (a, b, kmOf) => {
    const x = kmOf(a), y = kmOf(b);
    return (x !== undefined && y !== undefined && Math.min(x, y) < 59 && Math.max(x, y) <= 59) ? "横倉" : "今急";
  },
  // 田原線の自社駅（水谷・田原市）同士だけ西中電鉄。それ以外（吉田線・中央線・貨物線リンク）は今急
  "田原線": (a, b, kmOf) => (kmOf(a) !== undefined && kmOf(b) !== undefined) ? "西中" : "今急"
};
// 1レグ（1列車の乗車区間）を会社別の距離に分解する
function legCompanyKmInet(train, from, to) {
  const fi = train.times.findIndex(([st]) => st === from);
  const ti = train.times.findIndex(([st]) => st === to);
  if (fi < 0 || ti < 0 || fi >= ti) return null;
  const ranges = segmentRanges(train);
  const out = {};
  for (let i = fi; i < ti; i++) {
    const d = train.kms[i + 1] - train.kms[i];
    if (!d) continue;
    const midKm = (train.kms[i] + train.kms[i + 1]) / 2;
    const r = ranges.find(r => midKm >= r.startKm && midKm < r.endKm) || ranges[ranges.length - 1];
    const line = r.seg.line;
    let company;
    const splitFn = INET_SPLIT_PAIR[line];
    if (splitFn) {
      const kmOf = st => { const e = (INET_STATIONS[line] || []).find(x => x.name === st); return e ? e.km : undefined; };
      company = splitFn(train.times[i][0], train.times[i + 1][0], kmOf);
    } else {
      company = INET_LINE_COMPANY[line] || "今急";
    }
    out[company] = (out[company] || 0) + d;
  }
  return out;
}
// 乗換を含む全区間の料金（運賃は会社ごとに計算して合算）
function journeyPrice(legs) {
  let totalKm = 0;
  const items = [];
  const add = (label, amount) => {
    const hit = items.find(i => i.label === label);
    if (hit) hit.amount += amount; else items.push({ label, amount });
  };
  const companyKm = {};
  for (const leg of legs) {
    const lp = legPrice(leg.train, leg.from, leg.to, leg.cls);
    if (!lp) return null;
    totalKm += lp.km;
    const ckm = legCompanyKmInet(leg.train, leg.from, leg.to);
    if (!ckm) return null;
    for (const c of Object.keys(ckm)) companyKm[c] = (companyKm[c] || 0) + ckm[c];
    for (const i of lp.items) add(i.label, i.amount);
  }
  const companies = Object.keys(companyKm).filter(c => companyKm[c] > 0);
  const fareItems = companies.length <= 1
    ? [{ label: "運賃", amount: tierRow(FARE_TABLE, totalKm)[1] }]
    : companies.map(c => ({ label: "運賃（" + c + "）", amount: tierRow(FARE_TABLE, companyKm[c])[1] }));
  const all = [...fareItems, ...items];
  return { km: totalKm, items: all, total: all.reduce((a, i) => a + i.amount, 0) };
}
function availableClasses(train, from, to) {
  return train.classes.filter(cls => legPrice(train, from, to, cls) !== null);
}
// 予約全体の料金：往路・復路は方向ごとに運賃を通算する（往復は片道×2方向分）
function bookingPrice(legs) {
  const groups = [];
  for (const leg of legs) {
    const key = leg.label || "";
    let g = groups.find(g => g.key === key);
    if (!g) { g = { key, legs: [] }; groups.push(g); }
    g.legs.push(leg);
  }
  let total = 0;
  const items = [];
  for (const g of groups) {
    const jp = journeyPrice(g.legs);
    if (!jp) return null;
    total += jp.total;
    for (const it of jp.items) {
      items.push({ label: (groups.length > 1 && g.key ? g.key + "：" : "") + it.label, amount: it.amount });
    }
  }
  return { total, items };
}
// 号車の設備案内（試作版の割り当て）
function carFacilities(train, cls, car) {
  const list = [];
  if (cls === "セレストクラス") list.push("全室個室", "専用アテンダント");
  else if (cls === "ノーブルカー" || cls === "グリーン車") list.push("コンセント全席", "大型リクライニング");
  else if (cls === "SUYARIN") list.push("2段寝台", "カーテン仕切り");
  else if (ROOM_CLASSES.includes(cls)) list.push("個室", "洗面台つき");
  else list.push("コンセント（一部座席）");
  if (car === 2 || car === 8) list.push("トイレ・洗面所が近い");
  if (car === 5) list.push("車内販売ワゴン停車位置");
  return list;
}

// ---- 空席・座席の決定的生成（列車と日付からシード） ----
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seatLayout(cls) {
  const rows = [];
  if (cls === "セレストクラス") {
    for (let r = 1; r <= 8; r++) rows.push({ row: r, seats: [r + "A", null, r + "B"] });
  } else if (cls === "SUYARIN") {
    for (let r = 1; r <= 12; r++) rows.push({ row: r, seats: [r + "A", null, r + "B"] });
  } else if (ROOM_CLASSES.includes(cls)) {
    for (let r = 0; r < 5; r++) rows.push({ row: r + 1, seats: [(r * 2 + 1) + "号室", null, (r * 2 + 2) + "号室"] });
  } else if (cls === "ノーブルカー" || cls === "グリーン車") {
    for (let r = 1; r <= 10; r++) rows.push({ row: r, seats: [r + "A", r + "B", null, r + "C"] });
  } else {
    for (let r = 1; r <= 15; r++) rows.push({ row: r, seats: [r + "A", r + "B", null, r + "C", r + "D"] });
  }
  return rows;
}
function allSeatIds(cls) {
  const ids = [];
  for (const r of seatLayout(cls)) for (const s of r.seats) if (s) ids.push(s);
  return ids;
}
// ---- 号車構成（試作版の編成割り当て） ----
function carsFor(train, cls) {
  const name = train.name || "";
  const isHS = train.lines.some(l => HS_LINES.includes(l));
  if (cls === "セレストクラス") return [10];
  if (cls === "SUYARIN") return [3];
  if (ROOM_CLASSES.includes(cls)) {
    if (name.includes("秋川")) return cls === "A個室" ? [5] : [4];
    if (name === "銀鳥" || name === "天空") return cls === "S個室" ? [4] : cls === "A個室" ? [3] : [2];
    return [3];
  }
  if (cls === "ノーブルカー" || cls === "グリーン車") {
    // 河津高速線・拠点高速線のグリーン車は10号車（料金はノーブルカーと同じ）※悠征
    if (train.lines.includes("河津高速線・拠点高速線")) return [10];
    // 横倉の特急はグリーン車＝ノーブルカー扱い（料金同じ・4・5号車）※悠征
    if (train.lines.some(l => ["和阪線", "浜田本線", "浜見線", "扶桑本線"].includes(l))) return [4, 5];
    if (isHS) return (name === "しまなみ" || name === "てんりゅう") ? [6] : [8, 9];
    if (name === "いまみや") return [10];
    if (name === "加賀") return [7];
    if (name === "よこやま") return [3];
    return [6];
  }
  // 指定席
  // 河津高速線・拠点高速線は自由席1〜3号車・指定席4〜9号車・グリーン10号車 ※悠征
  if (train.lines.includes("河津高速線・拠点高速線")) return [4, 5, 6, 7, 8, 9];
  if (train.lines.some(l => ["和阪線", "浜田本線", "浜見線", "扶桑本線"].includes(l))) return [1, 2, 3, 6, 7, 8, 9, 10];
  if (isHS) {
    if (name === "しまなみ" || name === "てんりゅう") return [1, 2, 3, 4, 5];
    return [1, 2, 3, 4, 5, 6, 7];
  }
  if (LINER_TYPES.includes(train.type)) return [2, 3, 4, 5, 6];
  if (name === "いまみや") return [2, 3, 4, 5, 6, 7, 8, 9];
  if (name === "加賀") return [2, 3, 4, 5, 6];
  if (name === "よこやま") return [1, 2];
  if (name.includes("水谷")) return [2, 3];
  return [2, 3, 4, 5];
}
function reservedSeats(trainKey, date, cls, car) {
  const ids = allSeatIds(cls);
  const rnd = mulberry32(hashSeed(date + "|" + trainKey + "|" + cls + "|" + car));
  const r = rnd();
  let ratio;
  if (r < 0.5) ratio = rnd() * 0.45;
  else if (r < 0.88) ratio = 0.78 + rnd() * 0.2;
  else ratio = 1;
  const count = Math.floor(ids.length * ratio);
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return new Set(shuffled.slice(0, count));
}
function vacancyOf(trainKey, date, cls, reserved) {
  const total = allSeatIds(cls).length;
  const left = total - reserved;
  if (left === 0) return { mark: "×", cls: "full", left };
  if (left / total < 0.25) return { mark: "△", cls: "few", left };
  return { mark: "○", cls: "ok", left };
}
function vacancyMarkCar(train, date, cls, car) {
  return vacancyOf(train.key, date, cls, reservedSeats(train.key, date, cls, car).size);
}
function vacancyMark(train, date, cls) {
  const cars = carsFor(train, cls);
  let reservedTotal = 0;
  for (const car of cars) reservedTotal += reservedSeats(train.key, date, cls, car).size;
  const total = allSeatIds(cls).length * cars.length;
  const left = total - reservedTotal;
  if (left === 0) return { mark: "×", cls: "full", left };
  if (left / total < 0.25) return { mark: "△", cls: "few", left };
  return { mark: "○", cls: "ok", left };
}

// ---- 列車まわり ----
const TYPE_LABELS = { "寝特": "寝台特急", "臨寝特": "臨時寝台特急", "臨特急": "臨時特急", "ライ": "ライナー" };
function trainKey(train) { return train.key; }
function trainTitle(train) {
  if (train.name) return train.name + train.number + "号";
  return (TYPE_LABELS[train.type] || train.type) + train.number + "号";
}
function trainTimeAt(train, station) {
  const hit = train.times.find(([s]) => s === station);
  return hit ? hit[1] : null;
}
function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
// 列車内での単調化した分（日付またぎ対応）
function unwrappedTimes(train) {
  const out = [];
  let cur = null;
  for (const [, t] of train.times) {
    let m = timeToMin(t);
    if (cur !== null) while (m < cur) m += 1440;
    out.push(m);
    cur = m;
  }
  return out;
}
function durationText(dep, arr) {
  let d = timeToMin(arr) - timeToMin(dep);
  if (d < 0) d += 1440;
  const h = Math.floor(d / 60), m = d % 60;
  return h > 0 ? h + "時間" + m + "分" : m + "分";
}
function yen(n) { return n.toLocaleString() + "円"; }
function getParams() { return new URLSearchParams(location.search); }
function findTrain(key) { return INET_TRAINS.find(t => t.key === key) || null; }
function lineOfStations(from, to) {
  for (const line of Object.keys(INET_STATIONS)) {
    const names = INET_STATIONS[line].map(s => s.name);
    if (names.includes(from) && names.includes(to)) return line;
  }
  return null;
}
// 駅名入力（候補つき）：全駅名リストと解決・オートコンプリート
const ALL_STATION_NAMES = [...new Set(Object.values(INET_STATIONS).flat().map(s => s.name))];
function resolveStationName(v) {
  v = (v || "").trim();
  if (!v) return null;
  if (ALL_STATION_NAMES.includes(v)) return v;
  const hits = ALL_STATION_NAMES.filter(n => n.includes(v));
  return hits.length === 1 ? hits[0] : null;
}
function setupStationAutocomplete(input) {
  const wrap = input.parentElement;
  wrap.classList.add("station-input-wrap");
  const box = document.createElement("div");
  box.className = "station-suggest";
  box.hidden = true;
  wrap.appendChild(box);
  let items = [], active = -1;
  function render() {
    const v = input.value.trim();
    items = v ? ALL_STATION_NAMES.filter(n => n.includes(v)).slice(0, 12) : [];
    active = items.length ? 0 : -1;
    if (!items.length) { box.hidden = true; return; }
    box.innerHTML = "";
    items.forEach((n, i) => {
      const d = document.createElement("div");
      d.className = "suggest-item" + (i === active ? " active" : "");
      d.textContent = n;
      d.addEventListener("mousedown", e => { e.preventDefault(); input.value = n; box.hidden = true; });
      box.appendChild(d);
    });
    box.hidden = false;
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; }, 150));
  input.addEventListener("keydown", e => {
    if (box.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); input.value = items[active]; box.hidden = true; return; }
    else return;
    [...box.children].forEach((c, i) => c.classList.toggle("active", i === active));
  });
}

// ===== 運転日（臨時列車・運休）=====
function inetDateMatch(dates, dateStr) {
  for (const d of dates || []) {
    if (typeof d !== "string") continue;
    if (d.includes("/")) { const p = d.split("/"); if (dateStr >= p[0] && dateStr <= p[1]) return true; }
    else if (d === dateStr) return true;
  }
  return false;
}
// その列車が dateStr（予約日）に運転するかどうか
function trainRunsOnDate(t, dateStr) {
  if (!dateStr) return true;
  if (t.dates && !inetDateMatch(t.dates, dateStr)) return false;
  if (typeof INET_OPS !== "undefined" && INET_OPS && INET_OPS.rules) {
    let only = null;
    for (const r of INET_OPS.rules) {
      const lineHit = !r.line || (t.lines || []).includes(r.line);
      if (!lineHit) continue;
      if (r.name && t.name !== r.name) continue;
      if (r.type && t.type !== r.type) continue;
      if (r.id && String(t.id) !== String(r.id)) continue;
      if (!r.name && !r.type && !r.id) continue;
      if (r.mode === "except") { if (inetDateMatch(r.dates, dateStr)) return false; }
      else (only ||= []).push(...(r.dates || []));
    }
    if (only) return inetDateMatch(only, dateStr);
  }
  return true;
}
