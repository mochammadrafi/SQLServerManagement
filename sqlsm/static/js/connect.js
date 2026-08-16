(function () {
  var form = document.getElementById("connect-form");
  var errorBox = document.getElementById("form-error");
  var sqlFields = document.getElementById("sql-auth-fields");
  var driverNote = document.getElementById("driver-note");
  var connectBtn = document.getElementById("connect-btn");
  var portInput = window.SqlFormat.bindInput(document.getElementById("port"), { min: 1, max: 65535 });
  window.SqlSelect.mount(document.getElementById("database"), {
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

  document.getElementById("auth-windows").addEventListener("change", setAuthMode);
  document.getElementById("auth-sql").addEventListener("change", setAuthMode);

  window.SqlLoading.show("Memeriksa lingkungan", "Memeriksa driver ODBC, platform, dan kesiapan aplikasi.");
  fetch("/api/meta")
    .then(function (res) { return res.json(); })
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
      encrypt: document.getElementById("encrypt").checked
    };

    fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); })
      .then(function (pack) {
        if (!pack.data.ok) {
          window.SqlLoading.hide();
          connectBtn.disabled = false;
          showError(pack.data.error || "Koneksi gagal.", pack.data.hint);
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
