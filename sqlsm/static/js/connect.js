(function () {
  var form = document.getElementById("connect-form");
  var errorBox = document.getElementById("form-error");
  var sqlFields = document.getElementById("sql-auth-fields");
  var driverNote = document.getElementById("driver-note");
  var connectBtn = document.getElementById("connect-btn");
  var savedBox = document.getElementById("saved-profiles");
  var selectedProfileId = "";
  var portInput = window.SqlFormat.bindInput(document.getElementById("port"), { min: 1, max: 65535 });
  var dbSelect = window.SqlSelect.mount(document.getElementById("database"), {
    placeholder: "Cari atau ketik nama database",
    allowCustom: true
  });

  function showError(message, hint) {
    errorBox.hidden = false;
    errorBox.textContent = hint ? message + " — " + hint : message;
  }

  function setAuthMode() {
    var windows = document.getElementById("auth-windows").checked;
    sqlFields.hidden = windows;
  }

  function fillForm(profile) {
    document.getElementById("server").value = profile.server || "localhost";
    portInput.set(profile.port || 1433);
    document.getElementById("instance").value = profile.instance || "";
    document.getElementById("auth-windows").checked = profile.auth === "windows";
    document.getElementById("auth-sql").checked = profile.auth !== "windows";
    document.getElementById("username").value = profile.username || "sa";
    document.getElementById("password").value = "";
    document.getElementById("password").placeholder = profile.has_password ? "Tersimpan di komputer ini" : "";
    document.getElementById("remember-password").checked = !!profile.remember_password;
    document.getElementById("encrypt").checked = !!profile.encrypt;
    if (dbSelect && dbSelect.setValue) dbSelect.setValue(profile.database || "master");
    else document.getElementById("database").value = profile.database || "master";
    selectedProfileId = profile.id || "";
    setAuthMode();
  }

  function renderProfiles(profiles) {
    if (!savedBox) return;
    if (!profiles || !profiles.length) {
      savedBox.hidden = true;
      savedBox.innerHTML = "";
      return;
    }
    savedBox.hidden = false;
    savedBox.innerHTML = "<h3>Koneksi tersimpan</h3>";
    profiles.forEach(function (profile) {
      var row = document.createElement("div");
      row.className = "saved-item";
      var pick = document.createElement("button");
      pick.type = "button";
      pick.className = "saved-pick";
      pick.innerHTML = "<strong>" + escapeHtml(profile.label) + "</strong><span>" +
        escapeHtml(profile.has_password || profile.auth === "windows" ? "Klik untuk menghubungkan" : "Klik, lalu isi password") +
        "</span>";
      pick.addEventListener("click", function () {
        fillForm(profile);
        if (profile.auth === "windows" || profile.has_password) {
          form.requestSubmit ? form.requestSubmit() : connectBtn.click();
        } else {
          document.getElementById("password").focus();
        }
      });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn-tiny";
      remove.textContent = "Hapus";
      remove.addEventListener("click", function () {
        window.SqlApi.request("/api/profiles/" + encodeURIComponent(profile.id), { method: "DELETE" })
          .then(function (data) {
            if (data.ok) renderProfiles(data.profiles || []);
          });
      });
      row.appendChild(pick);
      row.appendChild(remove);
      savedBox.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  document.getElementById("auth-windows").addEventListener("change", setAuthMode);
  document.getElementById("auth-sql").addEventListener("change", setAuthMode);

  window.SqlLoading.show("Memeriksa lingkungan", "Memeriksa driver ODBC, platform, dan kesiapan aplikasi.");
  window.SqlApi.request("/api/meta")
    .then(function (data) {
      if (!data.windows) {
        document.getElementById("auth-windows").disabled = true;
        document.getElementById("auth-sql").checked = true;
        setAuthMode();
        driverNote.textContent = "Windows Authentication hanya aktif jika aplikasi dijalankan di Windows.";
      } else if (data.preferred_driver) {
        driverNote.textContent = "ODBC terdeteksi: " + data.preferred_driver;
      } else {
        driverNote.textContent = "ODBC SQL Server belum terdeteksi. SQL Authentication tetap bisa dipakai lewat pymssql.";
      }
      renderProfiles(data.profiles || []);
      if (data.profiles && data.profiles.length) fillForm(data.profiles[0]);
      window.SqlLoading.hide();
    })
    .catch(function () {
      driverNote.textContent = "";
      window.SqlLoading.hide();
    });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    errorBox.hidden = true;
    var port = portInput.value();
    if (port == null) {
      showError("Port tidak valid.", "Port default SQL Server adalah 1433.");
      return;
    }
    window.SqlLoading.show(
      "Menghubungkan ke SQL Server",
      "Memeriksa alamat server, autentikasi, dan database awal."
    );
    connectBtn.disabled = true;

    var body = {
      server: document.getElementById("server").value,
      port: port,
      instance: document.getElementById("instance").value,
      auth: document.getElementById("auth-windows").checked ? "windows" : "sql",
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
      database: document.getElementById("database").value || "master",
      encrypt: document.getElementById("encrypt").checked,
      remember_password: document.getElementById("remember-password").checked,
      profile_id: selectedProfileId
    };

    window.SqlApi.request("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (data) {
        if (!data.ok) {
          window.SqlLoading.hide();
          connectBtn.disabled = false;
          showError(data.error || "Koneksi gagal.", data.hint);
          return;
        }
        window.SqlLoading.show("Terhubung", "Membuka workspace dan memeriksa sesi.");
        window.location.href = "/workspace";
      })
      .catch(function (err) {
        window.SqlLoading.hide();
        connectBtn.disabled = false;
        showError("Tidak bisa menghubungi aplikasi.", String(err));
      });
  });
})();
