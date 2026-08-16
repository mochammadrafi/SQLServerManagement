(function (global) {
  var ROW_H = 28;
  var OVERSCAN = 10;
  var MIN_COL = 72;
  var DEFAULT_COL = 140;

  function isNull(value) {
    return value === null || value === undefined;
  }

  function text(value) {
    if (isNull(value)) return "null";
    return String(value);
  }

  function openDetail(title, value) {
    var modal = document.getElementById("detail-modal");
    var heading = document.getElementById("detail-title");
    var body = document.getElementById("detail-body");
    if (!modal || !heading || !body) return;
    heading.textContent = title || "Detail";
    body.textContent = isNull(value) ? "NULL" : String(value);
    modal.hidden = false;
  }

  function renderGrid(host, columns, rows, opts) {
    opts = opts || {};
    host.innerHTML = "";
    if (!columns || !columns.length) {
      host.innerHTML = '<div class="empty-state"><h3>Tidak ada kolom</h3></div>';
      return;
    }

    var widths = columns.map(function () { return DEFAULT_COL; });
    var root = document.createElement("div");
    root.className = "virt";

    var head = document.createElement("div");
    head.className = "virt-head";
    var headInner = document.createElement("div");
    headInner.className = "virt-row virt-head-row";
    columns.forEach(function (name, index) {
      var cell = document.createElement("div");
      cell.className = "virt-cell virt-th";
      cell.style.width = widths[index] + "px";
      cell.style.minWidth = widths[index] + "px";
      var label = document.createElement("span");
      label.textContent = name;
      var grip = document.createElement("span");
      grip.className = "col-resizer";
      cell.appendChild(label);
      cell.appendChild(grip);
      bindResize(grip, index, widths, root);
      headInner.appendChild(cell);
    });
    head.appendChild(headInner);
    root.appendChild(head);

    var body = document.createElement("div");
    body.className = "virt-body";
    var spacer = document.createElement("div");
    spacer.className = "virt-spacer";
    spacer.style.height = (rows.length * ROW_H) + "px";
    var windowEl = document.createElement("div");
    windowEl.className = "virt-window";
    spacer.appendChild(windowEl);
    body.appendChild(spacer);
    root.appendChild(body);
    host.appendChild(root);

    if (opts.truncated) {
      var note = document.createElement("p");
      note.className = "grid-note";
      note.textContent = opts.truncatedText || "Hanya halaman ini yang dimuat. Pakai pager atau Export untuk data penuh.";
      host.appendChild(note);
    }

    function paint() {
      var scrollTop = body.scrollTop;
      var viewH = body.clientHeight || 240;
      var start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
      var end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
      windowEl.style.transform = "translateY(" + (start * ROW_H) + "px)";
      windowEl.innerHTML = "";
      for (var i = start; i < end; i++) {
        windowEl.appendChild(rowEl(columns, rows[i], i, widths, opts));
      }
      head.scrollLeft = body.scrollLeft;
    }

    body.addEventListener("scroll", paint);
    paint();
  }

  function rowEl(columns, row, rowIndex, widths, opts) {
    var el = document.createElement("div");
    el.className = "virt-row" + (opts && opts.selectedRow === rowIndex ? " is-selected" : "");
    el.setAttribute("data-row", String(rowIndex));
    el.style.height = ROW_H + "px";
    el.addEventListener("click", function () {
      if (opts && opts.onRowClick) opts.onRowClick(row, rowIndex, columns);
    });
    columns.forEach(function (name, colIndex) {
      var value = row[colIndex];
      var cell = document.createElement("div");
      cell.className = "virt-cell" + (isNull(value) ? " null" : "");
      cell.style.width = widths[colIndex] + "px";
      cell.style.minWidth = widths[colIndex] + "px";
      cell.textContent = text(value);
      cell.title = "Double-click untuk detail";
      cell.addEventListener("dblclick", function () {
        openDetail(name, value);
      });
      el.appendChild(cell);
    });
    el.addEventListener("dblclick", function (event) {
      if (event.target && event.target.className.indexOf("virt-cell") !== -1 && event.target !== el) {
        return;
      }
      var pairs = columns.map(function (name, i) {
        return name + ": " + (isNull(row[i]) ? "NULL" : String(row[i]));
      });
      openDetail("Baris " + (rowIndex + 1), pairs.join("\n"));
    });
    return el;
  }

  function bindResize(grip, index, widths, root) {
    grip.addEventListener("mousedown", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var startX = event.pageX;
      var startW = widths[index];
      function move(ev) {
        widths[index] = Math.max(MIN_COL, startW + (ev.pageX - startX));
        var cells = root.querySelectorAll(".virt-row > .virt-cell:nth-child(" + (index + 1) + ")");
        Array.prototype.forEach.call(cells, function (cell) {
          cell.style.width = widths[index] + "px";
          cell.style.minWidth = widths[index] + "px";
        });
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  global.SqlGrid = {
    render: renderGrid,
    openDetail: openDetail
  };
})(window);
