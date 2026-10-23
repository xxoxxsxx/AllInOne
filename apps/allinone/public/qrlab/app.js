// 二维码工具：生成（qrcode-generator）+ 识别（jsQR），全部本地运行。
(function () {
  "use strict";

  // qrcode-generator 默认按单字节切字符串；切到内置 UTF-8 以支持中文。
  if (window.qrcode && window.qrcode.stringToBytesFuncs && window.qrcode.stringToBytesFuncs["UTF-8"]) {
    window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs["UTF-8"];
  }

  function $(id) { return document.getElementById(id); }

  // —— Tab 切换 ——
  var tabs = [{ btn: $("tab-gen"), panel: $("panel-gen") }, { btn: $("tab-read"), panel: $("panel-read") }];
  tabs.forEach(function (t, i) {
    t.btn.addEventListener("click", function () {
      tabs.forEach(function (o, j) {
        o.btn.classList.toggle("active", o === t);
        o.btn.setAttribute("aria-selected", o === t ? "true" : "false");
        o.panel.hidden = o !== t;
      });
    });
  });

  function setHint(el, msg, isErr) {
    el.textContent = msg;
    el.classList.toggle("err", !!isErr);
  }

  // ============ 生成 ============
  var genCanvas = $("qr-canvas");
  var genHint = $("gen-hint");
  var genDownload = $("gen-download");

  function utf8Len(s) { return new TextEncoder().encode(s).length; }

  function generate() {
    var text = $("gen-input").value;
    var ecc = $("gen-ecc").value;
    var size = parseInt($("gen-size").value, 10);
    if (!text) { setHint(genHint, "请先输入内容。", true); return; }
    try {
      var qr = window.qrcode(0, ecc);
      qr.addData(text);
      qr.make();
      var count = qr.getModuleCount();
      var quiet = 4; // 静区（白边），提高扫码兼容性
      var cell = Math.max(1, Math.floor(size / (count + quiet * 2)));
      var px = cell * (count + quiet * 2);
      genCanvas.width = px;
      genCanvas.height = px;
      var ctx = genCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = "#111111";
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
      }
      $("gen-preview").hidden = false;
      genDownload.disabled = false;
      setHint(genHint, "已生成：" + count + "×" + count + " 模块 · " + px + "×" + px + " px · 内容 " + utf8Len(text) + " 字节。");
    } catch (e) {
      $("gen-preview").hidden = true;
      genDownload.disabled = true;
      setHint(genHint, "生成失败：" + (e && String(e.message || e).slice(0, 80)) + "。内容可能超出该纠错级别的容量，请缩短内容或改用 L 级别。", true);
    }
  }

  $("gen-btn").addEventListener("click", generate);
  genDownload.addEventListener("click", function () {
    var a = document.createElement("a");
    a.href = genCanvas.toDataURL("image/png");
    a.download = "qrcode.png";
    a.click();
  });

  // ============ 识别 ============
  var readCanvas = $("read-canvas");
  var readHint = $("read-hint");
  var readOut = $("read-out");
  var readText = $("read-text");
  var readOpen = $("read-open");
  var lastObjectUrl = null;

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setHint(readHint, "请选择图片文件（PNG / JPEG / WebP）。", true); return; }
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { URL.revokeObjectURL(lastObjectUrl); decodeImage(img); };
    img.onerror = function () { setHint(readHint, "图片读取失败，请换一张试试。", true); };
    img.src = lastObjectUrl;
  }

  function decodeImage(img) {
    var maxDim = 2000;
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) { setHint(readHint, "图片尺寸异常。", true); return; }
    var scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    readCanvas.width = w;
    readCanvas.height = h;
    var ctx = readCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h);
    var code = window.jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" });
    $("read-preview").hidden = false;
    if (code && code.data) {
      readOut.hidden = false;
      readText.value = code.data;
      var isUrl = /^https?:\/\//i.test(code.data);
      readOpen.hidden = !isUrl;
      if (isUrl) readOpen.href = code.data;
      setHint(readHint, "识别成功（内容 " + utf8Len(code.data) + " 字节）。");
    } else {
      readOut.hidden = true;
      setHint(readHint, "未在图片中识别到二维码。可尝试更清晰、完整的截图（保留四角定位框）。", true);
    }
  }

  $("read-drop").addEventListener("click", function () { $("read-file").click(); });
  $("read-drop").addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("read-file").click(); } });
  $("read-file").addEventListener("change", function (e) { handleFile(e.target.files && e.target.files[0]); });

  var drop = $("read-drop");
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(f);
  });

  // 粘贴截图直接识别（无需切换焦点，页面内任意位置粘贴）
  document.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (/^image\//.test(items[i].type)) {
        handleFile(items[i].getAsFile());
        break;
      }
    }
  });

  $("read-copy").addEventListener("click", function () {
    var btn = $("read-copy");
    navigator.clipboard.writeText(readText.value).then(function () {
      btn.textContent = "已复制 ✓";
      setTimeout(function () { btn.textContent = "复制内容"; }, 1500);
    }, function () {
      setHint(readHint, "复制失败：请手动全选复制。", true);
    });
  });
})();
