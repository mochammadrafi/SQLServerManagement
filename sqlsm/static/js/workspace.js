(function () {
  var state = {
    connection: null,
    connections: [],
    server: null,
    databases: [],
    selectedDb: "",
    catalog: {},
    expandedDbs: {},
    expandedSchemas: {},
    showSystem: false,
    explorerQuery: "",
    mode: "browse",
    browse: { view: "home", database: "", kind: "all", query: "", sort: "name", dbSort: "name" },
    table: null,
    selectedRow: null
  };

  var explorerBody = document.getElementById("explorer-body");
  var browseBody = document.getElementById("browse-body");
  var crumbs = document.getElementById("crumbs");
  var dbSelect = document.getElementById("db-select");
  var editor = document.getElementById("sql-editor");
  var resultTabs = document.getElementById("result-tabs");
  var resultBody = document.getElementById("result-body");
  var statusText = document.getElementById("status-text");
  var statusMeta = document.getElementById("status-meta");
  var connSelect = document.getElementById("conn-select");
  var btnExport = document.getElementById("btn-export");
  var btnExportDb = document.getElementById("btn-export-db");
  var btnBackupHere = document.getElementById("btn-backup-here");
  var btnOpenSql = document.getElementById("btn-open-sql");
  var btnScript = document.getElementById("btn-script");

  function api(url, options) {
    return window.SqlApi.request(url, options);
  }

  function setStatus(text, meta) {
    statusText.textContent = text;
    statusMeta.textContent = meta || "";
  }

  function activePane() {
    return state.mode === "sql" ? resultBody : browseBody;
  }

  var switchSeq = 0;

  function showError(err, hint, opts) {
    opts = opts || {};
    var cancelled = !!opts.cancelled || /dibatalkan/i.test(String(err || ""));
    var pane = activePane();
    window.SqlLoading.hideIn(pane);
    window.SqlLoading.hide();
    clearBusyMarks();
    if (cancelled) {
      if (state.mode === "browse" && state.table && state.table.page) {
        renderTableViewer();
        setStatus("Dibatalkan", "");
        return;
      }
      if (state.mode === "sql") {
        resultBody.className = "result-body";
        resultTabs.innerHTML = "";
      } else {
        browseBody.className = "browse-body";
      }
      pane.innerHTML =
        '<div class="empty-state"><h3>Dibatalkan</h3>' +
        "<p>Perintah dihentikan. Jalankan lagi jika masih diperlukan.</p></div>";
      setStatus("Dibatalkan", "");
      return;
    }
    if (state.mode === "sql") {
      resultBody.className = "result-body";
      resultTabs.innerHTML = "";
    } else {
      browseBody.className = "browse-body";
    }
    pane.innerHTML =
      '<div class="error-state"><h3>' + escapeHtml(err || "Terjadi kesalahan") + "</h3>" +
      (hint ? '<p class="hint">' + escapeHtml(hint) + "</p>" : "") +
      "</div>";
    setStatus("Gagal", "");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function ico(name) {
    var paths = {
      db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
      table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
      view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      folder: '<path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
      caret: '<path d="M9 6l6 6-6 6"/>',
      proc: '<path d="M8 3h7l5 5v13H8z"/><path d="M15 3v5h5"/>'
    };
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[name] || "") + "</svg>";
  }

  function currentDb() {
    return dbSelect.value || state.selectedDb || (state.connection && state.connection.database) || "master";
  }

  function setMode(mode) {
    state.mode = mode;
    document.getElementById("mode-browse").hidden = mode !== "browse";
    document.getElementById("mode-sql").hidden = mode !== "sql";
    document.getElementById("mode-browse-btn").className = "mode-btn" + (mode === "browse" ? " active" : "");
    document.getElementById("mode-sql-btn").className = "mode-btn" + (mode === "sql" ? " active" : "");
  }

  function setCrumbs(items) {
    crumbs.innerHTML = "";
    items.forEach(function (item, index) {
      if (index) {
        var sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        crumbs.appendChild(sep);
      }
      var el = document.createElement(item.onClick ? "button" : "span");
      el.className = "crumb" + (item.current ? " is-current" : "");
      el.textContent = item.label;
      if (item.onClick) {
        el.type = "button";
        el.addEventListener("click", item.onClick);
      }
      crumbs.appendChild(el);
    });
  }

  function syncBrowseActions() {
    var view = state.browse.view;
    var hasTable = !!(state.table && view === "table");
    var hasDb = view === "database" || view === "table";
    btnExport.hidden = !hasTable;
    btnExport.disabled = !hasTable;
    btnOpenSql.hidden = !hasTable;
    if (btnScript) btnScript.hidden = !hasTable;
    btnExportDb.hidden = view !== "database";
    btnBackupHere.hidden = !hasDb;
  }

  function catalogObjects(name, key) {
    var catalog = state.catalog[name];
    if (!catalog || !catalog.objects) return [];
    return (catalog.objects[key] || []).filter(function (item) {
      return state.showSystem || !item.is_system;
    });
  }

  function openDatabaseExport(name) {
    function go(catalog) {
      if (!catalog) return;
      window.SqlExport.openDatabaseExport({
        database: name,
        tables: catalogObjects(name, "tables"),
        views: catalogObjects(name, "views")
      });
    }
    var needMetrics = !state.catalog[name] || !state.catalog[name]._counts;
    if (needMetrics) {
      window.SqlLoading.showIn(
        browseBody,
        "Menyiapkan export",
        "Mengambil daftar tabel, jumlah baris, dan ukuran.",
        { track: false }
      );
    }
    ensureCatalog(name).then(function () {
      return loadCatalogCounts(name);
    }).then(function (catalog) {
      window.SqlLoading.hideIn(browseBody);
      go(catalog);
    }).catch(function (err) {
      window.SqlLoading.hideIn(browseBody);
      showError(String(err && err.message ? err.message : err));
    });
  }

  function openDatabaseBackup(name) {
    window.SqlExport.openBackup({
      databases: state.databases,
      selected: name
    });
  }

  function openTableExport(database, schema, table, rowCount) {
    window.SqlLoading.showIn(
      browseBody,
      "Menyiapkan export",
      schema + "." + table,
      { track: false }
    );
    api("/api/columns?database=" + encodeURIComponent(database) +
      "&schema=" + encodeURIComponent(schema) +
      "&table=" + encodeURIComponent(table)).then(function (data) {
      window.SqlLoading.hideIn(browseBody);
      if (!data.ok) return showError(data.error, data.hint);
      window.SqlExport.openDialog({
        database: database,
        schema: schema,
        table: table,
        columns: data.columns || [],
        rowCount: rowCount
      });
    }).catch(function (err) {
      window.SqlLoading.hideIn(browseBody);
      showError(String(err));
    });
  }

  function closestClass(el, className) {
    while (el && el !== document) {
      if (el.className && String(el.className).indexOf(className) !== -1) return el;
      el = el.parentNode;
    }
    return null;
  }

  function loadSession() {
    window.SqlLoading.show("Memeriksa sesi", "Memeriksa koneksi SQL Server dan sesi yang sedang aktif.");
    return api("/api/session").then(function (data) {
      if (data.csrf_token && window.SqlApi.setCsrf) window.SqlApi.setCsrf(data.csrf_token);
      if (!data.connected) {
        window.location.href = "/";
        return;
      }
      applySession(data);
      window.SqlLoading.status("Memuat database", "Mengambil daftar database dari SQL Server.");
      return loadDatabases();
    });
  }

  function applySession(data) {
    state.connection = data.connection;
    state.connections = data.connections || [];
    fillConnSelect();
    setStatus("Terhubung", data.driver_name || data.backend || "");
  }

  function fillConnSelect() {
    if (!connSelect) return;
    var widget = connSelect._sqlSelect || window.SqlSelect.mount(connSelect, {
      placeholder: "Pilih koneksi..."
    });
    var current = state.connection && state.connection.id;
    widget.setOptions((state.connections || []).map(function (item) {
      return {
        value: item.id,
        label: item.label || item.display_server || item.server,
        sub: item.database || ""
      };
    }), current);
  }

  function resetWorkspace() {
    state.catalog = {};
    state.expandedDbs = {};
    state.expandedSchemas = {};
    state.databases = [];
    state.selectedDb = "";
    state.table = null;
    state.selectedRow = null;
    state.server = null;
    state.browse = { view: "home", database: "", kind: "all", query: "", sort: "name", dbSort: "name" };
  }

  function loadDatabases() {
    window.SqlLoading.showIn(
      explorerBody,
      "Memuat database",
      "Mengambil daftar database dari SQL Server.",
      { track: false }
    );
    return api("/api/databases").then(function (data) {
      window.SqlLoading.hideIn(explorerBody);
      if (!data.ok) {
        window.SqlLoading.hide();
        setStatus("Gagal memuat database", data.error || "");
        explorerBody.innerHTML = '<p class="empty-inline">' + escapeHtml(data.error) + "</p>";
        return;
      }
      state.databases = data.databases || [];
      fillDbSelect();
      renderExplorer();
      return loadServerOverview();
    });
  }

  function fillDbSelect() {
    var widget = dbSelect._sqlSelect || window.SqlSelect.mount(dbSelect, {
      placeholder: "Cari database..."
    });
    var initial = (state.connection && state.connection.database) || "master";
    widget.setOptions(state.databases.map(function (db) {
      var size = db.size_mb != null ? window.SqlFormat.integer(Math.round(Number(db.size_mb))) + " MB" : "";
      return {
        value: db.name,
        label: db.name,
        sub: [db.state_desc, size].filter(Boolean).join(" · ")
      };
    }), initial);
    state.selectedDb = dbSelect.value;
  }

  function matchesQuery() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i] || "").toLowerCase());
    var q = (state.explorerQuery || "").toLowerCase().trim();
    if (!q) return true;
    return parts.some(function (part) { return part.indexOf(q) !== -1; });
  }

  function renderExplorer() {
    explorerBody.innerHTML = "";
    if (!state.databases.length) {
      explorerBody.innerHTML = '<p class="empty-inline">Tidak ada database yang terlihat.</p>';
      return;
    }
    var shown = 0;
    state.databases.forEach(function (db) {
      var catalog = state.catalog[db.name];
      var dbMatch = matchesQuery(db.name);
      var childMatch = false;
      if (catalog && state.explorerQuery) {
        (catalog.schemas || []).forEach(function (schema) {
          if (matchesQuery(db.name, schema.name)) childMatch = true;
        });
        ["tables", "views", "procedures", "functions"].forEach(function (key) {
          (catalog.objects[key] || []).forEach(function (item) {
            if (matchesQuery(db.name, item.schema, item.name)) childMatch = true;
          });
        });
      }
      if (state.explorerQuery && !dbMatch && !childMatch) return;
      shown += 1;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-db" + (db.name === state.selectedDb ? " active" : "");
      btn.innerHTML =
        '<span class="tree-caret' + (state.expandedDbs[db.name] ? " is-open" : "") + '">' + ico("caret") + "</span>" +
        '<span class="tree-ico">' + ico("db") + "</span>" +
        '<span class="tree-copy"><span class="tree-name">' + escapeHtml(db.name) + "</span>" +
        '<span class="db-meta">' + escapeHtml((db.state_desc || "") +
        (db.size_mb != null ? " · " + window.SqlFormat.integer(Math.round(Number(db.size_mb))) + " MB" : "")) +
        "</span></span>";
      btn.addEventListener("click", function () {
        openDatabase(db.name, true);
      });
      explorerBody.appendChild(btn);
      if (state.expandedDbs[db.name] && catalog) {
        renderSchemas(db.name, catalog);
      }
    });
    if (!shown) {
      explorerBody.innerHTML = '<p class="empty-inline">Tidak ada yang cocok dengan pencarian.</p>';
    }
  }

  function renderSchemas(dbName, catalog) {
    var groups = [
      ["tables", "Tables"],
      ["views", "Views"],
      ["procedures", "Stored procedures"],
      ["functions", "Functions"]
    ];
    var schemas = catalog.schemas || [];
    if (!schemas.length) {
      var empty = document.createElement("div");
      empty.className = "tree-item";
      empty.textContent = "(tidak ada schema)";
      explorerBody.appendChild(empty);
      return;
    }
    schemas.forEach(function (schema) {
      if (!state.showSystem && schema.is_system) return;
      if (state.explorerQuery && !matchesQuery(dbName, schema.name)) {
        var hasHit = false;
        groups.forEach(function (pair) {
          (catalog.objects[pair[0]] || []).forEach(function (item) {
            if (item.schema === schema.name && matchesQuery(dbName, item.schema, item.name)) hasHit = true;
          });
        });
        if (!hasHit) return;
      }
      var key = dbName + "." + schema.name;
      var schemaBtn = document.createElement("button");
      schemaBtn.type = "button";
      schemaBtn.className = "tree-db tree-schema";
      schemaBtn.innerHTML =
        '<span class="tree-caret' + (state.expandedSchemas[key] ? " is-open" : "") + '">' + ico("caret") + "</span>" +
        '<span class="tree-ico">' + ico("folder") + "</span>" +
        '<span class="tree-copy"><span class="tree-name">' + escapeHtml(schema.name) +
        (schema.is_system ? " (sistem)" : "") + "</span></span>";
      schemaBtn.addEventListener("click", function () {
        state.expandedSchemas[key] = !state.expandedSchemas[key];
        renderExplorer();
      });
      explorerBody.appendChild(schemaBtn);
      if (!state.expandedSchemas[key] && !state.explorerQuery) return;
      groups.forEach(function (pair) {
        var items = (catalog.objects[pair[0]] || []).filter(function (item) {
          if (item.schema !== schema.name) return false;
          if (!state.showSystem && item.is_system) return false;
          return matchesQuery(dbName, item.schema, item.name);
        });
        if (!items.length) return;
        var label = document.createElement("div");
        label.className = "tree-group";
        label.textContent = pair[1] + " (" + items.length + ")";
        explorerBody.appendChild(label);
        items.forEach(function (item) {
          var node = document.createElement("button");
          node.type = "button";
          var active = state.table && state.table.database === dbName &&
            state.table.schema === item.schema && state.table.name === item.name;
          node.className = "tree-item nested" + (active ? " active" : "");
          var countLabel = item.row_count != null ? " · " + formatCount(item.row_count) : "";
          if (item.size_kb != null) countLabel += " · " + formatSizeKb(item.size_kb);
          var kindIcon = pair[0] === "views" ? "view" : (pair[0] === "tables" ? "table" : "proc");
          node.innerHTML =
            '<span class="tree-ico">' + ico(kindIcon) + "</span>" +
            '<span class="tree-copy"><span class="tree-name">' + escapeHtml(item.name + countLabel) + "</span></span>";
          node.addEventListener("click", function () {
            if (pair[0] === "tables" || pair[0] === "views") {
              openTable(dbName, item.schema, item.name);
            } else {
              openProcInSql(dbName, item.schema, item.name, pair[0]);
            }
          });
          explorerBody.appendChild(node);
        });
      });
    });
  }

  function bracket(name) {
    return "[" + String(name).replace(/]/g, "]]") + "]";
  }

  function formatCount(n) {
    if (n == null || n === "") return "-";
    return window.SqlFormat.integer(n);
  }

  function formatSizeKb(kb) {
    if (kb == null || kb === "") return "";
    if (window.SqlExport && window.SqlExport.formatSizeKb) {
      return window.SqlExport.formatSizeKb(kb);
    }
    var bytes = Number(kb) * 1024;
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function sortCatalogItems(items, sort) {
    if (window.SqlExport && window.SqlExport.sortObjects) {
      return window.SqlExport.sortObjects(items, sort);
    }
    return (items || []).slice();
  }

  function objectMeta(item, kindLabel, includeSchema) {
    var parts = [];
    if (includeSchema && item.schema) parts.push(item.schema);
    if (kindLabel) parts.push(kindLabel);
    if (item.row_count != null) parts.push(formatCount(item.row_count) + " baris");
    else parts.push("jumlah tidak diketahui");
    if (item.size_kb != null) parts.push(formatSizeKb(item.size_kb));
    return parts.join(" · ");
  }

  function selectDatabase(name, loadObjects) {
    state.selectedDb = name;
    if (dbSelect._sqlSelect) dbSelect._sqlSelect.setValue(name);
    else dbSelect.value = name;
    if (loadObjects) {
      return ensureCatalog(name).then(function () {
        state.expandedDbs[name] = true;
        renderExplorer();
      });
    }
    state.expandedDbs[name] = true;
    renderExplorer();
    return Promise.resolve();
  }

  function ensureCatalog(name) {
    if (state.catalog[name]) return Promise.resolve(state.catalog[name]);
    window.SqlLoading.showIn(explorerBody, "Memuat objek", "Mengambil tabel dan view di " + name + ".");
    return api("/api/objects?database=" + encodeURIComponent(name)).then(function (data) {
      window.SqlLoading.hideIn(explorerBody);
      if (!data.ok) {
        throw new Error(data.error || "Gagal memuat objek");
      }
      state.catalog[name] = {
        schemas: data.schemas || [],
        objects: data.objects || {},
        _counts: false
      };
      return state.catalog[name];
    }).catch(function (err) {
      window.SqlLoading.hideIn(explorerBody);
      setStatus("Gagal memuat objek", String(err && err.message ? err.message : err));
      throw err;
    });
  }

  function loadCatalogCounts(name) {
    var catalog = state.catalog[name];
    if (!catalog || catalog._counts) return Promise.resolve(catalog);
    return api("/api/objects?database=" + encodeURIComponent(name) + "&counts=1").then(function (data) {
      if (!data.ok || !state.catalog[name]) return catalog;
      ["tables", "views"].forEach(function (key) {
        var map = {};
        (data.objects[key] || []).forEach(function (item) {
          map[item.schema + "\0" + item.name] = item;
        });
        (state.catalog[name].objects[key] || []).forEach(function (item) {
          var stat = map[item.schema + "\0" + item.name];
          if (!stat) return;
          if (stat.row_count != null) item.row_count = stat.row_count;
          if (stat.size_kb != null) item.size_kb = stat.size_kb;
        });
      });
      state.catalog[name]._counts = true;
      return state.catalog[name];
    });
  }

  function loadServerOverview() {
    window.SqlLoading.status("Memuat informasi server", "Mengambil versi, edisi, collation, dan sesi aktif.");
    return api("/api/server").then(function (data) {
      if (!data.ok) {
        showError(data.error, data.hint);
        return;
      }
      state.server = data;
      showHome();
      window.SqlLoading.hide();
      setStatus("Siap", data.driver_name || "");
      if (window.SqlExport && window.SqlExport.refreshJobs) {
        window.SqlExport.refreshJobs();
      }
    });
  }

  function clearBusyMarks() {
    Array.prototype.forEach.call(document.querySelectorAll(".is-busy"), function (el) {
      if (window.SqlBusy) window.SqlBusy.mark(el, false);
      else el.classList.remove("is-busy");
    });
  }

  function closeExplorerDrawer() {
    document.body.classList.remove("is-explorer-open");
  }

  function showHome() {
    setMode("browse");
    clearBusyMarks();
    var sort = state.browse.sort || "name";
    var dbSort = state.browse.dbSort || "name";
    state.browse = { view: "home", database: "", kind: "all", query: "", sort: sort, dbSort: dbSort };
    state.table = null;
    state.selectedRow = null;
    syncBrowseActions();
    setCrumbs([{ label: "Database", current: true }]);
    browseBody.className = "browse-body";
    var s = (state.server && state.server.server) || {};
    var online = 0;
    var sizeMb = 0;
    state.databases.forEach(function (db) {
      if (/online/i.test(db.state_desc || "")) online += 1;
      if (db.size_mb != null) sizeMb += Number(db.size_mb) || 0;
    });
    var html = '<div class="browse-page">';
    html += '<div class="page-hero"><div>';
    html += '<p class="brand-kicker brand-kicker-ink">Katalog</p>';
    html += "<h3>Database</h3>";
    html += '<p class="browse-lead">Klik database untuk melihat tabel. Export atau backup bisa langsung dari kartu.</p>';
    html += "</div><div class=\"stat-pills\">";
    html += '<div class="stat-pill"><b>' + formatCount(state.databases.length) + "</b><span>Database</span></div>";
    html += '<div class="stat-pill"><b>' + formatCount(online) + "</b><span>Online</span></div>";
    html += '<div class="stat-pill"><b>' + (sizeMb ? formatCount(Math.round(sizeMb)) + " MB" : "-") + "</b><span>Total ukuran</span></div>";
    html += "</div></div>";
    if (s.server_name || s.edition) {
      html += '<div class="server-strip"><strong>Server</strong><dl>';
      [
        ["Nama", s.server_name],
        ["Edisi", s.edition],
        ["Versi", s.product_version],
        ["Collation", s.collation]
      ].forEach(function (pair) {
        html += "<dt>" + escapeHtml(pair[0]) + "</dt><dd>" + escapeHtml(pair[1] == null ? "-" : pair[1]) + "</dd>";
      });
      html += "</dl></div>";
    }
    var dbSort = state.browse.dbSort || "name";
    html += '<div class="browse-filter">';
    html += '<span class="filter-label">Urutkan</span>';
    html += '<button type="button" class="chip' + (dbSort === "name" ? " active" : "") + '" data-dbsort="name">Nama</button>';
    html += '<button type="button" class="chip' + (dbSort === "size" ? " active" : "") + '" data-dbsort="size">Ukuran</button>';
    html += "</div>";
    html += '<div class="card-grid" id="db-cards"></div></div>';
    browseBody.innerHTML = html;
    Array.prototype.forEach.call(browseBody.querySelectorAll("[data-dbsort]"), function (chip) {
      chip.addEventListener("click", function () {
        state.browse.dbSort = chip.getAttribute("data-dbsort") || "name";
        showHome();
      });
    });
    var grid = document.getElementById("db-cards");
    if (!state.databases.length) {
      grid.innerHTML = '<p class="browse-lead">Tidak ada database yang terlihat.</p>';
      return;
    }
    var databases = state.databases.slice();
    if (dbSort === "size") {
      databases.sort(function (a, b) {
        var as = a.size_mb == null ? -1 : Number(a.size_mb);
        var bs = b.size_mb == null ? -1 : Number(b.size_mb);
        if (as === bs) return String(a.name).localeCompare(String(b.name));
        return bs - as;
      });
    } else {
      databases.sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
      });
    }
    databases.forEach(function (db) {
      var card = document.createElement("div");
      card.className = "browse-card";
      var size = db.size_mb != null ? window.SqlFormat.integer(Math.round(Number(db.size_mb))) + " MB" : "";
      card.innerHTML =
        '<div class="card-top"><div class="card-icon">' + ico("db") + "</div>" +
        '<div class="card-copy"><strong>' + escapeHtml(db.name) + "</strong><span>" +
        escapeHtml([db.state_desc, size].filter(Boolean).join(" · ") || "Database") +
        "</span></div></div>" +
        '<div class="card-actions">' +
          '<button type="button" class="btn-tiny" data-act="export">Export</button>' +
          '<button type="button" class="btn-tiny" data-act="backup">Backup</button>' +
        "</div>";
      card.addEventListener("click", function (event) {
        var act = event.target.getAttribute("data-act");
        if (act === "export") {
          event.stopPropagation();
          if (window.SqlBusy) window.SqlBusy.mark(event.target, true);
          openDatabaseExport(db.name);
          return;
        }
        if (act === "backup") {
          event.stopPropagation();
          openDatabaseBackup(db.name);
          return;
        }
        if (closestClass(event.target, "card-actions")) return;
        card.classList.add("is-busy");
        openDatabase(db.name, true);
      });
      grid.appendChild(card);
    });
    renderExplorer();
  }

  function openDatabase(name, loadObjects) {
    closeExplorerDrawer();
    setMode("browse");
    state.browse.view = "database";
    state.browse.database = name;
    state.browse.kind = state.browse.kind || "all";
    state.browse.query = state.browse.query || "";
    state.table = null;
    state.selectedRow = null;
    syncBrowseActions();
    selectDatabase(name, true).then(function () {
      return loadCatalogCounts(name);
    }).then(function () {
      renderExplorer();
      if (state.catalog[name]) renderDatabasePage(name);
    }).catch(function (err) {
      showError(String(err && err.message ? err.message : err));
    });
  }

  function renderDatabasePage(name) {
    clearBusyMarks();
    var catalog = state.catalog[name];
    setCrumbs([
      { label: "Database", onClick: showHome },
      { label: name, current: true }
    ]);
    browseBody.className = "browse-body";
    if (!catalog) {
      window.SqlLoading.showIn(browseBody, "Memuat " + name, "Mengambil daftar tabel dan view.");
      return;
    }
    var q = (state.browse.query || "").toLowerCase().trim();
    var kind = state.browse.kind || "all";
    var tableCount = catalogObjects(name, "tables").length;
    var viewCount = catalogObjects(name, "views").length;
    var html = '<div class="browse-page">';
    html += '<div class="page-hero"><div>';
    html += '<p class="brand-kicker brand-kicker-ink">Database</p>';
    html += "<h3>" + escapeHtml(name) + "</h3>";
    html += '<p class="browse-lead">Klik tabel untuk melihat data. Export atau backup dari kartu dan toolbar.</p>';
    html += "</div><div class=\"stat-pills\">";
    html += '<div class="stat-pill"><b>' + formatCount(tableCount) + "</b><span>Tabel</span></div>";
    html += '<div class="stat-pill"><b>' + formatCount(viewCount) + "</b><span>View</span></div>";
    html += "</div></div>";
    var sort = state.browse.sort || "name";
    html += '<div class="browse-filter">';
    html += '<input id="browse-search" type="text" placeholder="Cari tabel atau view" value="' + escapeHtml(state.browse.query || "") + '">';
    html += '<button type="button" class="chip' + (kind === "all" ? " active" : "") + '" data-kind="all">Semua</button>';
    html += '<button type="button" class="chip' + (kind === "tables" ? " active" : "") + '" data-kind="tables">Tabel</button>';
    html += '<button type="button" class="chip' + (kind === "views" ? " active" : "") + '" data-kind="views">View</button>';
    html += '<span class="filter-label">Urutkan</span>';
    html += '<button type="button" class="chip' + (sort === "name" ? " active" : "") + '" data-sort="name">Nama</button>';
    html += '<button type="button" class="chip' + (sort === "rows" ? " active" : "") + '" data-sort="rows">Baris</button>';
    html += '<button type="button" class="chip' + (sort === "size" ? " active" : "") + '" data-sort="size">Ukuran</button>';
    html += "</div>";
    html += '<div id="table-cards"></div></div>';
    browseBody.innerHTML = html;

    document.getElementById("browse-search").addEventListener("input", function (event) {
      state.browse.query = event.target.value || "";
      renderDatabasePage(name);
      var input = document.getElementById("browse-search");
      if (input) {
        input.focus();
        var pos = input.value.length;
        if (input.setSelectionRange) input.setSelectionRange(pos, pos);
      }
    });
    Array.prototype.forEach.call(browseBody.querySelectorAll("[data-kind]"), function (chip) {
      chip.addEventListener("click", function () {
        state.browse.kind = chip.getAttribute("data-kind");
        renderDatabasePage(name);
      });
    });
    Array.prototype.forEach.call(browseBody.querySelectorAll("[data-sort]"), function (chip) {
      chip.addEventListener("click", function () {
        state.browse.sort = chip.getAttribute("data-sort") || "name";
        renderDatabasePage(name);
      });
    });

    function appendTableCard(grid, entry, includeSchema) {
      var card = document.createElement("div");
      card.className = "browse-card";
      card.innerHTML =
        '<div class="card-top"><div class="card-icon' + (entry.kind === "views" ? " is-view" : "") + '">' +
        ico(entry.kind === "views" ? "view" : "table") + "</div>" +
        '<div class="card-copy"><strong>' + escapeHtml(entry.item.name) + "</strong><span>" +
        escapeHtml(objectMeta(entry.item, entry.label, includeSchema)) +
        "</span></div></div>" +
        '<div class="card-actions">' +
          '<button type="button" class="btn-tiny" data-act="export">Export</button>' +
        "</div>";
      card.addEventListener("click", function (event) {
        if (event.target.getAttribute("data-act") === "export") {
          event.stopPropagation();
          if (window.SqlBusy) window.SqlBusy.mark(event.target, true);
          openTableExport(name, entry.item.schema, entry.item.name, entry.item.row_count);
          return;
        }
        if (closestClass(event.target, "card-actions")) return;
        card.classList.add("is-busy");
        openTable(name, entry.item.schema, entry.item.name);
      });
      grid.appendChild(card);
    }

    function collectCards(schemaName) {
      var groups = [];
      if (kind === "all" || kind === "tables") groups.push(["tables", "Tabel"]);
      if (kind === "all" || kind === "views") groups.push(["views", "View"]);
      var cards = [];
      groups.forEach(function (pair) {
        (catalog.objects[pair[0]] || []).forEach(function (item) {
          if (schemaName && item.schema !== schemaName) return;
          if (!state.showSystem && item.is_system) return;
          if (q && String(item.name).toLowerCase().indexOf(q) === -1 &&
              String(item.schema).toLowerCase().indexOf(q) === -1) return;
          cards.push({ item: item, kind: pair[0], label: pair[1] });
        });
      });
      return cards;
    }

    var host = document.getElementById("table-cards");
    var shown = 0;
    if (sort === "rows" || sort === "size") {
      var flat = collectCards(null);
      var sortedItems = sortCatalogItems(flat.map(function (entry) { return entry.item; }), sort);
      var byKey = {};
      flat.forEach(function (entry) {
        byKey[entry.item.schema + "\0" + entry.item.name] = entry;
      });
      if (sortedItems.length) {
        var block = document.createElement("div");
        block.className = "schema-block";
        block.innerHTML = "<h4>Objek" +
          ' <span class="schema-count">' + sortedItems.length + "</span></h4>";
        var grid = document.createElement("div");
        grid.className = "card-grid";
        sortedItems.forEach(function (item) {
          var entry = byKey[item.schema + "\0" + item.name];
          if (!entry) return;
          shown += 1;
          appendTableCard(grid, entry, true);
        });
        block.appendChild(grid);
        host.appendChild(block);
      }
    } else {
      (catalog.schemas || []).forEach(function (schema) {
        if (!state.showSystem && schema.is_system) return;
        var cards = collectCards(schema.name);
        if (!cards.length) return;
        shown += cards.length;
        cards.sort(function (a, b) {
          return String(a.item.name).localeCompare(String(b.item.name), undefined, { sensitivity: "base" });
        });
        var block = document.createElement("div");
        block.className = "schema-block";
        block.innerHTML = "<h4>" + escapeHtml(schema.name) + (schema.is_system ? " · sistem" : "") +
          ' <span class="schema-count">' + cards.length + "</span></h4>";
        var grid = document.createElement("div");
        grid.className = "card-grid";
        cards.forEach(function (entry) {
          appendTableCard(grid, entry, false);
        });
        block.appendChild(grid);
        host.appendChild(block);
      });
    }

    if (kind === "all") {
      var extras = [];
      ["procedures", "functions"].forEach(function (key) {
        (catalog.objects[key] || []).forEach(function (item) {
          if (!state.showSystem && item.is_system) return;
          if (q && String(item.name).toLowerCase().indexOf(q) === -1) return;
          extras.push({ item: item, kind: key });
        });
      });
      if (extras.length) {
        var extraBlock = document.createElement("div");
        extraBlock.className = "schema-block";
        extraBlock.innerHTML = "<h4>Prosedur &amp; fungsi</h4><p class=\"browse-lead\">Dibuka di mode SQL.</p>";
        var list = document.createElement("div");
        list.className = "proc-list";
        extras.forEach(function (entry) {
          var row = document.createElement("button");
          row.type = "button";
          row.className = "proc-item";
          row.textContent = entry.item.schema + "." + entry.item.name +
            (entry.kind === "functions" ? " · fungsi" : " · prosedur");
          row.addEventListener("click", function () {
            openProcInSql(name, entry.item.schema, entry.item.name, entry.kind);
          });
          list.appendChild(row);
        });
        extraBlock.appendChild(list);
        host.appendChild(extraBlock);
      }
    }

    if (!shown) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h3>Tidak ada tabel</h3><p>Coba tampilkan objek sistem di sidebar, atau ganti filter.</p>";
      host.appendChild(empty);
    }
  }

  function openProcInSql(database, schema, name, kind) {
    selectDatabase(database, false);
    if (kind === "functions") {
      editor.value = "SELECT * FROM " + bracket(schema) + "." + bracket(name) + "();";
    } else {
      editor.value = "EXEC " + bracket(schema) + "." + bracket(name) + ";";
    }
    setMode("sql");
    editor.focus();
    setStatus("Skrip prosedur disiapkan", schema + "." + name);
  }

  function openTable(database, schema, table) {
    closeExplorerDrawer();
    setMode("browse");
    state.browse.view = "table";
    state.browse.database = database;
    state.selectedRow = null;
    selectDatabase(database, false);
    state.table = {
      database: database,
      schema: schema,
      name: table,
      columns: [],
      keys: [],
      rowCount: null,
      pageSize: 200,
      afterStack: [],
      lastKey: null,
      seek: null,
      offset: 0,
      paging: "keyset",
      page: null
    };
    syncBrowseActions();
    setCrumbs([
      { label: "Database", onClick: showHome },
      { label: database, onClick: function () { openDatabase(database, false); } },
      { label: schema + "." + table, current: true }
    ]);
    setStatus("Memuat " + schema + "." + table + "...", "Mengambil statistik partisi, bukan COUNT(*)");
    window.SqlLoading.showIn(
      browseBody,
      "Memuat " + schema + "." + table,
      "Mengambil kolom dan satu halaman data. Data penuh tidak dimuat ke memori."
    );
    Promise.all([
      api("/api/columns?database=" + encodeURIComponent(database) +
        "&schema=" + encodeURIComponent(schema) +
        "&table=" + encodeURIComponent(table)),
      api("/api/table/stats?database=" + encodeURIComponent(database) +
        "&schema=" + encodeURIComponent(schema) +
        "&table=" + encodeURIComponent(table))
    ]).then(function (pack) {
      var cols = pack[0];
      var stats = pack[1];
      if (!cols.ok) return showError(cols.error, cols.hint);
      if (!stats.ok) return showError(stats.error, stats.hint);
      state.table.columns = cols.columns || [];
      state.table.keys = stats.keys || [];
      state.table.rowCount = stats.row_count;
      state.table.paging = stats.paging;
      editor.value = "SELECT TOP 200 *\nFROM " + bracket(schema) + "." + bracket(table) +
        (state.table.keys.length ? "\nORDER BY " + state.table.keys.map(bracket).join(", ") : "") + ";";
      window.SqlLoading.hideIn(browseBody);
      return loadTablePage();
    }).catch(function (err) {
      window.SqlLoading.hideIn(browseBody);
      showError(String(err));
    });
  }

  function tablePageUrl(after, seek, offset) {
    var t = state.table;
    var url = "/api/table/page?database=" + encodeURIComponent(t.database) +
      "&schema=" + encodeURIComponent(t.schema) +
      "&table=" + encodeURIComponent(t.name) +
      "&page_size=" + encodeURIComponent(t.pageSize);
    if (after) url += "&after=" + encodeURIComponent(JSON.stringify(after));
    if (seek) url += "&seek=" + encodeURIComponent(JSON.stringify(seek));
    if (offset) url += "&offset=" + encodeURIComponent(offset);
    return url;
  }

  function loadTablePage() {
    var t = state.table;
    if (!t) return;
    var after = t.afterStack.length ? t.afterStack[t.afterStack.length - 1] : null;
    setStatus("Memuat halaman...", t.schema + "." + t.name);
    window.SqlLoading.showIn(browseBody, "Memuat halaman", "Mengambil satu halaman dari " + t.schema + "." + t.name + ".");
    return api(tablePageUrl(after, t.seek, t.offset)).then(function (page) {
      window.SqlLoading.hideIn(browseBody);
      if (!page.ok) {
        if (page.cancelled) return showError(page.error, page.hint, { cancelled: true });
        return showError(page.error, page.hint);
      }
      t.page = page;
      t.lastKey = page.last_key;
      t.paging = page.paging;
      state.selectedRow = null;
      renderTableViewer();
    }).catch(function (err) {
      window.SqlLoading.hideIn(browseBody);
      showError(String(err));
    });
  }

  function renderTableViewer() {
    var t = state.table;
    if (!t) return;
    var page = t.page || { columns: [], rows: [], has_more: false, elapsed_ms: 0 };
    browseBody.className = "browse-body is-viewer";
    browseBody.innerHTML = "";
    var frame = document.createElement("div");
    frame.className = "viewer-frame";
    var main = document.createElement("div");
    main.className = "viewer-main";
    var bar = document.createElement("div");
    bar.className = "table-bar";
    bar.innerHTML =
      '<div class="table-bar-info">' +
        "<strong>" + escapeHtml(t.schema + "." + t.name) + "</strong>" +
        "<span>" + (t.rowCount != null ? formatCount(t.rowCount) + " baris" : "view / jumlah tidak diketahui") + "</span>" +
        "<span>Klik baris untuk viewer</span>" +
      "</div>" +
      '<div class="table-bar-seek">' +
        (t.keys.length
          ? '<label>Mulai dari ' + escapeHtml(t.keys[0]) +
            ' <input id="seek-value" type="text" placeholder="nilai kunci"></label>' +
            '<button type="button" class="btn-tiny" id="btn-seek">Pergi</button>'
          : "<span>Tidak ada PK/identity. Jangan loncat jauh dengan OFFSET.</span>") +
      "</div>";
    var gridHost = document.createElement("div");
    gridHost.className = "grid-host";
    var pager = document.createElement("div");
    pager.className = "pager";
    pager.innerHTML =
      '<button type="button" class="btn-tiny" id="page-first">Awal</button>' +
      '<button type="button" class="btn-tiny" id="page-prev">Sebelumnya</button>' +
      '<button type="button" class="btn-tiny" id="page-next">Berikutnya</button>' +
      "<span>Halaman " + (t.afterStack.length + 1) + (page.has_more ? "+" : "") + "</span>" +
      '<label>Ukuran <select id="page-size">' +
        [100, 200, 500, 1000].map(function (n) {
          return '<option value="' + n + '"' + (n === t.pageSize ? " selected" : "") + ">" +
            window.SqlFormat.integer(n) + "</option>";
        }).join("") +
      "</select></label>";
    main.appendChild(bar);
    main.appendChild(gridHost);
    main.appendChild(pager);

    var viewer = document.createElement("aside");
    viewer.className = "row-viewer";
    viewer.id = "row-viewer";
    frame.appendChild(main);
    frame.appendChild(viewer);
    browseBody.appendChild(frame);
    renderRowViewer(page);

    var gridOpts = {
      widthKey: t.database + "." + t.schema + "." + t.name,
      truncated: page.has_more,
      truncatedText: "Satu halaman saja. Berikutnya atau Export untuk data lain.",
      selectedRow: state.selectedRow,
      onRowClick: function (row, rowIndex) {
        state.selectedRow = rowIndex;
        gridOpts.selectedRow = rowIndex;
        highlightRow(gridHost, rowIndex);
        renderRowViewer(page);
      }
    };
    window.SqlGrid.render(gridHost, page.columns, page.rows, gridOpts);

    document.getElementById("page-first").addEventListener("click", function () {
      t.afterStack = [];
      t.seek = null;
      t.offset = 0;
      loadTablePage();
    });
    document.getElementById("page-prev").addEventListener("click", function () {
      if (t.seek) {
        t.seek = null;
        t.afterStack = [];
        t.offset = 0;
        loadTablePage();
        return;
      }
      if (!t.afterStack.length && !t.offset) return;
      if (t.paging === "offset") {
        t.offset = Math.max(0, t.offset - t.pageSize);
      } else {
        t.afterStack.pop();
      }
      loadTablePage();
    });
    document.getElementById("page-next").addEventListener("click", function () {
      if (!page.has_more) return;
      if (t.paging === "offset") {
        t.offset += t.pageSize;
      } else if (t.lastKey) {
        t.afterStack.push(t.lastKey);
        t.seek = null;
      }
      loadTablePage();
    });
    window.SqlSelect.mount(document.getElementById("page-size"), {
      placeholder: "Cari...",
      compact: true
    });
    document.getElementById("page-size").addEventListener("change", function (event) {
      t.pageSize = Number(event.target.value) || 200;
      t.afterStack = [];
      t.offset = 0;
      loadTablePage();
    });
    var seekBtn = document.getElementById("btn-seek");
    if (seekBtn) {
      var seekInput = window.SqlFormat.bindInput(document.getElementById("seek-value"), { flexible: true });
      seekBtn.addEventListener("click", function () {
        var value = seekInput.raw();
        if (!value) return;
        var seek = {};
        seek[t.keys[0]] = value;
        if (t.keys.length > 1) {
          showError("Seek kunci majemuk belum diisi lengkap.", "Pakai pager Berikutnya, atau export dengan WHERE.");
          return;
        }
        t.seek = seek;
        t.afterStack = [];
        t.offset = 0;
        loadTablePage();
      });
    }
    setStatus(
      t.schema + "." + t.name,
      (t.rowCount != null ? formatCount(t.rowCount) + " baris total" : "jumlah tidak dihitung") +
        " · halaman " + formatCount(page.rows.length) +
        (page.elapsed_ms != null ? " · " + page.elapsed_ms + " ms" : "")
    );
    renderExplorer();
  }

  function highlightRow(host, rowIndex) {
    var nodes = host.querySelectorAll(".virt-row");
    Array.prototype.forEach.call(nodes, function (el) {
      var selected = el.getAttribute("data-row") === String(rowIndex);
      el.className = selected ? "virt-row is-selected" : "virt-row";
    });
  }

  function renderRowViewer(page) {
    var viewer = document.getElementById("row-viewer");
    if (!viewer) return;
    var idx = state.selectedRow;
    var row = page && page.rows && idx != null ? page.rows[idx] : null;
    var columns = (page && page.columns) || [];
    if (row == null) {
      viewer.innerHTML =
        '<div class="row-viewer-head"><h3>Viewer</h3></div>' +
        '<p class="row-viewer-empty">Klik satu baris di tabel untuk melihat semua kolom. Double-click sel untuk nilai penuh.</p>';
      return;
    }
    viewer.innerHTML =
      '<div class="row-viewer-head"><h3>Baris ' + (idx + 1) + '</h3>' +
      '<button type="button" class="btn-tiny" id="row-viewer-close">Tutup</button></div>' +
      '<div class="row-viewer-body"><dl class="row-kv" id="row-kv"></dl></div>';
    var list = document.getElementById("row-kv");
    columns.forEach(function (name, i) {
      var value = row[i];
      var item = document.createElement("button");
      item.type = "button";
      item.className = "row-kv-row";
      var ddClass = value == null ? " is-null" : "";
      item.innerHTML = "<dt>" + escapeHtml(name) + "</dt><dd class=\"" + ddClass + "\">" +
        escapeHtml(value == null ? "NULL" : String(value)) + "</dd>";
      item.addEventListener("click", function () {
        window.SqlGrid.openDetail(name, value);
      });
      list.appendChild(item);
    });
    document.getElementById("row-viewer-close").addEventListener("click", function () {
      state.selectedRow = null;
      renderTableViewer();
    });
  }

  function runQuery() {
    var sql = editor.value;
    if (!sql.trim()) {
      showError("SQL kosong.", "Tulis query di editor, atau klik tabel di Jelajah.");
      return;
    }
    var unbounded = /select\s+\*\s+from/i.test(sql) && !/\btop\s+\d+/i.test(sql) && !/\boffset\s+\d+/i.test(sql);
    var dml = /\b(insert|update|delete|merge|drop|alter|truncate|backup|restore|exec|execute)\b/i.test(sql);
    if (dml && !window.confirm("Perintah ini mengubah data atau objek di SQL Server. Tidak ada undo. Lanjut?")) {
      return;
    }
    if (unbounded && !window.confirm("Query ini tanpa TOP/OFFSET. Aplikasi hanya menampilkan 1000 baris pertama. Untuk 100 juta baris, pakai pager tabel atau Export. Lanjut?")) {
      return;
    }
    resultBody.className = "result-body";
    setStatus("Menjalankan query...", currentDb());
    window.SqlLoading.showIn(resultBody, "Menjalankan SQL", "Menunggu hasil dari " + currentDb() + ".");
    api("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sql: sql,
        database: currentDb(),
        max_rows: 1000
      })
    }).then(function (data) {
      if (!data.ok) {
        if (data.cancelled) return showError(data.error, data.hint, { cancelled: true });
        return showError(data.error, data.hint);
      }
      renderQueryResult(data);
    }).catch(function (err) {
      showError(String(err && err.message ? err.message : err));
    });
  }

  function tabButton(id, label, active) {
    return '<button type="button" class="result-tab' + (active ? " active" : "") +
      '" data-tab="' + id + '">' + escapeHtml(label) + "</button>";
  }

  function renderQueryResult(data) {
    window.SqlLoading.hideIn(resultBody);
    resultBody.className = "result-body";
    var sets = data.result_sets || [];
    var html = "";
    if (!sets.length) {
      html += tabButton("messages", "Messages", true);
      resultTabs.innerHTML = html;
      resultBody.innerHTML = '<pre class="msg-list">' +
        escapeHtml((data.messages || []).join("\n") || "Selesai.") + "</pre>";
      setStatus("Selesai", (data.elapsed_ms || 0) + " ms");
      return;
    }
    sets.forEach(function (set, index) {
      html += tabButton("set-" + index, "Results " + (index + 1), index === 0);
    });
    html += tabButton("messages", "Messages", false);
    resultTabs.innerHTML = html;
    function show(tab) {
      Array.prototype.forEach.call(resultTabs.querySelectorAll(".result-tab"), function (btn) {
        btn.className = "result-tab" + (btn.getAttribute("data-tab") === tab ? " active" : "");
      });
      if (tab === "messages") {
        resultBody.innerHTML = '<pre class="msg-list">' +
          escapeHtml((data.messages || []).join("\n") || "Selesai.") + "</pre>";
        return;
      }
      var index = Number(tab.replace("set-", ""));
      var set = sets[index] || { columns: [], rows: [] };
      window.SqlGrid.render(resultBody, set.columns, set.rows, {
        truncated: set.truncated,
        truncatedText: "Query ad-hoc dipotong 1000 baris. Untuk tabel besar, buka dari Jelajah lalu Export."
      });
    }
    resultTabs.onclick = function (event) {
      var tab = event.target.getAttribute("data-tab");
      if (tab) show(tab);
    };
    show("set-0");
    var total = sets.reduce(function (sum, set) { return sum + (set.row_count || 0); }, 0);
    setStatus("Selesai", total + " baris · " + (data.elapsed_ms || 0) + " ms · " + (data.database || ""));
  }

  function bindSplitters() {
    var explorer = document.getElementById("explorer");
    var editorWrap = document.querySelector(".editor-wrap");
    document.getElementById("splitter-x").addEventListener("mousedown", function (event) {
      event.preventDefault();
      var startX = event.pageX;
      var startW = explorer.offsetWidth;
      function move(ev) {
        explorer.style.width = Math.max(200, Math.min(480, startW + (ev.pageX - startX))) + "px";
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    document.getElementById("splitter-y").addEventListener("mousedown", function (event) {
      event.preventDefault();
      var startY = event.pageY;
      var startH = editorWrap.offsetHeight;
      function move(ev) {
        editorWrap.style.height = Math.max(120, startH + (ev.pageY - startY)) + "px";
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  document.getElementById("mode-browse-btn").addEventListener("click", function () {
    setMode("browse");
    if (state.browse.view === "table" && state.table && state.table.page) {
      renderTableViewer();
    } else if (state.browse.view === "database" && state.browse.database) {
      openDatabase(state.browse.database, false);
    } else {
      showHome();
    }
  });
  document.getElementById("mode-sql-btn").addEventListener("click", function () {
    setMode("sql");
    setStatus("Mode SQL", currentDb());
  });
  document.getElementById("btn-run").addEventListener("click", runQuery);
  document.getElementById("btn-new").addEventListener("click", function () {
    setMode("sql");
    editor.value = "";
    editor.focus();
    setStatus("Query baru", currentDb());
  });
  if (btnScript) {
    btnScript.addEventListener("click", function () {
      var t = state.table;
      if (!t) return;
      api("/api/script/select?database=" + encodeURIComponent(t.database) +
        "&schema=" + encodeURIComponent(t.schema) +
        "&table=" + encodeURIComponent(t.name)).then(function (data) {
        if (!data.ok) return showError(data.error, data.hint);
        editor.value = data.sql || "";
        setMode("sql");
        editor.focus();
        setStatus("Script SELECT", t.schema + "." + t.name);
      });
    });
  }
  document.getElementById("btn-open-sql").addEventListener("click", function () {
    if (!state.table) return;
    setMode("sql");
    editor.focus();
    setStatus("SQL dari tabel", state.table.schema + "." + state.table.name);
  });
  document.getElementById("btn-export").addEventListener("click", function () {
    if (!state.table) return;
    window.SqlExport.openDialog({
      database: state.table.database,
      schema: state.table.schema,
      table: state.table.name,
      columns: state.table.columns,
      rowCount: state.table.rowCount,
      keys: state.table.keys
    });
  });
  document.getElementById("btn-export-db").addEventListener("click", function () {
    if (!state.browse.database) return;
    openDatabaseExport(state.browse.database);
  });
  document.getElementById("btn-backup-here").addEventListener("click", function () {
    openDatabaseBackup(state.browse.database || currentDb());
  });
  document.getElementById("btn-backup").addEventListener("click", function () {
    window.SqlExport.openBackup({
      databases: state.databases,
      selected: state.browse.database || currentDb()
    });
  });
  document.getElementById("btn-refresh").addEventListener("click", function () {
    state.catalog = {};
    state.expandedDbs = {};
    state.expandedSchemas = {};
    loadDatabases();
  });
  document.getElementById("explorer-search").addEventListener("input", function (event) {
    state.explorerQuery = event.target.value || "";
    renderExplorer();
  });
  document.getElementById("explorer-system").addEventListener("change", function (event) {
    state.showSystem = !!event.target.checked;
    renderExplorer();
    if (state.mode === "browse" && state.browse.view === "database" && state.browse.database) {
      renderDatabasePage(state.browse.database);
    }
  });
  document.getElementById("btn-load-all").addEventListener("click", function () {
    var names = state.databases.map(function (db) { return db.name; });
    var index = 0;
    function next() {
      if (index >= names.length) {
        window.SqlLoading.hideIn(explorerBody);
        renderExplorer();
        return;
      }
      var name = names[index];
      index += 1;
      if (state.catalog[name]) {
        state.expandedDbs[name] = true;
        next();
        return;
      }
      window.SqlLoading.showIn(
        explorerBody,
        "Memuat semua database",
        name + " (" + index + " / " + names.length + ")"
      );
      api("/api/objects?database=" + encodeURIComponent(name)).then(function (data) {
        if (data.ok) {
          state.catalog[name] = {
            schemas: data.schemas || [],
            objects: data.objects || {}
          };
          state.expandedDbs[name] = true;
        }
        next();
      }).catch(function () { next(); });
    }
    next();
  });
  var explorerToggle = document.getElementById("btn-explorer");
  if (explorerToggle) {
    explorerToggle.addEventListener("click", function () {
      document.body.classList.toggle("is-explorer-open");
    });
  }
  document.getElementById("btn-new-conn").addEventListener("click", function () {
    window.location.href = "/connect";
  });
  if (connSelect) {
    window.SqlSelect.mount(connSelect, { placeholder: "Pilih koneksi..." });
    connSelect.addEventListener("change", function () {
      var id = connSelect.value;
      if (!id || (state.connection && id === state.connection.id)) return;
      var seq = ++switchSeq;
      window.SqlLoading.show("Mengganti koneksi", "Memuat database dari koneksi yang dipilih.");
      api("/api/connections/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id })
      }).then(function (data) {
        if (seq !== switchSeq) return;
        if (!data.ok) {
          window.SqlLoading.hide();
          showError(data.error, data.hint);
          return;
        }
        resetWorkspace();
        applySession(data);
        return loadDatabases();
      }).catch(function (err) {
        if (seq !== switchSeq) return;
        window.SqlLoading.hide();
        showError(String(err && err.message ? err.message : err));
      });
    });
  }
  document.getElementById("btn-disconnect").addEventListener("click", function () {
    var current = state.connection && state.connection.id;
    window.SqlLoading.show("Memutuskan koneksi", "Menutup koneksi yang sedang dipakai.");
    api("/api/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: current })
    }).then(function (data) {
      if (!data.connected) {
        window.location.href = "/";
        return;
      }
      resetWorkspace();
      applySession(data);
      return loadDatabases();
    }).catch(function (err) {
      window.SqlLoading.hide();
      showError(String(err && err.message ? err.message : err));
    });
  });
  dbSelect.addEventListener("change", function () {
    if (state.mode === "browse") selectDatabase(dbSelect.value, true);
    else state.selectedDb = dbSelect.value;
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (document.body.classList.contains("is-working")) return;
      if (!detailModal.hidden) detailModal.hidden = true;
      if (!helpModal.hidden) helpModal.hidden = true;
    }
    if (state.mode !== "sql") return;
    if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      runQuery();
    }
  });

  var detailModal = document.getElementById("detail-modal");
  var helpModal = document.getElementById("help-modal");
  document.getElementById("detail-close").addEventListener("click", function () { detailModal.hidden = true; });
  document.getElementById("help-close").addEventListener("click", function () { helpModal.hidden = true; });
  document.getElementById("btn-help").addEventListener("click", function () { helpModal.hidden = false; });
  detailModal.addEventListener("click", function (event) { if (event.target === detailModal) detailModal.hidden = true; });
  helpModal.addEventListener("click", function (event) { if (event.target === helpModal) helpModal.hidden = true; });

  bindSplitters();
  window.SqlSelect.mount(dbSelect, { placeholder: "Cari database..." });
  if (window.SqlExport) window.SqlExport.bind();
  loadSession();
})();
