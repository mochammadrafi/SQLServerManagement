(function (global) {
  function formatInteger(value) {
    if (value == null || value === "") return "";
    var num = typeof value === "number" ? value : Number(String(value).replace(/\./g, ""));
    if (!isFinite(num)) return String(value);
    var neg = num < 0;
    var whole = String(Math.abs(Math.round(num)));
    return (neg ? "-" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function parseInteger(value) {
    if (value == null) return null;
    var text = String(value).trim();
    if (!text) return null;
    var cleaned = text.replace(/\./g, "").replace(/[^\d-]/g, "");
    if (!cleaned || cleaned === "-") return null;
    var num = Number(cleaned);
    return isFinite(num) ? num : null;
  }

  function bindNumberInput(input, opts) {
    opts = opts || {};
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("autocomplete", "off");
    input.classList.add("is-number-input");
    if (input.type === "number") input.type = "text";
    input.removeAttribute("min");
    input.removeAttribute("max");
    input.removeAttribute("step");

    function current() {
      return parseInteger(input.value);
    }

    function digitsOnly(value) {
      return String(value || "").replace(/[^\d]/g, "");
    }

    function clamp(num) {
      if (num == null) return null;
      if (opts.min != null && num < opts.min) num = opts.min;
      if (opts.max != null && num > opts.max) num = opts.max;
      return num;
    }

    input.addEventListener("keydown", function (event) {
      if (opts.flexible) return;
      var key = event.key;
      if (key.length === 1 && !/\d/.test(key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
      }
    });
    input.addEventListener("paste", function (event) {
      if (opts.flexible) return;
      event.preventDefault();
      var text = "";
      if (event.clipboardData) text = event.clipboardData.getData("text");
      else if (window.clipboardData) text = window.clipboardData.getData("Text");
      input.value = digitsOnly(text);
    });
    input.addEventListener("input", function () {
      if (opts.flexible && /[a-zA-Z]/.test(input.value)) return;
      input.value = digitsOnly(input.value);
    });
    input.addEventListener("blur", function () {
      if (opts.flexible && /[a-zA-Z]/.test(input.value)) return;
      var num = clamp(current());
      input.value = num == null ? "" : String(num);
    });
    input.value = digitsOnly(input.value);
    input._sqlNumber = {
      value: current,
      set: function (num) {
        input.value = num == null || num === "" ? "" : digitsOnly(num);
      },
      raw: function () {
        if (opts.flexible && /[a-zA-Z]/.test(input.value)) return input.value.trim();
        var num = current();
        return num == null ? "" : String(num);
      }
    };
    return input._sqlNumber;
  }

  function ensureBoot() {
    var overlay = document.getElementById("boot-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "boot-overlay";
    overlay.className = "boot-overlay";
    overlay.innerHTML =
      '<div class="boot-panel">' +
        '<div class="boot-spinner"></div>' +
        '<p class="boot-kicker">SQL Server Management</p>' +
        '<h2 id="boot-title">Memuat</h2>' +
        '<p id="boot-text">Menyiapkan aplikasi.</p>' +
      "</div>";
    document.body.appendChild(overlay);
    return overlay;
  }

  function showBoot(title, text) {
    var overlay = ensureBoot();
    var heading = document.getElementById("boot-title");
    var body = document.getElementById("boot-text");
    if (heading) heading.textContent = title || "Memuat";
    if (body) body.textContent = text || "";
    overlay.hidden = false;
  }

  function hideBoot() {
    var overlay = document.getElementById("boot-overlay");
    if (overlay) overlay.hidden = true;
  }

  function showIn(host, title, text) {
    if (!host) return;
    host.classList.add("is-loading-host");
    var layer = childByClass(host, "panel-loading");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "panel-loading";
      host.appendChild(layer);
    }
    layer.innerHTML =
      '<div class="boot-spinner dark"></div>' +
      "<h3>" + escapeHtml(title || "Memuat") + "</h3>" +
      "<p>" + escapeHtml(text || "") + "</p>";
    layer.hidden = false;
  }

  function hideIn(host) {
    if (!host) return;
    host.classList.remove("is-loading-host");
    var layer = childByClass(host, "panel-loading");
    if (layer) layer.hidden = true;
  }

  function childByClass(host, className) {
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].className === className) return host.children[i];
    }
    return null;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function optionList(select) {
    return Array.prototype.map.call(select.options, function (opt) {
      return {
        value: opt.value,
        label: opt.textContent,
        sub: opt.getAttribute("data-sub") || ""
      };
    });
  }

  function mountSelect(select, opts) {
    opts = opts || {};
    if (select._sqlSelect) return select._sqlSelect;
    select.classList.add("sql-select-native");
    var wrap = document.createElement("div");
    wrap.className = "sql-select" + (opts.compact ? " is-compact" : "");
    wrap.innerHTML =
      '<button type="button" class="sql-select-toggle"></button>' +
      '<div class="sql-select-drop" hidden>' +
        '<input type="text" class="sql-select-search" placeholder="' +
          escapeHtml(opts.placeholder || "Cari...") + '" autocomplete="off">' +
        '<ul class="sql-select-list"></ul>' +
      "</div>";
    select.parentNode.insertBefore(wrap, select.nextSibling);
    wrap.insertBefore(select, wrap.firstChild);

    var toggle = wrap.querySelector(".sql-select-toggle");
    var drop = wrap.querySelector(".sql-select-drop");
    var search = wrap.querySelector(".sql-select-search");
    var list = wrap.querySelector(".sql-select-list");
    var activeIndex = -1;

    function selectedLabel() {
      var opt = select.options[select.selectedIndex];
      return opt ? opt.textContent : (opts.emptyLabel || "Pilih");
    }

    function sync() {
      toggle.textContent = selectedLabel();
      toggle.classList.toggle("is-empty", !select.value);
    }

    function close() {
      drop.hidden = true;
      wrap.classList.remove("is-open");
    }

    function open() {
      drop.hidden = false;
      wrap.classList.add("is-open");
      search.value = "";
      render("");
      search.focus();
    }

    function render(query) {
      var q = String(query || "").toLowerCase();
      var items = optionList(select).filter(function (item) {
        if (!q) return true;
        return item.label.toLowerCase().indexOf(q) !== -1 ||
          item.value.toLowerCase().indexOf(q) !== -1 ||
          String(item.sub).toLowerCase().indexOf(q) !== -1;
      });
      list.innerHTML = "";
      if (!items.length && opts.allowCustom && q) {
        var custom = document.createElement("li");
        custom.className = "sql-select-item is-custom";
        custom.textContent = 'Pakai "' + query + '"';
        custom.addEventListener("mousedown", function (event) {
          event.preventDefault();
          choose(query, query);
        });
        list.appendChild(custom);
        activeIndex = 0;
        return;
      }
      if (!items.length) {
        var empty = document.createElement("li");
        empty.className = "sql-select-empty";
        empty.textContent = "Tidak ada hasil";
        list.appendChild(empty);
        activeIndex = -1;
        return;
      }
      items.forEach(function (item, index) {
        var li = document.createElement("li");
        li.className = "sql-select-item" + (item.value === select.value ? " is-selected" : "");
        li.innerHTML = "<strong>" + escapeHtml(item.label) + "</strong>" +
          (item.sub ? '<span>' + escapeHtml(item.sub) + "</span>" : "");
        li.addEventListener("mousedown", function (event) {
          event.preventDefault();
          choose(item.value, item.label);
        });
        list.appendChild(li);
        if (item.value === select.value) activeIndex = index;
      });
    }

    function choose(value, label) {
      var exists = Array.prototype.some.call(select.options, function (opt) {
        return opt.value === value;
      });
      if (!exists && opts.allowCustom) {
        var opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label || value;
        select.appendChild(opt);
      }
      select.value = value;
      sync();
      close();
      var ev = document.createEvent("HTMLEvents");
      ev.initEvent("change", true, false);
      select.dispatchEvent(ev);
    }

    toggle.addEventListener("click", function () {
      if (drop.hidden) open();
      else close();
    });
    search.addEventListener("input", function () {
      render(search.value);
    });
    search.addEventListener("keydown", function (event) {
      var items = list.querySelectorAll(".sql-select-item");
      if (event.key === "Escape") {
        close();
        toggle.focus();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (opts.allowCustom && search.value && !items.length) {
          choose(search.value, search.value);
          return;
        }
        if (items[activeIndex]) items[activeIndex].dispatchEvent(new MouseEvent("mousedown"));
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return;
        activeIndex += event.key === "ArrowDown" ? 1 : -1;
        if (activeIndex < 0) activeIndex = items.length - 1;
        if (activeIndex >= items.length) activeIndex = 0;
        Array.prototype.forEach.call(items, function (item, index) {
          item.classList.toggle("is-active", index === activeIndex);
        });
        items[activeIndex].scrollIntoView({ block: "nearest" });
      }
    });
    document.addEventListener("mousedown", function (event) {
      if (!wrap.contains(event.target)) close();
    });

    var api = {
      sync: sync,
      setOptions: function (items, selected) {
        select.innerHTML = "";
        (items || []).forEach(function (item) {
          var opt = document.createElement("option");
          opt.value = item.value;
          opt.textContent = item.label;
          if (item.sub) opt.setAttribute("data-sub", item.sub);
          select.appendChild(opt);
        });
        if (selected != null) select.value = selected;
        sync();
      },
      setValue: function (value) {
        select.value = value;
        sync();
      }
    };
    select._sqlSelect = api;
    sync();
    return api;
  }

  global.SqlFormat = {
    integer: formatInteger,
    parseInteger: parseInteger,
    bindInput: bindNumberInput
  };
  global.SqlLoading = {
    show: showBoot,
    hide: hideBoot,
    showIn: showIn,
    hideIn: hideIn
  };
  global.SqlSelect = {
    mount: mountSelect
  };
})(window);
