(function () {
  "use strict";

  var CFG = window.DG_CONFIG || {};
  var REPO = CFG.repo || {};
  var PATHS = CFG.paths || {};
  var LIMITS = CFG.limits || {};
  var TIER_ORDER = ["Apex", "Mythic", "Legendary", "Epic", "Rare", "Uncommon", "Common", "Limited"];
  var MAX_AUDIT = Number(LIMITS.maxAuditEntries) || 500;
  var TOKEN_KEY = "dg.editor.token";

  var state = {
    anchors: null,
    cards: [],
    meta: null,
    roles: { owner: [], admins: [], mods: [] },
    audit: { entries: [] },
    filtered: [],
    view: { q: "", tier: "all", sort: "value-desc", status: "all", holo: false, page: 1, size: 100 },
    auth: { token: null, login: null, role: "viewer", canPush: false },
    patches: new Map(),
    anchorsDraft: null,
    rolesDraft: null,
    busy: false
  };

  function $(sel, root) { return (root || document).querySelector(sel); }

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var val = props[key];
        if (val == null || val === false) return;
        if (key === "class") node.className = val;
        else if (key === "text") node.textContent = val;
        else if (key === "dataset") Object.keys(val).forEach(function (k) { node.dataset[k] = val[k]; });
        else if (key === "on") Object.keys(val).forEach(function (ev) { node.addEventListener(ev, val[ev]); });
        else if (key === "attrs") Object.keys(val).forEach(function (a) { if (val[a] != null) node.setAttribute(a, val[a]); });
        else if (val === true) node.setAttribute(key, "");
        else node.setAttribute(key, String(val));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kids = arguments[i];
      if (kids == null || kids === false) continue;
      if (Array.isArray(kids)) {
        kids.forEach(function (k) { if (k != null && k !== false) node.append(k.nodeType ? k : document.createTextNode(String(k))); });
      } else {
        node.append(kids.nodeType ? kids : document.createTextNode(String(kids)));
      }
    }
    return node;
  }

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function norm(s) { return String(s == null ? "" : s).toLowerCase().trim(); }

  // ---------- curve ----------

  function anchorsSorted() {
    var list = (state.anchors && Array.isArray(state.anchors.anchors)) ? state.anchors.anchors : [];
    return list
      .map(function (a) { return { rank: num(a.rank), value: num(a.value), label: a.label || "" }; })
      .filter(function (a) { return a.rank != null && a.rank > 0 && a.value != null && a.value > 0; })
      .sort(function (a, b) { return a.rank - b.rank; });
  }

  function curveValue(rank) {
    var pts = anchorsSorted();
    if (!pts.length) return null;
    var r = num(rank);
    if (r == null || r < 1) return null;
    var min = num(state.anchors.curve && state.anchors.curve.min) || 0.001;
    var v = interpolate(pts, r);
    if (v == null) return null;
    return Math.max(min, v);
  }

  function interpolate(pts, r) {
    if (r <= pts[0].rank) return pts[0].value;
    for (var i = 0; i < pts.length; i++) {
      if (r === pts[i].rank) return pts[i].value;
      if (i < pts.length - 1 && r < pts[i + 1].rank) {
        var t = (Math.log(r) - Math.log(pts[i].rank)) / (Math.log(pts[i + 1].rank) - Math.log(pts[i].rank));
        return Math.exp(Math.log(pts[i].value) + t * (Math.log(pts[i + 1].value) - Math.log(pts[i].value)));
      }
    }
    var a = pts[pts.length - 2];
    var b = pts[pts.length - 1];
    var slope = (Math.log(b.value) - Math.log(a.value)) / (Math.log(b.rank) - Math.log(a.rank));
    return Math.exp(Math.log(b.value) + slope * (Math.log(r) - Math.log(b.rank)));
  }

  function unitAnchor() {
    var pts = anchorsSorted();
    var unitRank = num(state.anchors && state.anchors.unit && state.anchors.unit.rank);
    if (unitRank == null && pts.length) {
      var ones = pts.filter(function (p) { return Math.abs(p.value - 1) < 1e-9; });
      if (ones.length) unitRank = ones[0].rank;
    }
    return unitRank || (pts.length ? pts[pts.length - 1].rank : 25);
  }

  function displayValue(card) {
    if (!card || card.confirmed === false) return null;
    if (card.valueOverride != null) return num(card.valueOverride);
    return curveValue(card.rank);
  }

  function holoOf(card) {
    if (!card || card.confirmed === false) return null;
    if (card.holoOverride != null) return num(card.holoOverride);
    var v = displayValue(card);
    return v == null ? null : v * 3;
  }

  function normalDemandOf(card) {
    if (!card || card.confirmed === false) return null;
    return card.demand == null ? null : num(card.demand);
  }

  function holoDemandOf(card) {
    if (!card || card.confirmed === false) return null;
    return card.holoDemand == null ? null : num(card.holoDemand);
  }

  function demandOf(card) {
    if (state.view.holo) {
      var hd = holoDemandOf(card);
      if (hd != null) return hd;
    }
    return normalDemandOf(card);
  }

  function shownValue(card) {
    return state.view.holo ? holoOf(card) : displayValue(card);
  }

  function demandLabel(d) {
    if (d == null) return "N/A";
    var labels = (state.anchors && state.anchors.demand && state.anchors.demand.labels) || {};
    var key = String(Math.round(d));
    if (labels[key]) return labels[key];
    return d >= 9 ? "S" : d >= 7 ? "A" : d >= 5 ? "B" : d >= 3 ? "C" : d >= 1 ? "D" : "E";
  }

  // ---------- formatting ----------

  function fmtValue(v) {
    if (v == null) return "N/A";
    var n = Number(v);
    if (!Number.isFinite(n)) return "N/A";
    if (n === 0) return "0.00";
    if (n >= 100) return n.toFixed(1);
    if (n >= 10) return n.toFixed(2);
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.1) return n.toFixed(3);
    return n.toFixed(4);
  }

  function fmtSite(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
  }

  function fmtDate(ms) {
    var n = num(ms);
    if (!n) return "—";
    var d = new Date(n);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
  }

  function timeAgo(ms) {
    var n = num(ms);
    if (!n) return "—";
    var diff = Date.now() - n;
    if (diff < 0) diff = 0;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + "d ago";
    return fmtDate(n);
  }

  function safeThumb(url) {
    if (!url) return null;
    try {
      var u = new URL(String(url), location.href);
      if (u.protocol !== "https:") return null;
      if (u.hostname !== "i.ytimg.com" && u.hostname !== "img.youtube.com") return null;
      return u.href;
    } catch (e) { return null; }
  }

  function thumbNode(url, cls) {
    var safe = safeThumb(url);
    if (!safe) return h("div", { class: cls + " thumb-fallback", text: "EXT" });
    var img = h("img", { class: cls, src: safe, alt: "", loading: "lazy", decoding: "async", attrs: { referrerpolicy: "no-referrer" } });
    img.addEventListener("error", function () {
      img.replaceWith(h("div", { class: cls + " thumb-fallback", text: "EXT" }));
    }, { once: true });
    return img;
  }

  function safeLink(url) {
    if (!url) return null;
    try {
      var u = new URL(String(url), location.href);
      if (u.protocol !== "https:") return null;
      var ok = ["www.youtube.com", "youtube.com", "youtu.be", "aredl.net", "www.aredl.net"];
      if (ok.indexOf(u.hostname) === -1) return null;
      return u.href;
    } catch (e) { return null; }
  }

  // ---------- toasts ----------

  function toast(message, kind) {
    var box = $("#toasts");
    var node = h("div", { class: "toast" + (kind ? " " + kind : ""), text: message });
    box.append(node);
    setTimeout(function () {
      node.classList.add("toast-out");
      setTimeout(function () { node.remove(); }, 220);
    }, 4200);
  }

  // ---------- data loading ----------

  function loadLocal() {
    return Promise.all([
      fetchJson("data/anchors.json"),
      fetchJson("data/cards.json"),
      fetchJson("data/meta.json").catch(function () { return null; }),
      fetchJson("data/roles.json").catch(function () { return { owner: [], admins: [], mods: [] }; }),
      fetchJson("data/audit.json").catch(function () { return { entries: [] }; })
    ]).then(function (res) {
      state.anchors = res[0];
      state.cards = (res[1] && res[1].cards) || [];
      state.meta = res[2];
      state.roles = normalizeRoles(res[3]);
      state.audit = res[4] && Array.isArray(res[4].entries) ? res[4] : { entries: [] };
    });
  }

  function fetchJson(path) {
    return fetch(path, { cache: "no-cache", credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
      return r.json();
    });
  }

  function normalizeRoles(r) {
    r = r || {};
    function list(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && x.trim(); }).map(function (x) { return x.trim(); }) : []; }
    return { owner: list(r.owner), admins: list(r.admins), mods: list(r.mods) };
  }

  // ---------- role / auth ----------

  function resolveRole(login) {
    if (!login) return "viewer";
    var lo = login.toLowerCase();
    if (REPO.owner && lo === String(REPO.owner).toLowerCase()) return "owner";
    if (state.roles.owner.some(function (x) { return x.toLowerCase() === lo; })) return "owner";
    if (state.roles.admins.some(function (x) { return x.toLowerCase() === lo; })) return "admin";
    if (state.roles.mods.some(function (x) { return x.toLowerCase() === lo; })) return "mod";
    return "viewer";
  }

  function canEdit() { return state.auth.canPush && state.auth.role !== "viewer"; }
  function canEditAnchors() { return state.auth.canPush && (state.auth.role === "owner" || state.auth.role === "admin"); }
  function canManageRoles() { return state.auth.canPush && state.auth.role === "owner"; }

  function ghFetch(path, opts) {
    opts = opts || {};
    var token = opts.token != null ? opts.token : state.auth.token;
    if (!token) return Promise.reject(new Error("Sign in first."));
    var url = /^https?:/.test(path) ? path : "https://api.github.com" + path;
    var headers = {
      "Accept": opts.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": "Bearer " + token
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30000)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && (data.message || data.error)) || ("GitHub HTTP " + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function verifyToken(token) {
    return ghFetch("/user", { token: token }).then(function (user) {
      return ghFetch("/repos/" + encRepo(), { token: token }).then(function (repo) {
        var push = !!(repo.permissions && repo.permissions.push);
        return { login: user.login, canPush: push, repo: repo };
      });
    });
  }

  function signInWithToken(token) {
    return verifyToken(token).then(function (info) {
      state.auth.token = token;
      state.auth.login = info.login;
      state.auth.canPush = info.canPush;
      state.auth.role = resolveRole(info.login);
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      if (!info.canPush) {
        toast("Signed in as " + info.login + ", but you do not have write access to this repo.", "error");
      } else if (state.auth.role === "viewer") {
        toast("Signed in as " + info.login + ", but you are not on the editor roles list.", "error");
      } else {
        toast("Signed in as " + info.login + " (" + state.auth.role + ").", "ok");
      }
      return refreshFromRepo().then(renderAll);
    });
  }

  function signOut() {
    state.auth = { token: null, login: null, role: "viewer", canPush: false };
    state.patches.clear();
    state.anchorsDraft = null;
    state.rolesDraft = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    close("drawer");
    toast("Signed out.");
    loadLocal().then(renderAll);
  }

  function encRepo() { return encodeURIComponent(REPO.owner) + "/" + encodeURIComponent(REPO.name); }

  function refPath() {
    return String(REPO.branch || "main").split("/").map(encodeURIComponent).join("/");
  }

  function fetchRepoText(path) {
    var url = "https://api.github.com/repos/" + encRepo() + "/contents/" +
      String(path).split("/").map(encodeURIComponent).join("/") +
      "?ref=" + encodeURIComponent(REPO.branch || "main");
    return fetch(url, {
      headers: {
        "Authorization": "Bearer " + state.auth.token,
        "Accept": "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(30000)
    }).then(function (res) {
      if (!res.ok) throw new Error("Could not read " + path + " (HTTP " + res.status + ").");
      return res.text();
    });
  }

  function refreshFromRepo() {
    if (!state.auth.token) return Promise.resolve();
    var files = [PATHS.anchors, PATHS.cards, PATHS.roles, PATHS.audit, PATHS.meta];
    return Promise.all(files.map(function (p) {
      return fetchRepoText(p).then(function (t) { return JSON.parse(t); }).catch(function () { return null; });
    })).then(function (res) {
      if (res[0]) state.anchors = res[0];
      if (res[1]) state.cards = res[1].cards || [];
      if (res[2]) state.roles = normalizeRoles(res[2]);
      if (res[3]) state.audit = Array.isArray(res[3].entries) ? res[3] : { entries: [] };
      if (res[4]) state.meta = res[4];
      var role = resolveRole(state.auth.login);
      state.auth.role = role;
      // roles may have changed; keep token, re-resolve permissions
    });
  }

  // ---------- filtering / rendering ----------

  function computedCard(card) {
    return {
      card: card,
      value: displayValue(card),
      holo: holoOf(card),
      demand: demandOf(card)
    };
  }

  function applyFilters() {
    var q = norm(state.view.q);
    var tier = state.view.tier;
    var status = state.view.status;
    var list = state.cards.filter(function (card) {
      if (tier !== "all" && String(card.tier) !== tier) return false;
      if (status === "priced" && card.confirmed === false) return false;
      if (status === "pending" && card.confirmed !== false) return false;
      if (status === "override" && card.confirmed === false) return false;
      if (status === "override" && card.valueOverride == null && card.holoOverride == null && card.demandSource !== "manual" && card.demandSource !== "sheet") return false;
      if (!q) return true;
      var hay = [card.name, card.creator, card.verifier, card.tier, String(card.rank), (card.tags || []).join(" ")].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    var sort = state.view.sort;
    list.sort(function (a, b) {
      if (sort === "rank") return num(a.rank) - num(b.rank);
      if (sort === "name") return String(a.name).localeCompare(String(b.name));
      if (sort === "updated") return (num(b.updatedAt) || 0) - (num(a.updatedAt) || 0);
      if (sort === "demand-desc") {
        var da = demandOf(a), db = demandOf(b);
        if (da == null && db == null) return (shownValue(b) || 0) - (shownValue(a) || 0);
        if (da == null) return 1;
        if (db == null) return -1;
        if (db !== da) return db - da;
        return (shownValue(b) || 0) - (shownValue(a) || 0);
      }
      var va = shownValue(a), vb = shownValue(b);
      if (va == null && vb == null) return num(a.rank) - num(b.rank);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va === vb) return num(a.rank) - num(b.rank);
      return sort === "value-asc" ? va - vb : vb - va;
    });

    state.filtered = list;
    var maxPage = Math.max(1, Math.ceil(list.length / state.view.size));
    if (state.view.page > maxPage) state.view.page = maxPage;
  }

  function renderAll() {
    applyFilters();
    renderStats();
    renderChips();
    renderRows();
    renderPager();
    renderAuthButton();
    renderUpdated();
    syncUrl();
  }

  function renderStats() {
    var total = state.cards.length;
    var pending = state.cards.filter(function (c) { return c.confirmed === false; }).length;
    var priced = total - pending;
    $("#statTotal").textContent = total.toLocaleString("en-US");
    $("#statPriced").textContent = priced.toLocaleString("en-US");
    $("#statPending").textContent = pending.toLocaleString("en-US");
    var unitRank = unitAnchor();
    var unitCard = state.cards.find(function (c) { return num(c.rank) === unitRank; });
    $("#statUnit").textContent = "1.00 = " + (unitCard ? unitCard.name : "rank " + unitRank);
    $("#listNote").textContent = "Values are positional and non-linear. 1.00 is " +
      (unitCard ? unitCard.name + " (rank " + unitRank + ")" : "rank " + unitRank) +
      ". Holo values follow the community sheet where known, otherwise 3x value.";
  }

  function renderChips() {
    var box = $("#tierChips");
    box.textContent = "";
    var counts = {};
    state.cards.forEach(function (c) { counts[c.tier] = (counts[c.tier] || 0) + 1; });
    var makeChip = function (key, label, count) {
      var b = h("button", {
        class: "chip",
        type: "button",
        attrs: { "aria-pressed": state.view.tier === key ? "true" : "false" },
        on: {
          click: function () {
            state.view.tier = key;
            state.view.page = 1;
            renderAll();
          }
        }
      }, label, h("span", { class: "count", text: count }));
      return b;
    };
    box.append(makeChip("all", "All", state.cards.length));
    TIER_ORDER.forEach(function (tier) {
      if (!counts[tier]) return;
      box.append(makeChip(tier, tier, counts[tier]));
    });
  }

  function renderRows() {
    var body = $("#vbody");
    body.textContent = "";
    var start = (state.view.page - 1) * state.view.size;
    var slice = state.filtered.slice(start, start + state.view.size);
    var frag = document.createDocumentFragment();

    var table = $("#vtable");
    if (table) table.classList.toggle("holo-mode", !!state.view.holo);

    slice.forEach(function (card) {
      var value = shownValue(card);
      var holo = holoOf(card);
      var demand = demandOf(card);
      var tr = h("tr", { dataset: { id: card.id } });

      tr.append(h("td", { class: "col-rank", text: String(card.rank) }));

      var thumb = thumbNode(card.thumb, "thumb");

      var nameWrap = h("button", { class: "card-name card-open", type: "button", text: card.name, attrs: { "aria-label": "Open details for " + card.name } });
      var sub = h("div", { class: "card-sub", text: (card.creator && card.creator !== "-" ? card.creator : "unknown") + (card.twoPlayer ? " · 2P" : "") });
      tr.append(h("td", { class: "col-card" }, h("div", { class: "card-cell" }, thumb, h("div", { class: "card-main" }, nameWrap, sub))));

      tr.append(h("td", { class: "col-tier" }, h("span", { class: "tier " + norm(card.tier), text: card.tier })));

      var demandCell;
      if (demand == null) {
        demandCell = h("span", { class: "na", text: "N/A" });
      } else {
        var d = clamp(Math.round(demand), 0, 10);
        demandCell = h("div", { class: "demand-wrap" },
          h("span", { class: "demand " + demandLabel(d).toLowerCase(), text: demandLabel(d) }),
          h("span", { class: "demand-bar d" + d, attrs: { "aria-hidden": "true" } }, h("span"))
        );
      }
      tr.append(h("td", { class: "col-demand" }, demandCell));

      var valueCell = h("td", { class: "col-value num" },
        h("span", { class: "value-cell" }, fmtValue(value),
          card.confirmed === false ? h("span", { class: "pending-pill", text: "pending" }) : null,
          card.officialValue != null ? h("span", { class: "ofv", text: (state.view.holo ? "holo · " : "") + "site " + fmtSite(card.officialValue) }) : null
        )
      );
      tr.append(valueCell);
      tr.append(h("td", { class: "col-holo num" }, h("span", { class: "value-cell", text: fmtValue(holo) })));
      tr.append(h("td", { class: "col-updated", text: card.updatedAt ? timeAgo(card.updatedAt) : "—" }));

      var editCell = h("td", { class: "col-edit" });
      if (canEdit()) {
        editCell.append(h("button", { class: "row-edit", type: "button", title: "Edit this card", attrs: { "aria-label": "Edit " + card.name }, text: "Edit" }));
      }
      tr.append(editCell);
      frag.append(tr);
    });

    body.append(frag);
    $("#empty").hidden = state.filtered.length !== 0;
    $("#vbody").hidden = state.filtered.length === 0;
  }

  function renderPager() {
    var total = state.filtered.length;
    var pages = Math.max(1, Math.ceil(total / state.view.size));
    $("#pageInfo").textContent = total === 0 ? "0 cards" :
      "Page " + state.view.page + " of " + pages + " · " + total.toLocaleString("en-US") + " cards";
    $("#prevPage").disabled = state.view.page <= 1;
    $("#nextPage").disabled = state.view.page >= pages;
  }

  function renderUpdated() {
    var ms = state.meta && (state.meta.generatedAt || state.meta.syncedAt);
    $("#updated").textContent = ms ? "Updated " + timeAgo(ms) : "";
  }

  function renderAuthButton() {
    var btn = $("#authBtn");
    if (state.auth.login) {
      btn.textContent = "Editor: " + state.auth.login + " (" + state.auth.role + ")";
      btn.onclick = function () { openDrawer(); };
    } else {
      btn.textContent = "Sign in";
      btn.onclick = function () { openLogin(); };
    }
  }

  // ---------- URL state ----------

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.view.q) p.set("q", state.view.q);
    if (state.view.tier !== "all") p.set("tier", state.view.tier);
    if (state.view.sort !== "value-desc") p.set("sort", state.view.sort);
    if (state.view.status !== "all") p.set("status", state.view.status);
    if (state.view.holo) p.set("holo", "1");
    if (state.view.page > 1) p.set("page", String(state.view.page));
    if (state.view.size !== 100) p.set("size", String(state.view.size));
    var hash = p.toString();
    try { history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search); } catch (e) {}
  }

  function readUrl() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ""));
    var q = params.get("q") || "";
    var tier = params.get("tier") || "all";
    var sort = params.get("sort") || "value-desc";
    var status = params.get("status") || "all";
    var size = clamp(Number(params.get("size")) || 100, 100, 1000);
    var page = Math.max(1, Number(params.get("page")) || 1);
    var validSorts = ["value-desc", "value-asc", "rank", "demand-desc", "name", "updated"];
    var validStatus = ["all", "priced", "pending", "override"];
    state.view.q = q;
    state.view.tier = tier;
    state.view.sort = validSorts.indexOf(sort) !== -1 ? sort : "value-desc";
    state.view.status = validStatus.indexOf(status) !== -1 ? status : "all";
    state.view.holo = params.get("holo") === "1";
    state.view.size = [100, 250, 500, 1000].indexOf(size) !== -1 ? size : 100;
    state.view.page = page;
    $("#search").value = q;
    $("#sort").value = state.view.sort;
    $("#status").value = state.view.status;
    $("#holo").checked = state.view.holo;
    $("#pageSize").value = String(state.view.size);
  }

  // ---------- modal ----------

  function open(id) { var n = $("#" + id); if (n) n.hidden = false; }
  function close(id) { var n = $("#" + id); if (n) n.hidden = true; }
  function closeAllModals() { ["modal", "drawer", "loginModal"].forEach(close); }

  function openCard(id, editing) {
    var card = state.cards.find(function (c) { return c.id === id; });
    if (!card) return;
    renderCardModal(card, editing);
    open("modal");
  }

  function renderCardModal(card, editing) {
    var body = $("#modalBody");
    body.textContent = "";

    var head = h("div", { class: "cd-head" },
      thumbNode(card.thumb, "cd-thumb"),
      h("div", null,
        h("h2", { id: "modalTitle", class: "cd-title", text: card.name }),
        h("div", { class: "cd-meta", text: "Rank " + card.rank + " · by " + (card.creator || "unknown") + (card.verifier && card.verifier !== "-" ? " · verified by " + card.verifier : "") }),
        h("div", { class: "cd-badges" },
          h("span", { class: "tier " + norm(card.tier), text: card.tier }),
          card.twoPlayer ? h("span", { class: "tag", text: "2 Player" }) : null,
          card.confirmed === false ? h("span", { class: "pending-pill", text: "pending" }) : null
        )
      )
    );
    body.append(head);

    var value = displayValue(card);
    var holo = holoOf(card);
    var demand = demandOf(card);
    var normalDemand = normalDemandOf(card);
    var holoDemand = holoDemandOf(card);
    body.append(h("div", { class: "cd-grid" },
      statBox("Value", fmtValue(value)),
      statBox("Holo", fmtValue(holo)),
      statBox(state.view.holo ? "Demand (holo)" : "Demand", demand == null ? "N/A" : demandLabel(demand) + " (" + demand + "/10)")
    ));

    var valueNote = card.valueOverride != null
      ? (card.valueSource === "sheet" ? "community sheet" : "manual override")
      : "curve at rank " + card.rank;
    body.append(h("div", { class: "cd-meta", text: "Value source: " + valueNote + " · site value " + fmtSite(card.officialValue) }));
    body.append(h("div", { class: "cd-meta", text: "Normal demand " + (normalDemand == null ? "N/A" : demandLabel(normalDemand)) + " · holo demand " + (holoDemand == null ? "N/A" : demandLabel(holoDemand)) }));

    if (card.description) body.append(h("p", { class: "cd-desc", text: card.description }));
    if (card.tags && card.tags.length) {
      body.append(h("div", { class: "tags" }, card.tags.map(function (t) { return h("span", { class: "tag", text: t }); })));
    }
    if (card.note) body.append(h("p", { class: "cd-desc", text: "Editor note: " + card.note }));

    var links = h("div", { class: "cd-actions" });
    var video = safeLink(card.video);
    if (video) links.append(h("a", { class: "btn btn-ghost", href: video, target: "_blank", rel: "noopener noreferrer", text: "Watch video" }));
    var aredl = safeLink(card.aredlUrl);
    if (aredl) links.append(h("a", { class: "btn btn-ghost", href: aredl, target: "_blank", rel: "noopener noreferrer", text: "AREDL" }));
    if (canEdit() && !editing) links.append(h("button", { class: "btn btn-primary", type: "button", text: "Edit values", on: { click: function () { renderCardModal(card, true); } } }));
    body.append(links);

    if (editing && canEdit()) {
      body.append(renderCardEditor(card));
    }
  }

  function statBox(k, v) {
    return h("div", { class: "cd-stat" }, h("div", { class: "k", text: k }), h("div", { class: "v", text: v }));
  }

  function renderCardEditor(card) {
    var form = h("div", { class: "panel-box" });
    form.append(h("h3", { text: "Edit card" }));

    var valueInput = h("input", { type: "number", step: "0.001", min: "0", placeholder: "blank = use curve", value: card.valueOverride != null ? String(card.valueOverride) : "" });
    var holoInput = h("input", { type: "number", step: "0.001", min: "0", placeholder: "blank = 3x value", value: card.holoOverride != null ? String(card.holoOverride) : "" });
    var demandSel = h("select", null, h("option", { value: "", text: "N/A" }));
    var holoDemandSel = h("select", null, h("option", { value: "", text: "N/A" }));
    for (var d = 0; d <= 10; d++) {
      demandSel.append(h("option", { value: String(d), text: d + " (" + demandLabel(d) + ")" }));
      holoDemandSel.append(h("option", { value: String(d), text: d + " (" + demandLabel(d) + ")" }));
    }
    demandSel.value = card.demand == null ? "" : String(Math.round(num(card.demand)));
    holoDemandSel.value = card.holoDemand == null ? "" : String(Math.round(num(card.holoDemand)));
    var noteInput = h("textarea", { maxlength: "500", placeholder: "Short editor note (optional)" });
    noteInput.value = card.note || "";

    form.append(h("div", { class: "form-grid" },
      field("Value override", valueInput, "Rank-25 units. Leave blank to follow the curve."),
      field("Holo override", holoInput, "Leave blank for 3x value."),
      field("Demand (normal)", demandSel, "Trade interest, separate from value."),
      field("Demand (holo)", holoDemandSel, "Falls back to normal demand when empty."),
      h("div", { class: "form-field full" },
        h("label", { text: "Note" }),
        noteInput,
        h("span", { class: "hint", text: "Shown on the card." })
      )
    ));

    var actions = h("div", { class: "form-actions" });
    actions.append(h("button", {
      class: "btn btn-primary", type: "button", text: card.confirmed === false ? "Confirm and stage" : "Stage change",
      on: {
        click: function () {
          var patch = {
            id: card.id,
            name: card.name,
            valueOverride: valueInput.value.trim() === "" ? null : Number(valueInput.value),
            holoOverride: holoInput.value.trim() === "" ? null : Number(holoInput.value),
            demand: demandSel.value === "" ? null : Number(demandSel.value),
            holoDemand: holoDemandSel.value === "" ? null : Number(holoDemandSel.value),
            note: noteInput.value.trim(),
            confirmed: true,
            was: {
              valueOverride: card.valueOverride != null ? card.valueOverride : null,
              holoOverride: card.holoOverride != null ? card.holoOverride : null,
              demand: card.demand != null ? card.demand : null,
              holoDemand: card.holoDemand != null ? card.holoDemand : null,
              valueSource: card.valueSource || null,
              holoDemandSource: card.holoDemandSource || null,
              note: card.note || "",
              confirmed: card.confirmed !== false,
              updatedAt: card.updatedAt != null ? card.updatedAt : null
            }
          };
          if (patch.valueOverride != null && (!Number.isFinite(patch.valueOverride) || patch.valueOverride < 0)) return toast("Value must be a positive number.", "error");
          if (patch.holoOverride != null && (!Number.isFinite(patch.holoOverride) || patch.holoOverride < 0)) return toast("Holo value must be a positive number.", "error");
          if (patch.demand != null && (!Number.isFinite(patch.demand) || patch.demand < 0 || patch.demand > 10)) return toast("Demand must be between 0 and 10.", "error");
          if (patch.holoDemand != null && (!Number.isFinite(patch.holoDemand) || patch.holoDemand < 0 || patch.holoDemand > 10)) return toast("Holo demand must be between 0 and 10.", "error");
          stagePatch(patch);
          close("modal");
          toast("Staged: " + card.name);
        }
      }
    }));
    if (card.valueOverride != null || card.holoOverride != null || card.demandSource === "manual" || card.holoDemand != null) {
      actions.append(h("button", {
        class: "btn btn-danger", type: "button", text: "Reset to curve",
        on: {
          click: function () {
            stagePatch({
              id: card.id, name: card.name,
              valueOverride: null, holoOverride: null, demand: null, holoDemand: null, note: "", confirmed: true,
              was: {
                valueOverride: card.valueOverride != null ? card.valueOverride : null,
                holoOverride: card.holoOverride != null ? card.holoOverride : null,
                demand: card.demand != null ? card.demand : null,
                holoDemand: card.holoDemand != null ? card.holoDemand : null,
                valueSource: card.valueSource || null,
                holoDemandSource: card.holoDemandSource || null,
                note: card.note || "",
                confirmed: card.confirmed !== false,
                updatedAt: card.updatedAt != null ? card.updatedAt : null
              }
            });
            close("modal");
            toast("Staged reset: " + card.name);
          }
        }
      }));
    }
    form.append(actions);
    return form;
  }

  function field(label, input, hint) {
    return h("div", { class: "form-field" }, h("label", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
  }

  // ---------- staging ----------

  function stagePatch(patch) {
    state.patches.set(patch.id, patch);
    // reflect immediately in the in-memory card
    var card = state.cards.find(function (c) { return c.id === patch.id; });
    if (card) {
      var valueChanged = patch.valueOverride !== (patch.was ? patch.was.valueOverride : null) ||
        patch.holoOverride !== (patch.was ? patch.was.holoOverride : null);
      card.valueOverride = patch.valueOverride;
      card.holoOverride = patch.holoOverride;
      if (valueChanged) card.valueSource = patch.valueOverride != null ? "manual" : null;
      card.demand = patch.demand;
      card.demandSource = patch.demand != null ? "manual" : null;
      card.holoDemand = patch.holoDemand;
      card.holoDemandSource = patch.holoDemand != null ? "manual" : null;
      card.note = patch.note;
      card.confirmed = true;
      card.updatedAt = Date.now();
    }
    applyFilters();
    renderStats();
    renderRows();
    renderPager();
    if (canEdit() && !$("#drawer").hidden) renderDrawer();
  }

  function patchSummary(patch) {
    var parts = [];
    var w = patch.was || {};
    if (patch.valueOverride !== w.valueOverride) parts.push("value " + (w.valueOverride == null ? "curve" : fmtValue(w.valueOverride)) + " -> " + (patch.valueOverride == null ? "curve" : fmtValue(patch.valueOverride)));
    if (patch.holoOverride !== w.holoOverride) parts.push("holo " + (patch.holoOverride == null ? "3x" : fmtValue(patch.holoOverride)));
    if (patch.demand !== w.demand) parts.push("demand " + (patch.demand == null ? "N/A" : demandLabel(patch.demand)));
    if (patch.holoDemand !== w.holoDemand) parts.push("holo demand " + (patch.holoDemand == null ? "N/A" : demandLabel(patch.holoDemand)));
    if (patch.note !== w.note) parts.push("note");
    if (w.confirmed === false) parts.push("confirmed");
    return parts.length ? parts.join(", ") : "no change";
  }

  // ---------- drawer ----------

  function openDrawer() {
    renderDrawer();
    open("drawer");
  }

  function renderDrawer() {
    var body = $("#drawerBody");
    body.textContent = "";

    body.append(h("div", { class: "panel-box" },
      h("h3", { text: "Session" }),
      kv("Signed in as", state.auth.login || "not signed in"),
      kv("Role", state.auth.role),
      kv("Push access", state.auth.canPush ? "yes" : "no"),
      h("div", { class: "form-actions" },
        !state.auth.login ? h("button", { class: "btn btn-primary", type: "button", text: "Sign in", on: { click: openLogin } }) : null,
        state.auth.login ? h("button", { class: "btn btn-danger", type: "button", text: "Sign out", on: { click: signOut } }) : null
      )
    ));

    if (!canEdit()) {
      body.append(h("div", { class: "panel-box" },
        h("h3", { text: "Editing is locked" }),
        h("p", { class: "muted", text: state.auth.login
          ? "This GitHub account either has no write access to the repository or is not on the roles list. Ask the owner to add you to data/roles.json and grant repo write access."
          : "Sign in with a GitHub account that has write access to this repository and is listed in data/roles.json." })
      ));
      return;
    }

    // pending changes
    var changes = h("div", { class: "panel-box" });
    changes.append(h("h3", { text: "Pending changes (" + state.patches.size + ")" }));
    if (state.patches.size === 0) {
      changes.append(h("p", { class: "muted", text: "Edit a card to stage a change. Nothing is sent until you commit." }));
    } else {
      var list = h("div", { class: "changes" });
      state.patches.forEach(function (patch) {
        var row = h("div", { class: "change-row" },
          h("span", null, h("strong", { text: patch.name }), " · " + patchSummary(patch)),
          h("button", { type: "button", title: "Discard", text: "x", on: { click: function () { discardPatch(patch.id); } } })
        );
        list.append(row);
      });
      changes.append(list);
      var msg = h("input", { type: "text", value: "Update values (" + state.patches.size + " cards)", maxlength: "120", placeholder: "Commit message" });
      changes.append(h("div", { class: "form-field" }, h("label", { text: "Commit message" }), msg));
      changes.append(h("div", { class: "form-actions" },
        h("button", { class: "btn btn-primary", type: "button", text: "Commit " + state.patches.size + " change(s)", on: { click: function () { commitChanges(msg.value, this); } } })
      ));
    }
    body.append(changes);

    // anchors (admin/owner)
    if (canEditAnchors()) {
      body.append(renderAnchorsEditor());
    }

    // roles (owner)
    if (canManageRoles()) {
      body.append(renderRolesEditor());
    }

    // audit
    var auditBox = h("div", { class: "panel-box" });
    auditBox.append(h("h3", { text: "Recent edits" }));
    var entries = (state.audit.entries || []).slice(0, 60);
    if (!entries.length) {
      auditBox.append(h("p", { class: "muted", text: "No edits yet." }));
    } else {
      entries.forEach(function (e) {
        var line = h("div", { class: "audit-item" },
          h("strong", { text: e.by || "unknown" }), " · ",
          (e.action === "roles" ? "updated roles" : e.action === "anchors" ? "updated curve anchors" : "edited " + (e.name || e.id)),
          " · " + timeAgo(e.at));
        auditBox.append(line);
      });
    }
    body.append(auditBox);
  }

  function kv(k, v) { return h("div", { class: "kv" }, h("span", { text: k }), h("strong", { text: v })); }

  function discardPatch(id) {
    var patch = state.patches.get(id);
    state.patches.delete(id);
    if (patch && patch.was) {
      var card = state.cards.find(function (c) { return c.id === id; });
      if (card) {
        card.valueOverride = patch.was.valueOverride;
        card.holoOverride = patch.was.holoOverride;
        card.valueSource = patch.was.valueSource != null ? patch.was.valueSource : (patch.was.valueOverride != null ? "manual" : null);
        card.demand = patch.was.demand;
        card.demandSource = patch.was.demand != null ? "manual" : null;
        card.holoDemand = patch.was.holoDemand;
        card.holoDemandSource = patch.was.holoDemandSource != null ? patch.was.holoDemandSource : (patch.was.holoDemand != null ? "manual" : null);
        card.note = patch.was.note;
        card.confirmed = patch.was.confirmed;
        card.updatedAt = patch.was.updatedAt != null ? patch.was.updatedAt : null;
      }
    }
    applyFilters();
    renderRows();
    renderStats();
    renderDrawer();
  }

  function renderAnchorsEditor() {
    var box = h("div", { class: "panel-box" });
    box.append(h("h3", { text: "Curve anchors" }));
    box.append(h("p", { class: "muted", text: "Values are log-interpolated between anchors. 1.00 is the unit rank. Add anchors to bend the curve, for example at rank 10 or rank 100." }));

    var draft = state.anchorsDraft || {
      schema: state.anchors.schema || 1,
      unit: state.anchors.unit,
      curve: state.anchors.curve,
      anchors: anchorsSorted(),
      demand: state.anchors.demand
    };
    var rows = h("div", null);
    draft.anchors.forEach(function (a, idx) {
      rows.append(anchorRow(draft, a, idx));
    });

    var addBtn = h("button", { class: "btn btn-ghost", type: "button", text: "Add anchor", on: { click: function () {
      draft.anchors.push({ rank: 50, value: 0.5, label: "" });
      state.anchorsDraft = draft;
      renderDrawer();
    } } });

    var saveBtn = h("button", { class: "btn btn-primary", type: "button", text: "Stage anchors", on: { click: function () {
      var clean = [];
      state.anchorsDraft.anchors.forEach(function (a) {
        var r = Number(a.rank), v = Number(a.value);
        if (!Number.isFinite(r) || r < 1) return;
        if (!Number.isFinite(v) || v <= 0) return;
        clean.push({ rank: Math.round(r), value: v, label: String(a.label || "").slice(0, 40) });
      });
      clean.sort(function (a, b) { return a.rank - b.rank; });
      var seen = {};
      for (var i = 0; i < clean.length; i++) {
        if (seen[clean[i].rank]) return toast("Two anchors share rank " + clean[i].rank + ".", "error");
        seen[clean[i].rank] = true;
      }
      if (clean.length < 2) return toast("Keep at least two anchors.", "error");
      state.anchorsDraft = {
        schema: 1,
        unit: state.anchorsDraft.unit || state.anchors.unit,
        curve: state.anchorsDraft.curve || state.anchors.curve,
        anchors: clean,
        demand: state.anchorsDraft.demand || state.anchors.demand
      };
      toast("Anchors staged. Commit to apply.", "ok");
      renderDrawer();
    } } });

    box.append(rows, h("div", { class: "form-actions" }, addBtn, saveBtn,
      state.anchorsDraft ? h("button", { class: "btn btn-danger", type: "button", text: "Discard", on: { click: function () { state.anchorsDraft = null; renderDrawer(); } } }) : null
    ));
    if (state.anchorsDraft) box.append(h("p", { class: "muted", text: "Anchors staged. They apply after you commit." }));
    return box;
  }

  function anchorRow(draft, a, idx) {
    var rankIn = h("input", { type: "number", min: "1", step: "1", value: String(a.rank) });
    var valIn = h("input", { type: "number", min: "0.0001", step: "0.01", value: String(a.value) });
    var labelIn = h("input", { type: "text", value: a.label || "", placeholder: "label (optional)", maxlength: "40" });
    rankIn.addEventListener("input", function () { a.rank = Number(rankIn.value); });
    valIn.addEventListener("input", function () { a.value = Number(valIn.value); });
    labelIn.addEventListener("input", function () { a.label = labelIn.value; });
    return h("div", { class: "anchor-row" }, rankIn, valIn, labelIn,
      h("button", { class: "del", type: "button", title: "Remove", text: "x", on: { click: function () {
        draft.anchors.splice(idx, 1);
        state.anchorsDraft = draft;
        renderDrawer();
      } } })
    );
  }

  function renderRolesEditor() {
    var box = h("div", { class: "panel-box" });
    box.append(h("h3", { text: "Roles (owner only)" }));
    box.append(h("p", { class: "muted", text: "GitHub logins, comma or newline separated. Owners can manage roles, admins can edit anchors, mods can edit cards. Everyone also needs repo write access." }));

    var draft = state.rolesDraft || { owner: state.roles.owner.slice(), admins: state.roles.admins.slice(), mods: state.roles.mods.slice() };
    var ownerTa = h("textarea", { placeholder: "owner logins" });
    ownerTa.value = draft.owner.join(", ");
    var adminTa = h("textarea", { placeholder: "admin logins" });
    adminTa.value = draft.admins.join(", ");
    var modTa = h("textarea", { placeholder: "mod logins" });
    modTa.value = draft.mods.join(", ");

    function parse(v) {
      return v.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean).filter(function (s, i, arr) { return arr.indexOf(s) === i; });
    }

    box.append(field("Owners", ownerTa), field("Admins", adminTa), field("Mods", modTa));
    box.append(h("div", { class: "form-actions" },
      h("button", { class: "btn btn-primary", type: "button", text: "Stage roles", on: { click: function () {
        var re = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
        var all = parse(ownerTa.value).concat(parse(adminTa.value)).concat(parse(modTa.value));
        for (var i = 0; i < all.length; i++) if (!re.test(all[i])) return toast("Invalid GitHub login: " + all[i], "error");
        state.rolesDraft = { owner: parse(ownerTa.value), admins: parse(adminTa.value), mods: parse(modTa.value) };
        toast("Roles staged. Commit to apply.", "ok");
        renderDrawer();
      } } }),
      state.rolesDraft ? h("button", { class: "btn btn-danger", type: "button", text: "Discard", on: { click: function () { state.rolesDraft = null; renderDrawer(); } } }) : null
    ));
    return box;
  }

  // ---------- serialization (must match scripts/lib.mjs) ----------

  function serializeCards(doc) {
    var rest = {};
    Object.keys(doc).forEach(function (k) { if (k !== "cards") rest[k] = doc[k]; });
    var head = JSON.stringify(rest, null, 2).replace(/\n}$/, "");
    var out = "{\n" + head.slice(2) + ",\n  \"cards\": [\n";
    out += doc.cards.map(function (c) { return "    " + JSON.stringify(c); }).join(",\n");
    out += "\n  ]\n}\n";
    return out;
  }

  function serializePretty(obj) { return JSON.stringify(obj, null, 2) + "\n"; }

  // ---------- commit ----------

  function commitChanges(message, btn) {
    if (state.patches.size === 0 && !state.anchorsDraft && !state.rolesDraft) {
      return toast("Nothing staged.", "error");
    }
    if (!canEdit()) return toast("Not allowed.", "error");
    if (state.rolesDraft && !canManageRoles()) return toast("Only owners can change roles.", "error");
    if (state.anchorsDraft && !canEditAnchors()) return toast("Only admins and owners can change anchors.", "error");
    if (state.busy) return;
    state.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = "Committing..."; }

    var by = state.auth.login;
    var now = Date.now();
    var patches = Array.from(state.patches.values());

    fetchRepoText(PATHS.cards).then(function (text) {
      var doc = JSON.parse(text);
      var cards = doc.cards || [];
      var byId = new Map(cards.map(function (c) { return [c.id, c]; }));
      var auditEntries = [];

      patches.forEach(function (p) {
        var card = byId.get(p.id);
        if (!card) return;
        var changes = {};
        if (p.valueOverride !== card.valueOverride) changes.value = { from: card.valueOverride, to: p.valueOverride };
        if (p.holoOverride !== card.holoOverride) changes.holo = { from: card.holoOverride, to: p.holoOverride };
        if (p.demand !== card.demand) changes.demand = { from: card.demand, to: p.demand };
        if (p.holoDemand !== card.holoDemand) changes.holoDemand = { from: card.holoDemand, to: p.holoDemand };
        if (p.note !== card.note) changes.note = true;
        if (card.confirmed === false) changes.confirmed = true;

        card.valueOverride = p.valueOverride;
        card.holoOverride = p.holoOverride;
        if (changes.value || changes.holo) card.valueSource = p.valueOverride != null ? "manual" : null;
        if (changes.demand) card.demandSource = p.demand == null ? null : "manual";
        if (changes.holoDemand) card.holoDemandSource = p.holoDemand == null ? null : "manual";
        card.demand = p.demand;
        card.holoDemand = p.holoDemand;
        card.note = p.note;
        card.confirmed = true;
        card.updatedAt = now;

        auditEntries.push({ at: now, by: by, action: "card", id: p.id, name: card.name, changes: changes });
      });

      doc.cards = cards;
      doc.syncedAt = doc.syncedAt || now;

      var files = {};
      files[PATHS.cards] = serializeCards(doc);

      // append audit from the freshest copy
      return fetchRepoText(PATHS.audit).then(function (t) {
        var audit = { schema: 1, entries: [] };
        try { var parsed = JSON.parse(t); if (parsed && Array.isArray(parsed.entries)) audit = parsed; } catch (e) {}
        if (state.anchorsDraft) {
          audit.entries.unshift({ at: now, by: by, action: "anchors", ranks: state.anchorsDraft.anchors.map(function (a) { return a.rank; }) });
          files[PATHS.anchors] = serializePretty(state.anchorsDraft);
        }
        if (state.rolesDraft) {
          audit.entries.unshift({ at: now, by: by, action: "roles", owner: state.rolesDraft.owner.length, admins: state.rolesDraft.admins.length, mods: state.rolesDraft.mods.length });
          files[PATHS.roles] = serializePretty({
            schema: 1,
            note: "Only these GitHub logins may edit values. The repo owner is always an owner. Granting edit access also requires GitHub write access to the repository.",
            owner: state.rolesDraft.owner,
            admins: state.rolesDraft.admins,
            mods: state.rolesDraft.mods
          });
        }
        audit.entries = audit.entries.slice(0, MAX_AUDIT);
        files[PATHS.audit] = serializePretty(audit);

        // meta
        var confirmed = cards.filter(function (c) { return c.confirmed !== false; }).length;
        var meta = {
          schema: 1,
          syncedAt: doc.syncedAt,
          generatedAt: now,
          total: cards.length,
          confirmed: confirmed,
          pending: cards.length - confirmed,
          valued: cards.filter(function (c) { return c.valueOverride != null; }).length,
          demandSet: cards.filter(function (c) { return c.demand != null; }).length,
          revision: (Number(state.meta && state.meta.revision) || 0) + 1
        };
        files[PATHS.meta] = serializePretty(meta);

        return gitCommit(files, String(message || "Update values").slice(0, 120)).then(function (sha) {
          state.meta = meta;
          state.audit = audit;
          if (state.anchorsDraft) { state.anchors = state.anchorsDraft; state.anchorsDraft = null; }
          if (state.rolesDraft) { state.roles = normalizeRoles(state.rolesDraft); state.rolesDraft = null; }
          state.patches.clear();
          toast("Committed " + sha.slice(0, 7) + ". Pages will refresh in about a minute.", "ok");
          renderAll();
          renderDrawer();
        });
      });
    }).catch(function (err) {
      toast(err.message || "Commit failed.", "error");
    }).then(function () {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Commit"; }
    });
  }

  function gitCommit(files, message) {
    var base = "/repos/" + encRepo();
    var paths = Object.keys(files);
    return ghFetch(base + "/git/ref/heads/" + refPath()).then(function (ref) {
      var parentSha = ref.object.sha;
      return ghFetch(base + "/git/commits/" + parentSha).then(function (parent) {
        var blobChain = Promise.resolve([]);
        paths.forEach(function (path) {
          blobChain = blobChain.then(function (entries) {
            return ghFetch(base + "/git/blobs", { method: "POST", body: { content: files[path], encoding: "utf-8" } })
              .then(function (blob) { entries.push({ path: path, mode: "100644", type: "blob", sha: blob.sha }); return entries; });
          });
        });
        return blobChain.then(function (entries) {
          return ghFetch(base + "/git/trees", { method: "POST", body: { base_tree: parent.tree.sha, tree: entries } });
        }).then(function (tree) {
          return ghFetch(base + "/git/commits", { method: "POST", body: { message: message, tree: tree.sha, parents: [parentSha] } });
        }).then(function (commit) {
          return ghFetch(base + "/git/refs/heads/" + refPath(), { method: "PATCH", body: { sha: commit.sha, force: false } })
            .then(function () { return commit.sha; });
        });
      });
    });
  }

  // ---------- login ----------

  function openLogin() {
    var body = $("#loginBody");
    body.textContent = "";
    body.append(h("p", { class: "muted", text: "Editors sign in with GitHub. Your account must have write access to this repository and be listed in data/roles.json. The token stays in this tab and is only sent to GitHub." }));

    var tokenInput = h("input", { type: "password", placeholder: "Fine-grained personal access token", autocomplete: "off", spellcheck: "false" });
    var status = h("p", { class: "muted", text: "" });

    body.append(h("div", { class: "form-field" },
      h("label", { text: "GitHub token (Contents: Read and write on this repo)" }),
      tokenInput,
      h("span", { class: "hint", text: "github.com/settings/tokens -> Fine-grained tokens -> this repository -> Contents: Read and write." })
    ));

    body.append(h("div", { class: "form-actions" },
      h("button", { class: "btn btn-primary", type: "button", text: "Sign in", on: { click: function () {
        var token = tokenInput.value.trim();
        if (!token) return toast("Paste a token first.", "error");
        status.textContent = "Checking...";
        signInWithToken(token).then(function () {
          close("loginModal");
        }).catch(function (err) {
          status.textContent = err.message || "Sign in failed.";
          toast(err.message || "Sign in failed.", "error");
        });
      } } }),
      h("button", { class: "btn btn-ghost", type: "button", text: "Cancel", on: { click: function () { close("loginModal"); } } })
    ));

    if (CFG.oauth && CFG.oauth.clientId) {
      body.append(h("div", { class: "form-actions" },
        h("button", { class: "btn btn-ghost", type: "button", text: "Sign in with GitHub (device flow)", on: { click: function () { deviceFlow(status); } } })
      ));
    }
    body.append(status);
    open("loginModal");
    setTimeout(function () { tokenInput.focus(); }, 40);
  }

  function deviceFlow(status) {
    var clientId = CFG.oauth.clientId;
    var scope = CFG.oauth.scope || "public_repo";
    status.textContent = "Requesting device code...";
    fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: scope })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.device_code) throw new Error(d.error_description || "Device flow unavailable.");
      status.textContent = "Open https://github.com/login/device and enter " + d.user_code + ". Waiting...";
      var link = h("a", { href: "https://github.com/login/device", target: "_blank", rel: "noopener noreferrer", text: "Open github.com/login/device" });
      status.append(" ", link);
      var interval = Math.max(5, Number(d.interval) || 5) * 1000;
      var deadline = Date.now() + (Number(d.expires_in) || 900) * 1000;
      function poll() {
        if (Date.now() > deadline) { status.textContent = "Code expired. Try again."; return; }
        fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            device_code: d.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code"
          })
        }).then(function (r) { return r.json(); }).then(function (t) {
          if (t.access_token) {
            status.textContent = "Authorized. Signing in...";
            signInWithToken(t.access_token).then(function () { close("loginModal"); }).catch(function (err) {
              status.textContent = err.message || "Sign in failed.";
            });
            return;
          }
          if (t.error === "authorization_pending") { setTimeout(poll, interval); return; }
          if (t.error === "slow_down") { interval += 5000; setTimeout(poll, interval); return; }
          if (t.error === "expired_token") { status.textContent = "Code expired. Try again."; return; }
          if (t.error === "access_denied") { status.textContent = "Access denied."; return; }
          status.textContent = t.error_description || t.error || "Device flow failed.";
        }).catch(function () {
          status.textContent = "Device flow is blocked by the browser (CORS). Use a personal access token instead.";
        });
      }
      setTimeout(poll, interval);
    }).catch(function (err) {
      status.textContent = err.message || "Device flow unavailable. Use a personal access token.";
    });
  }

  // ---------- events ----------

  function bind() {
    var debounced = (function () {
      var t;
      return function (fn) { clearTimeout(t); t = setTimeout(fn, 160); };
    })();

    $("#search").addEventListener("input", function (e) {
      var v = e.target.value;
      debounced(function () { state.view.q = v; state.view.page = 1; renderAll(); });
    });
    $("#sort").addEventListener("change", function (e) { state.view.sort = e.target.value; state.view.page = 1; renderAll(); });
    $("#status").addEventListener("change", function (e) { state.view.status = e.target.value; state.view.page = 1; renderAll(); });
    $("#holo").addEventListener("change", function (e) { state.view.holo = e.target.checked; renderAll(); });
    $("#pageSize").addEventListener("change", function (e) { state.view.size = Number(e.target.value); state.view.page = 1; renderAll(); });
    $("#prevPage").addEventListener("click", function () { if (state.view.page > 1) { state.view.page--; renderAll(); } });
    $("#nextPage").addEventListener("click", function () {
      var pages = Math.max(1, Math.ceil(state.filtered.length / state.view.size));
      if (state.view.page < pages) { state.view.page++; renderAll(); }
    });
    $("#clearFilters").addEventListener("click", function () {
      state.view = { q: "", tier: "all", sort: "value-desc", status: "all", holo: false, page: 1, size: 100 };
      $("#search").value = ""; $("#sort").value = "value-desc"; $("#status").value = "all"; $("#holo").checked = false; $("#pageSize").value = "100";
      renderAll();
    });
    $("#guideBtn").addEventListener("click", function () { document.getElementById("guide").scrollIntoView({ behavior: "smooth" }); });

    $("#vbody").addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      if (e.target.closest(".row-edit")) { openCard(tr.dataset.id, true); return; }
      openCard(tr.dataset.id, false);
    });

    document.addEventListener("click", function (e) {
      var closer = e.target.closest("[data-close]");
      if (closer) close(closer.dataset.close);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllModals();
    });
  }

  // ---------- boot ----------

  function boot() {
    bind();
    readUrl();
    loadLocal().then(function () {
      renderAll();
      var saved = null;
      try { saved = sessionStorage.getItem(TOKEN_KEY); } catch (e) {}
      if (saved) {
        verifyToken(saved).then(function (info) {
          state.auth.token = saved;
          state.auth.login = info.login;
          state.auth.canPush = info.canPush;
          state.auth.role = resolveRole(info.login);
          return refreshFromRepo();
        }).then(renderAll).catch(function () {
          try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
        });
      }
    }).catch(function (err) {
      $("#listNote").textContent = "Could not load values: " + err.message;
      toast("Could not load values: " + err.message, "error");
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
