(function (global) {
  var pollTimer = null;
  var currentJobId = null;
  var folderTarget = null;
  var folderPath = "";
  var defaultFolder = "";

  function $(id) {
    return document.getElementById(id);
  }

  function api(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().then(function (data) {
        return data;
      });
    });
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

  function loadDefaultFolder() {
    return api("/api/meta").then(function (data) {
      if (data.ok && data.default_folder) {
        defaultFolder = data.default_folder;
        if ($("export-folder") && !$("export-folder").value) $("export-folder").value = defaultFolder;
        if ($("db-export-folder") && !$("db-export-folder").value) $("db-export-folder").value = defaultFolder;
        if ($("backup-folder") && !$("backup-folder").value) $("backup-folder").value = defaultFolder;
      }
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
        String(col.name).replace(/"/g, "&quot;") + '"> <span>' +
        String(col.name) + (col.data_type ? " <em>(" + col.data_type + ")</em>" : "") + "</span>";
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
      objects.push({ schema: item.schema, name: item.name, row_count: item.row_count, kind: "table", is_system: item.is_system });
    });
    (ctx.views || []).forEach(function (item) {
      objects.push({ schema: item.schema, name: item.name, row_count: item.row_count, kind: "view", is_system: item.is_system });
    });
    $("db-export-modal")._objects = objects;
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
    box.innerHTML = "";
    var estimate = 0;
    var shown = 0;
    objects.forEach(function (item) {
      if (item.kind === "view" && !includeViews) return;
      shown += 1;
      if (item.row_count) estimate += Number(item.row_count) || 0;
      var label = document.createElement("label");
      label.className = "choice tight";
      label.innerHTML = '<input type="checkbox" checked data-schema="' +
        String(item.schema).replace(/"/g, "&quot;") + '" data-name="' +
        String(item.name).replace(/"/g, "&quot;") + '"> <span>' +
        item.schema + "." + item.name +
        (item.kind === "view" ? " <em>(view)</em>" : "") +
        (item.row_count != null ? " <em>· " + formatCount(item.row_count) + " baris</em>" : "") +
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
      nolock: $("db-export-nolock").checked
    };
    $("db-export-start").disabled = true;
    window.SqlLoading.showIn(
      $("db-export-modal").querySelector(".modal-card"),
      "Menyiapkan export database",
      "Setiap tabel ditulis ke folder yang dipilih."
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
      "Menulis ke folder yang dipilih, dipecah bertahap."
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
      "SQL Server akan menulis file .bak ke folder yang dipilih."
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
    loadFolder($(inputId).value || defaultFolder || "");
    $("folder-modal").hidden = false;
  }

  function loadFolder(path) {
    window.SqlLoading.showIn($("folder-modal").querySelector(".modal-card"), "Membaca folder", path || "Daftar drive");
    api("/api/fs?path=" + encodeURIComponent(path || "")).then(function (data) {
      window.SqlLoading.hideIn($("folder-modal").querySelector(".modal-card"));
      if (!data.ok) {
        $("folder-list").innerHTML = '<p class="form-error">' + (data.error || "Gagal membaca folder") + "</p>";
        return;
      }
      folderPath = data.path || "";
      $("folder-path").textContent = folderPath || "Drive";
      $("folder-up").disabled = !data.parent && data.path !== "";
      $("folder-up").setAttribute("data-parent", data.parent || "");
      var host = $("folder-list");
      host.innerHTML = "";
      (data.entries || []).forEach(function (entry) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "folder-item";
        btn.textContent = (entry.kind === "drive" ? "Disk " : "") + entry.name;
        btn.addEventListener("click", function () { loadFolder(entry.path); });
        host.appendChild(btn);
      });
      if (!(data.entries || []).length) {
        host.innerHTML = '<p class="empty-inline">Tidak ada subfolder.</p>';
      }
    });
  }

  function openJobs() {
    $("jobs-modal").hidden = false;
    refreshJobs();
  }

  function refreshJobs() {
    api("/api/exports").then(function (data) {
      if (!data.ok) return;
      renderJobs(data.jobs || []);
      updateBadge(data.jobs || []);
    });
  }

  function updateBadge(jobs) {
    var badge = $("export-badge");
    var active = jobs.filter(function (job) {
      return job.status === "running" || job.status === "queued" || job.status === "cancelling";
    }).length;
    if (!badge) return;
    badge.hidden = active === 0;
    badge.textContent = String(active);
  }

  function renderJobs(jobs) {
    var host = $("jobs-body");
    if (!jobs.length) {
      host.innerHTML = '<div class="empty-state"><h3>Belum ada job</h3><p>Export CSV atau backup .bak muncul di sini. File sudah ada di folder yang Anda pilih.</p></div>';
      return;
    }
    host.innerHTML = "";
    jobs.slice().reverse().forEach(function (job) {
      var card = document.createElement("div");
      card.className = "job-card";
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
        if (job.current_object && (job.status === "running" || job.status === "queued")) {
          title += " · " + job.current_object;
        }
      } else {
        title = "Export " + (job.schema ? job.schema + "." : "") + job.table;
      }
      var parts = (job.parts || []).map(function (part) {
        return '<a class="job-file" href="/api/export/' + job.id + "/parts/" + encodeURIComponent(part.name) +
          '">' + part.name + (part.rows ? " · " + formatCount(part.rows) + " baris" : "") +
          " · " + formatBytes(part.bytes) + "</a>";
      }).join("");
      card.innerHTML =
        "<h4>" + title + "</h4>" +
        '<p class="job-meta">' + job.status +
        (job.rows_written ? " · " + formatCount(job.rows_written) +
          (job.row_count_estimate != null ? " / " + formatCount(job.row_count_estimate) : "") + " baris" : "") +
        pct + " · " + formatBytes(job.bytes_written) + "</p>" +
        (job.folder ? '<p class="job-meta">' + job.folder + "</p>" : "") +
        (job.error ? '<p class="form-error">' + job.error + (job.hint ? " — " + job.hint : "") + "</p>" : "") +
        '<div class="job-files">' + (parts || "<span class='job-meta'>Belum ada file siap.</span>") + "</div>" +
        (job.status === "running" || job.status === "queued" || job.status === "cancelling"
          ? '<button type="button" class="btn-secondary" data-cancel="' + job.id + '">Batalkan</button>'
          : "");
      host.appendChild(card);
    });
  }

  function pollJob(jobId) {
    currentJobId = jobId;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      api("/api/export/" + jobId).then(function (data) {
        if (!data.ok) return;
        refreshJobs();
        if (data.job.status === "done" || data.job.status === "error" || data.job.status === "cancelled") {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      });
    }, 1000);
  }

  function bind() {
    window.SqlSelect.mount($("export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("export-chunk"), { placeholder: "Cari baris..." });
    window.SqlSelect.mount($("backup-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("db-export-chunk-mode"), { placeholder: "Cari..." });
    window.SqlSelect.mount($("db-export-chunk-size"), { placeholder: "Cari ukuran..." });
    window.SqlSelect.mount($("db-export-chunk"), { placeholder: "Cari baris..." });
    window.SqlFormat.bindInput($("export-chunk-custom"), { min: 1, max: 1024 });
    window.SqlFormat.bindInput($("db-export-chunk-custom"), { min: 1, max: 1024 });
    $("export-chunk-mode").addEventListener("change", syncChunkMode);
    $("export-chunk-size").addEventListener("change", syncChunkMode);
    $("db-export-chunk-mode").addEventListener("change", syncDbChunkMode);
    $("db-export-chunk-size").addEventListener("change", syncDbChunkMode);
    $("export-close").addEventListener("click", function () { $("export-modal").hidden = true; });
    $("db-export-close").addEventListener("click", function () { $("db-export-modal").hidden = true; });
    $("backup-close").addEventListener("click", function () { $("backup-modal").hidden = true; });
    $("jobs-close").addEventListener("click", function () { $("jobs-modal").hidden = true; });
    $("folder-close").addEventListener("click", function () { $("folder-modal").hidden = true; });
    $("export-start").addEventListener("click", startExport);
    $("db-export-start").addEventListener("click", startDatabaseExport);
    $("backup-start").addEventListener("click", startBackup);
    $("export-browse").addEventListener("click", function () { openFolderPicker("export-folder"); });
    $("db-export-browse").addEventListener("click", function () { openFolderPicker("db-export-folder"); });
    $("backup-browse").addEventListener("click", function () { openFolderPicker("backup-folder"); });
    $("db-export-views").addEventListener("change", renderDbExportTables);
    $("db-export-all").addEventListener("click", function () {
      Array.prototype.forEach.call($("db-export-tables").querySelectorAll("input"), function (box) { box.checked = true; });
    });
    $("db-export-none").addEventListener("click", function () {
      Array.prototype.forEach.call($("db-export-tables").querySelectorAll("input"), function (box) { box.checked = false; });
    });
    $("folder-up").addEventListener("click", function () {
      loadFolder($("folder-up").getAttribute("data-parent") || "");
    });
    $("folder-use").addEventListener("click", function () {
      if (folderTarget) $(folderTarget).value = folderPath || defaultFolder;
      $("folder-modal").hidden = true;
    });
    $("export-all").addEventListener("click", function () {
      Array.prototype.forEach.call($("export-columns").querySelectorAll("input"), function (box) { box.checked = true; });
    });
    $("export-none").addEventListener("click", function () {
      Array.prototype.forEach.call($("export-columns").querySelectorAll("input"), function (box) { box.checked = false; });
    });
    $("btn-jobs").addEventListener("click", openJobs);
    $("jobs-body").addEventListener("click", function (event) {
      var id = event.target.getAttribute("data-cancel");
      if (!id) return;
      api("/api/export/" + id + "/cancel", { method: "POST" }).then(refreshJobs);
    });
    ["export-modal", "db-export-modal", "backup-modal", "jobs-modal", "folder-modal"].forEach(function (id) {
      $(id).addEventListener("click", function (event) {
        if (event.target === $(id)) $(id).hidden = true;
      });
    });
    syncChunkMode();
    syncDbChunkMode();
    loadDefaultFolder();
    refreshJobs();
  }

  global.SqlExport = {
    openDialog: openDialog,
    openDatabaseExport: openDatabaseExport,
    openBackup: openBackup,
    openJobs: openJobs,
    bind: bind,
    formatCount: formatCount
  };
})(window);
