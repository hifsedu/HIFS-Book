// 교재 재고관리 — Supabase에 저장하고 읽어 오는 화면 코드입니다.
// 현재 재고는 저장하지 않고, 입고 합계 - 출고 합계로 항상 계산합니다 (book_stock 뷰).
var cfg = window.APP_CONFIG || {};
var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase) &&
  cfg.SUPABASE_URL.indexOf("여기에") === -1 && cfg.SUPABASE_ANON_KEY.indexOf("여기에") === -1;
var db = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

var suppliers = [], books = [], txs = [], stockMap = {}, detailTx = null;
var filter = "all", query = "", lastTxId = null, detailId = null, busy = false, currentUser = null;
var LOG_LIMIT = 100;
function supplierOf(book) { return suppliers.find(function (s) { return s.id === book.supplier_id; }) || null; }

// ---------- 서버와 주고받기 ----------
function need(res) { if (res.error) throw res.error; return res.data; }
function errText(e) {
  var m = (e && e.message) || String(e);
  if (/STOCK_NEGATIVE/.test(m)) return "재고보다 많이 출고할 수 없습니다. 다른 사람이 먼저 기록했을 수 있으니 재고를 다시 확인해 주세요.";
  if (/duplicate key|already exists/i.test(m)) return "같은 이름이 이미 등록되어 있습니다. 이름을 확인해 주세요.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로고침을 눌러 주세요.";
  if (/does not exist|schema cache/i.test(m)) return "데이터베이스 표를 찾지 못했습니다. Supabase에서 schema.sql을 실행했는지 확인해 주세요. (" + m + ")";
  return "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요. (" + m + ")";
}
function showErr(text) {
  $("app-err").textContent = text;
  $("app-err").hidden = !text;
  if (text) $("app-err").scrollIntoView({ block: "center" });
}
async function save(task) {
  if (busy) return;
  busy = true;
  showErr("");
  document.body.classList.add("busy");
  try { await task(); }
  catch (e) {
    console.error(e);
    showErr(errText(e));
    if (task !== loadAll) { try { await loadAll(); } catch (e2) { console.error(e2); } }
  }
  finally { busy = false; document.body.classList.remove("busy"); }
}
async function loadAll() {
  var r = await Promise.all([
    db.from("suppliers").select("*").order("name"),
    db.from("books").select("*").order("title"),
    db.from("book_stock").select("*"),
    db.from("transactions").select("*").order("date", { ascending: false }).order("id", { ascending: false }).limit(LOG_LIMIT)
  ]);
  suppliers = need(r[0]); books = need(r[1]);
  stockMap = {};
  need(r[2]).forEach(function (s) { stockMap[s.book_id] = { in: Number(s.total_in) || 0, out: Number(s.total_out) || 0 }; });
  txs = need(r[3]);
  renderSupSelect();
  render();
  if ($("detail").open) { renderDetail(); loadDetailTx(detailId); }
  if ($("sup-dlg").open) renderSup();
}
async function loadDetailTx(id) {
  try {
    var rows = need(await db.from("transactions").select("*").eq("book_id", id).order("date", { ascending: false }).order("id", { ascending: false }).limit(200));
    if (detailId !== id) return;
    detailTx = rows;
    if ($("detail").open) renderDetail();
  } catch (e) { console.error(e); }
}

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function fmt(n) { return n.toLocaleString("ko-KR"); }
function today() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function totals(bookId) {
  var s = stockMap[bookId] || { in: 0, out: 0 };
  return { in: s.in, out: s.out, stock: s.in - s.out };
}
function statusOf(book, stock) {
  if (stock <= 0) return { key: "none", label: "품절" };
  if (stock <= book.min_stock) return { key: "low", label: "부족" };
  return { key: "ok", label: "정상" };
}
function selectedBookId() { return Number($("f-book").value); }
function selectedType() { return $("type-out").checked ? "out" : "in"; }

function renderSummary(view) {
  var total = 0, low = 0, none = 0;
  view.forEach(function (v) {
    total += v.t.stock;
    if (v.s.key === "low") low++;
    if (v.s.key === "none") none++;
  });
  $("s-books").textContent = fmt(books.length);
  $("s-total").textContent = fmt(total);
  $("s-low").textContent = fmt(low);
  $("s-none").textContent = fmt(none);
  $("t-low").classList.toggle("caution", low > 0);
  $("t-none").classList.toggle("alert", none > 0);
}

function renderTable(view) {
  var max = Math.max.apply(null, view.map(function (v) { return v.t.stock; }).concat([1]));
  var sel = selectedBookId();
  var sp;
  var q = query.trim().toLowerCase();
  var shown = view.filter(function (v) {
    if (filter === "attn" && v.s.key === "ok") return false;
    sp = supplierOf(v.b);
    if (q && (v.b.title + " " + v.b.category + " " + (sp ? sp.name : "")).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  $("rows").innerHTML = shown.map(function (v) {
    var pct = Math.max(0, Math.round(v.t.stock / max * 100));
    return '<tr class="' + (v.b.id === sel ? "sel" : "") + '">' +
      '<td class="title"><button type="button" class="linkbtn" data-detail="' + v.b.id + '">' + esc(v.b.title) + '</button><small>' + esc(v.b.category || "미분류") + '</small></td>' +
      '<td class="sup" data-label="주문처">' + esc(supplierOf(v.b) ? supplierOf(v.b).name : "미지정") + '</td>' +
      '<td class="r c-stock"><div class="stock"><span class="bar ' + v.s.key + '"><i style="width:' + pct + '%"></i></span><b>' + fmt(v.t.stock) + '</b></div></td>' +
      '<td class="c-status"><span class="pill ' + v.s.key + '">' + v.s.label + '</span></td>' +
      '<td class="r c-btns"><div class="rowbtns">' +
        '<button type="button" class="mini" data-book="' + v.b.id + '" data-type="in">+ 입고</button>' +
        '<button type="button" class="mini" data-book="' + v.b.id + '" data-type="out">− 출고</button>' +
      '</div></td></tr>';
  }).join("");
  $("no-rows").hidden = shown.length > 0;
}

function renderSelect() {
  var cur = $("f-book").value;
  $("f-book").innerHTML = books.map(function (b) {
    return '<option value="' + b.id + '">' + esc(b.title) + ' (현재 ' + fmt(totals(b.id).stock) + '권)</option>';
  }).join("");
  if (cur) $("f-book").value = cur;
}

function renderPreview() {
  var book = books.find(function (b) { return b.id === selectedBookId(); });
  var type = selectedType();
  var qty = Math.floor(Number($("f-qty").value));
  var box = $("preview"), btn = $("submit");
  btn.textContent = type === "in" ? "입고 기록하기" : "출고 기록하기";
  box.className = "preview full";
  if (!book) { box.textContent = "교재를 먼저 등록해 주세요."; btn.disabled = true; return; }
  var stock = totals(book.id).stock;
  if (!qty || qty < 1) { box.textContent = "수량을 1권 이상 입력해 주세요."; btn.disabled = true; return; }
  if (type === "out" && qty > stock) {
    box.className = "preview full err";
    box.textContent = "재고가 " + fmt(stock) + "권이라 " + fmt(qty) + "권을 출고할 수 없습니다. 수량을 줄이거나 먼저 입고를 기록해 주세요.";
    btn.disabled = true; return;
  }
  var after = type === "in" ? stock + qty : stock - qty;
  box.innerHTML = "현재 <strong>" + fmt(stock) + "권</strong> → 기록 후 <strong>" + fmt(after) + "권</strong>";
  btn.disabled = false;
}

function renderLog() {
  var sorted = txs.slice().sort(function (a, b) {
    return a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1);
  });
  $("log-count").textContent = txs.length >= LOG_LIMIT ? "최근 " + fmt(LOG_LIMIT) + "건" : "총 " + fmt(txs.length) + "건";
  $("log").innerHTML = sorted.map(function (x) {
    var b = books.find(function (k) { return k.id === x.book_id; });
    return '<li class="' + (x.id === lastTxId ? "flash" : "") + '">' +
      '<span class="pill ' + x.type + '">' + (x.type === "in" ? "입고" : "출고") + '</span>' +
      '<span class="what">' + esc(b ? b.title : "삭제된 교재") + '</span>' +
      '<span class="qty ' + x.type + '">' + (x.type === "in" ? "+" : "−") + fmt(x.quantity) + '</span>' +
      '<span class="meta">' + esc(x.date) + (x.memo ? " · " + esc(x.memo) : "") + '</span>' +
      '<button type="button" class="undo" data-undo="' + x.id + '">기록 삭제</button>' +
    '</li>';
  }).join("") || '<li><span></span><span class="meta">아직 기록이 없습니다.</span></li>';
}

function renderDetail() {
  var b = books.find(function (k) { return k.id === detailId; });
  if (!b) return;
  var t = totals(b.id), s = statusOf(b, t.stock), sp = supplierOf(b);
  $("d-title").textContent = b.title;
  $("d-sub").textContent = (b.category || "미분류") + " · 부족 기준 " + fmt(b.min_stock) + "권";
  var notice = "";
  if (s.key !== "ok") {
    notice = '<div class="notice ' + s.key + '">' + (s.key === "none" ? "품절입니다. " : "재고가 부족 기준 이하입니다. ") +
      (sp ? esc(sp.name) + "에 " + (sp.order_method ? esc(sp.order_method) + "으로 " : "") + "주문하세요." : "주문처가 지정되지 않았습니다.") + '</div>';
  }
  var supHtml = sp
    ? '<dl class="info">' +
        '<dt>업체명</dt><dd><strong>' + esc(sp.name) + '</strong></dd>' +
        '<dt>담당자</dt><dd>' + contactsHtml(sp) + '</dd>' +
        '<dt>사이트</dt><dd>' + siteHtml(sp) + '</dd>' +
        '<dt>주문 방법</dt><dd>' + esc(sp.order_method || "미입력") + '</dd>' +
        '<dt>납기</dt><dd>' + esc(sp.lead_time || "미입력") + '</dd>' +
        '<dt>메모</dt><dd>' + esc(sp.memo || "미입력") + '</dd>' +
      '</dl>'
    : '<p style="margin:0;color:var(--muted);font-size:14px">주문처가 지정되지 않았습니다.</p>';
  var mine = detailTx || [];
  var logHtml = mine.map(function (x) {
    return '<li><span class="pill ' + x.type + '">' + (x.type === "in" ? "입고" : "출고") + '</span>' +
      '<span class="meta">' + esc(x.date) + (x.memo ? " · " + esc(x.memo) : "") + '</span>' +
      '<span class="num" style="font-weight:600;color:var(--' + x.type + ')">' + (x.type === "in" ? "+" : "−") + fmt(x.quantity) + '</span></li>';
  }).join("") || '<li><span></span><span class="meta">' + (detailTx ? "아직 기록이 없습니다." : "불러오는 중입니다.") + '</span><span></span></li>';
  $("d-body").innerHTML =
    '<div class="d-stats">' +
      '<div class="d-stat now"><span>현재 재고</span><b>' + fmt(t.stock) + '권</b><span class="pill ' + s.key + '">' + s.label + '</span></div>' +
      '<div class="d-stat"><span>누적 입고</span><b>' + fmt(t.in) + '</b></div>' +
      '<div class="d-stat"><span>누적 출고</span><b>' + fmt(t.out) + '</b></div>' +
    '</div>' +
    '<div class="d-sec"><h3>주문처</h3>' + notice + supHtml +
      (sp && incomplete(sp) ? '<p class="help" style="margin-top:8px">이 업체의 연락처, 사이트, 주문 방법이 아직 입력되지 않았습니다. <button type="button" class="linkbtn" data-editsup="' + sp.id + '">업체 정보 입력</button></p>' : '') +
      '<div class="field" style="margin-top:12px"><label for="d-sup" style="font-size:13px;color:var(--muted)">주문처 변경</label><select id="d-sup">' +
        '<option value="">미지정</option>' + suppliers.map(function (x) { return '<option value="' + x.id + '"' + (sp && sp.id === x.id ? " selected" : "") + '>' + esc(x.name) + '</option>'; }).join("") +
      '</select></div></div>' +
    '<div class="d-sec"><h3>이 교재의 입출고' + (detailTx ? ' ' + fmt(mine.length) + '건' : '') + '</h3><ul class="d-log">' + logHtml + '</ul></div>' +
    '<div class="d-actions"><button type="button" class="go-in" data-go="in">입고 기록하기</button><button type="button" data-go="out">출고 기록하기</button></div>';
}
function openDlg(id) { var d = $(id); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); } }
function closeDlg(id) { var d = $(id); if (!d.open) return; if (d.close) d.close(); else d.removeAttribute("open"); }
function openDetail(id) { detailId = id; detailTx = null; renderDetail(); openDlg("detail"); loadDetailTx(id); }
function closeDetail() { closeDlg("detail"); }

// 요약 칸을 눌렀을 때의 교재 목록
var LISTS = {
  all:   { title: "등록 교재", pick: function () { return true; } },
  stock: { title: "전체 재고", pick: function () { return true; } },
  low:   { title: "재고 부족 교재", pick: function (v) { return v.s.key === "low"; } },
  none:  { title: "품절 교재", pick: function (v) { return v.s.key === "none"; } }
};
function openList(kind) {
  var def = LISTS[kind];
  var view = books.map(function (b) { var t = totals(b.id); return { b: b, t: t, s: statusOf(b, t.stock) }; }).filter(def.pick);
  if (kind === "stock") view.sort(function (a, c) { return c.t.stock - a.t.stock; });
  else view.sort(function (a, c) { return a.b.title.localeCompare(c.b.title, "ko"); });
  var sum = view.reduce(function (n, v) { return n + v.t.stock; }, 0);
  $("list-title").textContent = def.title;
  $("list-sub").textContent = kind === "stock"
    ? "모두 " + fmt(sum) + "권 · 재고가 많은 순서"
    : fmt(view.length) + "종 · 교재를 누르면 상세 정보가 열립니다";
  $("list-body").innerHTML = view.map(function (v) {
    var sp = supplierOf(v.b);
    return '<li><button type="button" data-detail="' + v.b.id + '">' +
      '<span class="nm">' + esc(v.b.title) + '<small>' + esc(v.b.category || "미분류") + ' · ' + esc(sp ? sp.name : "주문처 미지정") + '</small></span>' +
      '<span class="q">' + fmt(v.t.stock) + '권</span>' +
      '<span class="pill ' + v.s.key + '">' + v.s.label + '</span></button></li>';
  }).join("") || '<li style="padding:18px 12px;color:var(--muted);text-align:center">해당하는 교재가 없습니다.</li>';
  openDlg("list-dlg");
}
function renderSupSelect() {
  $("a-sup").innerHTML = '<option value="">미지정</option>' + suppliers.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join("");
  $("sup-names").textContent = suppliers.length ? suppliers.map(function (x) { return x.name; }).join(", ") : "아직 등록된 업체가 없습니다";
  renderSupBox();
}
function renderSupBox() {}
function contactsOf(sp) {
  return Array.isArray(sp.contacts) ? sp.contacts.filter(function (c) { return c && (c.name || c.phone); }) : [];
}
// 사이트 주소: http/https만 받아들이고, 앞에 https://가 없으면 붙인다
function siteUrl(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    var u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.indexOf(".") !== -1 ? u.href : "";
  } catch (e) { return ""; }
}
function contactsHtml(sp) {
  var list = contactsOf(sp);
  if (!list.length) return "미입력";
  return list.map(function (c) {
    return esc(c.name || "이름 없음") + (c.phone ? ' · <a class="num" href="tel:' + esc(c.phone.replace(/[^0-9+]/g, "")) + '">' + esc(c.phone) + '</a>' : '');
  }).join("<br>");
}
function siteHtml(sp) {
  var u = siteUrl(sp.website);
  return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(sp.website) + '</a>' : "미입력";
}
function incomplete(sp) { return !contactsOf(sp).some(function (c) { return c.phone; }) && !sp.order_method && !sp.website; }
function booksOf(supId) {
  return books.filter(function (b) { return (b.supplier_id || 0) === supId; }).map(function (b) {
    var t = totals(b.id);
    return { b: b, t: t, s: statusOf(b, t.stock) };
  });
}
function sayDone(text) { $("done").textContent = text; $("done").hidden = false; }
function hasTitle(title) { return books.some(function (b) { return b.title.trim().toLowerCase() === title.toLowerCase(); }); }
// 좁은 화면에서는 입출고 입력 폼을 창으로 띄운다 (같은 폼을 옮겨 쓴다)
var txHome = $("tx-form").parentNode;
function isStacked() { return !!(window.matchMedia && window.matchMedia("(max-width: 900px)").matches); }
function prefill(bookId, type) {
  $("f-book").value = String(bookId);
  $(type === "out" ? "type-out" : "type-in").checked = true;
  render();
  if (isStacked()) {
    $("tx-slot").appendChild($("tx-form"));
    openDlg("tx-dlg");
  }
  $("f-qty").focus({ preventScroll: true });
  $("f-qty").select();
}

function render() {
  var view = books.map(function (b) {
    var t = totals(b.id);
    return { b: b, t: t, s: statusOf(b, t.stock) };
  });
  renderSummary(view);
  renderSelect();
  renderTable(view);
  renderPreview();
  renderLog();
  renderVendors();
}

// 업체 관리 화면
function phoneSummary(sp) {
  var phones = contactsOf(sp).map(function (c) { return c.phone; }).filter(Boolean);
  if (!phones.length) return "미입력";
  return phones[0] + (phones.length > 1 ? " 외 " + (phones.length - 1) + "곳" : "");
}
function renderVendors() {
  var rows = suppliers.map(function (sp) { return { sp: sp, id: sp.id, list: booksOf(sp.id) }; });
  var none = booksOf(0);
  if (none.length) rows.push({ sp: null, id: 0, list: none });
  $("sup-rows").innerHTML = rows.map(function (r) {
    var need = r.list.filter(function (v) { return v.s.key !== "ok"; }).length;
    return '<tr>' +
      '<td class="title"><button type="button" class="linkbtn" data-sup="' + r.id + '">' + esc(r.sp ? r.sp.name : "주문처 미지정") + '</button>' +
        (r.sp && incomplete(r.sp) ? '<span class="tag">정보 미입력</span>' : '') + '</td>' +
      (r.sp
        ? '<td class="dim c-wide" data-label="담당자">' + esc(contactsOf(r.sp).map(function (c) { return c.name; }).filter(Boolean).join(", ") || "미입력") + '</td>' +
          '<td class="dim c-wide num" data-label="전화">' + esc(phoneSummary(r.sp)) + '</td>' +
          '<td class="dim c-wide" data-label="주문 방법">' + esc(r.sp.order_method || "미입력") + '</td>'
        : '<td class="dim c-wide" colspan="3">주문처를 지정하지 않은 교재</td>') +
      '<td class="r c-wide dim" data-label="담당 교재">' + fmt(r.list.length) + '종</td>' +
      '<td class="c-need">' + (need ? '<span class="hint">주문 필요 </span>' : '') + (need ? '<span class="pill low">' + fmt(need) + '종</span>' : '<span class="dim" style="color:var(--muted)">없음</span>') + '</td></tr>';
  }).join("") || '<tr><td colspan="6" class="empty">등록된 업체가 없습니다. 새 업체를 등록해 주세요.</td></tr>';
}

// 업체 상세 창
var supViewId = null, supNeedOnly = false, supCopyMsg = "";
function orderText(sp, need) {
  return (sp ? sp.name : "주문처 미지정") + " 주문 목록\n" + need.map(function (v) {
    return "- " + v.b.title + " (현재 " + v.t.stock + "권, 부족 기준 " + v.b.min_stock + "권)";
  }).join("\n");
}
function renderSup() {
  var sp = suppliers.find(function (x) { return x.id === supViewId; }) || null;
  var list = booksOf(supViewId);
  var need = list.filter(function (v) { return v.s.key !== "ok"; });
  var shown = supNeedOnly ? need : list;
  $("sv-title").textContent = sp ? sp.name : "주문처 미지정";
  $("sv-sub").textContent = "담당 교재 " + fmt(list.length) + "종 · 주문 필요 " + fmt(need.length) + "종";
  var info = sp
    ? '<div class="d-sec"><div class="sec-head"><h3>업체 정보</h3><button type="button" class="mini" data-editsup="' + sp.id + '">정보 수정</button></div>' +
        (incomplete(sp) ? '<div class="notice low">연락처, 사이트, 주문 방법이 아직 입력되지 않았습니다.</div>' : '') +
        '<dl class="info">' +
        '<dt>담당자</dt><dd>' + contactsHtml(sp) + '</dd>' +
        '<dt>사이트</dt><dd>' + siteHtml(sp) + '</dd>' +
        '<dt>주문 방법</dt><dd>' + esc(sp.order_method || "미입력") + '</dd>' +
        '<dt>납기</dt><dd>' + esc(sp.lead_time || "미입력") + '</dd>' +
        '<dt>메모</dt><dd>' + esc(sp.memo || "미입력") + '</dd></dl></div>'
    : '<p class="help">주문처가 지정되지 않은 교재입니다. 교재를 눌러 주문처를 지정해 주세요.</p>';
  var items = shown.map(function (v) {
    return '<li><button type="button" data-detail="' + v.b.id + '">' +
      '<span class="nm">' + esc(v.b.title) + '<small>' + esc(v.b.category || "미분류") + ' · 부족 기준 ' + fmt(v.b.min_stock) + '권</small></span>' +
      '<span class="q">' + fmt(v.t.stock) + '권</span><span class="pill ' + v.s.key + '">' + v.s.label + '</span></button></li>';
  }).join("") || '<li style="padding:16px 12px;color:var(--muted);text-align:center">' + (supNeedOnly ? "주문이 필요한 교재가 없습니다." : "담당 교재가 없습니다.") + '</li>';
  var others = books.filter(function (b) { return (b.supplier_id || 0) !== supViewId; });
  var move = sp && others.length
    ? '<details class="move"><summary>다른 교재를 이 업체로 옮기기</summary><ul class="checks">' +
        others.map(function (b) {
          var cur = supplierOf(b);
          return '<li><label><input type="checkbox" value="' + b.id + '">' + esc(b.title) + '<small>지금: ' + esc(cur ? cur.name : "미지정") + '</small></label></li>';
        }).join("") + '</ul><button type="button" class="ghost" data-move="1">선택한 교재를 이 업체로 옮기기</button></details>'
    : '';
  $("sv-body").innerHTML = info +
    '<div class="d-sec"><div class="sec-head"><h3>담당 교재</h3>' +
      '<div class="chips" role="group" aria-label="교재 필터">' +
        '<button type="button" data-need="0" aria-pressed="' + String(!supNeedOnly) + '">전체</button>' +
        '<button type="button" data-need="1" aria-pressed="' + String(supNeedOnly) + '">주문 필요만</button></div></div>' +
      '<ul class="b-list">' + items + '</ul>' +
      (need.length ? '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center"><button type="button" class="ghost" data-copy="1">주문 목록 복사</button><span class="hint" role="status">' + esc(supCopyMsg) + '</span></div>' : '') +
    '</div>' + move;
}
function openSup(id) { supViewId = id; supNeedOnly = false; supCopyMsg = ""; renderSup(); openDlg("sup-dlg"); }

// 업체 등록·수정 창
var supEditId = null, supReturn = null;
function addContactRow(c) {
  var row = document.createElement("div");
  row.className = "c-row";
  row.innerHTML = '<input type="text" class="c-name" placeholder="이름 (예: 김 대리)" aria-label="담당자 이름">' +
    '<input type="text" class="c-phone" inputmode="tel" placeholder="전화" aria-label="담당자 전화">' +
    '<button type="button" class="mini c-del" aria-label="이 담당자 지우기">지우기</button>';
  row.querySelector(".c-name").value = (c && c.name) || "";
  row.querySelector(".c-phone").value = (c && c.phone) || "";
  $("e-contacts").appendChild(row);
  return row;
}
function openSupEdit(id, returnTo) {
  supEditId = id; supReturn = returnTo || null;
  var sp = suppliers.find(function (x) { return x.id === id; });
  $("se-title").textContent = sp ? "업체 정보 수정" : "새 업체 등록";
  $("sup-save").textContent = sp ? "수정 내용 저장하기" : "업체 등록하기";
  $("e-name").value = sp ? sp.name : "";
  $("e-site").value = sp ? (sp.website || "") : "";
  $("e-contacts").innerHTML = "";
  var list = sp ? contactsOf(sp) : [];
  (list.length ? list : [{ name: "", phone: "" }]).forEach(addContactRow);
  $("e-method").value = sp ? sp.order_method : "";
  $("e-lead").value = sp ? sp.lead_time : "";
  $("e-memo").value = sp ? sp.memo : "";
  $("sup-err").hidden = true;
  openDlg("supedit-dlg");
}

// 입출고 기록
$("tx-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var bookId = selectedBookId(), type = selectedType();
  var qty = Math.floor(Number($("f-qty").value));
  if (!bookId || !qty || qty < 1) return;
  if (type === "out" && qty > totals(bookId).stock) return;
  var row = { book_id: bookId, type: type, quantity: qty, date: $("f-date").value || today(), memo: $("f-memo").value.trim() };
  var bk = books.find(function (b) { return b.id === bookId; });
  closeDlg("tx-dlg");
  save(async function () {
    var made = need(await db.from("transactions").insert(row).select().single());
    lastTxId = made.id;
    $("f-memo").value = "";
    await loadAll();
    sayDone("\u201c" + (bk ? bk.title : "") + "\u201d " + (type === "in" ? "입고 " : "출고 ") + fmt(qty) + "권을 기록했습니다. 현재 재고 " + fmt(totals(bookId).stock) + "권.");
  });
});
$("tx-dlg").addEventListener("close", function () { txHome.appendChild($("tx-form")); });
$("tx-dlg").addEventListener("click", function (e) { if (e.target === $("tx-dlg")) closeDlg("tx-dlg"); });
$("open-tx").addEventListener("click", function () { prefill(selectedBookId(), selectedType()); });
["f-book", "f-qty", "type-in", "type-out"].forEach(function (id) {
  $(id).addEventListener("input", function () { id === "f-book" ? render() : renderPreview(); });
});

// 표의 입고/출고 버튼: 폼에 교재와 구분을 채워 준다
$("rows").addEventListener("click", function (e) {
  var d = e.target.closest("button[data-detail]");
  if (d) { openDetail(Number(d.getAttribute("data-detail"))); return; }
  var btn = e.target.closest("button[data-book]");
  if (!btn) return;
  prefill(Number(btn.getAttribute("data-book")), btn.getAttribute("data-type"));
});

// 상세 창
$("d-close").addEventListener("click", closeDetail);
$("detail").addEventListener("click", function (e) {
  if (e.target === $("detail")) { closeDetail(); return; }
  var go = e.target.closest("button[data-go]");
  if (!go) return;
  var id = detailId;
  closeDetail();
  prefill(id, go.getAttribute("data-go"));
});

// 기록 삭제 (삭제하면 재고가 음수가 되는 경우는 막는다)
$("log").addEventListener("click", function (e) {
  var btn = e.target.closest("button[data-undo]");
  if (!btn) return;
  var id = Number(btn.getAttribute("data-undo"));
  var x = txs.find(function (t) { return t.id === id; });
  if (!x) return;
  if (x.type === "in" && totals(x.book_id).stock - x.quantity < 0) {
    btn.textContent = "이미 출고된 수량이라 삭제 불가";
    btn.disabled = true;
    return;
  }
  if (!btn.hasAttribute("data-armed")) {
    btn.setAttribute("data-armed", "1");
    btn.textContent = "한 번 더 누르면 삭제됩니다";
    return;
  }
  save(async function () {
    need(await db.from("transactions").delete().eq("id", id));
    lastTxId = null;
    await loadAll();
  });
});

// 필터와 검색
document.querySelectorAll(".chips button").forEach(function (b) {
  b.addEventListener("click", function () {
    filter = b.getAttribute("data-filter");
    document.querySelectorAll(".chips button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
    render();
  });
});
$("q").addEventListener("input", function () { query = $("q").value; render(); });

// 요약 칸과 목록 창
document.querySelectorAll("button.tile").forEach(function (t) {
  t.addEventListener("click", function () { openList(t.getAttribute("data-list")); });
});
$("list-body").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-detail]");
  if (!b) return;
  closeDlg("list-dlg");
  openDetail(Number(b.getAttribute("data-detail")));
});
document.querySelectorAll("[data-close]").forEach(function (b) {
  b.addEventListener("click", function () { closeDlg(b.getAttribute("data-close")); });
});
["add-dlg", "list-dlg"].forEach(function (id) {
  $(id).addEventListener("click", function (e) { if (e.target === $(id)) closeDlg(id); });
});

// 화면 전환
document.querySelectorAll(".views button").forEach(function (b) {
  b.addEventListener("click", function () {
    var v = b.getAttribute("data-view");
    document.querySelectorAll(".views button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
    $("view-stock").hidden = v !== "stock";
    $("view-vendors").hidden = v !== "vendors";
  });
});

// 업체 관리
$("open-sup").addEventListener("click", function () { openSupEdit(null, null); });
$("sup-rows").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-sup]");
  if (b) openSup(Number(b.getAttribute("data-sup")));
});
$("sup-dlg").addEventListener("click", function (e) {
  if (e.target === $("sup-dlg")) { closeDlg("sup-dlg"); return; }
  var t = e.target.closest("button");
  if (!t) return;
  if (t.hasAttribute("data-detail")) { closeDlg("sup-dlg"); openDetail(Number(t.getAttribute("data-detail"))); return; }
  if (t.hasAttribute("data-editsup")) { closeDlg("sup-dlg"); openSupEdit(Number(t.getAttribute("data-editsup")), "sup"); return; }
  if (t.hasAttribute("data-need")) { supNeedOnly = t.getAttribute("data-need") === "1"; renderSup(); return; }
  if (t.hasAttribute("data-move")) {
    var ids = Array.prototype.map.call($("sv-body").querySelectorAll(".checks input:checked"), function (c) { return Number(c.value); });
    if (!ids.length) return;
    save(async function () {
      need(await db.from("books").update({ supplier_id: supViewId }).in("id", ids));
      await loadAll();
    });
    return;
  }
  if (t.hasAttribute("data-copy")) {
    var sp = suppliers.find(function (x) { return x.id === supViewId; }) || null;
    var need = booksOf(supViewId).filter(function (v) { return v.s.key !== "ok"; });
    var done = function (msg) { supCopyMsg = msg; renderSup(); };
    try {
      navigator.clipboard.writeText(orderText(sp, need)).then(
        function () { done("주문 목록을 복사했습니다."); },
        function () { done("복사하지 못했습니다. 목록을 직접 적어 주세요."); });
    } catch (err) { done("복사하지 못했습니다. 목록을 직접 적어 주세요."); }
  }
});
$("supedit-dlg").addEventListener("click", function (e) { if (e.target === $("supedit-dlg")) closeDlg("supedit-dlg"); });
$("e-add-contact").addEventListener("click", function () { addContactRow(null).querySelector(".c-name").focus(); });
$("e-contacts").addEventListener("click", function (e) {
  var del = e.target.closest(".c-del");
  if (!del) return;
  del.closest(".c-row").remove();
  if (!$("e-contacts").querySelector(".c-row")) addContactRow(null);
});
$("sup-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var name = $("e-name").value.trim();
  if (!name) return;
  if (suppliers.some(function (x) { return x.name === name && x.id !== supEditId; })) {
    $("sup-err").textContent = "같은 이름의 업체가 이미 등록되어 있습니다.";
    $("sup-err").hidden = false; return;
  }
  var siteRaw = $("e-site").value.trim(), site = siteUrl(siteRaw);
  if (siteRaw && !site) {
    $("sup-err").textContent = "사이트 주소를 확인해 주세요. 예: https://www.example.com";
    $("sup-err").hidden = false; return;
  }
  var contacts = Array.prototype.map.call($("e-contacts").querySelectorAll(".c-row"), function (row) {
    return { name: row.querySelector(".c-name").value.trim(), phone: row.querySelector(".c-phone").value.trim() };
  }).filter(function (c) { return c.name || c.phone; });
  var fields = {
    name: name, website: site, contacts: contacts,
    order_method: $("e-method").value.trim(), lead_time: $("e-lead").value.trim(), memo: $("e-memo").value.trim()
  };
  var editId = supEditId, ret = supReturn;
  closeDlg("supedit-dlg");
  save(async function () {
    var sp = editId
      ? need(await db.from("suppliers").update(fields).eq("id", editId).select().single())
      : need(await db.from("suppliers").insert(fields).select().single());
    await loadAll();
    if (ret === "sup") openSup(sp.id);
    else if (ret === "detail") openDetail(detailId);
  });
});

// 교재 상세 창에서 주문처 변경, 업체 정보 입력
$("d-body").addEventListener("change", function (e) {
  if (e.target.id !== "d-sup") return;
  var b = books.find(function (k) { return k.id === detailId; });
  if (!b) return;
  var supId = Number(e.target.value) || null;
  save(async function () {
    need(await db.from("books").update({ supplier_id: supId }).eq("id", b.id));
    await loadAll();
  });
});
$("d-body").addEventListener("click", function (e) {
  var t = e.target.closest("button[data-editsup]");
  if (!t) return;
  closeDetail();
  openSupEdit(Number(t.getAttribute("data-editsup")), "detail");
});

// 새 교재 등록 창
function showTab(which) {
  var one = which === "one";
  $("tab-one").setAttribute("aria-selected", String(one));
  $("tab-xls").setAttribute("aria-selected", String(!one));
  $("pane-one").hidden = !one;
  $("pane-xls").hidden = one;
  $("pane-xls").style.display = one ? "none" : "flex";
}
$("tab-one").addEventListener("click", function () { showTab("one"); });
$("tab-xls").addEventListener("click", function () { showTab("xls"); });
$("open-add").addEventListener("click", function () {
  $("add-err").hidden = true;
  openDlg("add-dlg");
});

// 직접 입력
$("a-sup").addEventListener("change", function () { $("add-err").hidden = true; renderSupBox(); });
$("add-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var title = $("a-title").value.trim();
  if (!title) return;
  if (hasTitle(title)) {
    $("add-err").textContent = "같은 이름의 교재가 이미 등록되어 있습니다. 교재명을 확인해 주세요.";
    $("add-err").hidden = false;
    return;
  }
  var supId = Number($("a-sup").value) || null;
  var row = { title: title, category: $("a-cat").value.trim(), supplier_id: supId, min_stock: Math.max(0, Math.floor(Number($("a-min").value)) || 0) };
  var init = Math.max(0, Math.floor(Number($("a-init").value)) || 0);
  closeDlg("add-dlg");
  save(async function () {
    var made = need(await db.from("books").insert(row).select().single());
    if (init > 0) need(await db.from("transactions").insert({ book_id: made.id, type: "in", quantity: init, date: today(), memo: "처음 재고" }));
    $("a-title").value = ""; $("a-cat").value = ""; $("a-init").value = "0"; $("add-err").hidden = true;
    await loadAll();
    $("f-book").value = String(made.id);
    render();
    sayDone("\u201c" + title + "\u201d 교재를 등록했습니다.");
  });
});

// 엑셀로 한 번에 등록
var pendingSups = [];
var pending = [];
function normKey(k) { return String(k).replace(/\s+/g, "").replace(/\(.*?\)/g, ""); }
function xlsMsg(text, isErr) {
  $("xls-msg").textContent = text; $("xls-msg").hidden = !text;
  $("xls-msg").className = "msg" + (isErr ? " err" : "");
}
function resetImport(label) {
  pending = []; pendingSups = [];
  $("xls-prev-wrap").hidden = true;
  $("xls-go").disabled = true;
  $("xls-go").textContent = label || "파일을 먼저 선택해 주세요";
}
function txt(v) { return String(v == null ? "" : v).trim(); }
function nameKey(v) { return String(v).replace(/\s+/g, "").toLowerCase(); }
function readRows(rows) {
  var seen = {}, out = [];
  rows.forEach(function (raw) {
    var r = {};
    Object.keys(raw).forEach(function (k) { r[normKey(k)] = raw[k]; });
    var title = txt(r["교재명"]);
    if (!title) return;
    var minRaw = txt(r["부족기준"]), stockRaw = txt(r["현재재고"]);
    var min = minRaw === "" ? 10 : Number(minRaw), stock = stockRaw === "" ? 0 : Number(stockRaw);
    var supName = txt(r["주문처"]);
    var sp = supName ? suppliers.filter(function (x) { return nameKey(x.name) === nameKey(supName); })[0] : null;
    var row = { title: title, category: txt(r["분류"]), supplier: sp ? sp.name : supName, supId: sp ? sp.id : null, min: min, stock: stock, ok: true, note: "등록", cls: "good" };
    var key = title.toLowerCase();
    if (hasTitle(title)) { row.ok = false; row.note = "이미 등록된 교재라 건너뜀"; row.cls = "skip"; }
    else if (seen[key]) { row.ok = false; row.note = "파일 안에서 중복이라 건너뜀"; row.cls = "skip"; }
    else if (!isFinite(min) || !isFinite(stock) || min < 0 || stock < 0 || min % 1 || stock % 1) { row.ok = false; row.note = "부족 기준·현재 재고는 0 이상의 정수로 적어 주세요"; row.cls = "bad"; }
    else if (supName && !sp) { row.note = "등록 · 등록된 업체가 아니라 주문처는 미지정"; row.cls = "warn"; row.unmatched = true; }
    seen[key] = true;
    out.push(row);
  });
  return out;
}
$("xls-file").addEventListener("change", function () {
  var file = $("xls-file").files[0];
  resetImport();
  xlsMsg("");
  if (!file) return;
  if (typeof XLSX === "undefined") { xlsMsg("엑셀 읽기 기능을 불러오지 못했습니다. 인터넷 연결을 확인하고 페이지를 새로고침해 주세요.", true); return; }
  var reader = new FileReader();
  reader.onerror = function () { xlsMsg("파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.", true); };
  reader.onload = function () {
    var rowsB = [];
    try {
      var wb = XLSX.read(new Uint8Array(reader.result), { type: "array" });
      var bookSheet = wb.SheetNames.filter(function (n) { return normKey(n) === "교재목록"; })[0] || wb.SheetNames[0];
      rowsB = XLSX.utils.sheet_to_json(wb.Sheets[bookSheet], { defval: "" });
    } catch (err) {
      xlsMsg("엑셀 파일로 읽을 수 없습니다. .xlsx 형식으로 저장한 파일인지 확인해 주세요.", true); return;
    }
    if (!rowsB.length || !Object.keys(rowsB[0]).some(function (k) { return normKey(k) === "교재명"; })) {
      xlsMsg("첫 줄에 \u201c교재명\u201d 제목이 없습니다. 위 표와 같은 제목을 첫 줄에 넣어 주세요.", true); return;
    }
    pending = readRows(rowsB);
    var okN = pending.filter(function (r) { return r.ok; }).length;
    var miss = pending.filter(function (r) { return r.ok && r.unmatched; }).length;
    $("xls-prev").innerHTML = pending.map(function (r) {
      return '<tr><td>' + esc(r.title) + '</td><td>' + esc(r.supplier || "미지정") + '</td><td class="r num">' + (isFinite(r.stock) ? fmt(r.stock) : "?") + '</td><td class="' + r.cls + '">' + esc(r.note) + '</td></tr>';
    }).join("");
    $("xls-prev-wrap").hidden = pending.length === 0;
    xlsMsg("파일에서 " + fmt(pending.length) + "줄을 읽었습니다. 그중 " + fmt(okN) + "종을 등록할 수 있습니다." +
      (miss ? " " + fmt(miss) + "종은 주문처 이름이 등록된 업체와 달라 미지정으로 들어갑니다. 이름을 고쳐 다시 선택하거나, 등록한 뒤 교재 상세 창에서 지정해 주세요." : ""), miss > 0);
    $("xls-go").disabled = okN === 0;
    $("xls-go").textContent = okN ? fmt(okN) + "종 등록하기" : "등록할 수 있는 교재가 없습니다";
  };
  reader.readAsArrayBuffer(file);
});
$("xls-go").addEventListener("click", function () {
  var rows = pending.filter(function (r) { return r.ok; });
  if (!rows.length) return;
  closeDlg("add-dlg");
  save(async function () {
    var made = need(await db.from("books").insert(rows.map(function (r) {
      return { title: r.title, category: r.category, supplier_id: r.supId, min_stock: r.min };
    })).select());
    var idOf = {};
    made.forEach(function (b) { idOf[b.title] = b.id; });
    var init = rows.filter(function (r) { return r.stock > 0 && idOf[r.title]; }).map(function (r) {
      return { book_id: idOf[r.title], type: "in", quantity: r.stock, date: today(), memo: "처음 재고 (엑셀 등록)" };
    });
    if (init.length) need(await db.from("transactions").insert(init));
    $("xls-file").value = "";
    resetImport();
    xlsMsg("");
    await loadAll();
    sayDone("엑셀 파일에서 교재 " + fmt(made.length) + "종을 등록했습니다.");
  });
});

// 예시 엑셀 파일 받기: 누르는 시점에 등록된 업체 목록을 둘째 시트에 넣어 만든다
$("sample-btn").addEventListener("click", function () {
  if (typeof XLSX === "undefined") { xlsMsg("엑셀 기능을 불러오지 못했습니다. 인터넷 연결을 확인하고 페이지를 새로고침해 주세요.", true); return; }
  var n1 = suppliers[0] ? suppliers[0].name : "", n2 = suppliers[1] ? suppliers[1].name : n1;
  var wsB = XLSX.utils.aoa_to_sheet([
    ["교재명", "분류", "부족 기준", "현재 재고", "주문처"],
    ["중등 수학 3-1 개념", "수학", 15, 40, n1],
    ["영어 듣기 기초", "영어", 10, 25, n2],
    ["사회 핵심 요약", "사회", 10, 0, ""]
  ]);
  wsB["!cols"] = [{ wch: 26 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 18 }];
  var wsS = XLSX.utils.aoa_to_sheet([["업체명", "담당자", "사이트", "주문 방법", "납기", "메모"]].concat(suppliers.map(function (x) {
    return [x.name, contactsOf(x).map(function (c) { return [c.name, c.phone].filter(Boolean).join(" "); }).join(" / "), x.website || "", x.order_method, x.lead_time, x.memo];
  })));
  wsS["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 26 }];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsB, "교재 목록");
  XLSX.utils.book_append_sheet(wb, wsS, "등록된 업체 (참고용)");
  XLSX.writeFile(wb, "교재_등록_예시.xlsx");
});

// ---------- 로그인 ----------
function showScreen(name) {
  $("setup").hidden = name !== "setup";
  $("login").hidden = name !== "login";
  $("app").hidden = name !== "app";
}
function onSession(session) {
  var user = session && session.user ? session.user : null;
  if (!user) { currentUser = null; showScreen("login"); return; }
  if (user.id === currentUser) return;
  currentUser = user.id;
  $("who").textContent = user.email || "";
  showScreen("app");
  save(loadAll);
}
$("login-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var btn = $("login-btn");
  btn.disabled = true; $("login-err").hidden = true;
  db.auth.signInWithPassword({ email: $("l-email").value.trim(), password: $("l-pass").value }).then(function (res) {
    btn.disabled = false;
    if (res.error) {
      $("login-err").textContent = /Invalid login/i.test(res.error.message)
        ? "이메일 또는 비밀번호가 맞지 않습니다."
        : "로그인하지 못했습니다. 인터넷 연결을 확인해 주세요. (" + res.error.message + ")";
      $("login-err").hidden = false;
      return;
    }
    $("l-pass").value = "";
    onSession(res.data.session);
  }, function (err) {
    btn.disabled = false;
    $("login-err").textContent = "로그인하지 못했습니다. 인터넷 연결을 확인해 주세요.";
    $("login-err").hidden = false;
  });
});
$("logout").addEventListener("click", function () { db.auth.signOut(); });
$("reload").addEventListener("click", function () { save(loadAll); });
// 다른 사람이 기록한 내용이 보이도록, 화면으로 돌아올 때 다시 불러온다
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && currentUser && !busy && !document.querySelector("dialog[open]")) save(loadAll);
});

$("f-date").value = today();
if (!db) {
  showScreen("setup");
} else {
  db.auth.onAuthStateChange(function (event, session) { setTimeout(function () { onSession(session); }, 0); });
  db.auth.getSession().then(function (r) { onSession(r.data.session); });
}
