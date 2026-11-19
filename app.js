(function() {
  "use strict";
  var CFG = window.DG_CONFIG || {};
  var API = String(CFG.apiBase || "").replace(/\/+$/, "");
  var PATHS = CFG.paths || {};
  var LIMITS = CFG.limits || {};
  var TIER_ORDER = [ "Apex", "Mythic", "Legendary", "Epic", "Rare", "Uncommon", "Common", "Limited" ];
  var MAX_AUDIT = Number(LIMITS.maxAuditEntries) || 500;
  var TOKEN_KEY = "dg.editor.token";
  var state = {
    anchors: null,
    cards: [],
    meta: null,
    roles: {
      owner: [],
      admins: [],
      mods: []
    },
    audit: {
      entries: []
    },
    filtered: [],
    view: {
      q: "",
      tier: "all",
      sort: "value-desc",
      status: "all",
      holo: false,
      page: 1,
      size: 100
    },
    auth: {
      token: null,
      id: null,
      username: null,
      globalName: null,
      role: "viewer"
    },
    rolesRemote: null,
    rolesLoading: false,
    rolesYou: null,
    anchorsDraft: null,
    rolesDraft: null,
    busy: false
  };
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function(key) {
        var val = props[key];
        if (val == null || val === false) return;
        if (key === "class") node.className = val; else if (key === "text") node.textContent = val; else if (key === "dataset") Object.keys(val).forEach(function(k) {
          node.dataset[k] = val[k];
        }); else if (key === "on") Object.keys(val).forEach(function(ev) {
          node.addEventListener(ev, val[ev]);
        }); else if (key === "attrs") Object.keys(val).forEach(function(a) {
          if (val[a] != null) node.setAttribute(a, val[a]);
        }); else if (val === true) node.setAttribute(key, ""); else node.setAttribute(key, String(val));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kids = arguments[i];
      if (kids == null || kids === false) continue;
      if (Array.isArray(kids)) {
        kids.forEach(function(k) {
          if (k != null && k !== false) node.append(k.nodeType ? k : document.createTextNode(String(k)));
        });
      } else {
        node.append(kids.nodeType ? kids : document.createTextNode(String(kids)));
      }
    }
    return node;
  }
  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().trim();
  }
  function anchorsSorted() {
    var list = state.anchors && Array.isArray(state.anchors.anchors) ? state.anchors.anchors : [];
    return list.map(function(a) {
      return {
        rank: num(a.rank),
        value: num(a.value),
        label: a.label || ""
      };
    }).filter(function(a) {
      return a.rank != null && a.rank > 0 && a.value != null && a.value > 0;
    }).sort(function(a, b) {
      return a.rank - b.rank;
    });
  }
  function curveValue(rank) {
    var pts = anchorsSorted();
    if (!pts.length) return null;
    var r = num(rank);
    if (r == null || r < 1) return null;
    var min = num(state.anchors.curve && state.anchors.curve.min) || .001;
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
      var ones = pts.filter(function(p) {
        return Math.abs(p.value - 1) < 1e-9;
      });
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
    var labels = state.anchors && state.anchors.demand && state.anchors.demand.labels || {};
    var key = String(Math.round(d));
    if (labels[key]) return labels[key];
    return d >= 9 ? "S" : d >= 7 ? "A" : d >= 5 ? "B" : d >= 3 ? "C" : d >= 1 ? "D" : "E";
  }
  function fmtValue(v) {
    if (v == null) return "N/A";
    var n = Number(v);
    if (!Number.isFinite(n)) return "N/A";
    if (n === 0) return "0.00";
    if (n >= 100) return n.toFixed(1);
    if (n >= 10) return n.toFixed(2);
    if (n >= 1) return n.toFixed(2);
    if (n >= .1) return n.toFixed(3);
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
    return d.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }
  function timeAgo(ms) {
    var n = num(ms);
    if (!n) return "—";
    var diff = Date.now() - n;
    if (diff < 0) diff = 0;
    var mins = Math.floor(diff / 6e4);
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
    } catch (e) {
      return null;
    }
  }
  function thumbNode(url, cls) {
    var safe = safeThumb(url);
    if (!safe) return h("div", {
      class: cls + " thumb-fallback",
      text: "EXT"
    });
    var img = h("img", {
      class: cls,
      src: safe,
      alt: "",
      loading: "lazy",
      decoding: "async",
      attrs: {
        referrerpolicy: "no-referrer"
      }
    });
    img.addEventListener("error", function() {
      img.replaceWith(h("div", {
        class: cls + " thumb-fallback",
        text: "EXT"
      }));
    }, {
      once: true
    });
    return img;
  }
  function safeLink(url) {
    if (!url) return null;
    try {
      var u = new URL(String(url), location.href);
      if (u.protocol !== "https:") return null;
      var ok = [ "www.youtube.com", "youtube.com", "youtu.be", "aredl.net", "www.aredl.net" ];
      if (ok.indexOf(u.hostname) === -1) return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }
  function toast(message, kind) {
    var box = $("#toasts");
    var node = h("div", {
      class: "toast" + (kind ? " " + kind : ""),
      text: message
    });
    box.append(node);
    setTimeout(function() {
      node.classList.add("toast-out");
      setTimeout(function() {
        node.remove();
      }, 220);
    }, 4200);
  }
  function loadLocal() {
    return Promise.all([ fetchJson("data/anchors.json"), fetchJson("data/cards.json"), fetchJson("data/meta.json").catch(function() {
      return null;
    }), fetchJson("data/roles.json").catch(function() {
      return {
        owner: [],
        admins: [],
        mods: []
      };
    }), fetchJson("data/audit.json").catch(function() {
      return {
        entries: []
      };
    }) ]).then(function(res) {
      state.anchors = res[0];
      state.cards = res[1] && res[1].cards || [];
      state.meta = res[2];
      state.roles = normalizeRoles(res[3]);
      state.audit = res[4] && Array.isArray(res[4].entries) ? res[4] : {
        entries: []
      };
    });
  }
  function fetchJson(path) {
    var sep = path.indexOf("?") === -1 ? "?" : "&";
    return fetch(path + sep + "v=" + Date.now(), {
      cache: "no-store",
      credentials: "omit"
    }).then(function(r) {
      if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
      return r.json();
    });
  }
  function normalizeRoles(r) {
    r = r || {};
    function list(v) {
      return Array.isArray(v) ? v.filter(function(x) {
        return typeof x === "string" && x.trim();
      }).map(function(x) {
        return x.trim();
      }) : [];
    }
    return {
      owner: list(r.owner),
      admins: list(r.admins),
      mods: list(r.mods)
    };
  }
  function canEdit() {
    return !!state.auth.token && state.auth.role !== "viewer";
  }
  function canEditAnchors() {
    return !!state.auth.token && (state.auth.role === "owner" || state.auth.role === "admin");
  }
  function canManageRoles() {
    return !!state.auth.token && state.auth.role === "owner";
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    if (!API) return Promise.reject(new Error("Sign in is not configured."));
    var headers = {
      Accept: "application/json"
    };
    if (state.auth.token) headers["Authorization"] = "Bearer " + state.auth.token;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(3e4)
    }).then(function(res) {
      return res.text().then(function(text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {}
        if (!res.ok) {
          var err = new Error(data && data.error || "Request failed (" + res.status + ").");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }
  function loadSession() {
    if (!state.auth.token) return Promise.resolve();
    return apiFetch("/api/session").then(function(data) {
      state.auth.id = data.user.id;
      state.auth.username = data.user.username;
      state.auth.globalName = data.user.global_name || data.user.username;
      state.auth.role = data.role;
      state.rolesRemote = null;
      if (state.auth.role !== "viewer") {
        return refreshAudit();
      }
    }).catch(function(err) {
      if (err.status === 401) clearAuth();
      throw err;
    });
  }
  function clearAuth() {
    state.auth = {
      token: null,
      id: null,
      username: null,
      globalName: null,
      role: "viewer"
    };
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }
  function signOut() {
    clearAuth();
    state.anchorsDraft = null;
    state.rolesDraft = null;
    state.rolesRemote = null;
    close("drawer");
    toast("Signed out.");
    renderAll();
  }
  function startDiscordLogin() {
    if (!API) return toast("Sign in is not configured.", "error");
    location.href = API + "/auth/discord";
  }
  function handleAuthFragment() {
    var hash = location.hash || "";
    if (hash.indexOf("auth=") === -1) return false;
    var params = new URLSearchParams(hash.replace(/^#/, ""));
    var token = params.get("auth");
    if (!token) return false;
    state.auth.token = token;
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch (e) {}
    params.delete("auth");
    var rest = params.toString();
    try {
      history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : ""));
    } catch (e) {}
    return true;
  }
  function computedCard(card) {
    return {
      card,
      value: displayValue(card),
      holo: holoOf(card),
      demand: demandOf(card)
    };
  }
  function applyFilters() {
    var q = norm(state.view.q);
    var tier = state.view.tier;
    var status = state.view.status;
    var list = state.cards.filter(function(card) {
      if (tier !== "all" && String(card.tier) !== tier) return false;
      if (status === "priced" && card.confirmed === false) return false;
      if (status === "pending" && card.confirmed !== false) return false;
      if (status === "override" && card.confirmed === false) return false;
      if (status === "override" && card.valueOverride == null && card.holoOverride == null && card.demandSource !== "manual" && card.demandSource !== "sheet") return false;
      if (!q) return true;
      var hay = [ card.name, card.creator, card.verifier, card.tier, String(card.rank), (card.tags || []).join(" ") ].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var sort = state.view.sort;
    list.sort(function(a, b) {
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
    var pending = state.cards.filter(function(c) {
      return c.confirmed === false;
    }).length;
    var priced = total - pending;
    $("#statTotal").textContent = total.toLocaleString("en-US");
    $("#statPriced").textContent = priced.toLocaleString("en-US");
    $("#statPending").textContent = pending.toLocaleString("en-US");
    var unitRank = unitAnchor();
    var unitCard = state.cards.find(function(c) {
      return num(c.rank) === unitRank;
    });
    $("#statUnit").textContent = unitCard ? unitCard.name : "rank " + unitRank;

  }
  function renderChips() {
    var box = $("#tierChips");
    box.textContent = "";
    var counts = {};
    state.cards.forEach(function(c) {
      counts[c.tier] = (counts[c.tier] || 0) + 1;
    });
    var makeChip = function(key, label, count) {
      var b = h("button", {
        class: "chip",
        type: "button",
        attrs: {
          "aria-pressed": state.view.tier === key ? "true" : "false"
        },
        on: {
          click: function() {
            state.view.tier = key;
            state.view.page = 1;
            renderAll();
          }
        }
      }, label, h("span", {
        class: "count",
        text: count
      }));
      return b;
    };
    box.append(makeChip("all", "All", state.cards.length));
    TIER_ORDER.forEach(function(tier) {
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
    slice.forEach(function(card) {
      var value = shownValue(card);
      var holo = holoOf(card);
      var demand = demandOf(card);
      var tr = h("tr", {
        dataset: {
          id: card.id
        }
      });
      tr.append(h("td", {
        class: "col-rank",
        text: String(card.rank)
      }));
      var thumb = thumbNode(card.thumb, "thumb");
      var nameWrap = h("button", {
        class: "card-name card-open",
        type: "button",
        text: card.name,
        attrs: {
          "aria-label": "Open details for " + card.name
        }
      });
      var sub = h("div", {
        class: "card-sub",
        text: (card.creator && card.creator !== "-" ? card.creator : "unknown") + (card.twoPlayer ? " · 2P" : "")
      });
      tr.append(h("td", {
        class: "col-card"
      }, h("div", {
        class: "card-cell"
      }, thumb, h("div", {
        class: "card-main"
      }, nameWrap, sub))));
      tr.append(h("td", {
        class: "col-tier"
      }, h("span", {
        class: "tier " + norm(card.tier),
        text: card.tier
      })));
      var demandCell;
      if (demand == null) {
        demandCell = h("span", {
          class: "na",
          text: "N/A"
        });
      } else {
        var d = clamp(Math.round(demand), 0, 10);
        demandCell = h("div", {
          class: "demand-wrap"
        }, h("span", {
          class: "demand " + demandLabel(d).toLowerCase(),
          text: demandLabel(d)
        }), h("span", {
          class: "demand-bar d" + d,
          attrs: {
            "aria-hidden": "true"
          }
        }, h("span")));
      }
      tr.append(h("td", {
        class: "col-demand"
      }, demandCell));
      var valueCell = h("td", {
        class: "col-value num"
      }, h("span", {
        class: "value-cell"
      }, fmtValue(value), card.confirmed === false ? h("span", {
        class: "pending-pill",
        text: "pending"
      }) : null, card.officialValue != null ? h("span", {
        class: "ofv",
        text: (state.view.holo ? "holo · " : "") + "site " + fmtSite(card.officialValue)
      }) : null));
      tr.append(valueCell);
      tr.append(h("td", {
        class: "col-holo num"
      }, h("span", {
        class: "value-cell",
        text: fmtValue(holo)
      })));
      tr.append(h("td", {
        class: "col-updated",
        text: card.updatedAt ? timeAgo(card.updatedAt) : "—"
      }));
      var editCell = h("td", {
        class: "col-edit"
      });
      if (canEdit()) {
        editCell.append(h("button", {
          class: "row-edit",
          type: "button",
          title: "Edit this card",
          attrs: {
            "aria-label": "Edit " + card.name
          },
          text: "Edit"
        }));
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
    $("#pageInfo").textContent = total === 0 ? "0 cards" : state.view.page + " / " + pages + " · " + total.toLocaleString("en-US");
    $("#prevPage").disabled = state.view.page <= 1;
    $("#nextPage").disabled = state.view.page >= pages;
  }
  function renderUpdated() {
    var ms = state.meta && (state.meta.generatedAt || state.meta.syncedAt);
    $("#updated").textContent = ms ? "Updated " + timeAgo(ms) : "";
  }
  function renderAuthButton() {
    var btn = $("#authBtn");
    if (state.auth.username) {
      btn.textContent = state.auth.username + " (" + state.auth.role + ")";
      btn.onclick = function() {
        openDrawer();
      };
    } else {
      btn.textContent = "Sign in";
      btn.onclick = function() {
        openLogin();
      };
    }
  }
  function syncUrl() {
    var p = new URLSearchParams;
    if (state.view.q) p.set("q", state.view.q);
    if (state.view.tier !== "all") p.set("tier", state.view.tier);
    if (state.view.sort !== "value-desc") p.set("sort", state.view.sort);
    if (state.view.status !== "all") p.set("status", state.view.status);
    if (state.view.holo) p.set("holo", "1");
    if (state.view.page > 1) p.set("page", String(state.view.page));
    if (state.view.size !== 100) p.set("size", String(state.view.size));
    var hash = p.toString();
    try {
      history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
    } catch (e) {}
  }
  function readUrl() {
    var params = new URLSearchParams(location.hash.replace(/^#/, ""));
    var q = params.get("q") || "";
    var tier = params.get("tier") || "all";
    var sort = params.get("sort") || "value-desc";
    var status = params.get("status") || "all";
    var size = clamp(Number(params.get("size")) || 100, 100, 1e3);
    var page = Math.max(1, Number(params.get("page")) || 1);
    var validSorts = [ "value-desc", "value-asc", "rank", "demand-desc", "name", "updated" ];
    var validStatus = [ "all", "priced", "pending", "override" ];
    state.view.q = q;
    state.view.tier = tier;
    state.view.sort = validSorts.indexOf(sort) !== -1 ? sort : "value-desc";
    state.view.status = validStatus.indexOf(status) !== -1 ? status : "all";
    state.view.holo = params.get("holo") === "1";
    state.view.size = [ 100, 250, 500, 1e3 ].indexOf(size) !== -1 ? size : 100;
    state.view.page = page;
    $("#search").value = q;
    $("#sort").value = state.view.sort;
    $("#status").value = state.view.status;
    $("#holo").checked = state.view.holo;
    $("#pageSize").value = String(state.view.size);
  }
  function open(id) {
    var n = $("#" + id);
    if (n) n.hidden = false;
  }
  function close(id) {
    var n = $("#" + id);
    if (n) n.hidden = true;
  }
  function closeAllModals() {
    [ "modal", "drawer", "loginModal" ].forEach(close);
  }
  function openCard(id, editing) {
    var card = state.cards.find(function(c) {
      return c.id === id;
    });
    if (!card) return;
    renderCardModal(card, editing);
    open("modal");
  }
  function renderCardModal(card, editing) {
    var body = $("#modalBody");
    body.textContent = "";
    var head = h("div", {
      class: "cd-head"
    }, thumbNode(card.thumb, "cd-thumb"), h("div", null, h("h2", {
      id: "modalTitle",
      class: "cd-title",
      text: card.name
    }), h("div", {
      class: "cd-meta",
      text: "Rank " + card.rank + " · " + (card.creator || "unknown")
    }), h("div", {
      class: "cd-badges"
    }, h("span", {
      class: "tier " + norm(card.tier),
      text: card.tier
    }), card.twoPlayer ? h("span", {
      class: "tag",
      text: "2 Player"
    }) : null, card.confirmed === false ? h("span", {
      class: "pending-pill",
      text: "pending"
    }) : null)));
    body.append(head);
    var value = displayValue(card);
    var holo = holoOf(card);
    var normalDemand = normalDemandOf(card);
    var holoDemand = holoDemandOf(card);
    body.append(h("div", {
      class: "cd-grid"
    }, statBox("Value", fmtValue(value)), statBox("Holo", fmtValue(holo)), statBox("Demand", normalDemand == null ? "N/A" : demandLabel(normalDemand)), statBox("Holo demand", holoDemand == null ? "N/A" : demandLabel(holoDemand))));
    if (card.description) body.append(h("p", {
      class: "cd-desc",
      text: card.description
    }));
    if (card.tags && card.tags.length) {
      body.append(h("div", {
        class: "tags"
      }, card.tags.map(function(t) {
        return h("span", {
          class: "tag",
          text: t
        });
      })));
    }
    if (card.note) body.append(h("p", {
      class: "cd-desc",
      text: "Note: " + card.note
    }));
    var links = h("div", {
      class: "cd-actions"
    });
    var video = safeLink(card.video);
    if (video) links.append(h("a", {
      class: "btn btn-ghost",
      href: video,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Video"
    }));
    var aredl = safeLink(card.aredlUrl);
    if (aredl) links.append(h("a", {
      class: "btn btn-ghost",
      href: aredl,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "AREDL"
    }));
    if (canEdit() && !editing) {
      links.append(h("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Edit",
        on: {
          click: function() {
            renderCardModal(card, true);
          }
        }
      }));
      var last = latestCardEdit(card.id);
      if (last) {
        links.append(h("button", {
          class: "btn btn-danger",
          type: "button",
          text: "Revert",
          on: {
            click: function(ev) {
              publishCardChange(card, last.before, ev.currentTarget, "Revert " + card.name);
            }
          }
        }));
      }
    }
    body.append(links);
    if (editing && canEdit()) {
      body.append(renderCardEditor(card));
    }
  }
  function statBox(k, v) {
    return h("div", {
      class: "cd-stat"
    }, h("div", {
      class: "k",
      text: k
    }), h("div", {
      class: "v",
      text: v
    }));
  }
  function renderCardEditor(card) {
    var form = h("div", {
      class: "panel-box"
    });
    form.append(h("h3", {
      text: "Edit"
    }));
    var valueInput = h("input", {
      type: "number",
      step: "0.001",
      min: "0",
      placeholder: "blank = use curve",
      value: card.valueOverride != null ? String(card.valueOverride) : ""
    });
    var holoInput = h("input", {
      type: "number",
      step: "0.001",
      min: "0",
      placeholder: "blank = 3x value",
      value: card.holoOverride != null ? String(card.holoOverride) : ""
    });
    var demandSel = h("select", null, h("option", {
      value: "",
      text: "N/A"
    }));
    var holoDemandSel = h("select", null, h("option", {
      value: "",
      text: "N/A"
    }));
    for (var d = 0; d <= 10; d++) {
      demandSel.append(h("option", {
        value: String(d),
        text: d + " (" + demandLabel(d) + ")"
      }));
      holoDemandSel.append(h("option", {
        value: String(d),
        text: d + " (" + demandLabel(d) + ")"
      }));
    }
    demandSel.value = card.demand == null ? "" : String(Math.round(num(card.demand)));
    holoDemandSel.value = card.holoDemand == null ? "" : String(Math.round(num(card.holoDemand)));
    var noteInput = h("textarea", {
      maxlength: "500",
      placeholder: "optional"
    });
    noteInput.value = card.note || "";
    form.append(h("div", {
      class: "form-grid"
    }, field("Value", valueInput, null), field("Holo", holoInput, null), field("Demand", demandSel, null), field("Holo demand", holoDemandSel, null), h("div", {
      class: "form-field full"
    }, h("label", {
      text: "Note"
    }), noteInput)));
    var actions = h("div", {
      class: "form-actions"
    });
    actions.append(h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Save",
      on: {
        click: function(ev) {
          var patch = {
            valueOverride: valueInput.value.trim() === "" ? null : Number(valueInput.value),
            holoOverride: holoInput.value.trim() === "" ? null : Number(holoInput.value),
            demand: demandSel.value === "" ? null : Number(demandSel.value),
            holoDemand: holoDemandSel.value === "" ? null : Number(holoDemandSel.value),
            note: noteInput.value.trim()
          };
          if (patch.valueOverride != null && (!Number.isFinite(patch.valueOverride) || patch.valueOverride < 0)) return toast("Value must be positive.", "error");
          if (patch.holoOverride != null && (!Number.isFinite(patch.holoOverride) || patch.holoOverride < 0)) return toast("Holo must be positive.", "error");
          if (patch.demand != null && (!Number.isFinite(patch.demand) || patch.demand < 0 || patch.demand > 10)) return toast("Demand 0-10.", "error");
          if (patch.holoDemand != null && (!Number.isFinite(patch.holoDemand) || patch.holoDemand < 0 || patch.holoDemand > 10)) return toast("Holo demand 0-10.", "error");
          publishCardChange(card, patch, ev.currentTarget);
        }
      }
    }));
    if (card.valueOverride != null || card.holoOverride != null || card.demandSource === "manual" || card.holoDemand != null) {
      actions.append(h("button", {
        class: "btn btn-danger",
        type: "button",
        text: "Reset",
        on: {
          click: function(ev) {
            publishCardChange(card, {
              valueOverride: null,
              holoOverride: null,
              demand: null,
              holoDemand: null,
              note: ""
            }, ev.currentTarget, "Reset " + card.name);
          }
        }
      }));
    }
    form.append(actions);
    return form;
  }
  function field(label, input, hint) {
    return h("div", {
      class: "form-field"
    }, h("label", {
      text: label
    }), input, hint ? h("span", {
      class: "hint",
      text: hint
    }) : null);
  }
  function refreshAudit() {
    if (!canEdit()) return Promise.resolve();
    return apiFetch("/api/audit").then(function(data) {
      if (data && Array.isArray(data.entries)) state.audit = data;
    }).catch(function() {});
  }
  function latestCardEdit(id) {
    var entries = state.audit && state.audit.entries || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && e.action === "card" && e.id === id && e.before) return e;
    }
    return null;
  }
  function applyLocalCardPatch(card, patch) {
    var valueChanged = patch.valueOverride !== (card.valueOverride == null ? null : card.valueOverride) || patch.holoOverride !== (card.holoOverride == null ? null : card.holoOverride);
    card.valueOverride = patch.valueOverride;
    card.holoOverride = patch.holoOverride;
    if (valueChanged) card.valueSource = patch.valueOverride != null ? "manual" : null;
    if (patch.demand !== card.demand) card.demandSource = patch.demand != null ? "manual" : null;
    if (patch.holoDemand !== card.holoDemand) card.holoDemandSource = patch.holoDemand != null ? "manual" : null;
    card.demand = patch.demand;
    card.holoDemand = patch.holoDemand;
    card.note = patch.note || "";
    card.confirmed = true;
    card.updatedAt = Date.now();
  }
  function publishCardChange(card, patch, btn, message) {
    if (!canEdit()) return toast("Sign in with Discord.", "error");
    if (state.busy) return;
    var label = btn ? btn.textContent : "Save";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }
    var body = {
      changes: [ {
        id: card.id,
        valueOverride: patch.valueOverride,
        holoOverride: patch.holoOverride,
        demand: patch.demand,
        holoDemand: patch.holoDemand,
        note: patch.note
      } ],
      message: message || "Update " + card.name
    };
    apiFetch("/api/commit", {
      method: "POST",
      body
    }).then(function() {
      applyLocalCardPatch(card, patch);
      if (state.meta) state.meta.generatedAt = Date.now();
      toast("Saved.", "ok");
      close("modal");
      applyFilters();
      renderStats();
      renderRows();
      renderPager();
      return refreshAudit().then(function() {
        if (!$("#drawer").hidden) renderDrawer();
      });
    }).catch(function(err) {
      if (err.status === 401) {
        clearAuth();
        renderAll();
        toast("Session expired.", "error");
      } else {
        toast(err.message || "Save failed.", "error");
      }
    }).then(function() {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }
  function publishAnchors(draft, btn) {
    if (!canEditAnchors()) return toast("Admins only.", "error");
    if (state.busy) return;
    var label = btn ? btn.textContent : "Save";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }
    apiFetch("/api/commit", {
      method: "POST",
      body: {
        changes: [],
        anchors: draft,
        message: "Update curve"
      }
    }).then(function() {
      state.anchors = draft;
      state.anchorsDraft = null;
      if (state.meta) state.meta.generatedAt = Date.now();
      toast("Saved.", "ok");
      renderAll();
      renderDrawer();
    }).catch(function(err) {
      toast(err.message || "Save failed.", "error");
    }).then(function() {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }
  function openDrawer() {
    renderDrawer();
    open("drawer");
    if (state.auth.token) {
      loadSession().then(function() {
        renderAuthButton();
        if (!$("#drawer").hidden) renderDrawer();
      }).catch(function() {
        renderAuthButton();
        if (!$("#drawer").hidden) renderDrawer();
      });
    }
  }
  function renderDrawer() {
    var body = $("#drawerBody");
    body.textContent = "";
    $("#drawerTitle").textContent = state.auth.role === "owner" ? "Admin panel" : "Editor panel";
    body.append(h("div", {
      class: "panel-box"
    }, h("h3", {
      text: "Session"
    }), kv("Signed in as", state.auth.username || "not signed in"), kv("Discord ID", state.auth.id || "—"), kv("Role", state.auth.role), h("div", {
      class: "form-actions"
    }, !state.auth.username ? h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Sign in with Discord",
      on: {
        click: startDiscordLogin
      }
    }) : null, state.auth.username ? h("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Sign out",
      on: {
        click: signOut
      }
    }) : null)));
    if (canManageRoles()) {
      body.append(renderRolesEditor());
    }
    if (!canEdit()) {
      var locked = state.auth.username ? "Your ID " + state.auth.id + ". Ask vxef." : "Sign in with Discord.";
      body.append(h("div", {
        class: "panel-box"
      }, h("h3", {
        text: "Locked"
      }), h("p", {
        class: "muted",
        text: locked
      })));
      return;
    }
    if (canEditAnchors()) {
      body.append(renderAnchorsEditor());
    }
    var auditBox = h("div", {
      class: "panel-box"
    });
    auditBox.append(h("h3", {
      text: "Edits"
    }));
    var entries = (state.audit.entries || []).slice(0, 60);
    if (!entries.length) {
      auditBox.append(h("p", {
        class: "muted",
        text: "No edits yet."
      }));
    } else {
      entries.forEach(function(e) {
        var line = h("div", {
          class: "audit-item"
        }, h("strong", {
          text: e.by || "unknown"
        }), " · ", e.action === "roles" ? "roles" : e.action === "anchors" ? "anchors" : e.name || e.id, " · " + timeAgo(e.at));
        auditBox.append(line);
      });
    }
    body.append(auditBox);
  }
  function kv(k, v) {
    return h("div", {
      class: "kv"
    }, h("span", {
      text: k
    }), h("strong", {
      text: v
    }));
  }
  function renderAnchorsEditor() {
    var box = h("div", {
      class: "panel-box"
    });
    box.append(h("h3", {
      text: "Anchors"
    }));
    box.append(h("p", {
      class: "muted",
      text: "Log scale between anchors."
    }));
    var draft = state.anchorsDraft || {
      schema: state.anchors.schema || 1,
      unit: state.anchors.unit,
      curve: state.anchors.curve,
      anchors: anchorsSorted(),
      demand: state.anchors.demand
    };
    state.anchorsDraft = draft;
    var rows = h("div", null);
    draft.anchors.forEach(function(a, idx) {
      rows.append(anchorRow(draft, a, idx));
    });
    var addBtn = h("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Add",
      on: {
        click: function() {
          draft.anchors.push({
            rank: 50,
            value: .5,
            label: ""
          });
          state.anchorsDraft = draft;
          renderDrawer();
        }
      }
    });
    var saveBtn = h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Save",
      on: {
        click: function(ev) {
          var clean = [];
          draft.anchors.forEach(function(a) {
            var r = Number(a.rank), v = Number(a.value);
            if (!Number.isFinite(r) || r < 1) return;
            if (!Number.isFinite(v) || v <= 0) return;
            clean.push({
              rank: Math.round(r),
              value: v,
              label: String(a.label || "").slice(0, 40)
            });
          });
          clean.sort(function(a, b) {
            return a.rank - b.rank;
          });
          var seen = {};
          for (var i = 0; i < clean.length; i++) {
            if (seen[clean[i].rank]) return toast("Duplicate rank.", "error");
            seen[clean[i].rank] = true;
          }
          if (clean.length < 2) return toast("Need two anchors.", "error");
          publishAnchors({
            schema: 1,
            unit: draft.unit || state.anchors.unit,
            curve: draft.curve || state.anchors.curve,
            anchors: clean,
            demand: draft.demand || state.anchors.demand
          }, ev.currentTarget);
        }
      }
    });
    box.append(rows, h("div", {
      class: "form-actions"
    }, addBtn, saveBtn, h("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Reload",
      on: {
        click: function() {
          state.anchorsDraft = null;
          renderDrawer();
        }
      }
    })));
    return box;
  }
  function anchorRow(draft, a, idx) {
    var rankIn = h("input", {
      type: "number",
      min: "1",
      step: "1",
      value: String(a.rank)
    });
    var valIn = h("input", {
      type: "number",
      min: "0.0001",
      step: "0.01",
      value: String(a.value)
    });
    var labelIn = h("input", {
      type: "text",
      value: a.label || "",
      placeholder: "label",
      maxlength: "40"
    });
    rankIn.addEventListener("input", function() {
      a.rank = Number(rankIn.value);
    });
    valIn.addEventListener("input", function() {
      a.value = Number(valIn.value);
    });
    labelIn.addEventListener("input", function() {
      a.label = labelIn.value;
    });
    return h("div", {
      class: "anchor-row"
    }, rankIn, valIn, labelIn, h("button", {
      class: "del",
      type: "button",
      title: "Remove",
      text: "x",
      on: {
        click: function() {
          draft.anchors.splice(idx, 1);
          state.anchorsDraft = draft;
          renderDrawer();
        }
      }
    }));
  }
  function renderRolesEditor() {
    var box = h("div", {
      class: "panel-box"
    });
    box.append(h("h3", {
      text: "Access"
    }));
    if (!state.rolesDraft) {
      if (!state.rolesLoading) {
        state.rolesLoading = true;
        apiFetch("/api/roles").then(function(data) {
          state.rolesRemote = data.roles;
          state.rolesYou = data.you;
          state.rolesDraft = {
            owner: data.roles.owner.slice(),
            admins: data.roles.admins.slice(),
            mods: data.roles.mods.slice()
          };
          state.rolesLoading = false;
          renderDrawer();
        }).catch(function(err) {
          state.rolesLoading = false;
          if (err.status === 401) {
            clearAuth();
            renderAll();
            toast("Session expired. Sign in with Discord again.", "error");
          } else {
            toast(err.message || "Could not load the access list.", "error");
          }
        });
      }
      box.append(h("p", {
        class: "muted",
        text: "Loading access list..."
      }));
      return box;
    }
    var draft = state.rolesDraft;
    box.append(h("p", {
      class: "muted",
      text: "Owner only."
    }));
    if (state.rolesYou) {
      box.append(h("p", {
        class: "muted",
        text: "Owner: @" + state.rolesYou.username
      }));
    }
    var idInput = h("input", {
      type: "text",
      placeholder: "Discord ID",
      maxlength: "20",
      autocomplete: "off",
      spellcheck: "false"
    });
    var roleSel = h("select", null, h("option", {
      value: "mod",
      text: "Mod (edit values)"
    }), h("option", {
      value: "admin",
      text: "Admin (values + curve)"
    }), h("option", {
      value: "owner",
      text: "Owner (everything)"
    }));
    function addId() {
      var id = idInput.value.trim();
      if (!/^\d{16,20}$/.test(id)) return toast("That is not a Discord user ID. Right-click a name in Discord and Copy User ID.", "error");
      [ "owner", "admins", "mods" ].forEach(function(k) {
        draft[k] = draft[k].filter(function(x) {
          return x !== id;
        });
      });
      draft[roleSel.value === "owner" ? "owner" : roleSel.value === "admin" ? "admins" : "mods"].push(id);
      renderDrawer();
    }
    box.append(h("div", {
      class: "form-actions"
    }, idInput, roleSel, h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Add",
      on: {
        click: addId
      }
    })));
    function listBlock(label, key) {
      var wrap = h("div", {
        class: "role-block"
      }, h("div", {
        class: "role-label",
        text: label
      }));
      if (!draft[key].length) wrap.append(h("span", {
        class: "muted",
        text: "none"
      }));
      draft[key].forEach(function(id) {
        wrap.append(h("span", {
          class: "role-chip"
        }, h("span", {
          text: id
        }), h("button", {
          type: "button",
          title: "Remove",
          text: "x",
          on: {
            click: function() {
              draft[key] = draft[key].filter(function(x) {
                return x !== id;
              });
              renderDrawer();
            }
          }
        })));
      });
      return wrap;
    }
    box.append(listBlock("Owners", "owner"), listBlock("Admins", "admins"), listBlock("Mods", "mods"));
    box.append(h("div", {
      class: "form-actions"
    }, h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Save",
      on: {
        click: function(ev) {
          var btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = "Saving...";
          apiFetch("/api/roles", {
            method: "PUT",
            body: draft
          }).then(function(data) {
            state.rolesRemote = data.roles;
            state.rolesDraft = null;
            state.roles = normalizeRoles(data.roles);
            toast("Access list saved.", "ok");
            renderDrawer();
          }).catch(function(err) {
            toast(err.message || "Could not save the access list.", "error");
            btn.disabled = false;
            btn.textContent = "Save";
          });
        }
      }
    }), h("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Reload",
      on: {
        click: function() {
          state.rolesDraft = null;
          state.rolesRemote = null;
          renderDrawer();
        }
      }
    })));
    return box;
  }
  function openLogin() {
    var body = $("#loginBody");
    body.textContent = "";
    body.append(h("p", {
      class: "muted",
      text: "Sign in with Discord."
    }));
    if (!API) {
      body.append(h("p", {
        class: "muted",
        text: "Not configured."
      }));
      body.append(h("div", {
        class: "form-actions"
      }, h("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Close",
        on: {
          click: function() {
            close("loginModal");
          }
        }
      })));
      open("loginModal");
      return;
    }
    var status = h("p", {
      class: "muted",
      text: ""
    });
    body.append(h("div", {
      class: "form-actions"
    }, h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Sign in with Discord",
      on: {
        click: function() {
          status.textContent = "Redirecting to Discord...";
          startDiscordLogin();
        }
      }
    }), h("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Cancel",
      on: {
        click: function() {
          close("loginModal");
        }
      }
    })));
    body.append(status);
    open("loginModal");
  }
  function bind() {
    var debounced = function() {
      var t;
      return function(fn) {
        clearTimeout(t);
        t = setTimeout(fn, 160);
      };
    }();
    $("#search").addEventListener("input", function(e) {
      var v = e.target.value;
      debounced(function() {
        state.view.q = v;
        state.view.page = 1;
        renderAll();
      });
    });
    $("#sort").addEventListener("change", function(e) {
      state.view.sort = e.target.value;
      state.view.page = 1;
      renderAll();
    });
    $("#status").addEventListener("change", function(e) {
      state.view.status = e.target.value;
      state.view.page = 1;
      renderAll();
    });
    $("#holo").addEventListener("change", function(e) {
      state.view.holo = e.target.checked;
      renderAll();
    });
    $("#pageSize").addEventListener("change", function(e) {
      state.view.size = Number(e.target.value);
      state.view.page = 1;
      renderAll();
    });
    $("#prevPage").addEventListener("click", function() {
      if (state.view.page > 1) {
        state.view.page--;
        renderAll();
      }
    });
    $("#nextPage").addEventListener("click", function() {
      var pages = Math.max(1, Math.ceil(state.filtered.length / state.view.size));
      if (state.view.page < pages) {
        state.view.page++;
        renderAll();
      }
    });
    $("#clearFilters").addEventListener("click", function() {
      state.view = {
        q: "",
        tier: "all",
        sort: "value-desc",
        status: "all",
        holo: false,
        page: 1,
        size: 100
      };
      $("#search").value = "";
      $("#sort").value = "value-desc";
      $("#status").value = "all";
      $("#holo").checked = false;
      $("#pageSize").value = "100";
      renderAll();
    });
    $("#vbody").addEventListener("click", function(e) {
      var tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      if (e.target.closest(".row-edit")) {
        openCard(tr.dataset.id, true);
        return;
      }
      openCard(tr.dataset.id, false);
    });
    document.addEventListener("click", function(e) {
      var closer = e.target.closest("[data-close]");
      if (closer) close(closer.dataset.close);
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") closeAllModals();
    });
  }
  function boot() {
    bind();
    var justSignedIn = handleAuthFragment();
    readUrl();
    loadLocal().then(function() {
      renderAll();
      var saved = null;
      try {
        saved = sessionStorage.getItem(TOKEN_KEY);
      } catch (e) {}
      if (!state.auth.token && saved) state.auth.token = saved;
      if (!state.auth.token) return;
      loadSession().then(function() {
        renderAll();
        if (justSignedIn) {
          if (state.auth.role === "viewer") {
            toast("Signed in as " + state.auth.username + ", but you are not on the editor list. Send your Discord ID to vxef.", "error");
          } else {
            toast("Signed in as " + state.auth.username + " (" + state.auth.role + ").", "ok");
          }
          openDrawer();
        }
      }).catch(function(err) {
        clearAuth();
        renderAll();
        if (justSignedIn) toast(err.message || "Discord session expired. Sign in again.", "error");
      });
    }).catch(function(err) {
      toast("Could not load values: " + err.message, "error");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
