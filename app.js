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
    proposals: null,
    proposalsLoading: false,
    anchorsDraft: null,
    rolesDraft: null,
    selected: new Set(),
    bulkInit: false,
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
  function priceLabel(s) {
    return s === "over" ? "overpriced" : s === "under" ? "underpriced" : s === "fair" ? "fair" : "";
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
      mods: list(r.mods),
      helpers: list(r.helpers),
      blocked: list(r.blocked)
    };
  }
  function canEdit() {
    return !!state.auth.token && state.auth.role !== "viewer" && state.auth.role !== "blocked";
  }
  function canEditAnchors() {
    return !!state.auth.token && (state.auth.role === "owner" || state.auth.role === "admin");
  }
  function canManageRoles() {
    return !!state.auth.token && state.auth.role === "owner";
  }
  function canApprove() {
    return !!state.auth.token && (state.auth.role === "owner" || state.auth.role === "admin");
  }
  function canPropose() {
    return !!state.auth.token && state.auth.role === "helper";
  }
  function canSuggest() {
    return !!state.auth.token && state.auth.role === "viewer";
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
      var previousRole = state.auth.role;
      state.auth.role = data.role;
      state.rolesRemote = null;
      if (previousRole !== data.role) state.proposals = null;
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
    state.proposals = null;
    state.proposalsLoading = false;
    state.selected.clear();
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
  function tierOf(card) {
    var i = TIER_ORDER.indexOf(card.tier);
    return i === -1 ? 99 : i;
  }
  function compareNullable(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (a === b) return 0;
    return dir === "asc" ? a < b ? -1 : 1 : a > b ? -1 : 1;
  }
  function sortComparator(sort) {
    return function(a, b) {
      var tie = function() {
        return (num(a.rank) || 0) - (num(b.rank) || 0) || String(a.name).localeCompare(String(b.name));
      };
      switch (sort) {
        case "rank-asc":
        case "rank":
          return (num(a.rank) || 0) - (num(b.rank) || 0) || String(a.name).localeCompare(String(b.name));
        case "rank-desc":
          return (num(b.rank) || 0) - (num(a.rank) || 0) || String(a.name).localeCompare(String(b.name));
        case "name-asc":
          return String(a.name).localeCompare(String(b.name)) || tie();
        case "name-desc":
          return String(b.name).localeCompare(String(a.name)) || tie();
        case "tier-asc":
          return tierOf(a) - tierOf(b) || tie();
        case "tier-desc":
          return tierOf(b) - tierOf(a) || tie();
        case "demand-asc":
          return compareNullable(demandOf(a), demandOf(b), "asc") || tie();
        case "demand-desc":
          return compareNullable(demandOf(a), demandOf(b), "desc") || tie();
        case "holo-asc":
          return compareNullable(holoOf(a), holoOf(b), "asc") || tie();
        case "holo-desc":
          return compareNullable(holoOf(a), holoOf(b), "desc") || tie();
        case "updated-asc":
          return compareNullable(num(a.updatedAt) || null, num(b.updatedAt) || null, "asc") || tie();
        case "updated-desc":
          return compareNullable(num(a.updatedAt) || null, num(b.updatedAt) || null, "desc") || tie();
        case "value-asc":
          return compareNullable(shownValue(a), shownValue(b), "asc") || tie();
        case "value-desc":
          return compareNullable(shownValue(a), shownValue(b), "desc") || tie();
        default:
          return tie();
      }
    };
  }
  function cycleSort(key) {
    var pairs = {
      rank: [ "rank-asc", "rank-desc" ],
      name: [ "name-asc", "name-desc" ],
      tier: [ "tier-asc", "tier-desc" ],
      demand: [ "demand-desc", "demand-asc" ],
      value: [ "value-desc", "value-asc" ],
      holo: [ "holo-desc", "holo-asc" ],
      updated: [ "updated-desc", "updated-asc" ]
    };
    var pair = pairs[key];
    if (!pair) return;
    var current = state.view.sort;
    if (current === pair[0]) state.view.sort = pair[1];
    else if (current === pair[1]) state.view.sort = "rank";
    else state.view.sort = pair[0];
  }
  function setSortIndicators() {
    var sort = state.view.sort;
    var key = sort === "rank" || sort === "rank-asc" ? "rank" : sort.split("-")[0];
    var dir = sort === "rank" || sort === "rank-asc" || sort.slice(-4) === "-asc" ? "ascending" : "descending";
    document.querySelectorAll("#vtable thead th[data-sort]").forEach(function(th) {
      th.setAttribute("aria-sort", th.dataset.sort === key ? dir : "none");
    });
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
    list.sort(sortComparator(sort));
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
    renderBulkBar();
    setSortIndicators();
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
    if (table) table.classList.toggle("editing", canEdit());
    slice.forEach(function(card) {
      var value = shownValue(card);
      var holo = holoOf(card);
      var demand = demandOf(card);
      var tr = h("tr", {
        dataset: {
          id: card.id
        }
      });
      var selectCell = h("td", {
        class: "col-select"
      });
      if (canEdit()) {
        var rowSelect = h("input", {
          type: "checkbox",
          class: "row-select",
          attrs: {
            "aria-label": "Select " + card.name
          }
        });
        rowSelect.dataset.id = card.id;
        rowSelect.checked = state.selected.has(card.id);
        selectCell.append(rowSelect);
      }
      tr.append(selectCell);
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
      var priceText = priceLabel(card.priceStatus);
      var sub = h("div", {
        class: "card-sub"
      }, (card.creator && card.creator !== "-" ? card.creator : "unknown") + (card.twoPlayer ? " · 2P" : ""), priceText ? h("span", {
        class: "price-tag " + card.priceStatus,
        text: " · " + priceText
      }) : null);
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
          class: "demand-num",
          text: d + "/10"
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
    updateSelectPage();
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
    if (state.view.sort !== "rank") p.set("sort", state.view.sort);
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
    var sort = params.get("sort") || "rank";
    var status = params.get("status") || "all";
    var size = clamp(Number(params.get("size")) || 100, 100, 1e3);
    var page = Math.max(1, Number(params.get("page")) || 1);
    var validSorts = [ "rank", "rank-asc", "rank-desc", "name-asc", "name-desc", "tier-asc", "tier-desc", "demand-asc", "demand-desc", "value-asc", "value-desc", "holo-asc", "holo-desc", "updated-asc", "updated-desc" ];
    var validStatus = [ "all", "priced", "pending", "override" ];
    state.view.q = q;
    state.view.tier = tier;
    state.view.sort = validSorts.indexOf(sort) !== -1 ? sort : "rank";
    state.view.status = validStatus.indexOf(status) !== -1 ? status : "all";
    state.view.holo = params.get("holo") === "1";
    state.view.size = [ 100, 250, 500, 1e3 ].indexOf(size) !== -1 ? size : 100;
    state.view.page = page;
    $("#search").value = q;
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
    renderCardModal(card, editing, false);
    open("modal");
  }
  function renderCardModal(card, editing, suggesting) {
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
    }) : null, card.priceStatus ? h("span", {
      class: "price-tag " + card.priceStatus,
      text: priceLabel(card.priceStatus)
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
    }, statBox("Value", fmtValue(value)), statBox("Holo", fmtValue(holo)), statBox("Demand", normalDemand == null ? "N/A" : demandLabel(normalDemand) + " " + Math.round(normalDemand) + "/10"), statBox("Holo demand", holoDemand == null ? "N/A" : demandLabel(holoDemand) + " " + Math.round(holoDemand) + "/10")));
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
            renderCardModal(card, true, false);
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
    } else if (canSuggest() && !suggesting) {
      links.append(h("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Suggest",
        on: {
          click: function() {
            renderCardModal(card, false, true);
          }
        }
      }));
    } else if (!state.auth.token) {
      links.append(h("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Sign in to suggest",
        on: {
          click: openLogin
        }
      }));
    }
    body.append(links);
    if (suggesting && canSuggest()) {
      body.append(renderSuggestionForm(card));
    } else if (editing && canEdit()) {
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
  function renderSuggestionForm(card) {
    var form = h("div", {
      class: "panel-box"
    });
    form.append(h("h3", {
      text: "Suggest a change"
    }));
    var valueInput = h("input", {
      type: "number",
      step: "0.001",
      min: "0",
      placeholder: "blank = curve",
      value: card.valueOverride != null ? String(card.valueOverride) : ""
    });
    var holoInput = h("input", {
      type: "number",
      step: "0.001",
      min: "0",
      placeholder: "blank = 3x",
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
    var priceSel = h("select", null, h("option", {
      value: "",
      text: "none"
    }), h("option", {
      value: "over",
      text: "overpriced"
    }), h("option", {
      value: "under",
      text: "underpriced"
    }), h("option", {
      value: "fair",
      text: "fair"
    }));
    priceSel.value = card.priceStatus || "";
    var noteInput = h("textarea", {
      maxlength: "500",
      placeholder: "optional"
    });
    noteInput.value = card.note || "";
    var reasonInput = h("textarea", {
      maxlength: "500",
      placeholder: "Why should this change? (required)"
    });
    var imageInput = h("input", {
      type: "file",
      accept: "image/png,image/jpeg,image/webp,image/gif",
      multiple: true
    });
    var previews = h("div", {
      class: "proposal-imgs"
    });
    var selectedImages = [];
    function renderPreviews() {
      previews.textContent = "";
      selectedImages.forEach(function(img, idx) {
        previews.append(h("span", {
          class: "proposal-img-wrap"
        }, h("img", {
          class: "proposal-img",
          src: "data:" + img.type + ";base64," + img.data,
          alt: img.name || ""
        }), h("button", {
          type: "button",
          text: "x",
          title: "Remove",
          on: {
            click: function() {
              selectedImages.splice(idx, 1);
              renderPreviews();
            }
          }
        })));
      });
    }
    imageInput.addEventListener("change", function() {
      var files = Array.from(imageInput.files || []);
      imageInput.value = "";
      (async function() {
        for (var i = 0; i < files.length; i++) {
          if (selectedImages.length >= 3) {
            toast("Max 3 images.", "error");
            break;
          }
          var file = files[i];
          if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type)) {
            toast("Images must be png, jpg, webp or gif.", "error");
            continue;
          }
          if (file.size > 2 * 1024 * 1024) {
            toast("Each image must be under 2MB.", "error");
            continue;
          }
          var data = await new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onload = function() {
              resolve(String(reader.result).split(",")[1]);
            };
            reader.onerror = function() {
              resolve(null);
            };
            reader.readAsDataURL(file);
          });
          if (data) selectedImages.push({
            name: file.name,
            type: file.type,
            data: data
          });
        }
        renderPreviews();
      })();
    });
    form.append(h("div", {
      class: "form-grid"
    }, field("Value", valueInput, null), field("Holo", holoInput, null), field("Demand", demandSel, null), field("Holo demand", holoDemandSel, null), field("Price", priceSel, null), h("div", {
      class: "form-field full"
    }, h("label", {
      text: "Note"
    }), noteInput), h("div", {
      class: "form-field full"
    }, h("label", {
      text: "Reason (required)"
    }), reasonInput), h("div", {
      class: "form-field full"
    }, h("label", {
      text: "Screenshots (max 3)"
    }), imageInput, previews)));
    var actions = h("div", {
      class: "form-actions"
    });
    actions.append(h("button", {
      class: "btn btn-primary",
      type: "button",
      text: "Send suggestion",
      on: {
        click: function(ev) {
          var patch = {
            valueOverride: valueInput.value.trim() === "" ? null : Number(valueInput.value),
            holoOverride: holoInput.value.trim() === "" ? null : Number(holoInput.value),
            demand: demandSel.value === "" ? null : Number(demandSel.value),
            holoDemand: holoDemandSel.value === "" ? null : Number(holoDemandSel.value),
            priceStatus: priceSel.value === "" ? null : priceSel.value,
            note: noteInput.value.trim()
          };
          if (patch.valueOverride != null && (!Number.isFinite(patch.valueOverride) || patch.valueOverride < 0)) return toast("Value must be positive.", "error");
          if (patch.holoOverride != null && (!Number.isFinite(patch.holoOverride) || patch.holoOverride < 0)) return toast("Holo must be positive.", "error");
          if (patch.demand != null && (!Number.isFinite(patch.demand) || patch.demand < 0 || patch.demand > 10)) return toast("Demand 0-10.", "error");
          if (patch.holoDemand != null && (!Number.isFinite(patch.holoDemand) || patch.holoDemand < 0 || patch.holoDemand > 10)) return toast("Holo demand 0-10.", "error");
          var fields = changedFields(card, patch);
          if (!fields.length) return toast("Change at least one field.", "error");
          var reason = reasonInput.value.trim();
          if (reason.length < 10) return toast("Add a reason (10+ characters).", "error");
          if (state.busy) return;
          var btn = ev.currentTarget;
          state.busy = true;
          btn.disabled = true;
          btn.textContent = "Sending...";
          apiFetch("/api/suggest", {
            method: "POST",
            body: {
              cardId: card.id,
              fields: fields,
              valueOverride: patch.valueOverride,
              holoOverride: patch.holoOverride,
              demand: patch.demand,
              holoDemand: patch.holoDemand,
              priceStatus: patch.priceStatus,
              note: patch.note,
              reason: reason,
              images: selectedImages
            }
          }).then(function() {
            toast("Suggestion sent.", "ok");
            close("modal");
            state.proposals = null;
            if (!$("#drawer").hidden) renderDrawer();
          }).catch(function(err) {
            toast(err.message || "Could not send suggestion.", "error");
          }).then(function() {
            state.busy = false;
            btn.disabled = false;
            btn.textContent = "Send suggestion";
          });
        }
      }
    }), h("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Cancel",
      on: {
        click: function() {
          renderCardModal(card, false, false);
        }
      }
    }));
    form.append(actions);
    return form;
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
    var priceSel = h("select", null, h("option", {
      value: "",
      text: "none"
    }), h("option", {
      value: "over",
      text: "overpriced"
    }), h("option", {
      value: "under",
      text: "underpriced"
    }), h("option", {
      value: "fair",
      text: "fair"
    }));
    priceSel.value = card.priceStatus || "";
    var noteInput = h("textarea", {
      maxlength: "500",
      placeholder: "optional"
    });
    noteInput.value = card.note || "";
    form.append(h("div", {
      class: "form-grid"
    }, field("Value", valueInput, null), field("Holo", holoInput, null), field("Demand", demandSel, null), field("Holo demand", holoDemandSel, null), field("Price", priceSel, null), h("div", {
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
      text: state.auth.role === "helper" ? "Submit" : "Save",
      on: {
        click: function(ev) {
          var patch = {
            valueOverride: valueInput.value.trim() === "" ? null : Number(valueInput.value),
            holoOverride: holoInput.value.trim() === "" ? null : Number(holoInput.value),
            demand: demandSel.value === "" ? null : Number(demandSel.value),
            holoDemand: holoDemandSel.value === "" ? null : Number(holoDemandSel.value),
            priceStatus: priceSel.value === "" ? null : priceSel.value,
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
    if (card.valueOverride != null || card.holoOverride != null || card.demandSource === "manual" || card.holoDemand != null || card.priceStatus != null) {
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
              priceStatus: null,
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
  function applyLocalCardPatch(card, patch, onlyFields) {
    var allow = function(f) {
      return !onlyFields || onlyFields.indexOf(f) !== -1;
    };
    var valueChanged = (allow("valueOverride") && patch.valueOverride !== (card.valueOverride == null ? null : card.valueOverride)) || (allow("holoOverride") && patch.holoOverride !== (card.holoOverride == null ? null : card.holoOverride));
    if (allow("valueOverride")) card.valueOverride = patch.valueOverride;
    if (allow("holoOverride")) card.holoOverride = patch.holoOverride;
    if (valueChanged) card.valueSource = card.valueOverride != null ? "manual" : null;
    if (allow("demand")) {
      if (patch.demand !== card.demand) card.demandSource = patch.demand != null ? "manual" : null;
      card.demand = patch.demand;
    }
    if (allow("holoDemand")) {
      if (patch.holoDemand !== card.holoDemand) card.holoDemandSource = patch.holoDemand != null ? "manual" : null;
      card.holoDemand = patch.holoDemand;
    }
    if (allow("priceStatus")) card.priceStatus = patch.priceStatus || null;
    if (allow("note")) card.note = patch.note || "";
    card.confirmed = true;
    card.updatedAt = Date.now();
  }
  function changedFields(card, patch) {
    var fields = [];
    if (patch.valueOverride !== (card.valueOverride == null ? null : card.valueOverride)) fields.push("valueOverride");
    if (patch.holoOverride !== (card.holoOverride == null ? null : card.holoOverride)) fields.push("holoOverride");
    if (patch.demand !== (card.demand == null ? null : card.demand)) fields.push("demand");
    if (patch.holoDemand !== (card.holoDemand == null ? null : card.holoDemand)) fields.push("holoDemand");
    if ((patch.priceStatus || null) !== (card.priceStatus == null ? null : card.priceStatus)) fields.push("priceStatus");
    if ((patch.note || "") !== (card.note || "")) fields.push("note");
    return fields;
  }
  function publishCardChange(card, patch, btn, message) {
    if (!canEdit()) return toast("Sign in with Discord.", "error");
    if (canPropose()) {
      var fields = changedFields(card, patch);
      if (!fields.length) return toast("No change.", "error");
      submitProposal([ {
        id: card.id,
        fields: fields,
        valueOverride: patch.valueOverride,
        holoOverride: patch.holoOverride,
        demand: patch.demand,
        holoDemand: patch.holoDemand,
        priceStatus: patch.priceStatus,
        note: patch.note
      } ], message || "Propose " + card.name, btn);
      return;
    }
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
        priceStatus: patch.priceStatus,
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
  function pageIds() {
    var start = (state.view.page - 1) * state.view.size;
    return state.filtered.slice(start, start + state.view.size).map(function(c) {
      return c.id;
    });
  }
  function updateSelectPage() {
    var el = $("#selectPage");
    if (!el) return;
    var ids = pageIds();
    el.checked = ids.length > 0 && ids.every(function(id) {
      return state.selected.has(id);
    });
  }
  function renderBulkBar() {
    var bar = $("#bulkBar");
    if (!bar) return;
    var show = canEdit() && state.selected.size > 0;
    bar.hidden = !show;
    if (!show) return;
    $("#bulkCount").textContent = state.selected.size + " selected";
    $("#bulkApply").textContent = state.auth.role === "helper" ? "Submit" : "Apply";
    $("#bulkRevert").hidden = state.auth.role === "helper";
    var any = false;
    state.selected.forEach(function(id) {
      if (latestCardEdit(id)) any = true;
    });
    $("#bulkRevert").disabled = !any;
  }
  function initBulk() {
    if (state.bulkInit) return;
    state.bulkInit = true;
    [ $("#bulkDemand"), $("#bulkHoloDemand") ].forEach(function(sel) {
      if (!sel) return;
      sel.append(h("option", {
        value: "",
        text: "N/A"
      }));
      for (var d = 0; d <= 10; d++) {
        sel.append(h("option", {
          value: String(d),
          text: d + " " + demandLabel(d)
        }));
      }
    });
    [ [ "bulkValueOn", "bulkValue" ], [ "bulkHoloOn", "bulkHolo" ], [ "bulkDemandOn", "bulkDemand" ], [ "bulkHoloDemandOn", "bulkHoloDemand" ], [ "bulkPriceOn", "bulkPrice" ], [ "bulkNoteOn", "bulkNote" ] ].forEach(function(pair) {
      var on = $("#" + pair[0]), input = $("#" + pair[1]);
      if (!on || !input) return;
      input.disabled = !on.checked;
      on.addEventListener("change", function() {
        input.disabled = !on.checked;
      });
    });
    $("#selectPage").addEventListener("change", function(e) {
      var ids = pageIds();
      if (e.target.checked) ids.forEach(function(id) {
        state.selected.add(id);
      }); else ids.forEach(function(id) {
        state.selected.delete(id);
      });
      renderRows();
      renderBulkBar();
    });
    $("#vbody").addEventListener("change", function(e) {
      if (!e.target.classList.contains("row-select")) return;
      var id = e.target.dataset.id;
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      updateSelectPage();
      renderBulkBar();
    });
    $("#bulkClear").addEventListener("click", function() {
      state.selected.clear();
      renderRows();
      renderBulkBar();
    });
    $("#bulkApply").addEventListener("click", function(e) {
      var items = buildBulkItems();
      if (items) publishBulkItems(items, "Bulk update " + items.length + " cards", e.currentTarget);
    });
    $("#bulkRevert").addEventListener("click", revertSelected);
  }
  function buildBulkItems() {
    var valueOn = $("#bulkValueOn").checked, holoOn = $("#bulkHoloOn").checked, demandOn = $("#bulkDemandOn").checked, holoDemandOn = $("#bulkHoloDemandOn").checked, priceOn = $("#bulkPriceOn").checked, noteOn = $("#bulkNoteOn").checked;
    if (!valueOn && !holoOn && !demandOn && !holoDemandOn && !priceOn && !noteOn) {
      toast("Pick a field.", "error");
      return null;
    }
    var value = valueOn ? $("#bulkValue").value.trim() === "" ? null : Number($("#bulkValue").value) : null;
    if (valueOn && value != null && (!Number.isFinite(value) || value < 0)) {
      toast("Value must be positive.", "error");
      return null;
    }
    var holo = holoOn ? $("#bulkHolo").value.trim() === "" ? null : Number($("#bulkHolo").value) : null;
    if (holoOn && holo != null && (!Number.isFinite(holo) || holo < 0)) {
      toast("Holo must be positive.", "error");
      return null;
    }
    var demand = demandOn ? $("#bulkDemand").value === "" ? null : Number($("#bulkDemand").value) : null;
    var holoDemand = holoDemandOn ? $("#bulkHoloDemand").value === "" ? null : Number($("#bulkHoloDemand").value) : null;
    var priceStatus = priceOn ? $("#bulkPrice").value === "" ? null : $("#bulkPrice").value : null;
    var note = noteOn ? $("#bulkNote").value.trim() : null;
    var items = [];
    state.selected.forEach(function(id) {
      var card = state.cards.find(function(c) {
        return c.id === id;
      });
      if (!card) return;
      items.push({
        card: card,
        patch: {
          valueOverride: valueOn ? value : card.valueOverride == null ? null : card.valueOverride,
          holoOverride: holoOn ? holo : card.holoOverride == null ? null : card.holoOverride,
          demand: demandOn ? demand : card.demand == null ? null : card.demand,
          holoDemand: holoDemandOn ? holoDemand : card.holoDemand == null ? null : card.holoDemand,
          priceStatus: priceOn ? priceStatus : card.priceStatus || null,
          note: noteOn ? note : card.note || ""
        }
      });
    });
    if (!items.length) {
      toast("Nothing selected.", "error");
      return null;
    }
    return items;
  }
  function publishBulkItems(items, message, btn) {
    if (!canEdit()) return toast("Sign in with Discord.", "error");
    if (canPropose()) {
      var changes = items.map(function(it) {
        return {
          id: it.card.id,
          fields: changedFields(it.card, it.patch),
          valueOverride: it.patch.valueOverride,
          holoOverride: it.patch.holoOverride,
          demand: it.patch.demand,
          holoDemand: it.patch.holoDemand,
          priceStatus: it.patch.priceStatus,
          note: it.patch.note
        };
      }).filter(function(c) {
        return c.fields.length;
      });
      if (!changes.length) return toast("No changes.", "error");
      submitProposal(changes, message, btn);
      return;
    }
    if (state.busy) return;
    var label = btn ? btn.textContent : "Apply";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }
    var chunks = [];
    for (var i = 0; i < items.length; i += 200) chunks.push(items.slice(i, i + 200));
    function next() {
      if (!chunks.length) {
        state.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = label;
        }
        if (state.meta) state.meta.generatedAt = Date.now();
        state.selected.clear();
        toast("Saved.", "ok");
        renderAll();
        return refreshAudit().then(function() {
          if (!$("#drawer").hidden) renderDrawer();
        });
      }
      var chunk = chunks.shift();
      var changes = chunk.map(function(it) {
        return {
          id: it.card.id,
          valueOverride: it.patch.valueOverride,
          holoOverride: it.patch.holoOverride,
          demand: it.patch.demand,
          holoDemand: it.patch.holoDemand,
          priceStatus: it.patch.priceStatus,
          note: it.patch.note
        };
      });
      return apiFetch("/api/commit", {
        method: "POST",
        body: {
          changes: changes,
          message: message
        }
      }).then(function() {
        chunk.forEach(function(it) {
          applyLocalCardPatch(it.card, it.patch);
        });
        return next();
      });
    }
    next().catch(function(err) {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      if (err.status === 401) {
        clearAuth();
        renderAll();
        toast("Session expired.", "error");
      } else {
        toast(err.message || "Save failed.", "error");
      }
    });
  }
  function revertSelected() {
    var items = [];
    state.selected.forEach(function(id) {
      var entry = latestCardEdit(id);
      if (!entry) return;
      var card = state.cards.find(function(c) {
        return c.id === id;
      });
      if (!card) return;
      var b = entry.before;
      items.push({
        card: card,
        patch: {
          valueOverride: b.valueOverride == null ? null : b.valueOverride,
          holoOverride: b.holoOverride == null ? null : b.holoOverride,
          demand: b.demand == null ? null : b.demand,
          holoDemand: b.holoDemand == null ? null : b.holoDemand,
          priceStatus: b.priceStatus == null ? null : b.priceStatus,
          note: b.note || ""
        }
      });
    });
    if (!items.length) return toast("No prior edits.", "error");
    publishBulkItems(items, "Revert selected", $("#bulkRevert"));
  }
  function loadProposals(force) {
    if (!(canApprove() || canPropose() || canSuggest())) return Promise.resolve();
    if (!force && (state.proposals || state.proposalsLoading)) return Promise.resolve();
    state.proposalsLoading = true;
    return apiFetch("/api/proposals").then(function(data) {
      state.proposals = Array.isArray(data.proposals) ? data.proposals : [];
      state.proposalsLoading = false;
      if (!$("#drawer").hidden) renderDrawer();
    }).catch(function(err) {
      state.proposalsLoading = false;
      toast(err.message || "Could not load proposals.", "error");
    });
  }
  function proposalSummary(change) {
    var card = state.cards.find(function(x) {
      return x.id === change.id;
    });
    if (!card) return change.id;
    var fields = Array.isArray(change.fields) ? change.fields : null;
    var has = function(f) {
      return !fields || fields.indexOf(f) !== -1;
    };
    var parts = [];
    if (has("valueOverride") && change.valueOverride !== (card.valueOverride == null ? null : card.valueOverride)) parts.push("value " + fmtValue(change.valueOverride));
    if (has("holoOverride") && change.holoOverride !== (card.holoOverride == null ? null : card.holoOverride)) parts.push("holo " + fmtValue(change.holoOverride));
    if (has("demand") && change.demand !== (card.demand == null ? null : card.demand)) parts.push("demand " + (change.demand == null ? "N/A" : demandLabel(change.demand) + " " + change.demand + "/10"));
    if (has("holoDemand") && change.holoDemand !== (card.holoDemand == null ? null : card.holoDemand)) parts.push("holo demand " + (change.holoDemand == null ? "N/A" : demandLabel(change.holoDemand) + " " + change.holoDemand + "/10"));
    if (has("priceStatus") && (change.priceStatus || null) !== (card.priceStatus == null ? null : card.priceStatus)) parts.push("price " + (change.priceStatus ? priceLabel(change.priceStatus) : "none"));
    if (has("note") && (change.note || "") !== (card.note || "")) parts.push("note");
    return card.name + (parts.length ? ": " + parts.join(", ") : "");
  }
  function renderProposalsEditor() {
    var box = h("div", {
      class: "panel-box"
    });
    box.append(h("h3", {
      text: canApprove() || canPropose() ? "Proposals" : "Suggestions"
    }));
    if (!state.proposals) {
      if (!state.proposalsLoading) loadProposals();
      box.append(h("p", {
        class: "muted",
        text: "Loading..."
      }));
      return box;
    }
    if (!state.proposals.length) {
      box.append(h("p", {
        class: "muted",
        text: "No pending proposals."
      }));
      return box;
    }
    state.proposals.forEach(function(p) {
      var lines = (p.changes || []).map(proposalSummary);
      var summary = lines.slice(0, 4).join(" · ") + (lines.length > 4 ? " · +" + (lines.length - 4) + " more" : "");
      box.append(h("div", {
        class: "proposal"
      }, h("div", {
        class: "proposal-head"
      }, h("strong", {
        text: "@" + (p.by || "unknown")
      }), h("span", {
        text: (p.kind === "suggestion" ? "suggestion · " : "proposal · ") + timeAgo(p.at)
      })), h("div", {
        class: "proposal-cards",
        text: summary
      }), p.reason || p.message ? h("div", {
        class: "muted",
        text: "Reason: " + (p.reason || p.message)
      }) : null, (p.images || []).length ? h("div", {
        class: "proposal-imgs"
      }, p.images.map(function(img) {
        return h("a", {
          class: "proposal-img-link",
          href: img.path,
          target: "_blank",
          rel: "noopener noreferrer"
        }, h("img", {
          class: "proposal-img",
          src: img.path,
          alt: img.name || "",
          loading: "lazy"
        }));
      })) : null, canApprove() ? h("div", {
        class: "form-actions"
      }, h("button", {
        class: "btn btn-primary",
        type: "button",
        text: "Accept",
        on: {
          click: function(ev) {
            approveProposal(p.id, ev.currentTarget);
          }
        }
      }), h("button", {
        class: "btn btn-danger",
        type: "button",
        text: "Reject",
        on: {
          click: function(ev) {
            rejectProposal(p.id, ev.currentTarget);
          }
        }
      }), h("button", {
        class: "btn btn-danger",
        type: "button",
        text: "Block",
        on: {
          click: function(ev) {
            blockProposal(p.id, ev.currentTarget);
          }
        }
      })) : h("div", {
        class: "muted",
        text: "pending"
      })));
    });
    return box;
  }
  function submitProposal(changes, message, btn) {
    if (!canPropose()) return toast("Helpers only.", "error");
    if (state.busy) return;
    var label = btn ? btn.textContent : "Submit";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Submitting...";
    }
    var chunks = [];
    for (var i = 0; i < changes.length; i += 200) chunks.push(changes.slice(i, i + 200));
    function next() {
      if (!chunks.length) {
        state.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = label;
        }
        toast("Submitted for approval.", "ok");
        close("modal");
        state.selected.clear();
        state.proposals = null;
        renderAll();
        return loadProposals(true);
      }
      var chunk = chunks.shift();
      return apiFetch("/api/propose", {
        method: "POST",
        body: {
          changes: chunk,
          message: String(message || "Proposal").slice(0, 120)
        }
      }).then(next);
    }
    next().catch(function(err) {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
      if (err.status === 401) {
        clearAuth();
        renderAll();
        toast("Session expired.", "error");
      } else {
        toast(err.message || "Submit failed.", "error");
      }
    });
  }
  function approveProposal(id, btn) {
    if (!canApprove() || state.busy) return;
    var label = btn ? btn.textContent : "Approve";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Approving...";
    }
    var proposal = (state.proposals || []).find(function(p) {
      return p.id === id;
    });
    apiFetch("/api/proposals/approve", {
      method: "POST",
      body: {
        id: id
      }
    }).then(function() {
      if (proposal && Array.isArray(proposal.changes)) {
        proposal.changes.forEach(function(c) {
          var card = state.cards.find(function(x) {
            return x.id === c.id;
          });
          if (card) applyLocalCardPatch(card, c, c.fields);
        });
      }
      state.proposals = null;
      if (state.meta) state.meta.generatedAt = Date.now();
      toast("Approved.", "ok");
      renderAll();
      return refreshAudit().then(function() {
        return loadProposals(true);
      });
    }).catch(function(err) {
      toast(err.message || "Approve failed.", "error");
    }).then(function() {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }
  function rejectProposal(id, btn) {
    if (!canApprove() || state.busy) return;
    var label = btn ? btn.textContent : "Reject";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Rejecting...";
    }
    apiFetch("/api/proposals/reject", {
      method: "POST",
      body: {
        id: id
      }
    }).then(function() {
      state.proposals = null;
      toast("Rejected.", "ok");
      return loadProposals(true);
    }).catch(function(err) {
      toast(err.message || "Reject failed.", "error");
    }).then(function() {
      state.busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }
  function blockProposal(id, btn) {
    if (!canApprove() || state.busy) return;
    var label = btn ? btn.textContent : "Block";
    state.busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Blocking...";
    }
    apiFetch("/api/proposals/block", {
      method: "POST",
      body: {
        id: id
      }
    }).then(function() {
      state.proposals = null;
      toast("Blocked.", "ok");
      return loadProposals(true);
    }).catch(function(err) {
      toast(err.message || "Block failed.", "error");
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
    $("#drawerTitle").textContent = state.auth.role === "owner" || state.auth.role === "admin" ? "Admin panel" : state.auth.role === "helper" ? "Helper panel" : state.auth.username ? "My panel" : "Editor panel";
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
    if (canApprove() || canPropose() || canSuggest()) {
      body.append(renderProposalsEditor());
    }
    if (!canEdit()) {
      var locked = state.auth.role === "blocked" ? "You are blocked from suggesting." : canSuggest() ? "View only. Use Suggest on a card." : state.auth.username ? "Your ID " + state.auth.id + ". Ask vxef." : "Sign in with Discord.";
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
        }), " · ", e.action === "propose" ? "proposal" : e.action === "approve" ? "approval" : e.action === "reject" ? "rejection" : e.action === "roles" ? "roles" : e.action === "anchors" ? "anchors" : e.name || e.id, " · " + timeAgo(e.at));
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
            mods: data.roles.mods.slice(),
            helpers: (data.roles.helpers || []).slice(),
            blocked: (data.roles.blocked || []).slice()
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
    }), h("option", {
      value: "helper",
      text: "Helper (submit only)"
    }));
    function addId() {
      var id = idInput.value.trim();
      if (!/^\d{16,20}$/.test(id)) return toast("That is not a Discord user ID. Right-click a name in Discord and Copy User ID.", "error");
      [ "owner", "admins", "mods", "helpers", "blocked" ].forEach(function(k) {
        draft[k] = draft[k].filter(function(x) {
          return x !== id;
        });
      });
      draft[roleSel.value === "owner" ? "owner" : roleSel.value === "admin" ? "admins" : roleSel.value === "helper" ? "helpers" : "mods"].push(id);
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
    box.append(listBlock("Owners", "owner"), listBlock("Admins", "admins"), listBlock("Mods", "mods"), listBlock("Helpers", "helpers"), listBlock("Blocked", "blocked"));
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
    $("#vtable thead").addEventListener("click", function(e) {
      var th = e.target.closest("th[data-sort]");
      if (!th) return;
      cycleSort(th.dataset.sort);
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
      sort: "rank",
        status: "all",
        holo: false,
        page: 1,
        size: 100
      };
      $("#search").value = "";
      $("#status").value = "all";
      $("#holo").checked = false;
      $("#pageSize").value = "100";
      renderAll();
    });
    $("#vbody").addEventListener("click", function(e) {
      if (e.target.closest(".col-select")) return;
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
    initBulk();
    initWelcome();
  }
  function initWelcome() {
    var el = $("#welcome");
    if (!el) return;
    var key = "dg.welcome.v1";
    var seen = false;
    try {
      seen = sessionStorage.getItem(key) === "1";
    } catch (e) {}
    if (seen) return;
    el.hidden = false;
    var btn = $("#welcomeEnter");
    var closeWelcome = function() {
      try {
        sessionStorage.setItem(key, "1");
      } catch (e) {}
      el.hidden = true;
    };
    if (btn) {
      btn.addEventListener("click", closeWelcome);
      setTimeout(function() {
        btn.focus();
      }, 40);
    }
    el.addEventListener("keydown", function(e) {
      if (e.key === "Enter") closeWelcome();
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
