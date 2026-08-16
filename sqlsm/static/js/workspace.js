(function () {
  var state = {
    connection: null,
    databases: [],
    selectedDb: "",
    catalog: {},
    expandedDbs: {},
    expandedSchemas: {},
    showSystem: false,
    explorerQuery: "",
    activeTab: "messages",
    table: null
  };

  var explorerBody = document.getElementById("explorer-body");
  var dbSelect = document.getElementById("db-select");
  var editor = document.getElementById("sql-editor");
  var resultTabs = document.getElementById("result-tabs");
  var resultBody = document.getElementById("result-body");
  var statusText = document.getElementById("status-text");
  var statusMeta = document.getElementById("status-meta");
  var headerTarget = document.getElementById("header-target");

  function api(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401 || (data && data.error && /Belum terhubung/i.test(data.error))) {
          window.location.href = "/";
        }
        return data;
      });
    });
  }

  function setStatus(text, meta) {
    statusText.textContent = text;
    statusMeta.textContent = meta || "";
  }

  function showError(err, hint) {
    window.SqlLoading.hideIn(resultBody);
    window.SqlLoading.hide();
    resultBody.className = "result-body";
    resultTabs.innerHTML = "";
    resultBody.innerHTML =
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

  function currentDb() {
    return dbSelect.value || state.selectedDb || (state.connection && state.connection.database) || "master";
  }

  function loadSession() {
    window.SqlLoading.show("Memeriksa sesi", "Memeriksa koneksi SQL Server dan sesi yang sedang aktif.");
    return api("/api/session").then(function (data) {
      if (!data.connected) {
        window.location.href = "/";
        return;
      }
      state.connection = data.connection;
      headerTarget.textContent = data.connection.display_server + " · " +
        (data.connection.auth === "windows" ? "Windows Auth" : data.connection.username);
      setStatus("Terhubung", data.driver_name || data.backend || "");
      window.SqlLoading.show("Memuat database", "Mengambil daftar database dari SQL Server.");
      return loadDatabases();
    });
  }

  function loadDatabases() {
    window.SqlLoading.showIn(explorerBody, "Memuat database", "Mengambil daftar database dari SQL Server.");
    return api("/api/databases").then(function (data) {
      window.SqlLoading.hideIn(explorerBody);
      if (!data.ok) {
        window.SqlLoading.hide();
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
      var mark = state.expandedDbs[db.name] ? "[-] " : "[+] ";
      btn.innerHTML = escapeHtml(mark + db.name) +
        '<span class="db-meta">' + escapeHtml((db.state_desc || "") +
        (db.size_mb != null ? " · " + window.SqlFormat.integer(Math.round(Number(db.size_mb))) + " MB" : "")) + "</span>";
      btn.addEventListener("click", function () {
        if (state.expandedDbs[db.name] && state.catalog[db.name]) {
          state.expandedDbs[db.name] = false;
          renderExplorer();
          return;
        }
        selectDatabase(db.name, true);
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
      schemaBtn.textContent = (state.expandedSchemas[key] ? "[-] " : "[+] ") + schema.name +
        (schema.is_system ? " (sistem)" : "");
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
        if (!items.length && !state.explorerQuery) {
          return;
        }
        if (!items.length) return;
        var label = document.createElement("div");
        label.className = "tree-group";
        label.textContent = pair[1] + " (" + items.length + ")";
        explorerBody.appendChild(label);
        items.forEach(function (item) {
          var node = document.createElement("button");
          node.type = "button";
          node.className = "tree-item nested";
          var countLabel = item.row_count != null ? " · " + formatCount(item.row_count) : "";
          node.textContent = item.name + countLabel;
          node.addEventListener("click", function () {
            if (pair[0] === "tables" || pair[0] === "views") {
              openTable(dbName, item.schema, item.name);
            } else {
              editor.value = "EXEC " + bracket(item.schema) + "." + bracket(item.name) + ";";
              setStatus("Skrip prosedur disiapkan", item.schema + "." + item.name);
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

  function selectDatabase(name, loadObjects) {
    state.selectedDb = name;
    if (dbSelect._sqlSelect) dbSelect._sqlSelect.setValue(name);
    else dbSelect.value = name;
    if (loadObjects) {
      window.SqlLoading.showIn(explorerBody, "Memuat objek", "Mengambil tabel, view, dan prosedur di " + name + ".");
      api("/api/objects?database=" + encodeURIComponent(name)).then(function (data) {
        window.SqlLoading.hideIn(explorerBody);
        if (!data.ok) {
          showError(data.error, data.hint);
          return;
        }
        state.catalog[name] = {
          schemas: data.schemas || [],
          objects: data.objects || {}
        };
        state.expandedDbs[name] = true;
        renderExplorer();
      }).catch(function (err) {
        window.SqlLoading.hideIn(explorerBody);
        showError(String(err));
      });
    } else {
      state.expandedDbs[name] = true;
      renderExplorer();
    }
  }

  function loadServerOverview() {
    window.SqlLoading.show("Memuat informasi server", "Mengambil versi, edisi, collation, dan sesi aktif.");
    setStatus("Memuat informasi server...", "");
    return api("/api/server").then(function (data) {
      if (!data.ok) {
        showError(data.error, data.hint);
        return;
      }
      renderOverview(data);
      setStatus("Siap", data.driver_name || "");
      window.SqlLoading.hide();
    });
  }

  function renderOverview(data) {
    resultBody.className = "result-body";
    var s = data.server || {};
    var html = '<div class="info-panel"><h3>Informasi server</h3><dl class="info-kv">';
    var rows = [
      ["Server", s.server_name],
      ["Mesin", s.machine_name],
      ["Edisi", s.edition],
      ["Versi", s.product_version],
      ["Level", s.product_level],
      ["Collation", s.collation],
      ["Login", s.login_name],
      ["Database aktif", s.current_database],
      ["Mode auth", s.windows_auth_only == 1 ? "Windows only" : "Mixed / SQL + Windows"]
    ];
    rows.forEach(function (pair) {
      html += "<dt>" + escapeHtml(pair[0]) + "</dt><dd>" + escapeHtml(pair[1] == null ? "-" : pair[1]) + "</dd>";
    });
    html += "</dl>";
    if (s.version_string) {
      html += "<p>" + escapeHtml(s.version_string) + "</p>";
    }
    html += "</div>";
    resultTabs.innerHTML = tabButton("server", "Server", true);
    resultBody.innerHTML = html;
    if (data.sessions && data.sessions.length) {
      var cols = ["session_id", "login_name", "host_name", "program_name", "status", "database_name"];
      var mapped = data.sessions.map(function (row) {
        return cols.map(function (key) { return row[key]; });
      });
      var extra = document.createElement("div");
      extra.className = "info-panel";
      extra.innerHTML = "<h3>Sesi aktif</h3>";
      resultBody.appendChild(extra);
      var gridHost = document.createElement("div");
      resultBody.appendChild(gridHost);
      window.SqlGrid.render(gridHost, cols, mapped);
    }
  }

  function tabButton(id, label, active) {
    return '<button type="button" class="result-tab' + (active ? " active" : "") +
      '" data-tab="' + id + '">' + escapeHtml(label) + "</button>";
  }

  function openTable(database, schema, table) {
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
    document.getElementById("btn-export").disabled = false;
    setStatus("Memuat " + schema + "." + table + "...", "Mengambil statistik partisi, bukan COUNT(*)");
    window.SqlLoading.showIn(
      resultBody,
      "Memuat " + schema + "." + table,
      "Mengambil kolom dan statistik partisi. Data penuh tidak dimuat ke memori."
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
      return loadTablePage();
    }).catch(function (err) {
      window.SqlLoading.hideIn(resultBody);
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
    window.SqlLoading.showIn(resultBody, "Memuat halaman", "Mengambil satu halaman dari " + t.schema + "." + t.name + ".");
    return api(tablePageUrl(after, t.seek, t.offset)).then(function (page) {
      window.SqlLoading.hideIn(resultBody);
      if (!page.ok) return showError(page.error, page.hint);
      t.page = page;
      t.lastKey = page.last_key;
      t.paging = page.paging;
      renderTableWorkspace();
    }).catch(function (err) {
      window.SqlLoading.hideIn(resultBody);
      showError(String(err));
    });
  }

  function renderTableWorkspace() {
    var t = state.table;
    if (!t) return;
    var page = t.page || { columns: [], rows: [], has_more: false, elapsed_ms: 0 };
    resultTabs.innerHTML =
      tabButton("data", "Data", true) +
      tabButton("columns", "Kolom", false) +
      tabButton("messages", "Messages", false);

    function show(tab) {
      state.activeTab = tab;
      Array.prototype.forEach.call(resultTabs.querySelectorAll(".result-tab"), function (btn) {
        btn.className = "result-tab" + (btn.getAttribute("data-tab") === tab ? " active" : "");
      });
      if (tab === "columns") {
        var names = ["ordinal", "name", "data_type", "max_length", "is_nullable", "column_default"];
        var rows = (t.columns || []).map(function (col) {
          return names.map(function (key) { return col[key]; });
        });
        window.SqlGrid.render(resultBody, names, rows);
        return;
      }
      if (tab === "messages") {
        resultBody.innerHTML = '<pre class="msg-list">' +
          escapeHtml("Halaman " + (t.afterStack.length + 1) +
            " · paging " + (t.paging || "-") +
            (t.keys.length ? " · kunci " + t.keys.join(", ") : " · tanpa kunci, OFFSET hanya untuk halaman awal") +
            (page.sql ? "\n" + page.sql : "")) + "</pre>";
        return;
      }
      renderDataPane(page);
    }
    resultTabs.onclick = function (event) {
      var tab = event.target.getAttribute("data-tab");
      if (tab) show(tab);
    };
    show("data");
    setStatus(
      t.schema + "." + t.name,
      (t.rowCount != null ? formatCount(t.rowCount) + " baris total" : "jumlah tidak dihitung") +
        " · halaman " + formatCount(page.rows.length) +
        (page.elapsed_ms != null ? " · " + page.elapsed_ms + " ms" : "")
    );
  }

  function renderDataPane(page) {
    var t = state.table;
    resultBody.innerHTML = "";
    resultBody.className = "result-body result-body-table";
    var bar = document.createElement("div");
    bar.className = "table-bar";
    bar.innerHTML =
      '<div class="table-bar-info">' +
        "<strong>" + escapeHtml(t.schema + "." + t.name) + "</strong>" +
        '<span>' + (t.rowCount != null ? formatCount(t.rowCount) + " baris" : "view / jumlah tidak diketahui") + "</span>" +
        '<span>paging: ' + escapeHtml(t.paging || "-") + "</span>" +
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
      '<span>Halaman ' + (t.afterStack.length + 1) + (page.has_more ? "+" : "") + "</span>" +
      '<label>Ukuran <select id="page-size">' +
        [100, 200, 500, 1000].map(function (n) {
          return '<option value="' + n + '"' + (n === t.pageSize ? " selected" : "") + ">" +
            window.SqlFormat.integer(n) + "</option>";
        }).join("") +
      "</select></label>";
    resultBody.appendChild(bar);
    resultBody.appendChild(gridHost);
    resultBody.appendChild(pager);
    window.SqlGrid.render(gridHost, page.columns, page.rows, {
      truncated: page.has_more,
      truncatedText: "Ini satu halaman saja. Berikutnya / Export untuk data lain. Jangan SELECT * seluruh tabel."
    });

    document.getElementById("page-first").addEventListener("click", function () {
      t.afterStack = [];
      t.seek = null;
      t.offset = 0;
      loadTablePage();
    });
    document.getElementById("page-prev").addEventListener("click", function () {
      if (!t.afterStack.length && !t.seek) return;
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
  }

  function runQuery() {
    var sql = editor.value;
    if (!sql.trim()) {
      showError("SQL kosong.", "Tulis query di editor, atau klik tabel di Object Explorer.");
      return;
    }
    var unbounded = /select\s+\*\s+from/i.test(sql) && !/\btop\s+\d+/i.test(sql) && !/\boffset\s+\d+/i.test(sql);
    if (unbounded && !window.confirm("Query ini tanpa TOP/OFFSET. Aplikasi hanya menampilkan 1000 baris pertama. Untuk 100 juta baris, pakai pager tabel atau Export. Lanjut?")) {
      return;
    }
    document.getElementById("btn-export").disabled = !state.table;
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
      if (!data.ok) return showError(data.error, data.hint);
      renderQueryResult(data);
    }).catch(function (err) {
      showError(String(err));
    });
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
        truncatedText: "Query ad-hoc dipotong 1000 baris. Untuk tabel 100 juta+, buka dari Object Explorer lalu Export."
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

  document.getElementById("btn-run").addEventListener("click", runQuery);
  document.getElementById("btn-new").addEventListener("click", function () {
    editor.value = "";
    editor.focus();
    setStatus("Query baru", currentDb());
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
  document.getElementById("btn-backup").addEventListener("click", function () {
    window.SqlExport.openBackup({
      databases: state.databases,
      selected: currentDb()
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
  document.getElementById("btn-disconnect").addEventListener("click", function () {
    window.SqlLoading.show("Memutuskan koneksi", "Menutup sesi SQL Server dan membatalkan export yang masih jalan.");
    api("/api/disconnect", { method: "POST" }).then(function () {
      window.location.href = "/";
    });
  });
  dbSelect.addEventListener("change", function () {
    selectDatabase(dbSelect.value, true);
  });
  document.addEventListener("keydown", function (event) {
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
