// beautify-select · 手帐风自定义下拉组件（plugin-kit）
// 用法：
//   1. 页面引入 beautify-select.css（或服务端内联）
//   2. 页面引入本文件（或服务端内联）
//   3. 对每个原生 <select> 调用 beautifySelect(sel)
// 特性：
//   - 原生 select 只保留值和 change 事件（视觉隐藏），外部改 options/value 经 MutationObserver 自动同步面板
//   - 面板 absolute left/right 0，与触发栏等宽（根治原生下拉面板宽度错位）
//   - 展开时自动提升最近 .card / [data-dd-lift] 容器的层级（.dd-open-card），
//     防止面板溢出容器时被下层内容（开关等）穿模盖住
//   - 主题色全部走 CSS 变量：--card --ink --ink-soft --line --accent --accent-deep --accent-soft
(function () {
  "use strict";

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function beautifySelect(sel) {
    if (!sel || sel.dataset.ddReady) return;
    sel.dataset.ddReady = "1";
    var wrap = document.createElement("div");
    wrap.className = "dd";
    if (sel.dataset.kind) wrap.dataset.kind = sel.dataset.kind;
    if (sel.dataset.agent) wrap.dataset.agent = sel.dataset.agent;
    var inline = sel.getAttribute("style");
    if (inline) { wrap.setAttribute("style", inline); sel.removeAttribute("style"); }
    sel.classList.add("dd-native");
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd-trigger";
    trigger.innerHTML = '<span class="dd-label"></span>' +
      '<svg class="dd-caret" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.25 5.25 7 9l3.75-3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.appendChild(trigger);

    var panel = document.createElement("div");
    panel.className = "dd-panel";
    wrap.appendChild(panel);

    var lifted = null;

    function currentLabel() {
      var i = sel.selectedIndex;
      if (i >= 0 && sel.options[i]) return sel.options[i].textContent;
      return "";
    }

    // 只刷新触发栏文字（选中变化后立即调用，避免关闭面板后显示旧值）
    function updateLabel() {
      var label = currentLabel();
      var labelEl = trigger.querySelector(".dd-label");
      if (labelEl) labelEl.textContent = label;
      trigger.title = label;
    }

    function renderPanel() {
      updateLabel();
      var html = "";
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        var on = i === sel.selectedIndex;
        html += '<div class="dd-opt' + (on ? " on" : "") + '" data-i="' + i + '">' +
          '<span class="dd-check">✓</span>' +
          '<span class="dd-opt-text">' + escapeText(o.textContent) + "</span></div>";
      }
      panel.innerHTML = html;
      var cur = panel.querySelector(".dd-opt.on");
      if (cur) {
        var pt = cur.offsetTop;
        var ph = cur.offsetHeight;
        if (pt < panel.scrollTop) panel.scrollTop = pt;
        else if (pt + ph > panel.scrollTop + panel.clientHeight) panel.scrollTop = pt + ph - panel.clientHeight;
      }
    }

    // 面板溢出容器时，提升最近的 .card / [data-dd-lift] 容器层级，防止被下层内容穿模盖住
    function findLiftTarget() {
      var el = wrap.parentElement;
      while (el && el !== document.body) {
        if (el.classList && (el.classList.contains("card") || (el.getAttribute && el.getAttribute("data-dd-lift") !== null))) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    }
    function lift() {
      if (!lifted) lifted = findLiftTarget();
      if (lifted) lifted.classList.add("dd-open-card");
    }
    function unlift() {
      if (lifted) { lifted.classList.remove("dd-open-card"); lifted = null; }
    }

    function close() {
      wrap.classList.remove("open");
      updateLabel(); // 关闭时同步触发栏，防止选中后仍显示旧值（需再次打开才更新的 bug）
      unlift();
    }
    // 面板按内容宽度展开后要挑边：默认从触发栏左沿向右铺，
    // 右边放不下就改成右对齐（贴着触发栏右沿向左铺），两边都不够才按可用宽度收窄，
    // 保证既不溢出屏幕，也不把选项挤成省略号。
    function positionPanel() {
      panel.style.left = "0px";
      panel.style.right = "auto";
      panel.style.width = "";
      var wrapRect = wrap.getBoundingClientRect();
      var need = panel.scrollWidth; // 内容真正需要的宽度
      var margin = 10;
      var spaceRight = window.innerWidth - margin - wrapRect.left;
      var spaceLeft = wrapRect.right - margin;
      if (need > spaceRight && spaceLeft > spaceRight) {
        panel.style.left = "auto";
        panel.style.right = "0px";
      }
      var avail = panel.style.right === "0px" ? spaceLeft : spaceRight;
      if (need > avail) {
        var w = Math.min(420, Math.max(120, avail));
        panel.style.width = w + "px";
      }
    }

    function open() {
      renderPanel();
      var all = document.querySelectorAll(".dd.open");
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== wrap && all[i]._ddClose) all[i]._ddClose();
      }
      wrap.classList.add("open");
      positionPanel(); // 展开后再量，面板已是 display:block 才量得到
      lift();
    }
    wrap._ddClose = close;
    wrap._ddRefresh = renderPanel; // 外部直接改 select.value 后调用，同步触发栏与面板

    trigger.addEventListener("click", function () {
      if (wrap.classList.contains("open")) close(); else open();
    });
    panel.addEventListener("click", function (e) {
      var opt = e.target && e.target.closest ? e.target.closest(".dd-opt") : null;
      if (!opt) return;
      sel.selectedIndex = Number(opt.dataset.i);
      close();
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    // 外部代码直接改 options/value（如动态塞模型列表）时自动同步面板
    var mo = new MutationObserver(function () {
      renderPanel();
      setTimeout(renderPanel, 0); // value 赋值紧随 innerHTML 时，下一轮事件循环再同步一次
    });
    mo.observe(sel, { childList: true, attributes: true, subtree: true });
    renderPanel();
  }

  if (typeof window !== "undefined") window.beautifySelect = beautifySelect;
  if (typeof globalThis !== "undefined") globalThis.beautifySelect = beautifySelect;
})();
