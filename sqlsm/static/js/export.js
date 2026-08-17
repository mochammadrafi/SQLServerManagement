(function (global) {
  var pollTimer = null;
  var currentJobId = null;
  var folderTarget = null;
  var folderPath = "";
  var defaultFolder = "";
  var dbExportSort = "name";
  var exportLimits = { max_workers: 32, max_jobs: 24, max_total_workers: 64 };

  function $(id) {
    return document.getElementById(id);
  }

  function api(url, options) {
    return window.SqlApi.request(url, options);
  }

  function formatCount(n) {
    if (n == null || n === "") return "-";
    return window.SqlFormat.integer(n);
  }

  function formatBytes(n) {
    n = Number(n || 0);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function formatSizeKb(kb) {
    if (kb == null || kb === "") return "";
    return formatBytes(Number(kb) * 1024);
  }

  function isActiveJob(job) {
    return job.status === "running" || job.status === "queued" ||
      job.status === "cancelling" || job.status === "paused";
  }

  function statusLabel(status) {
    var map = {
      queued: "Antrian",
      running: "Berjalan",
      paused: "Dijeda",
      cancelling: "Membatalkan",
      cancelled: "Dibatalkan",
      done: "Selesai",
      error: "Gagal"
    };
    return map[status] || status || "";
  }

  function objectName(item) {
    return String(item.schema || "") + "." + String(item.name || "");
  }

  function sortObjects(items, sort) {
    var list = (items || []).slice();
    function nameKey(item) {
      return objectName(item).toLowerCase();
    }
    function num(value) {
      return value == null || value === "" ? -1 : Number(value);
    }
    list.sort(function (a, b) {
      if (sort === "rows") {
        var rows = num(b.row_count) - num(a.row_count);
        return rows || nameKey(a).localeCompare(nameKey(b));
      }
      if (sort === "size") {
        var size = num(b.size_kb) - num(a.size_kb);
        if (size) return size;
        var byRows = num(b.row_count) - num(a.row_count);
        return byRows || nameKey(a).localeCompare(nameKey(b));
      }
      return nameKey(a).localeCompare(nameKey(b));
    });
    return list;
  }

  function applyExportLimits(limits) {
    if (!limits) return;
    exportLimits.max_workers = Number(limits.max_workers || exportLimits.max_workers);
    exportLimits.max_jobs = Number(limits.max_jobs || exportLimits.max_jobs);
    exportLimits.max_total_workers = Number(limits.max_total_workers || exportLimits.max_total_workers);
    var hint = $("db-export-workers-hint");
    if (hint) {
      hint.textContent = "Beberapa tabel diexport bersamaan. Isi 1–" +
        exportLimits.max_workers + " thread. Kalau slot penuh, jumlahnya disesuaikan sendiri (maks " +
        exportLimits.max_total_workers + " worker / " + exportLimits.max_jobs +
        " job sekaligus). Beberapa export bisa jalan bersama.";
    }
    var input = $("db-export-workers");
    if (input && window.SqlFormat && !input._exportBound) {
      window.SqlFormat.bindInput(input, { min: 1, max: exportLimits.max_workers });
      input._exportBound = true;
    }
  }

  function loadDefaultFolder() {
    return api("/api/meta").then(function (data) {
      if (!data.ok) return;
      if (data.default_folder) {
        defaultFolder = data.default_folder;
        if ($("export-folder") && !$("export-folder").value) $("export-folder").value = defaultFolder;
        if ($("db-export-folder") && !$("db-export-folder").value) $("db-export-folder").value = defaultFolder;
        if ($("backup-folder") && !$("backup-folder").value) $("backup-folder").value = defaultFolder;
      }
      applyExportLimits(data.export_limits);
    });
  }

  function syncChunkMode() {
    var mode = $("export-chunk-mode").value;
    $("export-chunk-size-wrap").hidden = mode !== "size";
    $("export-chunk-rows-wrap").hidden = mode !== "rows";
    $("export-chunk-custom-wrap").hidden = mode !== "size" || $("export-chunk-size").value !== "custom";
  }

  function syncDbChunkMode() {
    var mode = $("db-export-chunk-mode").value;
    $("db-export-chunk-size-wrap").hidden = mode !== "size";
    $("db-export-chunk-rows-wrap").hidden = mode !== "rows";
    $("db-export-chunk-custom-wrap").hidden = mode !== "size" || $("db-export-chunk-size").value !== "custom";
  }

  function chunkBytesFromUi(sizeId, customId) {
    var selected = $(sizeId).value;
    if (selected === "custom") {
      var gb = window.SqlFormat.parseInteger($(customId).value);
      if (!gb || gb < 1) return null;
      return gb * 1024 * 1024 * 1024;
    }
    return Number(selected || 0);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function openDialog(ctx) {
    $("export-target").textContent = ctx.database + "." + ctx.schema + "." + ctx.table;
    var estimate = ctx.rowCount;
    var warn = $("export-warn");
    if (estimate && estimate >= 1000000) {
      warn.hidden = false;
      warn.textContent = "Tabel ini sekitar " + formatCount(estimate) +
        " baris. Export penuh bisa puluhan GB. Pecah per 10 GB, atau filter WHERE.";
    } else {
      warn.hidden = !estimate;
      warn.textContent = estimate ? "Perkiraan " + formatCount(estimate) + " baris." : "";
    }
    var box = $("export-columns");
    box.innerHTML = "";
    (ctx.columns || []).forEach(function (col) {
      var label = document.createElement("label");
      label.className = "choice tight";
      label.innerHTML = '<input type="checkbox" checked data-col="' +
        escapeHtml(col.name) + '"> <span>' +
        escapeHtml(col.name) + (col.data_type ? " <em>(" + escapeHtml(col.data_type) + ")</em>" : "") + "</span>";
      box.appendChild(label);
    });
    $("export-where").value = "";
    if (!$("export-folder").value) $("export-folder").value = defaultFolder;
    $("export-error").hidden = true;
    $("export-modal").hidden = false;
    window.SqlSelect.mount($("export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("export-chunk"), { placeholder: "Cari baris..." });
    syncChunkMode();
    $("export-modal").setAttribute("data-db", ctx.database);
    $("export-modal").setAttribute("data-schema", ctx.schema);
    $("export-modal").setAttribute("data-table", ctx.table);
  }

  function openDatabaseExport(ctx) {
    ctx = ctx || {};
    $("db-export-target").textContent = ctx.database || "";
    $("db-export-modal").setAttribute("data-db", ctx.database || "");
    var objects = [];
    (ctx.tables || []).forEach(function (item) {
      objects.push({
        schema: item.schema,
        name: item.name,
        row_count: item.row_count,
        size_kb: item.size_kb,
        kind: "table",
        is_system: item.is_system
      });
    });
    (ctx.views || []).forEach(function (item) {
      objects.push({
        schema: item.schema,
        name: item.name,
        row_count: item.row_count,
        size_kb: item.size_kb,
        kind: "view",
        is_system: item.is_system
      });
    });
    $("db-export-modal")._objects = objects;
    if ($("db-export-sort")) {
      window.SqlSelect.mount($("db-export-sort"), { placeholder: "Urutkan..." });
      if ($("db-export-sort")._sqlSelect) $("db-export-sort")._sqlSelect.setValue(dbExportSort);
      else $("db-export-sort").value = dbExportSort;
    }
    applyExportLimits(exportLimits);
    renderDbExportTables();
    if (!$("db-export-folder").value) $("db-export-folder").value = defaultFolder;
    $("db-export-error").hidden = true;
    $("db-export-modal").hidden = false;
    window.SqlSelect.mount($("db-export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("db-export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("db-export-chunk"), { placeholder: "Cari baris..." });
    syncDbChunkMode();
  }

  function renderDbExportTables() {
    var objects = $("db-export-modal")._objects || [];
    var includeViews = $("db-export-views").checked;
    var box = $("db-export-tables");
    var prev = {};
    Array.prototype.forEach.call(box.querySelectorAll("input[type=checkbox]"), function (input) {
      prev[input.getAttribute("data-schema") + "\0" + input.getAttribute("data-name")] = input.checked;
    });
    var hasPrev = Object.keys(prev).length > 0;
    box.innerHTML = "";
    var estimate = 0;
    var shown = 0;
    var visible = objects.filter(function (item) {
      return item.kind !== "view" || includeViews;
    });
    sortObjects(visible, dbExportSort).forEach(function (item) {
      shown += 1;
      if (item.row_count) estimate += Number(item.row_count) || 0;
      var key = item.schema + "\0" + item.name;
      var checked = hasPrev ? prev[key] !== false : true;
      var meta = [];
      if (item.kind === "view") meta.push("view");
      if (item.row_count != null) meta.push(formatCount(item.row_count) + " baris");
      if (item.size_kb != null) meta.push(formatSizeKb(item.size_kb));
      var label = document.createElement("label");
      label.className = "choice tight";
      label.innerHTML = '<input type="checkbox"' + (checked ? " checked" : "") +
        ' data-schema="' + escapeHtml(item.schema) + '" data-name="' +
        escapeHtml(item.name) + '"> <span>' +
        escapeHtml(item.schema + "." + item.name) +
        (meta.length ? " <em>· " + escapeHtml(meta.join(" · ")) + "</em>" : "") +
        "</span>";
      box.appendChild(label);
    });
    var warn = $("db-export-warn");
    if (!shown) {
      warn.hidden = false;
      warn.textContent = "Tidak ada tabel yang bisa di-export.";
    } else if (estimate >= 1000000) {
      warn.hidden = false;
      warn.textContent = "Perkiraan " + formatCount(estimate) +
        " baris di " + shown + " objek. Export penuh bisa puluhan GB. Pecah per 10 GB.";
    } else {
      warn.hidden = false;
      warn.textContent = shown + " objek" + (estimate ? " · perkiraan " + formatCount(estimate) + " baris" : "") + ".";
    }
  }

  function selectedDbTables() {
    var picked = [];
    Array.prototype.forEach.call($("db-export-tables").querySelectorAll("input[type=checkbox]"), function (box) {
      if (box.checked) {
        picked.push({
          schema: box.getAttribute("data-schema"),
          name: box.getAttribute("data-name")
        });
      }
    });
    return picked;
  }

  function startDatabaseExport() {
    var error = $("db-export-error");
    error.hidden = true;
    var tables = selectedDbTables();
    if (!tables.length) {
      error.hidden = false;
      error.textContent = "Pilih minimal satu tabel.";
      return;
    }
    var mode = $("db-export-chunk-mode").value;
    var chunkRows = 0;
    var chunkBytes = 0;
    if (mode === "rows") {
      chunkRows = Number($("db-export-chunk").value || 0);
    } else if (mode === "size") {
      chunkBytes = chunkBytesFromUi("db-export-chunk-size", "db-export-chunk-custom");
      if (chunkBytes == null) {
        error.hidden = false;
        error.textContent = "Isi ukuran kustom dalam GB, minimal 1.";
        return;
      }
    }
    var body = {
      database: $("db-export-modal").getAttribute("data-db"),
      tables: tables,
      include_views: $("db-export-views").checked,
      folder: $("db-export-folder").value,
      chunk_rows: chunkRows,
      chunk_bytes: chunkBytes,
      gzip: $("db-export-gzip").checked,
      nolock: $("db-export-nolock").checked,
      workers: window.SqlFormat.parseInteger($("db-export-workers").value) || 3
    };
    $("db-export-start").disabled = true;
    window.SqlLoading.showIn(
      $("db-export-modal").querySelector(".modal-card"),
      "Menyiapkan export database",
      "Setiap tabel ditulis ke folder yang dipilih.",
      { track: false }
    );
    api("/api/export/database", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (data) {
      $("db-export-start").disabled = false;
      window.SqlLoading.hideIn($("db-export-modal").querySelector(".modal-card"));
      if (!data.ok) {
        error.hidden = false;
        error.textContent = data.error + (data.hint ? " — " + data.hint : "");
        return;
      }
      $("db-export-modal").hidden = true;
      currentJobId = data.job.id;
      openJobs();
      pollJob(data.job.id);
    }).catch(function (err) {
      $("db-export-start").disabled = false;
      window.SqlLoading.hideIn($("db-export-modal").querySelector(".modal-card"));
      error.hidden = false;
      error.textContent = String(err);
    });
  }

  function selectedColumns() {
    var picked = [];
    Array.prototype.forEach.call($("export-columns").querySelectorAll("input[type=checkbox]"), function (box) {
      if (box.checked) picked.push(box.getAttribute("data-col"));
    });
    return picked;
  }

  function startExport() {
    var error = $("export-error");
    error.hidden = true;
    var columns = selectedColumns();
    if (!columns.length) {
      error.hidden = false;
      error.textContent = "Pilih minimal satu kolom.";
      return;
    }
    var mode = $("export-chunk-mode").value;
    var chunkRows = 0;
    var chunkBytes = 0;
    if (mode === "rows") {
      chunkRows = Number($("export-chunk").value || 0);
    } else if (mode === "size") {
      chunkBytes = chunkBytesFromUi("export-chunk-size", "export-chunk-custom");
      if (chunkBytes == null) {
        error.hidden = false;
        error.textContent = "Isi ukuran kustom dalam GB, minimal 1.";
        return;
      }
    }
    var body = {
      database: $("export-modal").getAttribute("data-db"),
      schema: $("export-modal").getAttribute("data-schema"),
      table: $("export-modal").getAttribute("data-table"),
      columns: columns,
      where: $("export-where").value,
      folder: $("export-folder").value,
      chunk_rows: chunkRows,
      chunk_bytes: chunkBytes,
      gzip: $("export-gzip").checked,
      nolock: $("export-nolock").checked
    };
    $("export-start").disabled = true;
    window.SqlLoading.showIn(
      $("export-modal").querySelector(".modal-card"),
      "Menyiapkan export",
      "Menulis ke folder yang dipilih, dipecah bertahap.",
      { track: false }
    );
    api("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (data) {
      $("export-start").disabled = false;
      window.SqlLoading.hideIn($("export-modal").querySelector(".modal-card"));
      if (!data.ok) {
        error.hidden = false;
        error.textContent = data.error + (data.hint ? " — " + data.hint : "");
        return;
      }
      $("export-modal").hidden = true;
      currentJobId = data.job.id;
      openJobs();
      pollJob(data.job.id);
    }).catch(function (err) {
      $("export-start").disabled = false;
      window.SqlLoading.hideIn($("export-modal").querySelector(".modal-card"));
      error.hidden = false;
      error.textContent = String(err);
    });
  }

  function openBackup(ctx) {
    ctx = ctx || {};
    var select = $("backup-database");
    var widget = select._sqlSelect || window.SqlSelect.mount(select, { placeholder: "Cari database..." });
    widget.setOptions((ctx.databases || []).map(function (db) {
      return { value: db.name, label: db.name };
    }), ctx.selected || "");
    if (!$("backup-folder").value) $("backup-folder").value = defaultFolder;
    $("backup-error").hidden = true;
    $("backup-modal").hidden = false;
    window.SqlSelect.mount($("backup-chunk-size"), { placeholder: "Cari ukuran..." });
  }

  function startBackup() {
    var error = $("backup-error");
    error.hidden = true;
    var body = {
      database: $("backup-database").value,
      folder: $("backup-folder").value,
      chunk_bytes: Number($("backup-chunk-size").value || 0),
      compress: $("backup-compress").checked
    };
    if (!body.database) {
      error.hidden = false;
      error.textContent = "Pilih database.";
      return;
    }
    $("backup-start").disabled = true;
    window.SqlLoading.showIn(
      $("backup-modal").querySelector(".modal-card"),
      "Menyiapkan backup",
      "SQL Server akan menulis file .bak ke folder yang dipilih.",
      { track: false }
    );
    api("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (data) {
      $("backup-start").disabled = false;
      window.SqlLoading.hideIn($("backup-modal").querySelector(".modal-card"));
      if (!data.ok) {
        error.hidden = false;
        error.textContent = data.error + (data.hint ? " — " + data.hint : "");
        return;
      }
      $("backup-modal").hidden = true;
      currentJobId = data.job.id;
      openJobs();
      pollJob(data.job.id);
    }).catch(function (err) {
      $("backup-start").disabled = false;
      window.SqlLoading.hideIn($("backup-modal").querySelector(".modal-card"));
      error.hidden = false;
      error.textContent = String(err);
    });
  }

  function openFolderPicker(inputId) {
    folderTarget = inputId;
    var start = ($(inputId) && $(inputId).value) || defaultFolder || "";
    $("folder-modal").hidden = false;
    loadFolder(start);
  }

  function renderFolderEntries(host, entries, onClick) {
    host.innerHTML = "";
    (entries || []).forEach(function (entry) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = entry.kind === "shortcut" ? "btn-tiny" : "folder-item";
      btn.textContent = (entry.kind === "drive" ? "Disk " : "") + entry.name;
      btn.addEventListener("click", function () { onClick(entry.path); });
      host.appendChild(btn);
    });
  }

  function loadFolder(path) {
    var card = $("folder-modal").querySelector(".modal-card");
    window.SqlLoading.showIn(card, "Membaca folder", path || "Folder awal", { track: false });
    api("/api/fs?path=" + encodeURIComponent(path || "")).then(function (data) {
      window.SqlLoading.hideIn(card);
      if (!data.ok) {
        $("folder-list").innerHTML = '<p class="form-error">' +
          (data.error || "Gagal membaca folder") +
          (data.hint ? " — " + data.hint : "") + "</p>";
        return;
      }
      folderPath = data.path || "";
      $("folder-path").textContent = folderPath || "Pilih folder";
      $("folder-up").disabled = !data.parent && data.path !== "";
      $("folder-up").setAttribute("data-parent", data.parent || "");
      renderFolderEntries($("folder-shortcuts"), data.shortcuts || [], loadFolder);
      renderFolderEntries($("folder-list"), data.entries || [], loadFolder);
      if (!(data.entries || []).length) {
        $("folder-list").innerHTML = '<p class="empty-inline">Tidak ada subfolder. Pakai folder ini, atau naik dulu.</p>';
      }
    }).catch(function (err) {
      window.SqlLoading.hideIn(card);
      $("folder-list").innerHTML = '<p class="form-error">' + String(err) + "</p>";
    });
  }

  function openJobs() {
    $("jobs-modal").hidden = false;
    refreshJobs();
  }

  function refreshJobs() {
    api("/api/exports", { background: true }).then(function (data) {
      if (!data.ok) return;
      updateBadge(data.jobs || []);
      if ($("jobs-modal") && !$("jobs-modal").hidden) {
        renderJobs(data.jobs || []);
      }
      syncWatch(data.jobs || []);
    });
  }

  function updateBadge(jobs) {
    var badge = $("export-badge");
    var active = jobs.filter(isActiveJob).length;
    if (!badge) return;
    badge.hidden = active === 0;
    badge.textContent = String(active);
  }

  function renderJobTables(job) {
    var currents = job.current_objects || [];
    if (!currents.length && job.current_object && isActiveJob(job)) {
      currents = [{ schema: "", name: job.current_object, rows_written: job.rows_written, status: job.status }];
    }
    var html = "";
    if (currents.length) {
      html += '<div class="job-now"><p class="job-now-label">Sedang diexport</p>';
      currents.forEach(function (item) {
        html += '<div class="job-now-item">' +
          '<strong>' + escapeHtml(item.schema ? objectName(item) : (item.name || "")) + "</strong>" +
          '<span>' + escapeHtml(statusLabel(item.status || job.status)) +
          (item.rows_written ? " · " + formatCount(item.rows_written) + " baris" : "") +
          "</span></div>";
      });
      html += "</div>";
    }
    var tables = job.tables || [];
    if (!tables.length) return html;
    var queued = 0;
    var running = 0;
    tables.forEach(function (item) {
      if (item.status === "queued") queued += 1;
      if (item.status === "running" || item.status === "paused") running += 1;
    });
    html += '<p class="job-meta">Antrian ' + queued + " · aktif " + running +
      (job.workers ? " · " + job.workers + " worker" : "") + "</p>";
    html += '<div class="job-tables">';
    tables.forEach(function (item) {
      html += '<div class="job-table is-' + escapeHtml(item.status || "queued") + '">' +
        "<span>" + escapeHtml(objectName(item)) + "</span>" +
        "<em>" + escapeHtml(statusLabel(item.status)) +
        (item.rows_written ? " · " + formatCount(item.rows_written) : "") +
        (item.error ? " · " + escapeHtml(item.error) : "") +
        "</em></div>";
    });
    html += "</div>";
    return html;
  }

  function renderJobs(jobs) {
    var host = $("jobs-body");
    var bodyScroll = host.scrollTop;
    var tableScrolls = [];
    Array.prototype.forEach.call(host.querySelectorAll(".job-tables"), function (el) {
      tableScrolls.push(el.scrollTop);
    });
    if (!jobs.length) {
      host.innerHTML = '<div class="empty-state"><h3>Belum ada job</h3><p>Export CSV atau backup .bak muncul di sini. File sudah ada di folder yang Anda pilih.</p></div>';
      return;
    }
    host.innerHTML = "";
    jobs.slice().reverse().forEach(function (job) {
      var card = document.createElement("div");
      card.className = "job-card" + (isActiveJob(job) ? " is-active" : "");
      var pct = "";
      if (job.row_count_estimate && job.rows_written) {
        pct = " · " + Math.min(100, Math.round(job.rows_written / job.row_count_estimate * 100)) + "%";
      }
      var title;
      if (job.kind === "backup") {
        title = "Backup " + job.database;
      } else if (job.kind === "export_db") {
        title = "Export database " + job.database;
        if (job.tables_total) {
          title += " · " + (job.tables_done || 0) + "/" + job.tables_total + " tabel";
        }
      } else {
        title = "Export " + (job.schema ? job.schema + "." : "") + job.table;
      }
      var parts = (job.parts || []).map(function (part) {
        return '<a class="job-file" href="/api/export/' + encodeURIComponent(job.id) + "/parts/" + encodeURIComponent(part.name) +
          '">' + escapeHtml(part.name) + (part.rows ? " · " + formatCount(part.rows) + " baris" : "") +
          " · " + formatBytes(part.bytes) + "</a>";
      }).join("");
      var actions = "";
      if (job.can_pause) {
        actions += '<button type="button" class="btn-secondary" data-pause="' + escapeHtml(job.id) + '">Jeda</button>';
      }
      if (job.can_resume) {
        actions += '<button type="button" class="btn-primary" data-resume="' + escapeHtml(job.id) + '">Lanjut</button>';
      }
      if (job.can_cancel) {
        actions += '<button type="button" class="btn-secondary" data-cancel="' + escapeHtml(job.id) + '"' +
          (job.status === "cancelling" ? " disabled" : "") + ">" +
          (job.status === "cancelling" ? "Membatalkan..." : "Batalkan") + "</button>";
      }
      card.innerHTML =
        "<h4>" + escapeHtml(title) + "</h4>" +
        '<p class="job-meta"><span class="job-status is-' + escapeHtml(job.status) + '">' +
        escapeHtml(statusLabel(job.status)) + "</span>" +
        (job.rows_written ? " · " + formatCount(job.rows_written) +
          (job.row_count_estimate != null ? " / " + formatCount(job.row_count_estimate) : "") + " baris" : "") +
        pct + " · " + formatBytes(job.bytes_written) +
        (job.workers && job.kind === "export_db" ? " · " + job.workers + " worker" : "") + "</p>" +
        (job.folder ? '<p class="job-meta">' + escapeHtml(job.folder) + "</p>" : "") +
        (job.error ? '<p class="form-error">' + escapeHtml(job.error) + (job.hint ? " — " + escapeHtml(job.hint) : "") + "</p>" : "") +
        renderJobTables(job) +
        '<div class="job-files">' + (parts || "<span class='job-meta'>Belum ada file siap.</span>") + "</div>" +
        (actions ? '<div class="job-actions">' + actions + "</div>" : "");
      host.appendChild(card);
    });
    host.scrollTop = bodyScroll;
    Array.prototype.forEach.call(host.querySelectorAll(".job-tables"), function (el, index) {
      if (tableScrolls[index] != null) el.scrollTop = tableScrolls[index];
    });
  }

  function syncWatch(jobs) {
    var active = (jobs || []).some(isActiveJob);
    var modalOpen = $("jobs-modal") && !$("jobs-modal").hidden;
    if ((active || modalOpen) && !pollTimer) {
      pollTimer = setInterval(refreshJobs, 1000);
    }
    if (!active && !modalOpen && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollJob(jobId) {
    currentJobId = jobId;
    refreshJobs();
  }

  function bind() {
    window.SqlSelect.mount($("export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("export-chunk"), { placeholder: "Cari baris..." });
    window.SqlSelect.mount($("backup-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("db-export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("db-export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("db-export-chunk"), { placeholder: "Cari baris..." });
    window.SqlSelect.mount($("db-export-sort"), { placeholder: "Urutkan..." });
    window.SqlFormat.bindInput($("export-chunk-custom"), { min: 1, max: 1024 });
    window.SqlFormat.bindInput($("db-export-chunk-custom"), { min: 1, max: 1024 });
    $("export-chunk-mode").addEventListener("change", syncChunkMode);
    $("export-chunk-size").addEventListener("change", syncChunkMode);
    $("db-export-chunk-mode").addEventListener("change", syncDbChunkMode);
    $("db-export-chunk-size").addEventListener("change", syncDbChunkMode);
    $("export-close").addEventListener("click", function () { $("export-modal").hidden = true; });
    $("db-export-close").addEventListener("click", function () { $("db-export-modal").hidden = true; });
    $("backup-close").addEventListener("click", function () { $("backup-modal").hidden = true; });
    $("jobs-close").addEventListener("click", function () {
      $("jobs-modal").hidden = true;
      refreshJobs();
    });
    if ($("folder-close")) {
      $("folder-close").addEventListener("click", function () { $("folder-modal").hidden = true; });
    }
    if ($("folder-up")) {
      $("folder-up").addEventListener("click", function () {
        loadFolder($("folder-up").getAttribute("data-parent") || "");
      });
    }
    if ($("folder-use")) {
      $("folder-use").addEventListener("click", function () {
        if (folderTarget) $(folderTarget).value = folderPath || defaultFolder;
        $("folder-modal").hidden = true;
      });
    }
    $("export-start").addEventListener("click", startExport);
    $("db-export-start").addEventListener("click", startDatabaseExport);
    $("backup-start").addEventListener("click", startBackup);
    $("export-browse").addEventListener("click", function () { openFolderPicker("export-folder"); });
    $("db-export-browse").addEventListener("click", function () { openFolderPicker("db-export-folder"); });
    $("backup-browse").addEventListener("click", function () { openFolderPicker("backup-folder"); });
    $("db-export-views").addEventListener("change", renderDbExportTables);
    $("db-export-sort").addEventListener("change", function () {
      dbExportSort = $("db-export-sort").value || "name";
      renderDbExportTables();
    });
    $("db-export-all").addEventListener("click", function () {
      Array.prototype.forEach.call($("db-export-tables").querySelectorAll("input"), function (box) { box.checked = true; });
    });
    $("db-export-none").addEventListener("click", function () {
      Array.prototype.forEach.call($("db-export-tables").querySelectorAll("input"), function (box) { box.checked = false; });
    });
    $("export-all").addEventListener("click", function () {
      Array.prototype.forEach.call($("export-columns").querySelectorAll("input"), function (box) { box.checked = true; });
    });
    $("export-none").addEventListener("click", function () {
      Array.prototype.forEach.call($("export-columns").querySelectorAll("input"), function (box) { box.checked = false; });
    });
    $("btn-jobs").addEventListener("click", openJobs);
    $("jobs-body").addEventListener("click", function (event) {
      var cancelId = event.target.getAttribute("data-cancel");
      var pauseId = event.target.getAttribute("data-pause");
      var resumeId = event.target.getAttribute("data-resume");
      var url = "";
      if (cancelId) url = "/api/export/" + cancelId + "/cancel";
      else if (pauseId) url = "/api/export/" + pauseId + "/pause";
      else if (resumeId) url = "/api/export/" + resumeId + "/resume";
      if (!url) return;
      event.target.disabled = true;
      api(url, { method: "POST" }).then(refreshJobs).catch(function () {
        event.target.disabled = false;
      });
    });
    ["export-modal", "db-export-modal", "backup-modal", "jobs-modal", "folder-modal"].forEach(function (id) {
      $(id).addEventListener("click", function (event) {
        if (event.target !== $(id)) return;
        $(id).hidden = true;
        if (id === "jobs-modal") refreshJobs();
      });
    });
    syncChunkMode();
    syncDbChunkMode();
    applyExportLimits(exportLimits);
    loadDefaultFolder();
  }

  global.SqlExport = {
    openDialog: openDialog,
    openDatabaseExport: openDatabaseExport,
    openBackup: openBackup,
    openJobs: openJobs,
    bind: bind,
    refreshJobs: refreshJobs,
    formatCount: formatCount,
    formatBytes: formatBytes,
    formatSizeKb: formatSizeKb,
    sortObjects: sortObjects
  };
})(window);
