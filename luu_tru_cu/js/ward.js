/* Ward module - Danh sach phuong TP.HCM */
(function() {
  var S = function(s) { return document.querySelector(s); };
  var fmt = function(v, d) { d = d||2; return (v===null||v===undefined||!isFinite(+v)) ? '-' : (+v).toFixed(d); };

  function setupCoordDisplay() {
    var mapEl = document.getElementById('map');
    var coordDisplay = document.getElementById('coord-display');
    if (!mapEl || !coordDisplay) return;
    var check = setInterval(function() {
      var m = mapEl._leaflet_map;
      if (!m) return;
      clearInterval(check);
      m.on('mousemove', function(e) {
        coordDisplay.textContent = e.latlng.lat.toFixed(5) + 'N  ' + e.latlng.lng.toFixed(5) + 'E';
      });
      m.on('mouseout', function() { coordDisplay.textContent = '-'; });
    }, 200);
  }
  setupCoordDisplay();

  async function loadRole() {
    try {
      var token = new URLSearchParams(location.search).get('token') || '';
      var r = await fetch('/api/auth/role' + (token ? '?token=' + token : ''));
      var data = await r.json();
      window.__lstRole = data.role || 'user';
      var badge = document.getElementById('role-badge');
      if (badge) {
        if (data.role === 'admin') {
          badge.textContent = 'Admin';
          badge.className = 'role-badge admin-role';
        } else {
          badge.textContent = 'Người dùng';
          badge.className = 'role-badge user-role';
        }
      }

      // Phân quyền: mục Xu hướng và lọc chuyên sâu chỉ dành cho Admin
      var trendTabBtn = document.getElementById('tab-btn-trend');
      var trendTabPane = document.getElementById('tab-trend');
      var phuongSortTabs = document.getElementById('phuong-sort-tabs');
      var advFilters = document.getElementById('advanced-filters');
      if (data.role === 'admin') {
        if (trendTabBtn) trendTabBtn.style.display = '';
        if (phuongSortTabs) phuongSortTabs.style.display = 'flex';
        if (advFilters) advFilters.style.display = 'block';
      } else {
        if (trendTabBtn) trendTabBtn.style.display = 'none';
        if (trendTabPane) trendTabPane.style.display = 'none';
        if (phuongSortTabs) phuongSortTabs.style.display = 'none';
        if (advFilters) advFilters.style.display = 'none';
      }
    } catch(e) {}
  }
  loadRole();

  var wardData = [], currentSort = 'lst', wardYear = 2026;

  async function loadWards(sort, year) {
    var loading = document.getElementById('phuong-loading');
    var wrap = document.getElementById('phuong-table-wrap');
    var count = document.getElementById('phuong-count');
    if (loading) loading.style.display = 'block';
    if (wrap) wrap.style.display = 'none';
    try {
      var resp = await fetch('/api/phuong?sort=' + sort + '&year=' + year);
      var data = await resp.json();
      wardData = data.phuong || [];
      renderWardTable(wardData, sort);
      if (count) count.textContent = wardData.length + ' phường/xã · Năm ' + year;
    } catch(e) {
      if (loading) loading.textContent = 'Lỗi: ' + e.message;
      return;
    }
    if (loading) loading.style.display = 'none';
    if (wrap) wrap.style.display = 'block';
  }

  function lstColor(v) {
    if (!isFinite(v)) return '#7a85a6';
    if (v >= 42) return '#ef4444'; if (v >= 38) return '#fb923c';
    if (v >= 34) return '#fbbf24'; return '#34d399';
  }
  function ndviColor(v) {
    if (!isFinite(v)) return '#7a85a6';
    if (v >= 0.5) return '#34d399'; if (v >= 0.2) return '#fbbf24'; return '#ef4444';
  }
  function tvdiColor(v) {
    if (!isFinite(v)) return '#7a85a6';
    if (v >= 0.6) return '#ef4444'; if (v >= 0.4) return '#fb923c'; return '#34d399';
  }

  function heatBadge(v) {
    if (!isFinite(v)) return '<span class="ward-heat-badge">-</span>';
    if (v >= 42) return '<span class="ward-heat-badge hot-extreme">🔥 Cực nóng</span>';
    if (v >= 38) return '<span class="ward-heat-badge hot-high">☀️ Nắng gắt</span>';
    if (v >= 34) return '<span class="ward-heat-badge hot-med">🟡 Nóng ấm</span>';
    return '<span class="ward-heat-badge hot-cool">🌿 Mát mẻ</span>';
  }

  function renderWardTable(rows, sort) {
    var thead = document.getElementById('phuong-thead');
    var tbody = document.getElementById('phuong-tbody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px">Không có phường/xã nào thỏa điều kiện</td></tr>';
      return;
    }

    var isAdmin = window.__lstRole === 'admin';
    if (thead) {
      if (isAdmin) {
        thead.innerHTML = '<tr><th style="width:36px">#</th><th>Tên phường / xã</th><th>LST (°C)</th><th>NDVI</th><th>TVDI</th></tr>';
      } else {
        thead.innerHTML = '<tr><th style="width:36px">#</th><th>Phường / Xã & Quận</th><th>Nhiệt độ (LST)</th><th>Mức nhiệt</th></tr>';
      }
    }

    tbody.innerHTML = rows.map(function(r, i) {
      var wardName = r.ten || 'Phường / Xã';
      var districtName = r.quan || 'TP. Hồ Chí Minh';
      var rc = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'';
      var lstS = 'color:' + lstColor(r.lst_avg) + (sort==='lst'?';font-weight:700':'');

      if (isAdmin) {
        var ndviS = 'color:' + ndviColor(r.ndvi_avg) + (sort==='ndvi'?';font-weight:700':'');
        var tvdiS = 'color:' + tvdiColor(r.tvdi_avg) + (sort==='tvdi'?';font-weight:700':'');
        return '<tr class="phuong-row ' + rc + '" data-lat="' + (r.lat_grid||'') + '" data-lon="' + (r.lon_grid||'') + '" data-quan="' + districtName + '">' +
          '<td class="ward-rank">' + (i+1) + '</td>' +
          '<td class="ward-name"><b>' + wardName + '</b> <div class="ward-district-tag">' + districtName + '</div></td>' +
          '<td class="ward-val" style="' + lstS + '">' + fmt(r.lst_avg,1) + '°C</td>' +
          '<td class="ward-val" style="' + ndviS + '">' + fmt(r.ndvi_avg,3) + '</td>' +
          '<td class="ward-val" style="' + tvdiS + '">' + fmt(r.tvdi_avg,3) + '</td></tr>';
      }

      return '<tr class="phuong-row ' + rc + '" data-lat="' + (r.lat_grid||'') + '" data-lon="' + (r.lon_grid||'') + '" data-quan="' + districtName + '">' +
        '<td class="ward-rank">' + (i+1) + '</td>' +
        '<td class="ward-name">' +
          '<div style="font-weight:600;color:var(--text-0)">' + wardName + '</div>' +
          '<div class="ward-district-tag">' + districtName + '</div>' +
        '</td>' +
        '<td class="ward-val" style="' + lstS + ';font-size:14px"><b>' + fmt(r.lst_avg,1) + '°C</b></td>' +
        '<td class="ward-val">' + heatBadge(r.lst_avg) + '</td></tr>';
    }).join('');

    tbody.querySelectorAll('.phuong-row').forEach(function(row) {
      if (!row.dataset.lat) return;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function() {
        var lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
        var quan = row.dataset.quan;
        if (typeof window.__selectDistrictIn3D === 'function' && quan) {
          window.__selectDistrictIn3D(quan);
        }
        var mapEl = document.getElementById('map');
        var m = mapEl && mapEl._leaflet_map;
        if (m && isFinite(lat) && isFinite(lon)) m.flyTo([lat, lon], 13, {duration:0.8});
      });
    });
  }

  var sortTabs = document.getElementById('phuong-sort-tabs');
  if (sortTabs) {
    sortTabs.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn || !btn.dataset.psort) return;
      currentSort = btn.dataset.psort;
      sortTabs.querySelectorAll('button').forEach(function(b) { b.classList.toggle('active', b===btn); });
      loadWards(currentSort, wardYear);
    });
  }

  var applyBtn = document.getElementById('apply-filters-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', async function() {
      var ndviMin = parseFloat(document.getElementById('ndvi-threshold-min').value);
      var ndviMax = parseFloat(document.getElementById('ndvi-threshold-max').value);
      var tvdiMin = parseFloat(document.getElementById('tvdi-threshold-min').value);
      var tvdiMax = parseFloat(document.getElementById('tvdi-threshold-max').value);
      var loading = document.getElementById('phuong-loading');
      var wrap = document.getElementById('phuong-table-wrap');
      if (loading) loading.style.display = 'block';
      if (wrap) wrap.style.display = 'none';
      try {
        var params = new URLSearchParams({year:wardYear,ndvi_min:ndviMin,ndvi_max:ndviMax,tvdi_min:tvdiMin,tvdi_max:tvdiMax});
        var resp = await fetch('/api/phuong/filter?' + params);
        var data = await resp.json();
        renderWardTable(data.phuong||[], currentSort);
        var count = document.getElementById('phuong-count');
        if (count) count.textContent = (data.phuong||[]).length + ' vung loc';
        document.querySelectorAll('.tabs button').forEach(function(b){b.classList.remove('active');});
        document.querySelectorAll('.tab-pane').forEach(function(p){p.classList.remove('active');});
        var btn2 = document.getElementById('tab-btn-phuong');
        var pane = document.getElementById('tab-phuong');
        if (btn2) btn2.classList.add('active');
        if (pane) pane.classList.add('active');
      } catch(e) { alert('Loi loc: ' + e.message); }
      finally {
        if (loading) loading.style.display = 'none';
        if (wrap) wrap.style.display = 'block';
      }
    });
  }

  function setupDualRange(minId, maxId, labelId) {
    var minEl = document.getElementById(minId);
    var maxEl = document.getElementById(maxId);
    var label = document.getElementById(labelId);
    if (!minEl||!maxEl||!label) return;
    var update = function() {
      var minV = parseFloat(minEl.value), maxV = parseFloat(maxEl.value);
      if (minV > maxV) { maxEl.value = minEl.value; return; }
      var isAll = (minV <= parseFloat(minEl.min)+0.001) && (maxV >= parseFloat(maxEl.max)-0.001);
      label.textContent = isAll ? 'Tat ca' : minV.toFixed(2) + ' - ' + maxV.toFixed(2);
    };
    minEl.addEventListener('input', update);
    maxEl.addEventListener('input', update);
  }
  setupDualRange('ndvi-threshold-min','ndvi-threshold-max','ndvi-threshold-val');
  setupDualRange('tvdi-threshold-min','tvdi-threshold-max','tvdi-threshold-val');

  var SESSION_KEY = 'lst_search_history';
  function getHistory() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)||'[]'); } catch(e) { return []; } }
  function updatePreview() {
    var preview = document.getElementById('personal-data-preview');
    if (!preview) return;
    var h = getHistory();
    if (!h.length) { preview.innerHTML = '<span>Chua co du lieu nao</span>'; return; }
    preview.innerHTML = h.slice(-5).reverse().map(function(item) {
      return '<div class="personal-item">📍 ' + (item.query||'') + ' <small>(' + new Date(item.time).toLocaleTimeString('vi-VN') + ')</small></div>';
    }).join('');
  }
  var searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('change', function() {
      if (!searchInput.value.trim()) return;
      var h = getHistory();
      h.push({query: searchInput.value.trim(), time: Date.now()});
      if (h.length > 20) h.splice(0, h.length-20);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(h));
      updatePreview();
    });
  }
  var clearBtn = document.getElementById('clear-personal-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      sessionStorage.removeItem(SESSION_KEY);
      updatePreview();
      clearBtn.textContent = 'Da xoa du lieu ca nhan';
      clearBtn.disabled = true;
      setTimeout(function() {
        clearBtn.textContent = 'Xoa thong tin ca nhan trong phien';
        clearBtn.disabled = false;
      }, 2500);
    });
  }

  var tabs = document.getElementById('tabs');
  if (tabs) {
    tabs.addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (btn && btn.dataset.tab === 'phuong') {
        if (!wardData.length) {
          var s = window.__lstState;
          if (s && s.year) wardYear = s.year;
          loadWards(currentSort, wardYear);
        }
        updatePreview();
      }
    });
  }
  window.__wardSetYear = function(y) {
    wardYear = y;
    var pt = document.getElementById('tab-phuong');
    if (pt && pt.classList.contains('active')) loadWards(currentSort, wardYear);
  };
})();
