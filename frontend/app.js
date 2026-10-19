
window.API_BASE_URL = (window.LEO_API_BASE_URL || localStorage.getItem('leo_api_base') || (location.protocol === 'file:' ? 'http://127.0.0.1:8000' : location.origin)).replace(/\/$/, '');
window.API_URL = `${window.API_BASE_URL}/api`;
const API_URL = window.API_URL;

function toAbsoluteAssetUrl(url) {
  const u = String(url || '').trim();
  if (!u || u.toLowerCase() === 'none') return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `${window.API_BASE_URL}/${u}`.replace(/([^:]\/)\//g, '$1');
}

let globalData = [];
let inventoryLoaded = false;
let dpMode = 'brand'; // ใช้ใน dark prompt
let inventoryFilterCache = null;
let inventoryRenderCount = 0;
window.globalData = globalData;

function rebuildInventoryFilterCache() {
  const brandMap = new Map();
  const seriesMap = new Map();
  const brandSeriesMap = new Map();

  (globalData || []).forEach(item => {
    const rawBrand = String(item?.Brand ?? '').trim();
    const rawSeries = String(item?.Series ?? '').trim();
    if (rawBrand) brandMap.set(rawBrand.toUpperCase(), rawBrand);
    if (rawSeries) seriesMap.set(rawSeries.toUpperCase(), rawSeries);
    if (rawBrand && rawSeries) {
      const brandKey = rawBrand.toUpperCase();
      let seriesSet = brandSeriesMap.get(brandKey);
      if (!seriesSet) {
        seriesSet = new Set();
        brandSeriesMap.set(brandKey, seriesSet);
      }
      seriesSet.add(rawSeries.toUpperCase());
    }
  });

  inventoryFilterCache = {
    brands: [...brandMap.values()].sort(),
    series: [...seriesMap.values()].sort(),
    brandSeries: brandSeriesMap
  };

  return inventoryFilterCache;
}

function getInventoryFilterCache() {
  return inventoryFilterCache || rebuildInventoryFilterCache();
}

/* ──────────────── LOAD ──────────────── */
function setNav(el) {
  document.querySelectorAll('.nav-pill').forEach(p=>p.classList.remove('active'));
  if (el) el.classList.add('active');
}


async function loadProducts() {
  console.log("--- STARTING DIAGNOSTIC TEST ---");
  console.log("Loading inventory from API...");
  try {
    const res = await fetch(`${window.API_URL}/inventory`, {signal: AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // normalize and convert types
    globalData = data.map(item => {
      const toNum = v => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      // keep Image_URL as relative comma-separated paths in globalData.
      // Display helpers (toAbsoluteAssetUrl) convert each URL individually at render time.
      // Keeping relative here ensures removeExistingImage sends the exact path the backend stored.
      const img = String(item.Image_URL || item['Image_URL'] || item.ImageUrl || '').trim();

      return {
        'Part Number': item['Part Number'] ?? item.PartNumber ?? '',
        'Part Name': item['Part Name'] ?? item['Part_Name'] ?? item.PartName ?? item['Part Name'],
        'Brand': (item.Brand ?? item['Brand'] ?? '').toString().trim().toUpperCase(),
        'Series': (item.Series ?? item['Series'] ?? '').toString().trim().toUpperCase(),
        'Price': toNum(item.Price ?? item.Price_New ?? item['Price']),
        'Stock': toNum(item.Stock ?? item.Stock_New ?? item['Stock']),
        'Used_Price': toNum(item.Used_Price ?? item['Used_Price'] ?? 0),
        'Used_Stock': toNum(item.Used_Stock ?? item['Used_Stock'] ?? 0),
        'Image_URL': img,
        'Storage Location': item['Storage Location'] ?? item.Location ?? '',
        'Cost Price': toNum((item['Cost Price'] ?? item.Cost_Price ?? item.Cost) || 0),
        'Stock_LH':      toNum(item.Stock_LH      ?? item['Stock_LH']      ?? 0),
        'Stock_RH':      toNum(item.Stock_RH      ?? item['Stock_RH']      ?? 0),
        'Used_Stock_LH': toNum(item.Used_Stock_LH ?? item['Used_Stock_LH'] ?? 0),
        'Used_Stock_RH': toNum(item.Used_Stock_RH ?? item['Used_Stock_RH'] ?? 0)
      };
    });
    inventoryFilterCache = null;
    document.getElementById('inventoryNotice').textContent = '';
    document.getElementById('connectionStatus').textContent = 'เชื่อมต่อแล้ว';

    window.globalData = globalData;
    console.log('Inventory loaded:', globalData.length, 'items');
    return true;
  } catch (e) {
    console.error('Inventory request failed', e);
    document.getElementById('inventoryNotice').innerHTML = '<div class="load-error">โหลดข้อมูลไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วกดรีเฟรช'+ (globalData.length ? ' · ข้อมูลด้านล่างเป็นข้อมูลจากการโหลดครั้งล่าสุด' : '') +'</div>';
    document.getElementById('connectionStatus').textContent = 'เชื่อมต่อไม่สำเร็จ';
    return false;
  }
}

// Render grid and update UI after loading
let inventoryRequest = null;
async function refreshInventoryUI() {
  if (inventoryRequest) return inventoryRequest;
  inventoryRequest = refreshInventoryData().finally(() => { inventoryRequest = null; });
  return inventoryRequest;
}
async function refreshInventoryData() {
  inventoryLoaded = false;
  const success = await loadProducts();
  inventoryLoaded = true;
  filterLocal();
  updateStats(globalData);
  buildFilterChips();
  if (document.getElementById('page-analytics')?.style.display !== 'none') {
    renderStockDashboard();
  }
  return success;
}

// Load on page init
async function initInventory() {
  await refreshInventoryUI();
  const validPages = ['inventory', 'orders', 'analytics'];
  let savedPage = 'inventory';
  try {
    const p = localStorage.getItem('leo_last_page');
    if (validPages.includes(p)) savedPage = p;
  } catch {}
  const navEl = document.querySelector(`.nav-pill[data-view="${savedPage}"]`);
  switchPage(savedPage, navEl);
}

/* ──────────────── RENDER ──────────────── */
function _getSideBadge(item, allData) {
  const lNew      = Number((item && item['Stock_LH'])      || 0);
  const rNew      = Number((item && item['Stock_RH'])      || 0);
  const lUsed     = Number((item && item['Used_Stock_LH']) || 0);
  const rUsed     = Number((item && item['Used_Stock_RH']) || 0);
  const usedPrice = Number((item && item['Used_Price'])    || 0);
  const hasNew  = lNew  > 0 || rNew  > 0;
  // แสดง badge เก่า ถ้ามีราคาเก่า (แม้ stock = 0) หรือมี stock เก่า
  const hasUsed = usedPrice > 0 || lUsed > 0 || rUsed > 0;
  if (!hasNew && !hasUsed) return '';
  let html = '<div class="card-side-badges">';
  if (hasNew)  html += `<span class="card-side-badge card-side-new">ใหม่ L${lNew}·R${rNew}</span>`;
  if (hasUsed) html += `<span class="card-side-badge card-side-used">เก่า L${lUsed}·R${rUsed}</span>`;
  html += '</div>';
  return html;
}
function buildProductCardHtml(item) {
  const imageUrls = (item.Image_URL && item.Image_URL !== 'nan' && item.Image_URL !== 'none' ? item.Image_URL : "")
    .split(',')
    .map(url => url.trim())
    .filter(Boolean)
    .map(toAbsoluteAssetUrl);

  const firstImage = imageUrls[0] || '';
  const imageCountBadge = imageUrls.length > 1
    ? `<div class="image-count-badge">+${imageUrls.length - 1}</div>`
    : '';

  const stockClass = item.Stock > 5 ? 'stock-ok' : 'stock-low';
  const loc = item['Storage Location'] && item['Storage Location'] !== 'nan'
    ? item['Storage Location'] : '';
  const _cpRaw = item['Cost Price'];
  const parsedCost = (_cpRaw !== '' && _cpRaw !== 'nan' && _cpRaw != null) ? Number(_cpRaw) : null;
  const cost = (parsedCost !== null && Number.isFinite(parsedCost)) ? parsedCost : null;
  const partNumber = String(item['Part Number'] || '').trim();
  const pn = partNumber.replace(/'/g, "\\'");
  const costHtml = cost !== null ? `
      <div class="cost-row" id="cost-row-${pn}" onclick="toggleCostBox(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleCostBox(this)}" role="button" tabindex="0" title="แสดง/ซ่อนราคาทุน">
        <span class="cost-label"></span>
        <span class="cost-value hidden-cost">${'฿' + cost.toLocaleString()}</span>
      </div>` : '';

  return `
      <div class="card">
        <div class="card-img-wrap" onclick="openLightbox('${pn}')">
          ${imageCountBadge}
          <div class="card-img-placeholder">🔧</div>
          ${firstImage ? `<img src="${firstImage}" loading="lazy" decoding="async" onerror="this.style.display='none'" style="opacity:0;" onload="this.style.opacity='1'">` : ''}
        </div>
        <div class="card-body">
          <div class="card-brand"><span>${item.Brand} · ${item.Series}</span>${_getSideBadge(item, globalData)}</div>
          <div class="card-name">${item['Part Name']}</div>
          <div class="card-meta">
            <div class="price-stock-container">
              <div class="price-stock-group new-item">
                <div class="card-price">฿${Number(item.Price).toLocaleString()}</div>
                <div class="card-stock ${stockClass}">${item.Stock} pcs</div>
              </div>
              ${(item.Used_Price && item.Used_Stock) ? `
              <div class="price-stock-group used-item">
                <div class="card-price">฿${Number(item.Used_Price).toLocaleString()}</div>
                <div class="card-stock ${item.Used_Stock > 5 ? 'stock-ok' : (item.Used_Stock > 0 ? 'stock-low' : 'stock-out')}">${item.Used_Stock} pcs</div>
              </div>
              ` : ''}
            </div>
            ${loc ? `<div style="width:100%; text-align:right;"><div class="card-location-tag" style="display:inline-block;">📍 ${loc}</div></div>` : ''}
          </div>
        </div>
        <div style="padding:10px 16px;border-top:0.5px solid rgba(255,255,255,0.08);font-size:11px;color:gray;display:flex;justify-content:space-between;align-items:center;">
          <span class="part-code">${escapeHtml(partNumber)}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            ${costHtml}
            <button onclick="openManageModal(true,this.dataset.pn)" data-pn="${partNumber}" class="btn-action btn-edit">แก้ไข</button>
            <button onclick="deleteProduct(this.dataset.pn)" data-pn="${partNumber}" class="btn-action btn-del">ลบ</button>
          </div>
        </div>
      </div>`;
}

let inventoryPage = 1;
let visibleInventory = [];
const PAGE_SIZE = 24;
function changeInventoryPage(page) {
  inventoryPage = page;
  renderGrid(visibleInventory, true);
  document.querySelector(".section-header").scrollIntoView({block:"start"});
}
function renderGrid(data, keepPage = false) {
  visibleInventory = data;
  if (!keepPage) inventoryPage = 1;
  const pages = Math.max(1, Math.ceil(data.length / PAGE_SIZE));
  inventoryPage = Math.min(inventoryPage, pages);
  const pagination = document.getElementById("inventoryPagination");
  pagination.innerHTML = data.length ? `<span>${data.length.toLocaleString()} รายการ · หน้า ${inventoryPage} / ${pages}</span><div><button onclick="changeInventoryPage(${inventoryPage-1})" ${inventoryPage===1?"disabled":""}>← ก่อนหน้า</button><button onclick="changeInventoryPage(${inventoryPage+1})" ${inventoryPage===pages?"disabled":""}>ถัดไป →</button></div>` : "";
  const totalCount = data.length;
  data = data.slice((inventoryPage - 1) * PAGE_SIZE, inventoryPage * PAGE_SIZE);
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  const countLabel = document.getElementById('countLabel');
  if (countLabel) countLabel.innerText = `${totalCount} รายการ`;

  if (data.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">ไม่พบสินค้าที่ตรงกัน</div>
        <div class="empty-sub">ลองเปลี่ยนคำค้นหาหรือตัวกรอง Brand / Series</div>
        <button class="empty-clear-btn" onclick="clearSearch()">ล้างการค้นหาทั้งหมด</button>
      </div>`;
    return;
  }

  grid.classList.toggle('no-card-anim', inventoryRenderCount > 0);
  const cards = new Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    cards[index] = buildProductCardHtml(data[index]);
  }
  grid.innerHTML = cards.join('');
  inventoryRenderCount += 1;
}

function toggleCostBox(costRowEl) {
  if (!costRowEl) return;
  const costEl = costRowEl.querySelector('.cost-value');
  if (!costEl) return;
  costEl.classList.toggle('hidden-cost');
}

function updateStats(data) {
  document.getElementById('s-total').innerText = data.length;

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const totalNewStock = data.reduce((s, i) => s + toNum(i.Stock), 0);
  const totalUsedStock = data.reduce((s, i) => s + toNum(i.Used_Stock), 0);
  const totalStock = totalNewStock + totalUsedStock;

  const lowCount = data.reduce((s, i) => {
    let currentLow = 0;
    if (toNum(i.Stock) > 0 && toNum(i.Stock) < 5) currentLow++;
    if (toNum(i.Used_Stock) > 0 && toNum(i.Used_Stock) < 5) currentLow++;
    return s + currentLow;
  }, 0);

  const totalCostValue = data.reduce((s, i) => {
    const cost = toNum(i['Cost Price'] ?? i.Cost_Price ?? i.Cost ?? 0);
    const qty = toNum(i.Stock) + toNum(i.Used_Stock);
    return s + cost * qty;
  }, 0);
  window._costValueAmount = totalCostValue;

  document.getElementById('s-stock').innerText = totalStock.toLocaleString();
  document.getElementById('s-low').innerText = lowCount;
  const valEl = document.getElementById('s-value');
  if (valEl) {
    valEl.dataset.amount = totalCostValue;
    if (!window._costValueVisible) valEl.innerText = 'ซ่อน';
    else valEl.innerText = `฿${totalCostValue.toLocaleString()}`;
  }
}

/* ──────────────── END ORDERS PAGE ──────────────── */

 /* ──────────────── FILTER CHIPS (dynamic) ──────────────── */
let activeFilters = { brand: 'All', series: 'All' };

function getUniqueBrandSeries(data) {
  if (data === globalData) {
    return getInventoryFilterCache();
  }
  const brandMap = new Map();
  const seriesMap = new Map();
  (data || []).forEach(i => {
    const rawBrand = String(i?.Brand ?? '').trim();
    const rawSeries = String(i?.Series ?? '').trim();
    if (rawBrand) brandMap.set(rawBrand.toUpperCase(), rawBrand);
    if (rawSeries) seriesMap.set(rawSeries.toUpperCase(), rawSeries);
  });
  return {
    brands: [...brandMap.values()].sort(),
    series: [...seriesMap.values()].sort()
  };
}

function updateHeroMeta() {
  const el = document.getElementById('heroMeta');
  if (!el) return;
  const { brands, series } = getUniqueBrandSeries(globalData);
  el.textContent = `${brands.length} ยี่ห้อ · ${series.length} รุ่น · ข้อมูลจากคลังสินค้า`;
}

function buildFilterChips() {
  const row = document.getElementById('filterChipsRow');
  if (!row) return;

  // Collect unique brands and series from live data
  const { brands, series: allSeries } = getUniqueBrandSeries(globalData);

  let html = '';
  // Brand chips
  html += `<span class="chip-label">Brand</span>`;
  html += `<div class="chip active" onclick="setFilter(this,'brand','All')">All</div>`;
  brands.forEach(b => {
    html += `<div class="chip" onclick="setFilter(this,'brand','${b}')">${b}</div>`;
  });
  // Series chips
  html += `<span class="chip-label" style="margin-left:12px">Series</span>`;
  html += `<div class="chip active" onclick="setFilter(this,'series','All')">All</div>`;
  allSeries.forEach(s => {
    const escaped = s.replace(/'/g, "\\'");
    html += `<div class="chip" onclick="setFilter(this,'series','${escaped}')">${s}</div>`;
  });

  row.innerHTML = html;
  updateHeroMeta();
  // restore active state
  updateActiveChips();
}

function toggleClearBtn(inp) {
  const btn = document.getElementById('searchClear');
  if (btn) btn.style.display = inp.value ? 'block' : 'none';
}

function clearSearch() {
  const inp = document.getElementById('searchInput');
  if (inp) { inp.value = ''; toggleClearBtn(inp); }
  activeFilters = { brand: 'All', series: 'All' };
  updateSeriesChips('All');
  updateActiveChips();
  renderGrid(applySort(globalData));
  updateStats(globalData);
}

function setFilter(el, type, val) {
  activeFilters[type] = val;
  
  // ถ้าเลือก Brand → อัพเดท Series chips และรีเซ็ต series filter
  if (type === 'brand') {
    activeFilters.series = 'All'; // รีเซ็ตฟิลเตอร์ series
    updateSeriesChips(val);
  }

  updateActiveChips(); // อัปเดต active class ทั้งหมด
  filterLocal();
}

function updateSeriesChips(selectedBrand) {
  const { brandSeries } = getInventoryFilterCache();

  const seriesChips = document.querySelectorAll('#filterChipsRow .chip[onclick*="series"]');
  if (selectedBrand === 'All') {
    seriesChips.forEach(chip => { chip.style.display = ''; });
  } else {
    const allowed = brandSeries.get(selectedBrand.toUpperCase()) || new Set();
    seriesChips.forEach(chip => {
      const text = chip.textContent.trim().toUpperCase();
      chip.style.display = (text === 'ALL' || allowed.has(text)) ? '' : 'none';
    });
  }
}

let searchTimer;
function scheduleFilter() { clearTimeout(searchTimer); searchTimer = setTimeout(filterLocal, 120); }
function filterCards() { filterLocal(); }

function updateActiveChips() {
    document.querySelectorAll('.chip').forEach(chip => {
        const onclickAttr = chip.getAttribute('onclick');
        if (!onclickAttr) return;

        const match = onclickAttr.match(/setFilter\(this,\s*'(.*?)',\s*'(.*?)'\)/);
        if (match) {
            const type = match[1];
            const value = match[2];
            const isActive = activeFilters[type] && activeFilters[type].toUpperCase() === value.toUpperCase();
            chip.classList.toggle('active', isActive);
        }
    });
}

function filterLocal() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const filtered = globalData.filter(item => {
    const matchText = !q ||
      item['Part Name'].toLowerCase().includes(q) ||
      item['Part Number'].toLowerCase().includes(q) ||
      item['Brand'].toLowerCase().includes(q);
    const matchBrand  = activeFilters.brand  === 'All' || item['Brand'].toUpperCase()  === activeFilters.brand.toUpperCase();
    const matchSeries = activeFilters.series === 'All' || item['Series'].toUpperCase() === activeFilters.series.toUpperCase();
    return matchText && matchBrand && matchSeries;
  });
  renderGrid(applySort(filtered));
}

/* ──────────────── LIGHTBOX ──────────────── */
let lightboxState = {
  images: [],
  currentIndex: 0
};

let _savedScrollY = 0;
function syncModalBodyLock() {
  const hasOpenModal = !!document.querySelector('.modal-overlay.open, #fancyOverlay.open');
  if (hasOpenModal) {
    if (!document.body.classList.contains('modal-lock')) {
      _savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.classList.add('modal-lock');
      document.body.style.top = `-${_savedScrollY}px`;
    }
    return;
  }
  if (document.body.classList.contains('modal-lock')) {
    document.body.classList.remove('modal-lock');
    document.body.style.top = '';
    window.scrollTo(0, _savedScrollY);
  }
}

const _modalLockObserver = new MutationObserver(syncModalBodyLock);
_modalLockObserver.observe(document.documentElement, {
  subtree: true,
  attributes: true,
  attributeFilter: ['class']
});
syncModalBodyLock();

function openLightbox(partNumber) {
  const item = globalData.find(p => p['Part Number'] === partNumber);
  if (!item) return;

  const imageUrls = (item.Image_URL || "").split(',').map(url => url.trim()).filter(Boolean).map(toAbsoluteAssetUrl);
  if (imageUrls.length === 0) return;

  lightboxState.images = imageUrls;
  lightboxState.currentIndex = 0;

  const modal = document.getElementById('lightboxModal');
  const container = document.getElementById('lightbox-images-container');
  container.innerHTML = ''; // Clear previous images

  imageUrls.forEach((url, index) => {
    const img = document.createElement('img');
    img.src = url;
    if (index === 0) img.classList.add('active');
    container.appendChild(img);
  });

  document.getElementById('lightbox-prev').style.display = imageUrls.length > 1 ? 'block' : 'none';
  document.getElementById('lightbox-next').style.display = imageUrls.length > 1 ? 'block' : 'none';

  modal.classList.add('open');
}

function closeLightbox() {
  document.getElementById('lightboxModal').classList.remove('open');
}

function changeLightboxImage(direction) {
  const images = document.querySelectorAll('#lightbox-images-container img');
  if (images.length <= 1) return;

  images[lightboxState.currentIndex].classList.remove('active');
  lightboxState.currentIndex = (lightboxState.currentIndex + direction + images.length) % images.length;
  images[lightboxState.currentIndex].classList.add('active');
}

/* ──────────────── MANAGE MODAL ──────────────── */
function previewManageImages(files) {
  const previewContainer = document.getElementById('image-previews');
  const label = document.getElementById('fileLabel');
  // Don't clear existing previews, just add new ones
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const div = document.createElement('div');
      div.className = 'preview-container';
      div.innerHTML = `<img src="${e.target.result}" class="preview-image">`;
      previewContainer.appendChild(div);
    }
    reader.readAsDataURL(file);
  }
  if (files.length > 0) {
    label.innerHTML = `<span>✅ เลือกแล้ว ${files.length} รูป (เลือกเพิ่มได้)</span>`;
    label.style.borderColor = '#34d399';
  }
}

async function removeExistingImage(partNumber, imageUrl, event) {
  event.stopPropagation();
  if (!await fancyConfirm(`คุณแน่ใจหรือไม่ว่าต้องการลบรูปภาพนี้?`)) return;

  try {
    const res = await fetch(`${API_URL}/inventory/image?part_number=${encodeURIComponent(partNumber)}&image_url=${encodeURIComponent(imageUrl)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Failed to delete image');
    }
    // Visually remove the preview
    event.target.closest('.preview-container').remove();
    // Refresh data to update the main card display
    loadProducts();
  } catch (error) {
    console.error('Error deleting image:', error);
    await fancyAlert(`เกิดข้อผิดพลาดในการลบรูปภาพ: ${error.message}`, 'error');
  }
}

function openManageModal(isEdit = false, pn = null) {
  const modal = document.getElementById('manageModal');
  modal.classList.add('open');
  populateSelectsModal();

  const fileInput = document.getElementById('m_image');
  const previewContainer = document.getElementById('image-previews');
  const label = document.getElementById('fileLabel');
  const imgHint = document.getElementById('current_image_hint');

  // Reset image-related things
  fileInput.value = '';
  previewContainer.innerHTML = '';
  label.innerHTML = `<span>📸 คลิกเพื่อเลือกรูปภาพ (เลือกได้หลายรูป)</span>`;
  label.style.borderColor = 'rgba(255,255,255,0.3)';
  imgHint.style.display = 'none';

  // Attach file listener
  fileInput.onchange = function(e) {
    previewManageImages(e.target.files);
  };

  if (isEdit) {
    document.getElementById('modalTitle').innerText = "📝 แก้ไขสินค้า";
    document.getElementById('editMode').value = "true";
    document.getElementById('m_pn').readOnly = true;
    const item = globalData.find(i => i['Part Number'] === pn) ||
                  globalData.find(i => i['Part Number'].trim() === pn.trim());
    if (item) {
      document.getElementById('m_pn').value    = (item['Part Number'] || pn).trim();
      document.getElementById('m_name').value  = item['Part Name'];
      document.getElementById('m_brand').value = item['Brand'];
      document.getElementById('m_series').value= item['Series'];
      document.getElementById('m_price').value = item['Price'];
      const _editStock = Number(item['Stock'] || 0);
      document.getElementById('m_stock').value = _editStock;
      // Pre-fill LH/RH from saved Stock_LH / Stock_RH values
      const _lhEl = document.getElementById('m_stock_lh');
      const _rhEl = document.getElementById('m_stock_rh');
      if (_lhEl) _lhEl.value = Number(item['Stock_LH'] || 0);
      if (_rhEl) _rhEl.value = Number(item['Stock_RH'] || 0);
      document.getElementById('m_used_price').value = item['Used_Price'] || '';
      document.getElementById('m_used_stock').value = item['Used_Stock'] || '';
      const _ulhEl = document.getElementById('m_used_stock_lh');
      const _urhEl = document.getElementById('m_used_stock_rh');
      if (_ulhEl) _ulhEl.value = Number(item['Used_Stock_LH'] || 0) || '';
      if (_urhEl) _urhEl.value = Number(item['Used_Stock_RH'] || 0) || '';
      const _cp = item['Cost Price'];
      document.getElementById('m_cost').value = (_cp !== '' && _cp !== 'nan' && _cp != null && Number(_cp) > 0) ? Number(_cp) : '';
      document.getElementById('m_loc').value   = item['Storage Location'];

      // Display existing images with remove buttons
      const imageUrls = (item.Image_URL && item.Image_URL !== 'none' ? item.Image_URL : "").split(',').filter(url => url.trim() && url.trim().toLowerCase() !== 'none');
      if (imageUrls.length > 0) {
        imgHint.innerText = `รูปปัจจุบัน: ${imageUrls.length} รูป (คลิก ✕ เพื่อลบ)`;
        imgHint.style.display = 'block';
        imageUrls.forEach(rawUrl => {
          const url = rawUrl.trim();
          const fullUrl = toAbsoluteAssetUrl(url);
          const div = document.createElement('div');
          div.className = 'preview-container';
          div.innerHTML = `
            <img src="${fullUrl}" class="preview-image" loading="lazy">
            <button type="button" class="remove-image-btn" onclick="removeExistingImage('${item['Part Number']}', '${url}', event)">&times;</button>
          `;
          previewContainer.appendChild(div);
        });
      }
    }
  } else {
    document.getElementById('modalTitle').innerText = "🛠️ เพิ่มสินค้าใหม่";
    document.getElementById('editMode').value = "false";
    document.getElementById('m_pn').readOnly = false;
    document.getElementById('manageForm').reset();
    // Resetting the form already clears previews, but we do it again for safety
    previewContainer.innerHTML = '';
    label.innerHTML = `<span>📸 คลิกเพื่อเลือกรูปภาพ (เลือกได้หลายรูป)</span>`;
    label.style.borderColor = 'rgba(255,255,255,0.3)';
  }
}

function closeManageModal() {
  document.getElementById('manageModal').classList.remove('open');
}

// Backdrop click intentionally disabled — close via ESC or X button only
document.getElementById('reportModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('open');
});

document.addEventListener('keydown', function(event) {
  if (event.key === "Escape") {
    document.querySelectorAll('.modal-overlay.open').forEach(modal => {
      modal.classList.remove('open');
    });
  }
});

document.addEventListener('keydown', function(event) {
  if (event.key === "Escape") {
    document.querySelectorAll('.modal-overlay.open').forEach(modal => {
      modal.classList.remove('open');
    });
  }
});

/* ──────────────── FORM SUBMIT ──────────────── */
document.getElementById('manageForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
  const orig = btn.innerHTML;
  btn.innerHTML = '⏳ กำลังบันทึก...';

  const isEdit = document.getElementById('editMode').value === "true";
  const formData = new FormData(e.target);

  // Ensure cost_price is never sent as empty string (FastAPI float parse would fail → 422)
  if (!formData.get('cost_price') || String(formData.get('cost_price')).trim() === '') {
    formData.set('cost_price', '0');
  }
  const pn = (document.getElementById('m_pn').value || '').trim();
  if (!pn) {
    await fancyAlert('Part Number ว่างเปล่า — ไม่สามารถบันทึกได้', 'error');
    btn.innerHTML = orig;
    return;
  }
  const url    = `${API_URL}/inventory`;
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, { method, body: formData });
    if (res.ok) {
      const resData = await res.json().catch(() => ({}));
      closeManageModal();
      const pnVal = pn;
      const formPrice = Number(formData.get('price')) || 0;
      const formStock = Number(formData.get('stock')) || 0;
      const formUsedPrice = Number(formData.get('used_price')) || 0;
      const formUsedStock = Number(formData.get('used_stock')) || 0;
      const formBrand = (formData.get('brand') || '').trim().toUpperCase();
      const formSeries = (formData.get('series') || '').trim().toUpperCase();
      const formName = formData.get('part_name') || '';
      const formCost = Number(formData.get('cost_price')) || 0;
      const formLoc = formData.get('location') || '';
      const formStockLH    = Number(formData.get('stock_lh'))      || 0;
      const formStockRH    = Number(formData.get('stock_rh'))      || 0;
      const formUsedStockLH = Number(formData.get('used_stock_lh')) || 0;
      const formUsedStockRH = Number(formData.get('used_stock_rh')) || 0;
      // Use image_url returned by server (relative paths, comma-separated)
      const serverImageUrl = resData.image_url !== undefined ? resData.image_url : null;
      if (isEdit) {
        const idx = globalData.findIndex(i => i['Part Number'] === pnVal);
        if (idx !== -1) {
          globalData[idx] = { ...globalData[idx],
            'Part Name': formName, 'Brand': formBrand, 'Series': formSeries,
            'Price': formPrice, 'Stock': formStock, 'Stock_LH': formStockLH, 'Stock_RH': formStockRH,
            'Used_Price': formUsedPrice, 'Used_Stock': formUsedStock, 'Used_Stock_LH': formUsedStockLH, 'Used_Stock_RH': formUsedStockRH,
            'Cost Price': formCost, 'Storage Location': formLoc,
            // Update Image_URL immediately from server response so card shows new image right away
            ...(serverImageUrl !== null ? { 'Image_URL': serverImageUrl } : {})
          };
        }
      } else {
        globalData.push({
          'Part Number': pnVal, 'Part Name': formName, 'Brand': formBrand,
          'Series': formSeries, 'Price': formPrice, 'Stock': formStock,
          'Used_Price': formUsedPrice, 'Used_Stock': formUsedStock,
          'Image_URL': serverImageUrl !== null ? serverImageUrl : '',
          'Cost Price': formCost, 'Storage Location': formLoc,
          'Stock_LH': formStockLH, 'Stock_RH': formStockRH,
          'Used_Stock_LH': formUsedStockLH, 'Used_Stock_RH': formUsedStockRH
        });
      }
      inventoryFilterCache = null;
      window.globalData = globalData;
      renderGrid(applySort(globalData));
      updateStats(globalData);
      buildFilterChips();
    } else {
      let errMsg = `Error ${res.status}`;
      try {
        const err = await res.json();
        errMsg = err.detail[0]?.msg || err.detail || errMsg;
      } catch {}
      await fancyAlert(errMsg, 'error');
    }
  } catch (ex) {
    await fancyAlert('เชื่อมต่อ Backend ล้มเหลว: ' + ex.message, 'error');
  }
  btn.innerHTML = orig;
};

/* ──────────────── DELETE ──────────────── */
async function deleteProduct(pn) {
  pn = (pn || '').trim();
  if (!pn) { await fancyAlert('ไม่พบ Part Number', 'error'); return; }
  if (!await fancyConfirm(`ยืนยันลบ Part: ${pn}?`)) return;
  try {
    const res = await fetch(`${API_URL}/inventory?part_number=${encodeURIComponent(pn)}`, { method: 'DELETE' });
    if (res.ok) { 
      // Refresh data without changing page
      await loadProducts();
      renderGrid(applySort(globalData));
      updateStats(globalData);
      buildFilterChips();
    }
    else { const err = await res.json(); await fancyAlert(err.detail, 'error'); }
  } catch { await fancyAlert('เชื่อมต่อระบบล้มเหลว', 'error'); }
}

/* ──────────────── SELECTS ──────────────── */
function populateSelectsModal() {
  // Deduplicate case-insensitively: keep first occurrence, sorted
  const seenBrands = new Map();
  globalData.forEach(i => {
    const key = i.Brand.trim().toUpperCase();
    if (!seenBrands.has(key)) seenBrands.set(key, i.Brand.trim());
  });
  const seenSeries = new Map();
  globalData.forEach(i => {
    const key = i.Series.trim().toUpperCase();
    if (!seenSeries.has(key)) seenSeries.set(key, i.Series.trim());
  });

  const brands = [...seenBrands.values()].sort();
  const series = [...seenSeries.values()].sort();

  const bSel = document.getElementById('m_brand');
  const sSel = document.getElementById('m_series');
  bSel.innerHTML = '<option value="">Brand</option>';
  sSel.innerHTML = '<option value="">Series</option>';
  brands.forEach(b => bSel.innerHTML += `<option value="${b}">${b}</option>`);
  series.forEach(s => sSel.innerHTML += `<option value="${s}">${s}</option>`);
  
  // Add event listener to brand select to filter series
  bSel.addEventListener('change', filterSeriesByBrand);
}

function filterSeriesByBrand() {
  const selectedBrand = document.getElementById('m_brand').value;
  const sSel = document.getElementById('m_series');
  
  if (!selectedBrand) {
    // Show all series if no brand selected
    [...sSel.options].forEach(opt => {
      if (opt.value) opt.style.display = '';
    });
    return;
  }
  
  // Get series for selected brand from data
  const seriesForBrand = new Set();
  globalData.forEach(item => {
    if (item.Brand.trim().toUpperCase() === selectedBrand.toUpperCase()) {
      seriesForBrand.add(item.Series.trim().toUpperCase());
    }
  });
  
  // Show/hide series options
  [...sSel.options].forEach(opt => {
    if (!opt.value) return; // Always show placeholder
    const optText = opt.text.trim().toUpperCase();
    opt.style.display = seriesForBrand.has(optText) ? '' : 'none';
  });
  
  // Reset series selection
  sSel.value = '';
}

/* ลบ Brand หรือ Series ที่เลือกออกจาก dropdown */
async function deleteFromSelect(mode) {
  const sel = document.getElementById(mode === 'brand' ? 'm_brand' : 'm_series');
  const val = sel.value;
  if (!val) {
    // flash red border hint
    sel.style.borderColor = 'rgba(220,38,38,0.7)';
    setTimeout(() => sel.style.borderColor = '', 800);
    return;
  }
  // ถ้า brand/series นี้ยังมีสินค้าอยู่ในระบบ ให้เตือน
  const inUse = globalData.some(i =>
    mode === 'brand'
      ? i.Brand.toUpperCase() === val.toUpperCase()
      : i.Series.toUpperCase() === val.toUpperCase()
  );
  const label = mode === 'brand' ? 'Brand' : 'Series';
  if (inUse) {
    const ok = await fancyConfirm(`"${val}" ยังถูกใช้งานโดยสินค้าในระบบ\nการลบออกจากรายการนี้จะทำให้เลือกไม่ได้ในครั้งหน้า\nต้องการลบออกจากรายการ ${label} หรือไม่?`);
    if (!ok) return;
  }
  // Remove matching option
  [...sel.options].forEach(opt => {
    if (opt.value.toUpperCase() === val.toUpperCase()) opt.remove();
  });
  sel.value = '';
}

/* ──────────────── DARK PROMPT ──────────────── */
function openDarkPrompt(mode) {
  dpMode = mode;
  const isB = mode === 'brand';
  document.getElementById('dpLabel').innerText = isB ? '➕ เพิ่ม Brand ใหม่' : '➕ เพิ่ม Series ใหม่';
  document.getElementById('dpSub').innerText   = isB ? 'ชื่อแบรนด์รถบรรทุก เช่น HINO, ISUZU' : 'ชื่อซีรีส์ เช่น PROFIA, MEGA 700';
  document.getElementById('dpInput').value = '';
  document.getElementById('dpInput').placeholder = isB ? 'เช่น HINO' : 'เช่น PROFIA';
  document.getElementById('darkPromptOverlay').classList.add('open');
  setTimeout(()=> document.getElementById('dpInput').focus(), 100);
}

function closeDarkPrompt() {
  document.getElementById('darkPromptOverlay').classList.remove('open');
}

function confirmDarkPrompt() {
  const val = document.getElementById('dpInput').value.trim();
  if (!val) return;
  const sel = document.getElementById(dpMode === 'brand' ? 'm_brand' : 'm_series');
  // check duplicate
  const exists = [...sel.options].some(o => o.value.toLowerCase() === val.toLowerCase());
  if (!exists) sel.innerHTML += `<option value="${val}">${val}</option>`;
  sel.value = val;
  closeDarkPrompt();
}

// click outside dark prompt to close
document.getElementById('darkPromptOverlay').addEventListener('click', function(e){
  if (e.target === this) closeDarkPrompt();
});

/* ──────────────── SCAN / AI ──────────────── */
function showScanToast(msg, type = 'info') {
  let toast = document.getElementById('scanToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'scanToast';
    toast.style.cssText = `
      position:fixed; bottom:110px; left:50%; transform:translateX(-50%) translateY(20px);
      background:rgba(14,14,26,0.96); border:0.5px solid rgba(255,255,255,0.15);
      backdrop-filter:blur(20px); border-radius:14px; padding:12px 20px;
      font-size:13px; color:#f5f5f7; z-index:200; opacity:0;
      transition:all 0.35s cubic-bezier(0.34,1.56,0.64,1); max-width:320px; text-align:center;
      box-shadow:0 16px 40px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(toast);
  }
  const colors = { info:'#60a5fa', success:'#34d399', error:'#f87171' };
  toast.style.borderColor = `rgba(${type==='success'?'52,211,153':type==='error'?'248,113,113':'96,165,250'},0.4)`;
  toast.innerHTML = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
  }, 3500);
}

async function handleScan(input) {
  if (!input.files.length) return;
  const fileToSend = input.files[0];  // save before clearing
  input.value = '';                   // reset so same file can be re-selected
  const fd = new FormData(); fd.append('file', fileToSend);

  const searchEl = document.getElementById('searchInput');
  const orig = searchEl.value;
  searchEl.value = '';
  searchEl.placeholder = '🔍 AI กำลังวิเคราะห์รูปภาพ…';
  const scanBtn = document.getElementById('scanDockBtn');
  if (scanBtn) scanBtn.classList.add('scanning');
  showScanToast('⏳ AI กำลังระบุชิ้นส่วน…', 'info');

  try {
    const res = await fetch(`${API_URL}/vision`, { method: 'POST', body: fd });
    if (scanBtn) scanBtn.classList.remove('scanning');
    searchEl.placeholder = 'ค้นหา Part Number หรือชื่อชิ้นส่วน…';

    if (!res.ok) {
      searchEl.value = orig;
      showScanToast('❌ AI ขัดข้อง กรุณาลองใหม่', 'error');
      return;
    }

    const data = await res.json();

    if (data.match && data.match.toLowerCase() !== 'none') {
      // Use the full Part Number — do NOT split on spaces (PNs can contain spaces)
      const matchPN = data.match.trim();
      searchEl.value = matchPN;
      filterCards();
      const label = data.identified_as ? ` (${data.identified_as})` : '';
      showScanToast(`✅ พบ: <strong>${matchPN}</strong>${label}`, 'success');
      // Glow the first matched card
      setTimeout(() => {
        const firstCard = document.querySelector('#productGrid .card');
        if (firstCard) {
          firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          firstCard.style.transition = 'box-shadow 0.4s ease';
          firstCard.style.boxShadow = '0 0 0 2px #60a5fa, 0 24px 48px rgba(96,165,250,0.35)';
          setTimeout(() => { firstCard.style.boxShadow = ''; }, 3000);
        }
      }, 150);

    } else if (data.candidates && data.candidates.length > 0) {
      // AI couldn't pinpoint exact PN but found keyword matches
      const matched = globalData.filter(item =>
        data.candidates.includes(item['Part Number'].trim())
      );
      if (matched.length > 0) {
        renderGrid(matched);
        document.getElementById('countLabel').innerText = `${matched.length} items`;
        showScanToast(`🔍 AI ระบุว่าเป็น "<strong>${data.identified_as}</strong>" — พบ ${matched.length} รายการ`, 'info');
      } else {
        showScanToast(`⚠️ ${data.message || 'ไม่พบสินค้าที่ตรงกัน'}`, 'error');
      }

    } else if (data.identified_as) {
      // Last resort: text search with identified part type
      searchEl.value = data.identified_as;
      filterCards();
      const count = document.querySelectorAll('#productGrid .card').length;
      if (count > 0) {
        showScanToast(`🔍 ค้นหาด้วย "<strong>${data.identified_as}</strong>" — ${count} รายการ`, 'info');
      } else {
        searchEl.value = '';
        filterCards();
        showScanToast(`⚠️ ${data.message || 'ไม่พบสินค้าที่ตรงกัน'}`, 'error');
      }

    } else {
      searchEl.value = orig;
      showScanToast(`⚠️ ${data.message || 'ไม่พบสินค้าที่ตรงกัน'}`, 'error');
    }
  } catch {
    if (scanBtn) scanBtn.classList.remove('scanning');
    searchEl.placeholder = 'ค้นหา Part Number หรือชื่อชิ้นส่วน…';
    searchEl.value = orig;
    showScanToast('❌ เชื่อมต่อ AI ไม่สำเร็จ', 'error');
  }
}

function renderReport(text) {
  // Convert AI markdown text to beautiful HTML sections
  const lines = text.split('\n');
  let html = '';
  let inSection = false;
  let sectionContent = '';
  let sectionTitle = '';
  let sectionColor = 'blue';

  const colorMap = {
    '🚨': 'red', '⚠️': 'amber', '💎': 'blue', '📌': 'green', '✅': 'green',
    '🔴': 'red', '🟡': 'amber', '🟢': 'green', '📊': 'blue'
  };

  function flushSection() {
    if (!sectionTitle && !sectionContent) return;
    html += `<div class="report-section">`;
    if (sectionTitle) {
      const emoji = [...Object.keys(colorMap)].find(e => sectionTitle.includes(e)) || '';
      const col = colorMap[emoji] || 'blue';
      html += `<div class="report-section-title ${col}">${sectionTitle}</div>`;
    }
    // Render content lines
    const contentLines = sectionContent.split('\n').filter(l => l.trim());
    contentLines.forEach(line => {
      const clean = line.replace(/^[-*•]\s*/, '').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      if (clean.trim()) {
        html += `<div class="report-item"><div class="report-item-dot"></div><div>${clean}</div></div>`;
      }
    });
    html += `</div>`;
    sectionTitle = '';
    sectionContent = '';
  }

  lines.forEach(line => {
    const trimmed = line.trim();
    // Detect section headers: lines starting with emoji + number or just emoji heading
    if (/^[1-4][)\.]?\s*[🚨💎⚠️📌]/.test(trimmed) || /^[🚨💎⚠️📌]/.test(trimmed)) {
      flushSection();
      sectionTitle = trimmed.replace(/^[1-4][)\.]\s*/, '');
    } else if (trimmed) {
      sectionContent += line + '\n';
    }
  });
  flushSection();

  return html || `<div style="white-space:pre-wrap;color:rgba(255,255,255,0.8);font-size:13px;">${text}</div>`;
}

/* ══════════════════════════════════════
   RECEIVE STOCK MODAL
══════════════════════════════════════ */
let recvSelectedPN = null;

function openReceiveModal() {
  recvSelectedPN = null;
  document.getElementById('recvSearch').value = '';
  document.getElementById('recvDropdown').classList.remove('open');
  document.getElementById('recvSelectedCard').classList.remove('show');
  document.getElementById('recvQty').value = '';
  document.getElementById('recvQtyLH').value = '';
  document.getElementById('recvQtyRH').value = '';
  document.getElementById('recvUsedQty').value = '';
  document.getElementById('recvUsedQtyLH').value = '';
  document.getElementById('recvUsedQtyRH').value = '';
  document.getElementById('recvNote').value = '';
  document.getElementById('recvSubmitBtn').disabled = true;
  document.getElementById('receiveModal').classList.add('open');
}

function closeReceiveModal() {
  document.getElementById('receiveModal').classList.remove('open');
}

function recvFilter(q) {
  const dd = document.getElementById('recvDropdown');
  const term = (q || '').trim().toLowerCase();
  const results = globalData.filter(i =>
    (i['Part Number'] || '').toLowerCase().includes(term) ||
    (i['Part Name']   || '').toLowerCase().includes(term)
  ).slice(0, 30);

  if (!term && !results.length) { dd.classList.remove('open'); return; }
  dd.innerHTML = results.map(i => `
    <div class="recv-option" onclick="recvSelectItem('${(i['Part Number']||'').replace(/'/g,"\\'")}')">
      <strong>${i.Brand} · ${i.Series}</strong> — ${i['Part Name']}
    </div>`).join('') || '<div class="recv-option" style="color:rgba(255,255,255,0.3)">ไม่พบสินค้า</div>';
  dd.classList.add('open');
}

function recvSelectItem(pn) {
  const item = globalData.find(i => i['Part Number'] === pn);
  if (!item) return;
  recvSelectedPN = pn;
  document.getElementById('recvSearch').value = `${pn} — ${item['Part Name']}`;
  document.getElementById('recvDropdown').classList.remove('open');

  document.getElementById('recvCardName').textContent = item['Part Name'];
  document.getElementById('recvCardMeta').textContent = `${item['Brand']} · ${item['Series']} · ${pn}`;
  const chips = [
    `ใหม่: ${item['Stock']||0}`,
    `LH: ${item['Stock_LH']||0}`, `RH: ${item['Stock_RH']||0}`,
    `เก่า: ${item['Used_Stock']||0}`,
    `เก่า LH: ${item['Used_Stock_LH']||0}`, `เก่า RH: ${item['Used_Stock_RH']||0}`,
  ];
  document.getElementById('recvStockChips').innerHTML = chips.map(c => `<span class="recv-stock-chip">${c}</span>`).join('');
  document.getElementById('recvSelectedCard').classList.add('show');
  document.getElementById('recvSubmitBtn').disabled = false;
}

function recvSyncNewSides() {
  const lh = Number(document.getElementById('recvQtyLH').value||0);
  const rh = Number(document.getElementById('recvQtyRH').value||0);
  if (lh || rh) document.getElementById('recvQty').value = lh + rh;
}
function recvSyncNew() {
  // total typed manually — don't override sides
}
function recvSyncUsedSides() {
  const lh = Number(document.getElementById('recvUsedQtyLH').value||0);
  const rh = Number(document.getElementById('recvUsedQtyRH').value||0);
  if (lh || rh) document.getElementById('recvUsedQty').value = lh + rh;
}
function recvSyncUsed() {}

async function submitReceive() {
  if (!recvSelectedPN) return;
  const qty       = Number(document.getElementById('recvQty').value||0);
  const qtyLH     = Number(document.getElementById('recvQtyLH').value||0);
  const qtyRH     = Number(document.getElementById('recvQtyRH').value||0);
  const usedQty   = Number(document.getElementById('recvUsedQty').value||0);
  const usedQtyLH = Number(document.getElementById('recvUsedQtyLH').value||0);
  const usedQtyRH = Number(document.getElementById('recvUsedQtyRH').value||0);
  const note      = document.getElementById('recvNote').value.trim();

  if (!qty && !qtyLH && !qtyRH && !usedQty && !usedQtyLH && !usedQtyRH) {
    await fancyAlert('กรุณาใส่จำนวนที่รับเข้าอย่างน้อย 1 ช่อง', 'error'); return;
  }

  const btn = document.getElementById('recvSubmitBtn');
  btn.disabled = true; btn.textContent = 'กำลังบันทึก...';

  try {
    const fd = new FormData();
    fd.append('part_number', recvSelectedPN);
    fd.append('qty',          qty);
    fd.append('qty_lh',       qtyLH);
    fd.append('qty_rh',       qtyRH);
    fd.append('used_qty',     usedQty);
    fd.append('used_qty_lh',  usedQtyLH);
    fd.append('used_qty_rh',  usedQtyRH);
    fd.append('note',         note);

    const res = await fetch(`${API_URL}/inventory/receive`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'เกิดข้อผิดพลาด');

    // อัปเดต globalData ทันที
    const idx = globalData.findIndex(i => i['Part Number'] === recvSelectedPN);
    if (idx !== -1) {
      globalData[idx]['Stock']         = data.stock;
      globalData[idx]['Stock_LH']      = data.stock_lh;
      globalData[idx]['Stock_RH']      = data.stock_rh;
      globalData[idx]['Used_Stock']    = data.used_stock;
      globalData[idx]['Used_Stock_LH'] = data.used_stock_lh;
      globalData[idx]['Used_Stock_RH'] = data.used_stock_rh;
    }
    renderGrid(applySort(globalData));
    closeReceiveModal();
    await fancyAlert(`✅ รับสินค้าเข้าสำเร็จ!\nStock ใหม่ (รวม): ${data.stock}`, 'success');
  } catch (ex) {
    await fancyAlert('เกิดข้อผิดพลาด: ' + ex.message, 'error');
    btn.disabled = false; btn.textContent = 'บันทึกรับสินค้า';
  }
}

/* receiveModal backdrop click disabled — close via ✕ or ESC only */
document.addEventListener('click', function(e) {
  const dd = document.getElementById('recvDropdown');
  if (dd && !dd.contains(e.target) && e.target.id !== 'recvSearch') {
    dd.classList.remove('open');
  }
});

async function generateReport() {
  const modal = document.getElementById('reportModal');
  modal.classList.add('open');
  document.getElementById('reportContent').innerHTML = '<div class="report-loading"><div class="spinner"></div>กำลังให้ AI วิเคราะห์คลังสินค้า...</div>';
  try {
    const res = await fetch(`${API_URL}/summary`);
    const data = await res.json();
    document.getElementById('reportContent').innerHTML = renderReport(data.report);
  } catch { document.getElementById('reportContent').innerHTML = '<div class="report-loading">❌ ไม่สามารถสร้างรายงานได้</div>'; }
}

async function sendChat() {
  const inp = document.getElementById('chatIn');
  const txt = inp.value.trim();
  if (!txt) return;
  const msgs = document.getElementById('chatMsgs');

  // User bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'msg-bubble user-msg';
  userBubble.textContent = txt;
  msgs.appendChild(userBubble);

  inp.value = '';
  inp.style.height = 'auto';
  msgs.scrollTop = msgs.scrollHeight;

  // Typing indicator
  const typing = document.createElement('div');
  typing.className = 'msg-bubble';
  typing.innerHTML = '<span style="opacity:0.5;letter-spacing:2px;animation:pulse 1s infinite">●●●</span>';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  const fd = new FormData(); fd.append('question', txt);
  try {
    const res = await fetch(`${API_URL}/chat`, { method: 'POST', body: fd });
    const data = await res.json();
    typing.remove();
    const aiBubble = document.createElement('div');
    aiBubble.className = 'msg-bubble';
    aiBubble.innerHTML = data.reply.replace(/\n/g,'<br>');
    msgs.appendChild(aiBubble);
  } catch {
    typing.remove();
    const errBubble = document.createElement('div');
    errBubble.className = 'msg-bubble';
    errBubble.innerHTML = '❌ AI ขัดข้อง กรุณาลองใหม่อีกครั้ง';
    msgs.appendChild(errBubble);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function toggleChat() { document.getElementById('chatPanel').classList.toggle('open'); }

/* ══════════════════════════════════════
   ANALYTICS PAGE
══════════════════════════════════════ */
let analyticsInitialized = false;

function initAnalytics() {
  renderStockDashboard();
}

function buildLiveStats() {
  const data = globalData;
  if (!data.length) {
    document.getElementById('an-live-sub').textContent = 'ไม่พบข้อมูล';
    return;
  }

  const toNum = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const total = data.length;
  const totalStock = data.reduce((s, i) => s + toNum(i.Stock), 0);
  const lowStock = data.filter(i => toNum(i.Stock) < 5 && toNum(i.Stock) > 0).length;
  const outStock = data.filter(i => toNum(i.Stock) === 0).length;
  const totalVal = data.reduce((s, i) => s + toNum(i.Price) * toNum(i.Stock), 0);

  document.getElementById('an-live-sub').textContent =
    `อัปเดตล่าสุด: ${new Date().toLocaleDateString('th-TH', {day:'numeric',month:'short',year:'2-digit'})}`;

  document.getElementById('an-live-stats').innerHTML = `
    <div class="an-live-item">
      <div class="an-live-val" style="color:#60a5fa">${total}</div>
      <div class="an-live-lbl">รายการสินค้าทั้งหมด</div>
    </div>
    <div class="an-live-item">
      <div class="an-live-val" style="color:#34d399">${totalStock.toLocaleString()}</div>
      <div class="an-live-lbl">หน่วยในสต็อก</div>
    </div>
    <div class="an-live-item">
      <div class="an-live-val" style="color:#fbbf24">${lowStock}</div>
      <div class="an-live-lbl">สินค้าใกล้หมด (&lt;5)</div>
    </div>
    <div class="an-live-item">
      <div class="an-live-val" style="color:#a78bfa">฿${(totalVal/1000).toFixed(0)}K</div>
      <div class="an-live-lbl">มูลค่าสต็อกรวม</div>
    </div>
  `;

  // Brand distribution
  const brandCounts = {};
  data.forEach(i => {
    const b = (i.Brand || '').trim().toUpperCase() || 'OTHER';
    brandCounts[b] = (brandCounts[b] || 0) + 1;
  });
  const sorted = Object.entries(brandCounts).sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0]?.[1] || 1;
  const colors = ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#fb923c'];

  const container = document.getElementById('an-brand-chart');
  container.innerHTML = sorted.map(([brand, count], idx) => `
    <div class="an-brand-row">
      <div class="an-brand-name">${brand}</div>
      <div class="an-brand-track">
        <div class="an-brand-fill" style="background:${colors[idx % colors.length]};width:0%"
             data-w="${Math.round(count / maxCount * 100)}%"></div>
      </div>
      <div class="an-brand-cnt">${count} รายการ</div>
    </div>
  `).join('');

  setTimeout(() => {
    container.querySelectorAll('.an-brand-fill').forEach(el => {
      el.style.width = el.dataset.w;
    });
  }, 400);
}
function setNav(el) {
  document.querySelectorAll('.nav-pill').forEach(p=>p.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* ──────────────── PAGE STATE ──────────────── */
let currentPage = 'inventory'; // track current page

function switchPage(page, el) {
  const validPages = ['inventory', 'orders', 'analytics'];
  if (!validPages.includes(page)) page = 'inventory';
  currentPage = page; // store current page
  try { localStorage.setItem('leo_last_page', page); } catch {}
  setNav(el || document.querySelector(`.nav-pill[data-view="${page}"]`));
  validPages.forEach(id => {
    const div = document.getElementById('page-' + id);
    if (div) div.style.display = (id === page) ? '' : 'none';
  });
  if (page === 'orders') initOrdersPage().catch(error => { document.getElementById('billHistory').textContent = 'โหลดบิลไม่สำเร็จ ลองเปิดหน้านี้อีกครั้ง'; console.error(error); });
  if (page === 'analytics') initAnalytics();
}

/* ── DOCK TOGGLE ── */
function toggleDock() {
  document.getElementById('bottomBar').classList.toggle('hidden');
}
// ใส่ไว้ด้านล่างสุดของสคริปต์ใน index.html

// ฟังก์ชันสลับการมองเห็น (เปิด/ปิด ลูกตา)
function toggleVisibility(inputId, iconEl) {
    const inputField = document.getElementById(inputId);
    if (inputField.type === "password") {
        inputField.type = "text";     // แสดงตัวเลข
        iconEl.innerText = "🙈";       // เปลี่ยนเป็นไอคอนปิดตา
    } else {
        inputField.type = "password"; // ซ่อนเป็นจุดๆ
        iconEl.innerText = "👁️";       // เปลี่ยนเป็นไอคอนเปิดตา
    }
}

// ฟังก์ชันสำหรับส่งราคาทุนที่แก้ไขไปบันทึก (ปรับ URL ให้ตรงกับ API ของคุณ)
async function updateCost(partNumber, newCost) {
    const fd = new FormData();
    fd.append('part_number', partNumber);
    fd.append('cost_price', newCost); // ชื่อ key ต้องตรงกับที่รับใน main.py

    try {
        // เปลี่ยน endpoint เป็น endpoint ที่คุณใช้อัปเดตสินค้า
        const res = await fetch(`${API_URL}/edit`, { 
            method: 'POST', 
            body: fd 
        });
        
        if (res.ok) {
            console.log("บันทึกราคาทุนสำเร็จ");
        } else {
            await fancyAlert('เกิดข้อผิดพลาดในการบันทึกราคาทุน', 'error');
        }
    } catch (err) {
        console.error(err);
    }
}

/* ══════════════════════════════════════
   ORDERS PAGE — Local Storage only
══════════════════════════════════════ */
let billItems   = [];   // current bill items
let billCounter = 1;    // auto-increment bill number
let billsCache  = [];   // shared bills from backend

// Invoice Template Data
let invoiceTemplate = {
  sellerName: 'Leo Auto',
  buyerName: '',
  paymentReceiver: '',
  date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }),
  notes: ''
};

function openInvoiceTemplate() {
  console.log("Opening invoice template modal...");
  const modal = document.getElementById('invoiceTemplateModal');
  console.log("Modal element:", modal);
  if (!modal) {
    console.error("Modal not found!");
    return;
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  document.getElementById('invoiceDate').value = today;
  document.getElementById('invoiceSellerName').value = invoiceTemplate.sellerName || '';
  document.getElementById('invoiceBuyerName').value = invoiceTemplate.buyerName || '';
  document.getElementById('invoicePaymentReceiver').value = invoiceTemplate.paymentReceiver || '';
  document.getElementById('invoiceNotes').value = invoiceTemplate.notes || '';
  modal.classList.add('open');
  console.log("Modal classes after add:", modal.className);
  setTimeout(() => {
    const input = document.getElementById('invoiceSellerName');
    if (input) input.focus();
  }, 100);
}

function closeInvoiceTemplate() {  document.getElementById('invoiceTemplateModal')?.classList.remove('open');}

function confirmInvoiceTemplate() {
  const sellerName = document.getElementById('invoiceSellerName').value.trim();
  const buyerName = document.getElementById('invoiceBuyerName').value.trim();
  const paymentReceiver = document.getElementById('invoicePaymentReceiver').value.trim();
  const date = document.getElementById('invoiceDate').value;
  const notes = document.getElementById('invoiceNotes').value.trim();
  
  if (!sellerName || !buyerName || !paymentReceiver || !date) {
    showScanToast('⚠️ กรุณากรอกข้อมูลทั้งหมด', 'error');
    return;
  }
  
  invoiceTemplate = { sellerName, buyerName, paymentReceiver, date, notes };
  document.getElementById('billDate').value = date;
  updateTemplateDisplay();
  closeInvoiceTemplate();
  // Reset bill for new order
  billItems = [];
  renderBillItems();
}

function updateTemplateDisplay() {  const seller = document.getElementById('templateSellerDisplay');  const buyer = document.getElementById('templateBuyerDisplay');  const payment = document.getElementById('templatePaymentDisplay');  if (seller) seller.textContent = invoiceTemplate.sellerName || '-';  if (buyer) buyer.textContent = invoiceTemplate.buyerName || '-';  if (payment) payment.textContent = invoiceTemplate.paymentReceiver || '-';}

let billDetailDraft = null;

function normalizePaymentMethod(method) {
  return String(method || '').toLowerCase() === 'cash' ? 'cash' : 'transfer';
}

function paymentMethodLabel(method) {
  return normalizePaymentMethod(method) === 'cash' ? 'เงินสด' : 'โอน';
}

function paymentMethodBadge(method) {
  const normalized = normalizePaymentMethod(method);
  return `<span class="bill-method-badge ${normalized}">${paymentMethodLabel(normalized)}</span>`;
}

function computeBillTotals(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const transfer = safeItems
    .filter(it => normalizePaymentMethod(it.paymentMethod) === 'transfer')
    .reduce((sum, it) => sum + (Number(it.price || 0) * Number(it.qty || 0)), 0);
  const cash = safeItems
    .filter(it => normalizePaymentMethod(it.paymentMethod) === 'cash')
    .reduce((sum, it) => sum + (Number(it.price || 0) * Number(it.qty || 0)), 0);
  return { transfer, cash, grand: transfer + cash };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateBillDetailSummary() {
  if (!billDetailDraft) return;
  const totals = computeBillTotals(billDetailDraft.items);
  document.getElementById('bill-detail-transfer-value').textContent = '฿' + totals.transfer.toLocaleString();
  document.getElementById('bill-detail-cash-value').textContent = '฿' + totals.cash.toLocaleString();
  document.getElementById('bill-detail-total-value').textContent = '฿' + totals.grand.toLocaleString();
}

function updateBillDetailItem(idx, field, value) {
  if (!billDetailDraft || !billDetailDraft.items[idx]) return;
  if (field === 'price') {
    const numeric = Number(value);
    billDetailDraft.items[idx].price = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  } else if (field === 'paymentMethod') {
    billDetailDraft.items[idx].paymentMethod = normalizePaymentMethod(value);
  } else {
    billDetailDraft.items[idx][field] = String(value || '');
  }
  const rowTotal = document.getElementById(`bill-detail-row-total-${idx}`);
  if (rowTotal) {
    rowTotal.textContent = '฿' + (Number(billDetailDraft.items[idx].price || 0) * Number(billDetailDraft.items[idx].qty || 0)).toLocaleString();
  }
  updateBillDetailSummary();
}

function renderBillDetailEditor() {
  if (!billDetailDraft) return;
  document.getElementById('bill-detail-name-input').value = billDetailDraft.name || (`บิล #${billDetailDraft.no}`);
  document.getElementById('bill-detail-date').textContent = `📅 ${billDetailDraft.date}`;
  document.getElementById('bill-detail-items').innerHTML = billDetailDraft.items.map((it, idx) => `
    <div class="detail-item-card">
      <label class="detail-section-label">รายการที่ ${idx + 1}</label>
      <input class="detail-item-name-input" type="text" value="${escapeHtml(it.name)}" oninput="updateBillDetailItem(${idx}, 'name', this.value)">
      <div class="detail-meta-line">${escapeHtml(it.pn)} · ${it.type === 'used' ? 'เก่า' : 'ใหม่'} · จำนวน ${Number(it.qty || 0).toLocaleString()}</div>
      <div class="detail-item-grid">
        <div>
          <span class="detail-section-label">ราคา/ชิ้น</span>
          <input class="detail-item-price-input" type="number" min="0" step="0.01" value="${Number(it.price || 0)}" oninput="updateBillDetailItem(${idx}, 'price', this.value)">
        </div>
        <div>
          <span class="detail-section-label">รับชำระ</span>
          <select class="detail-payment-select" onchange="updateBillDetailItem(${idx}, 'paymentMethod', this.value)">
            <option value="transfer" ${normalizePaymentMethod(it.paymentMethod) === 'transfer' ? 'selected' : ''}>โอน</option>
            <option value="cash" ${normalizePaymentMethod(it.paymentMethod) === 'cash' ? 'selected' : ''}>เงินสด</option>
          </select>
        </div>
        <div style="text-align:right;">
          <span class="detail-section-label">รวม</span>
          <div id="bill-detail-row-total-${idx}" style="font-size:14px;font-weight:700;">฿${(Number(it.price || 0) * Number(it.qty || 0)).toLocaleString()}</div>
        </div>
      </div>
    </div>
  `).join('');
  updateBillDetailSummary();
}

function normalizeBackendBill(bill) {
  const no = Number(bill.bill_no || 0);
  const items = Array.isArray(bill.items) ? bill.items : [];
  const normalizedItems = items.map(it => ({
    pn: String(it.part_number || ''),
    name: String(it.part_name || ''),
    qty: Number(it.quantity || 0),
    price: Number(it.unit_price || 0),
    type: String(it.type || 'new'),
    paymentMethod: normalizePaymentMethod(it.payment_method)
  }));
  const totals = computeBillTotals(normalizedItems);
  return {
    id: no,
    no,
    name: bill.name || `บิล #${no}`,
    date: String(bill.date || ''),
    items: normalizedItems,
    total: Number(bill.total || totals.grand)
  };
}

async function fetchAllBills() {
  const res = await fetch(`${API_URL}/orders`);
  if (!res.ok) throw new Error(`Cannot load orders (${res.status})`);
  const raw = await res.json();
  billsCache = Array.isArray(raw) ? raw.map(normalizeBackendBill) : [];
  return billsCache;
}

async function initOrdersPage() {
  // Set today date if not set — use Thailand timezone (UTC+7)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  if (!document.getElementById('billDate').value) {
    document.getElementById('billDate').value = today;
  }
  // History defaults to today (Thai timezone) so latest bills show immediately.
  if (!document.getElementById('historyDate').value) {
    document.getElementById('historyDate').value = today;
  }
  
  // Don't auto-open modal - let user click edit button
  updateTemplateDisplay();
  
  await updateBillNo();
  renderBillItems();
  await loadHistory();

}

async function updateBillNo() {
  const bills = await fetchAllBills();
  billCounter = bills.length + 1;
  document.getElementById('billNoBadge').textContent = '#' + billCounter;
}

/* ── Search ── */
function billSearch() {
  const q = document.getElementById('billSearchInput').value.toLowerCase().trim();
  const box = document.getElementById('billSearchResults');
  if (!q) { box.style.display = 'none'; return; }

  const results = globalData.filter(item => {
    const totalStock = Number(item.Stock || 0) + Number(item.Used_Stock || 0);
    return totalStock > 0 && (
      item['Part Name'].toLowerCase().includes(q) ||
      item['Part Number'].toLowerCase().includes(q) ||
      item['Brand'].toLowerCase().includes(q)
    );
  }).slice(0, 8);

  if (!results.length) { box.style.display = 'none'; return; }

  box.innerHTML = results.map(item => {
    const totalStock = Number(item.Stock || 0) + Number(item.Used_Stock || 0);
    const stockDisplay = totalStock > 0 ? `(เหลือ ${totalStock})` : '(หมด)';
    return `
    <div class="bill-drop-item" onclick="addToBill('${escQ(item['Part Number'])}')">
      <div style="flex:1;min-width:0;">
        <div class="bill-drop-name">${item['Part Name']}</div>
        <div class="bill-drop-pn">${item['Part Number']} · ${item['Brand']} ${item['Series']} ${stockDisplay}</div>
      </div>
      <div class="bill-drop-price">฿${Number(item.Price).toLocaleString()}</div>
      <div class="bill-drop-add">+</div>
    </div>
  `}).join('');
  box.style.display = 'block';
}

function escQ(s) { return String(s).replace(/'/g,"\'"); }

function addToBill(pn) {
  const item = globalData.find(i => i['Part Number'].trim() === pn.trim());
  if (!item) return;
  
  // Check if stock is available
  const totalStock = Number(item.Stock || 0) + Number(item.Used_Stock || 0);
  if (totalStock <= 0) {
    showScanToast('❌ สินค้านี้หมดแล้ว ไม่สามารถเพิ่มลงบิลได้', 'error');
    return;
  }
  
  const existing = billItems.find(b => b.pn === pn);
  if (existing) {
    existing.qty++;
  } else {
    billItems.push({ pn, name: item['Part Name'], price: Number(item.Price), qty: 1, type: 'new', paymentMethod: 'transfer' });
  }
  document.getElementById('billSearchInput').value = '';
  document.getElementById('billSearchResults').style.display = 'none';
  renderBillItems();
}

function renderBillItems() {
  const list = document.getElementById('billItems');
  if (!billItems.length) {
    list.innerHTML = '<div class="bill-empty">ยังไม่มีรายการ - ค้นหาสินค้าเพื่อเพิ่มในบิล</div>';
    updateBillTotals();
    return;
  }
  list.innerHTML = billItems.map((it, idx) => `
    <div class="bill-row">
      <div class="bill-row-name" style="flex:2;">
        <div class="bill-row-name-text">${it.name}</div>
        <div class="bill-row-name-pn">${it.pn}</div>
        <div class="item-type-selector" style="margin-top:4px; display:inline-flex; gap:4px; background: rgba(255,255,255,0.1); border-radius:8px; padding:2px; font-size:10px;">
            <button class="type-btn ${it.type === 'new' ? 'active' : ''}" style="padding:3px 7px; border-radius:6px; border:none; background:${it.type === 'new' ? 'rgba(0,0,0,0.3)' : 'transparent'}; color:${it.type === 'new' ? 'white' : 'rgba(255,255,255,0.5)'}; cursor:pointer; font-weight:${it.type === 'new' ? '500' : 'normal'}" onclick="changeItemType(${idx},'new')">ใหม่</button>
            <button class="type-btn ${it.type === 'used' ? 'active' : ''}" style="padding:3px 7px; border-radius:6px; border:none; background:${it.type === 'used' ? 'rgba(0,0,0,0.3)' : 'transparent'}; color:${it.type === 'used' ? 'white' : 'rgba(255,255,255,0.5)'}; cursor:pointer; font-weight:${it.type === 'used' ? '500' : 'normal'}" onclick="changeItemType(${idx},'used')">เก่า</button>
        </div>
      </div>
      <div class="bill-qty-ctrl">
        <div class="bill-qty-btn" onclick="changeQty(${idx},-1)">−</div>
        <input class="bill-qty-val" type="number" min="1" value="${it.qty}" onchange="setQty(${idx},this.value)">
        <div class="bill-qty-btn" onclick="changeQty(${idx},1)">+</div>
      </div>
      <div class="bill-row-price" onclick="editPrice(${idx})" style="cursor:pointer;padding:4px 8px;border-radius:6px;transition:all 0.2s;" onmouseover="this.style.background='rgba(96,165,250,0.15)'" onmouseout="this.style.background='transparent'" title="คลิกเพื่อแก้ไขราคา">฿${it.price.toLocaleString()}</div>
      <div class="bill-row-payment">
        <select class="bill-payment-select" onchange="changePaymentMethod(${idx}, this.value)">
          <option value="transfer" ${normalizePaymentMethod(it.paymentMethod) === 'transfer' ? 'selected' : ''}>โอน</option>
          <option value="cash" ${normalizePaymentMethod(it.paymentMethod) === 'cash' ? 'selected' : ''}>เงินสด</option>
        </select>
      </div>
      <div class="bill-row-total">฿${(it.price*it.qty).toLocaleString()}</div>
      <div class="bill-row-del" onclick="removeBillItem(${idx})">✕</div>
    </div>
  `).join('');
  updateBillTotals();
}

function editPrice(idx) {
  const item = billItems[idx];
  const newPrice = prompt(`แก้ไขราคาสำหรับ ${item.name}:\n(ราคาเดิม: ฿${item.price.toLocaleString()})`, item.price.toString());
  if (newPrice !== null) {
    const priceNum = Number(newPrice);
    if (!isNaN(priceNum) && priceNum > 0) {
      item.price = priceNum;
      renderBillItems();
    } else {
      showScanToast('❌ ราคาต้องเป็นตัวเลขที่มากกว่า 0', 'error');
    }
  }
}

function changeQty(idx, delta) {
  billItems[idx].qty = Math.max(1, billItems[idx].qty + delta);
  renderBillItems();
}
function setQty(idx, val) {
  billItems[idx].qty = Math.max(1, parseInt(val)||1);
  renderBillItems();
}
function removeBillItem(idx) {
  billItems.splice(idx,1);
  renderBillItems();
}

function changeItemType(idx, type) {
  const item = billItems[idx];
  const product = globalData.find(p => p['Part Number'] === item.pn);
  if (!product) return;
  
  item.type = type;
  item.price = type === 'new' ? (Number(product.Price) || 0) : (Number(product.Used_Price) || 0);
  renderBillItems();
}

function changePaymentMethod(idx, method) {
  if (!billItems[idx]) return;
  billItems[idx].paymentMethod = normalizePaymentMethod(method);
  updateBillTotals();
}

function updateBillTotals() {
  const totals = computeBillTotals(billItems);
  document.getElementById('billSubtotal').textContent = '฿'+totals.grand.toLocaleString();
  document.getElementById('billTransferTotal').textContent = '฿'+totals.transfer.toLocaleString();
  document.getElementById('billCashTotal').textContent = '฿'+totals.cash.toLocaleString();
  document.getElementById('billGrand').textContent    = '฿'+totals.grand.toLocaleString();
}

async function clearBill() {
  if (billItems.length && !await fancyConfirm('ล้างบิลนี้ใช่ไหม?')) return;
  billItems = [];
  renderBillItems();
  document.getElementById('billSaveMsg').textContent = '';
}

/* ── Save ── */
async function saveBill() {
  if (!billItems.length) { await fancyAlert('ยังไม่มีรายการในบิล', 'warn'); return; }
  const date = document.getElementById('billDate').value;
  if (!date) { await fancyAlert('กรุณาเลือกวันที่', 'warn'); return; }

  const bills = getAllBills();
  const bill = {
    id: Date.now(),
    no: bills.length + 1,
    date,
    items: billItems.map(i => ({...i})),
    total: billItems.reduce((s,i)=>s+i.price*i.qty,0),
    sellerName: invoiceTemplate.sellerName,
    buyerName: invoiceTemplate.buyerName,
    paymentReceiver: invoiceTemplate.paymentReceiver,
    notes: invoiceTemplate.notes
  };
  bills.push(bill);
  saveBills(bills);

  // Adjust stock quantities immediately when a bill is saved
  (async () => {
    try {
      await adjustStockForBill(bill);
      // refresh products after stock update
      await loadProducts();
    } catch (err) {
      console.error('Error adjusting stock for bill:', err);
      // still proceed — product quantities may be out-of-sync
    }
  })();

  document.getElementById('billSaveMsg').textContent = `✅ บันทึกบิล #${bill.no} แล้ว (${date}) - ${invoiceTemplate.sellerName}`;
  billItems = [];
  document.getElementById('billSaveMsg').style.color = '#34d399';
  setTimeout(() => {
    document.getElementById('billSaveMsg').textContent = '';
  }, 3000);
  renderBillItems();
  updateBillNo();

  // refresh history if same date shown
  const hDate = document.getElementById('historyDate').value;
  if (!hDate || hDate === date) {
    document.getElementById('historyDate').value = date;
    loadHistory();
  }
}

// Decrement stock for each item in a saved bill and persist to backend
async function adjustStockForBill(bill) {
  if (!bill || !bill.items || !bill.items.length) return;
  for (const it of bill.items) {
    try {
      const pn = it.pn;
      const product = globalData.find(p => (p['Part Number'] || '').trim() === (pn || '').trim());
      if (!product) continue;

      // compute new stock values (do not go below zero)
      const qty = Number(it.qty) || 0;
      if (it.type === 'used') {
        product.Used_Stock = Math.max(0, (Number(product.Used_Stock) || 0) - qty);
      } else {
        product.Stock = Math.max(0, (Number(product.Stock) || 0) - qty);
      }

      // prepare FormData for PUT (main.py expects form fields)
      const fd = new FormData();
      fd.append('part_number', product['Part Number']);
      fd.append('part_name', product['Part Name'] || '');
      fd.append('brand', product.Brand || '');
      fd.append('series', product.Series || '');
      fd.append('price', String(product.Price || 0));
      fd.append('stock', String(product.Stock || 0));
      fd.append('used_price', String(product.Used_Price || 0));
      fd.append('used_stock', String(product.Used_Stock || 0));
      fd.append('cost_price', String(product['Cost Price'] || 0));
      fd.append('location', product['Storage Location'] || '');

      // call backend PUT endpoint to persist changes
      const url = `${API_URL}/inventory`;
      const res = await fetch(url, { method: 'PUT', body: fd });
      if (!res.ok) {
        console.warn('Failed to update stock for', product['Part Number'], await res.text());
      }
    } catch (e) {
      console.error('adjustStockForBill error for item', it, e);
    }
  }
}

/* ── Storage helpers ── */
function getAllBills() {
  try { return JSON.parse(localStorage.getItem('leoBills') || '[]'); } catch { return []; }
}
function saveBills(bills) {
  localStorage.setItem('leoBills', JSON.stringify(bills));
}

/* ── History ── */
function loadHistory() {
  const date = document.getElementById('historyDate').value;
  document.getElementById('historyDateLabel').textContent = date || 'ทั้งหมด';
  const all = getAllBills();
  const filtered = date ? all.filter(b => b.date === date) : all;
  renderHistory(filtered);
}

function renderHistory(bills) {
  const list = document.getElementById('billHistory');
  const summary = document.getElementById('historySummary');

  if (!bills.length) {
    list.innerHTML = '<div class="bill-empty">ยังไม่มีบิลที่บันทึก</div>';
    summary.style.display = 'none';
    return;
  }

  list.innerHTML = bills.slice().reverse().map(bill => `
    <div class="hist-card">
      <div class="hist-card-header" onclick="toggleHistItems(${bill.id})">
        <div>
          <div style="display:flex;gap:10px;align-items:center;">
            <div class="hist-bill-name">${bill.name ? bill.name : 'บิล #' + bill.no}</div>
            <button class="hist-edit-name" onclick="event.stopPropagation(); editBillName(${bill.id})" title="แก้ชื่อบิล">✎</button>
          </div>
          <div class="hist-bill-date">📅 ${bill.date}</div>
        </div>
        <div style="text-align:right;">
          <div class="hist-bill-total">฿${bill.total.toLocaleString()}</div>
          <div>${paymentMethodBadge('transfer')} ฿${computeBillTotals(bill.items).transfer.toLocaleString()}</div>
          <div>${paymentMethodBadge('cash')} ฿${computeBillTotals(bill.items).cash.toLocaleString()}</div>
          <div class="hist-bill-count">${bill.items.length} รายการ ▾</div>
        </div>
      </div>
      <div class="hist-items" id="hist-items-${bill.id}">
        ${bill.items.map(it=>`
          <div class="hist-item-row">
            <span>${it.name} <span style="color:rgba(255,255,255,0.35)">×${it.qty}</span> ${paymentMethodBadge(it.paymentMethod)}</span>
            <span style="font-weight:600;color:#f5f5f7;">฿${(it.price*it.qty).toLocaleString()}</span>
          </div>
        `).join('')}
      </div>
      <div class="hist-del-btn">
        <button class="hist-btn hist-btn-view" onclick="openBillDetail(${bill.id})">📋 รายละเอียด</button>
        <button class="hist-btn hist-btn-load" onclick="loadBillToEditor(${bill.id})">📂 โหลดบิล</button>
        <button class="hist-btn hist-btn-print" onclick="openPrintTemplateA5(${bill.id})">🖨️ A5</button>
        <button class="hist-btn hist-btn-del" onclick="deleteBill(${bill.id})">🗑 ลบ</button>
      </div>
    </div>
  `).join('');

  // Summary
  const total = bills.reduce((s,b)=>s+b.total,0);
  const transferTotal = bills.reduce((sum, bill) => sum + computeBillTotals(bill.items).transfer, 0);
  const cashTotal = bills.reduce((sum, bill) => sum + computeBillTotals(bill.items).cash, 0);
  document.getElementById('sumBillCount').textContent = bills.length + ' บิล';
  document.getElementById('sumTransferTotal').textContent = '฿'+transferTotal.toLocaleString();
  document.getElementById('sumCashTotal').textContent = '฿'+cashTotal.toLocaleString();
  document.getElementById('sumTotal').textContent = '฿'+total.toLocaleString();
  summary.style.display = 'flex';
}

// Edit a saved bill's display name (stored in localStorage)
async function editBillName(id) {
  const bills = getAllBills();
  const bill = bills.find(b => b.id === id);
  if (!bill) return;
  const current = bill.name || (`บิล #${bill.no}`);
  const name = await fancyPrompt('ตั้งชื่อบิล (ปล่อยว่างเพื่อใช้ชื่ออัตโนมัติ)', current);
  if (name === null) return; // cancelled
  const newName = String(name).trim();
  if (newName) bill.name = newName; else delete bill.name;
  saveBills(bills);
  loadHistory();
}

// Open Bill Detail modal and populate items
function openBillDetail(id) {
  const bill = getAllBills().find(b => b.id === id);
  if (!bill) return;
  document.getElementById('bill-detail-name').textContent = bill.name || (`บิล #${bill.no}`);
  document.getElementById('bill-detail-date').textContent = `📅 ${bill.date}`;
  const itemsEl = document.getElementById('bill-detail-items');
  itemsEl.innerHTML = bill.items.map(it => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,0.04);">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600">${it.name}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.45);">${it.pn} · ${it.type}</div>
      </div>
      <div style="text-align:right;min-width:110px;">
        <div>฿${(it.price).toLocaleString()} × ${it.qty}</div>
        <div style="font-weight:700;margin-top:6px;">฿${(it.price*it.qty).toLocaleString()}</div>
      </div>
    </div>
  `).join('');
  document.getElementById('bill-detail-total-value').textContent = '฿' + (bill.total || 0).toLocaleString();
  document.getElementById('billDetailModal').classList.add('open');
}

function toggleHistItems(id) {
  const el = document.getElementById('hist-items-'+id);
  if (el) el.classList.toggle('open');
}

async function restockItemsFromBill(bill) {
  if (!bill || !bill.items || !bill.items.length) return;
  for (const it of bill.items) {
    try {
      const pn = it.pn;
      const product = globalData.find(p => (p['Part Number'] || '').trim() === (pn || '').trim());
      if (!product) {
        console.warn(`Product not found for restocking: ${pn}`);
        continue;
      }

      const qty = Number(it.qty) || 0;
      if (it.type === 'used') {
        product.Used_Stock = (Number(product.Used_Stock) || 0) + qty;
      } else {
        product.Stock = (Number(product.Stock) || 0) + qty;
      }

      const fd = new FormData();
      fd.append('part_number', product['Part Number']);
      fd.append('part_name', product['Part Name'] || '');
      fd.append('brand', product.Brand || '');
      fd.append('series', product.Series || '');
      fd.append('price', String(product.Price || 0));
      fd.append('stock', String(product.Stock || 0));
      fd.append('used_price', String(product.Used_Price || 0));
      fd.append('used_stock', String(product.Used_Stock || 0));
      fd.append('cost_price', String(product['Cost Price'] || 0));
      fd.append('location', product['Storage Location'] || '');

      const url = `${API_URL}/inventory`;
      const res = await fetch(url, { method: 'PUT', body: fd });
      if (!res.ok) {
        console.warn('Failed to restock for', product['Part Number'], await res.text());
      }
    } catch (e) {
      console.error('restockItemsFromBill error for item', it, e);
      throw new Error(`Failed to restock item ${it.pn}`);
    }
  }
}

async function deleteBill(id) {
  if (!await fancyConfirm('ลบบิลนี้ใช่ไหม? การกระทำนี้จะคืนสต็อกสินค้ากลับเข้าระบบ')) return;
  const allBills = getAllBills();
  const billToDelete = allBills.find(b => b.id === id);

  if (!billToDelete) {
    console.error(`Bill with id ${id} not found.`);
    return;
  }

  try {
    // Restock items before deleting the bill
    await restockItemsFromBill(billToDelete);

    // Filter out the deleted bill and save
    const updatedBills = allBills.filter(b => b.id !== id);
    saveBills(updatedBills);

    // Refresh UI
    await loadProducts(); // Reload products to reflect new stock
    loadHistory();
    updateBillNo();
    console.log(`Bill #${billToDelete.no} deleted and stock restored.`);
  } catch (error) {
    console.error('Failed to delete bill and restock:', error);
    await fancyAlert('เกิดข้อผิดพลาดระหว่างการลบบิลและคืนสต็อก', 'error');
  }
}

function loadBillToEditor(id) {
  const bill = getAllBills().find(b => b.id === id);
  if (!bill) return;
  billItems = bill.items.map(i => ({...i}));
  renderBillItems();
  document.getElementById('billDate').value = bill.date;
  document.getElementById('billSaveMsg').textContent = `โหลดบิล #${bill.no} แล้ว (บันทึกจะสร้างบิลใหม่)`;
}

/* ══════ TEST MODE ══════ */
/* Backend orders override: make bill history shared across devices */
async function updateBillNo() {
  const bills = await fetchAllBills();
  billCounter = bills.length + 1;
  document.getElementById('billNoBadge').textContent = '#' + billCounter;
}

async function saveBill() {
  if (!billItems.length) { await fancyAlert('ยังไม่มีรายการในบิล', 'warn'); return; }
  const date = document.getElementById('billDate').value;
  if (!date) { await fancyAlert('กรุณาเลือกวันที่', 'warn'); return; }

  const payload = {
    date,
    name: (document.getElementById('bill-name-input')?.value || '').trim(),
    items: billItems.map(i => ({
      part_number: i.pn,
      part_name: i.name,
      quantity: Number(i.qty || 0),
      unit_price: Number(i.price || 0),
      type: i.type || 'new',
      payment_method: normalizePaymentMethod(i.paymentMethod)
    }))
  };

  const res = await fetch(`${API_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    await fancyAlert('บันทึกบิลไม่สำเร็จ', 'error');
    return;
  }
  const out = await res.json();
  const no = out?.new_bill?.bill_no || '?';
  document.getElementById('billSaveMsg').textContent = `✅ บันทึกบิล #${no} แล้ว (${date})`;
  billItems = [];
  renderBillItems();
  await loadProducts();
  await loadHistory();
  await updateBillNo();
}

function getAllBills() { return billsCache || []; }
function saveBills(_) {}

async function loadHistory() {
  const date = document.getElementById('historyDate').value;
  document.getElementById('historyDateLabel').textContent = date || 'ทั้งหมด';
  const all = await fetchAllBills();
  const filtered = date ? all.filter(b => b.date === date) : all;
  renderHistory(filtered);
}

async function editBillName(id) {
  const bill = billsCache.find(b => b.id === id);
  if (!bill) return;
  const current = bill.name || (`บิล #${bill.no}`);
  const name = await fancyPrompt('ตั้งชื่อบิล (ปล่อยว่างเพื่อใช้ชื่ออัตโนมัติ)', current);
  if (name === null) return;
  const newName = String(name).trim();
  if (!newName) return;
  const res = await fetch(`${API_URL}/orders/${encodeURIComponent(bill.no)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) { await fancyAlert('แก้ชื่อบิลไม่สำเร็จ', 'error'); return; }
  await loadHistory();
}

function openBillDetail(id) {
  const bill = billsCache.find(b => b.id === id);
  if (!bill) return;
  billDetailDraft = {
    id: bill.id,
    no: bill.no,
    name: bill.name,
    date: bill.date,
    items: bill.items.map(it => ({ ...it, paymentMethod: normalizePaymentMethod(it.paymentMethod) }))
  };
  renderBillDetailEditor();
  document.getElementById('billDetailModal').classList.add('open');
}

async function saveBillDetailEdits() {
  if (!billDetailDraft) return;
  const billNameInput = document.getElementById('bill-detail-name-input');
  const updatedName = String(billNameInput?.value || '').trim() || (`บิล #${billDetailDraft.no}`);
  const payload = {
    name: updatedName,
    items: billDetailDraft.items.map(it => ({
      part_number: it.pn,
      part_name: String(it.name || '').trim() || it.pn,
      quantity: Number(it.qty || 0),
      unit_price: Number(it.price || 0),
      type: it.type || 'new',
      payment_method: normalizePaymentMethod(it.paymentMethod)
    }))
  };
  const res = await fetch(`${API_URL}/orders/${encodeURIComponent(billDetailDraft.no)}/detail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    await fancyAlert('บันทึกการแก้ไขบิลไม่สำเร็จ', 'error');
    return;
  }
  document.getElementById('billDetailModal').classList.remove('open');
  billDetailDraft = null;
  await loadHistory();
  await updateBillNo();
}

function printBillA5_legacy1(id) {
  const bill = billsCache.find(b => b.id === id);
  if (!bill) return;

  const rows = (bill.items || []).map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${it.name || '-'}</td>
      <td>${it.pn || '-'}</td>
      <td style="text-align:right">${Number(it.qty || 0).toLocaleString()}</td>
      <td style="text-align:right">฿${Number(it.price || 0).toLocaleString()}</td>
      <td style="text-align:right">฿${(Number(it.price || 0) * Number(it.qty || 0)).toLocaleString()}</td>
    </tr>
  `).join('');

  const title = (bill.name && String(bill.name).trim()) ? bill.name : `บิล #${bill.no}`;
  const html = `
<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    @page { size: A5 landscape; margin: 8mm; }
    html, body { margin: 0; padding: 0; font-family: "Tahoma", "Segoe UI", sans-serif; color: #111; }
    .sheet { width: 100%; }
    .head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8mm; }
    .brand { font-size: 18px; font-weight: 700; }
    .meta { font-size: 12px; line-height: 1.6; text-align: right; }
    .title { font-size: 16px; font-weight: 700; margin-bottom: 2mm; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #222; padding: 6px; vertical-align: top; }
    th { background: #f2f2f2; text-align: left; }
    .sum { margin-top: 6mm; display:flex; justify-content:flex-end; }
    .sum-box { min-width: 38%; border: 1px solid #222; padding: 8px 10px; font-size: 12px; }
    .sum-row { display:flex; justify-content:space-between; margin: 2px 0; }
    .sum-total { font-size: 15px; font-weight: 700; border-top: 1px solid #222; padding-top: 6px; margin-top: 6px; }
    .note { margin-top: 5mm; font-size: 10px; color:#444; }
  </style>
<link rel="stylesheet" href="/assets/legacy.css">
<link rel="stylesheet" href="/assets/workspace.css">
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div>
        <div class="brand">Leo Auto</div>
        <div class="title">ใบเสร็จ / ใบส่งของ</div>
      </div>
      <div class="meta">
        <div><strong>${title}</strong></div>
        <div>วันที่: ${bill.date || '-'}</div>
        <div>จำนวนรายการ: ${(bill.items || []).length}</div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:7%;">#</th>
          <th style="width:33%;">รายการ</th>
          <th style="width:20%;">Part Number</th>
          <th style="width:10%;text-align:right;">จำนวน</th>
          <th style="width:15%;text-align:right;">ราคา/ชิ้น</th>
          <th style="width:15%;text-align:right;">รวม</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sum">
      <div class="sum-box">
        <div class="sum-row"><span>ยอดรวมสุทธิ</span><strong>฿${Number(bill.total || 0).toLocaleString()}</strong></div>
        <div class="sum-row sum-total"><span>รวมทั้งสิ้น</span><span>฿${Number(bill.total || 0).toLocaleString()}</span></div>
      </div>
    </div>
    <div class="note">A5 Landscape (สำหรับใส่กระดาษแนวนอน/ข้าง)</div>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=980,height=700');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 250);
}

async function deleteBill(id) {
  if (!await fancyConfirm('ลบบิลนี้ใช่ไหม? การกระทำนี้จะคืนสต็อกสินค้ากลับเข้าระบบ')) return;
  const bill = billsCache.find(b => b.id === id);
  if (!bill) return;
  await restockItemsFromBill(bill);
  const res = await fetch(`${API_URL}/orders/${encodeURIComponent(bill.no)}`, { method: 'DELETE' });
  if (!res.ok) { await fancyAlert('ลบบิลไม่สำเร็จ', 'error'); return; }
  await loadProducts();
  await loadHistory();
  await updateBillNo();
}

function loadBillToEditor(id) {
  const bill = billsCache.find(b => b.id === id);
  if (!bill) return;
  billItems = bill.items.map(i => ({ ...i }));
  renderBillItems();
  document.getElementById('billDate').value = bill.date;
  document.getElementById('billSaveMsg').textContent = `โหลดบิล #${bill.no} แล้ว (บันทึกจะสร้างบิลใหม่)`;
}

const testState = {
  active: false,
  timers: {
    search: { interval: null, start: null, elapsed: 0, records: [] },
    bill:   { interval: null, start: null, elapsed: 0, records: [] }
  },
  ai: { correct: 0, near: 0, miss: 0 },
  stars: { ease: 0, speed: 0, accuracy: 0, ui: 0, overall: 0 },
  activeTimer: null
};

function toggleTestMode() {
  testState.active = !testState.active;
  const btn = document.getElementById('testModeBtn');
  const panel = document.getElementById('testPanel');
  if (testState.active) {
    btn.classList.add('active');
    btn.textContent = '🧪 Test Mode ON';
    panel.style.display = '';
    panel.style.animation = 'fadeUp 0.3s ease both';
    renderStars();
  } else {
    btn.classList.remove('active');
    btn.textContent = '🧪 Test Mode';
    panel.style.display = 'none';
    document.getElementById('testHud').classList.remove('visible');
    // stop any running timers
    stopTimer('search', true);
    stopTimer('bill', true);
  }
}

function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }
function fmtMs(ms) {
  const s = ms / 1000;
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60) + '.' + String(Math.floor((ms % 1000) / 100));
}

function startTimer(task) {
  const t = testState.timers[task];
  if (t.interval) return; // already running
  // stop other timer first
  const other = task === 'search' ? 'bill' : 'search';
  stopTimer(other, true);
  t.start = Date.now() - t.elapsed;
  t.interval = setInterval(() => {
    t.elapsed = Date.now() - t.start;
    document.getElementById('timer' + capitalize(task)).textContent = fmtMs(t.elapsed);
    // update HUD if on different page
    if (testState.activeTimer === task) {
      document.getElementById('testHudTimer').textContent = fmtMs(t.elapsed);
    }
  }, 100);
  testState.activeTimer = task;
  const hud = document.getElementById('testHud');
  document.getElementById('testHudLabel').textContent = task === 'search' ? '⏱ ค้นหาชิ้นส่วน' : '🧾 สร้างบิล';
  hud.classList.add('visible');
}

function stopTimer(task, silent) {
  const t = testState.timers[task];
  if (!t.interval) { return; }
  clearInterval(t.interval);
  t.interval = null;
  if (!silent && t.elapsed > 0) {
    t.records.push(t.elapsed);
    t.elapsed = 0;
    document.getElementById('timer' + capitalize(task)).textContent = '00:00.0';
    updateTimerRecords(task);
  }
  if (testState.activeTimer === task) {
    testState.activeTimer = null;
    document.getElementById('testHud').classList.remove('visible');
  }
}

function resetTimer(task) {
  stopTimer(task, true);
  const t = testState.timers[task];
  t.elapsed = 0;
  t.records = [];
  document.getElementById('timer' + capitalize(task)).textContent = '00:00.0';
  updateTimerRecords(task);
}

function updateTimerRecords(task) {
  const t = testState.timers[task];
  const recEl = document.getElementById('records' + capitalize(task));
  const avgEl = document.getElementById('avg' + capitalize(task));
  if (t.records.length === 0) {
    recEl.textContent = 'ยังไม่มีข้อมูล';
    avgEl.textContent = 'เฉลี่ย: —';
    return;
  }
  recEl.innerHTML = t.records.map((ms, i) => `<span style="color:rgba(255,255,255,0.6);">#${i+1}</span> ${fmtMs(ms)}`).join(' &nbsp; ');
  const avg = t.records.reduce((a, b) => a + b, 0) / t.records.length;
  avgEl.textContent = `เฉลี่ย: ${(avg/1000).toFixed(1)} วินาที (${t.records.length} ครั้ง)`;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function recordAccuracy(type) {
  testState.ai[type]++;
  const { correct, near, miss } = testState.ai;
  const total = correct + near + miss;
  document.getElementById('recordsAI').innerHTML =
    `ถูก: <b style="color:#4ade80">${correct}</b> &nbsp;|&nbsp; ใกล้เคียง: <b style="color:#fbbf24">${near}</b> &nbsp;|&nbsp; ผิด: <b style="color:#f87171">${miss}</b>`;
  const pct = total > 0 ? Math.round((correct + near * 0.5) / total * 100) : 0;
  document.getElementById('avgAI').textContent = `ความแม่นยำ: ${pct}% (${total} ครั้ง)`;
}

function renderStars() {
  Object.keys(testState.stars).forEach(cat => {
    const row = document.getElementById('stars-' + cat);
    if (!row) return;
    row.innerHTML = [1,2,3,4,5].map(v =>
      `<span class="test-star${testState.stars[cat] >= v ? ' active' : ''}" onclick="setRating('${cat}',${v})">★</span>`
    ).join('');
  });
}

function setRating(cat, val) {
  testState.stars[cat] = val;
  renderStars();
}

function applyTestResults() {
  const { search, bill } = testState.timers;
  const { correct, near, miss } = testState.ai;
  const stars = testState.stars;

  // build payload
  const payload = {};

  // time reductions
  if (search.records.length > 0) {
    const avgSec = search.records.reduce((a,b)=>a+b,0) / search.records.length / 1000;
    payload.searchAvgSec = avgSec;
  }
  if (bill.records.length > 0) {
    const avgSec = bill.records.reduce((a,b)=>a+b,0) / bill.records.length / 1000;
    payload.billAvgSec = avgSec;
  }

  const total = correct + near + miss;
  if (total > 0) {
    payload.aiAccuracy = Math.round((correct + near * 0.5) / total * 100);
    payload.aiTotal = total;
    payload.aiCorrect = correct;
  }

  const ratedCats = Object.values(stars).filter(v => v > 0);
  if (ratedCats.length > 0) {
    payload.satisfactionAvg = ratedCats.reduce((a,b)=>a+b,0) / ratedCats.length;
  }

  // persist
  localStorage.setItem('testResults', JSON.stringify(payload));

  // update KPI cards live
  const kpiCards = document.querySelectorAll('.an-kpi-val');
  // card order: search%, ai%, satisfaction/5, bill%
  const BASELINE_SEARCH = 7.4 * 60; // seconds
  const BASELINE_BILL   = 9.8 * 60;

  if (payload.searchAvgSec !== undefined) {
    const redPct = Math.round((1 - payload.searchAvgSec / BASELINE_SEARCH) * 100);
    const el = kpiCards[0];
    if (el) {
      el.textContent = Math.max(0, redPct) + '%';
      el.closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${(BASELINE_SEARCH/60).toFixed(1)} → ${(payload.searchAvgSec/60).toFixed(1)} นาที`;
    }
  }
  if (payload.aiAccuracy !== undefined) {
    const el = kpiCards[1];
    if (el) {
      el.textContent = payload.aiAccuracy + '%';
      el.closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${payload.aiCorrect} / ${payload.aiTotal} ครั้ง`;
    }
  }
  if (payload.satisfactionAvg !== undefined) {
    const el = kpiCards[2];
    if (el) {
      el.textContent = payload.satisfactionAvg.toFixed(1) + '/5';
    }
  }
  if (payload.billAvgSec !== undefined) {
    const redPct = Math.round((1 - payload.billAvgSec / BASELINE_BILL) * 100);
    const el = kpiCards[3];
    if (el) {
      el.textContent = Math.max(0, redPct) + '%';
      el.closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${(BASELINE_BILL/60).toFixed(1)} → ${(payload.billAvgSec/60).toFixed(1)} นาที`;
    }
  }

  // update sub label
  const now = new Date();
  const sub = document.getElementById('anSubLabel');
  if (sub) sub.textContent = `ข้อมูลจริง · วัด ${now.toLocaleDateString('th-TH')} · ${total} ครั้ง AI · ดาว ${ratedCats.length} หัวข้อ`;

  const applyBtn = document.getElementById('testApplyBtn');
  if (applyBtn) {
    applyBtn.textContent = '✅ Applied!';
    applyBtn.style.background = 'rgba(74,222,128,0.2)';
    applyBtn.style.borderColor = '#4ade80';
    applyBtn.style.color = '#4ade80';
    setTimeout(() => {
      applyBtn.textContent = '💾 Apply ผลการทดสอบ';
      applyBtn.style.background = '';
      applyBtn.style.borderColor = '';
      applyBtn.style.color = '';
    }, 2500);
  }
}

// restore saved test results on analytics init
function loadSavedTestResults() {
  const raw = localStorage.getItem('testResults');
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    const BASELINE_SEARCH = 7.4 * 60;
    const BASELINE_BILL   = 9.8 * 60;
    const kpiCards = document.querySelectorAll('.an-kpi-val');
    if (payload.searchAvgSec !== undefined && kpiCards[0]) {
      const redPct = Math.round((1 - payload.searchAvgSec / BASELINE_SEARCH) * 100);
      kpiCards[0].textContent = Math.max(0, redPct) + '%';
      kpiCards[0].closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${(BASELINE_SEARCH/60).toFixed(1)} → ${(payload.searchAvgSec/60).toFixed(1)} นาที`;
    }
    if (payload.aiAccuracy !== undefined && kpiCards[1]) {
      kpiCards[1].textContent = payload.aiAccuracy + '%';
      kpiCards[1].closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${payload.aiCorrect} / ${payload.aiTotal} ครั้ง`;
    }
    if (payload.satisfactionAvg !== undefined && kpiCards[2]) {
      kpiCards[2].textContent = payload.satisfactionAvg.toFixed(1) + '/5';
    }
    if (payload.billAvgSec !== undefined && kpiCards[3]) {
      const redPct = Math.round((1 - payload.billAvgSec / BASELINE_BILL) * 100);
      kpiCards[3].textContent = Math.max(0, redPct) + '%';
      kpiCards[3].closest('.an-kpi').querySelector('.an-kpi-meta').textContent =
        `${(BASELINE_BILL/60).toFixed(1)} → ${(payload.billAvgSec/60).toFixed(1)} นาที`;
    }
  } catch(e) {}
}

// Override printBillA5 with editable A5 template (opens editor first, then print)
function printBillA5_legacy2(id) {
  const bill = (billsCache || []).find(b => b.id === id);
  if (!bill) return;

  const rows = (bill.items || []).map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><input class="cell-inp" value="${String(it.name || '-').replace(/"/g, '&quot;')}"></td>
      <td><input class="cell-inp" value="${String(it.pn || '-').replace(/"/g, '&quot;')}"></td>
      <td style="text-align:right"><input class="num-inp qty" type="number" min="0" step="1" value="${Number(it.qty || 0)}"></td>
      <td style="text-align:right"><input class="num-inp price" type="number" min="0" step="0.01" value="${Number(it.price || 0)}"></td>
      <td style="text-align:right" class="line-total">0</td>
    </tr>
  `).join('');

  const title = (bill.name && String(bill.name).trim()) ? bill.name : `บิล #${bill.no}`;
  const html = `
<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    @page { size: A5 landscape; margin: 8mm; }
    html, body { margin: 0; padding: 0; font-family: "Tahoma", "Segoe UI", sans-serif; color: #111; }
    .sheet { width: 100%; }
    .toolbar { position: sticky; top: 0; z-index: 20; background: #fff; border-bottom: 1px solid #ddd; padding: 8px; display:flex; gap:8px; align-items:center; }
    .toolbar button { border:1px solid #333; background:#f5f5f5; border-radius:6px; padding:6px 12px; cursor:pointer; font-family:inherit; }
    .toolbar .hint { font-size: 11px; color:#555; margin-left: 8px; }
    .head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8mm; }
    .brand { font-size: 18px; font-weight: 700; }
    .meta { font-size: 12px; line-height: 1.6; text-align: right; }
    .title { font-size: 16px; font-weight: 700; margin-bottom: 2mm; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #222; padding: 6px; vertical-align: top; }
    th { background: #f2f2f2; text-align: left; }
    .cell-inp, .meta-inp { width: 100%; border: none; outline: none; font: inherit; background: transparent; color: #111; }
    .num-inp { width: 100%; border: none; outline: none; font: inherit; background: transparent; color: #111; text-align: right; }
    .sum { margin-top: 6mm; display:flex; justify-content:flex-end; }
    .sum-box { min-width: 38%; border: 1px solid #222; padding: 8px 10px; font-size: 12px; }
    .sum-row { display:flex; justify-content:space-between; margin: 2px 0; }
    .sum-total { font-size: 15px; font-weight: 700; border-top: 1px solid #222; padding-top: 6px; margin-top: 6px; }
    .note { margin-top: 5mm; font-size: 10px; color:#444; display:flex; justify-content:space-between; }
    .signs { margin-top: 8mm; display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 10mm; font-size: 12px; }
    .sig-line { margin-top: 10mm; border-top: 1px solid #222; padding-top: 2mm; text-align: center; }
    @media print { .toolbar { display:none !important; } }
  </style>
<link rel="stylesheet" href="/assets/legacy.css">
<link rel="stylesheet" href="/assets/workspace.css">
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">พิมพ์ A5</button>
    <button onclick="window.close()">ปิด</button>
    <span class="hint">แก้ไขชื่อ/วันที่/ราคา/ส่วนลดได้ก่อนพิมพ์</span>
  </div>
  <div class="sheet">
    <div class="head">
      <div>
        <div class="brand">Leo Auto</div>
        <div class="title">ใบเงินสด / CASH SALE</div>
        <div style="font-size:11px;line-height:1.4;">ผู้ขาย: <input class="meta-inp" value="Leo Auto" style="display:inline-block;width:170px;border-bottom:1px solid #222;"></div>
      </div>
      <div class="meta">
        <div><strong>${title}</strong></div>
        <div>วันที่: <input class="meta-inp" value="${bill.date || ''}" style="display:inline-block;width:120px;border-bottom:1px solid #222;"></div>
        <div>เลขที่บิล: <input class="meta-inp" value="${String(bill.no || '')}" style="display:inline-block;width:80px;border-bottom:1px solid #222;"></div>
        <div>ลูกค้า: <input class="meta-inp" value="" style="display:inline-block;width:180px;border-bottom:1px solid #222;"></div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:7%;">#</th>
          <th style="width:33%;">รายการ</th>
          <th style="width:20%;">Part Number</th>
          <th style="width:10%;text-align:right;">จำนวน</th>
          <th style="width:15%;text-align:right;">หน่วยละ</th>
          <th style="width:15%;text-align:right;">จำนวนเงิน</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sum">
      <div class="sum-box">
        <div class="sum-row"><span>รวมก่อนลด</span><strong id="subTotalTxt">฿0</strong></div>
        <div class="sum-row"><span>ส่วนลด</span><span><input class="num-inp" id="discountInp" type="number" min="0" step="0.01" value="0"></span></div>
        <div class="sum-row sum-total"><span>รวมทั้งสิ้น</span><span id="grandTotalTxt">฿0</span></div>
      </div>
    </div>
    <div class="signs">
      <div>ผู้รับสินค้า<div class="sig-line"><input class="meta-inp" value=""></div></div>
      <div>ผู้รับเงิน<div class="sig-line"><input class="meta-inp" value=""></div></div>
      <div>ผู้ขาย<div class="sig-line"><input class="meta-inp" value=""></div></div>
    </div>
    <div class="note">
      <span>A5 Landscape (ใส่กระดาษด้านข้าง/แนวนอน)</span>
      <span>ถ้าไม่ตรงให้ปรับ Scale 95-100%</span>
    </div>
  </div>
  <script>
    function recalc() {
      const rs = [...document.querySelectorAll('tbody tr')];
      let sub = 0;
      rs.forEach(r => {
        const qty = Number(r.querySelector('.qty')?.value || 0);
        const price = Number(r.querySelector('.price')?.value || 0);
        const line = qty * price;
        sub += line;
        const out = r.querySelector('.line-total');
        if (out) out.textContent = '฿' + line.toLocaleString();
      });
      const discount = Math.max(0, Number(document.getElementById('discountInp')?.value || 0));
      const grand = Math.max(0, sub - discount);
      document.getElementById('subTotalTxt').textContent = '฿' + sub.toLocaleString();
      document.getElementById('grandTotalTxt').textContent = '฿' + grand.toLocaleString();
    }
    document.addEventListener('input', (e) => {
      if (e.target.matches('.qty,.price,#discountInp')) recalc();
    });
    recalc();
  <\/script>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=1100,height=820');
  if (!w) {
    alert('เบราว์เซอร์บล็อก Pop-up กรุณาอนุญาต Pop-up สำหรับเว็บนี้ก่อน');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
}

function closePrintTemplate() {
  const m = document.getElementById('printTemplateModal');
  if (m) m.classList.remove('open');
}

function _escapePrintText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _getPrintWatermarkText() {
  return (document.getElementById('p-copy-watermark')?.value || 'สำเนา').trim() || 'สำเนา';
}

function _isPrintCopyEnabled() {
  return (document.getElementById('p-copy-mode')?.value || 'copy') !== 'off';
}

function _isPrintTaxEnabled() {
  return (document.getElementById('p-tax-mode')?.value || 'tax') !== 'off';
}

let printTaxState = null;

function _getPrintLineItems() {
  return Array.from(document.querySelectorAll('#printA5Editor tbody tr')).map((r, idx) => {
    const qty = Number(r.querySelector('.p-qty')?.value || 0);
    const price = Number(r.querySelector('.p-price')?.value || 0);
    const line = qty * price;
    return {
      idx,
      name: r.querySelector('td:nth-child(2) input')?.value || '',
      qty,
      price,
      line
    };
  });
}

function _splitBahtSatang(amount) {
  const normalized = Math.max(0, Number(amount || 0));
  const fixed = normalized.toFixed(2).split('.');
  return { baht: Number(fixed[0]).toLocaleString(), satang: fixed[1] };
}

function _ensurePrintTaxState() {
  if (!printTaxState) {
    printTaxState = {
      bookNo: '011',
      receiptNo: '0535',
      docName: 'บิลเงินสด / ใบกำกับภาษีอย่างย่อ',
      sellerName: 'ร้านลีโอ ออโต้',
      sellerAddress: 'เลขที่ 32/249-250 หมู่ 6 ถนนพหลโยธิน ต.คลองหนึ่ง อ.คลองหลวง จ.ปทุมธานี 12120',
      sellerTaxId: '3450100241329',
      sellerPhone: '02-901829',
      customerName: '',
      customerAddress: '',
      customerTaxId: '',
      date: ''
    };
  }
  const customer = document.getElementById('p-customer')?.value || '';
  const date = document.getElementById('p-date')?.value || '';
  if (!printTaxState.customerName) printTaxState.customerName = customer;
  if (!printTaxState.date) printTaxState.date = date;
}

function updatePrintTaxField(field, value) {
  _ensurePrintTaxState();
  printTaxState[field] = value;
}

function _syncPrintA5Copy() {
  const copySheet = document.getElementById('printA5Copy');
  const copyWrap = document.getElementById('printA5CopyPage');
  if (!copySheet || !copyWrap) return;

  const enabled = _isPrintCopyEnabled();
  copyWrap.style.display = enabled ? '' : 'none';
  if (!enabled) return;

  const watermark = _escapePrintText(_getPrintWatermarkText());
  const title = _escapePrintText(document.getElementById('p-title')?.value || 'ใบเสร็จรับเงิน / Cash Sale');
  const badge = _escapePrintText(document.getElementById('p-badge')?.value || 'บิลเงินสด');
  const date = _escapePrintText(document.getElementById('p-date')?.value || '');
  const book = _escapePrintText(document.getElementById('p-book')?.value || '');
  const no = _escapePrintText(document.getElementById('p-no')?.value || '');
  const seller = _escapePrintText(document.getElementById('p-seller')?.value || '');
  const customer = _escapePrintText(document.getElementById('p-customer')?.value || '');
  const note = _escapePrintText(document.getElementById('p-note')?.value || '');
  const receiver = _escapePrintText(document.getElementById('p-receiver')?.value || '');
  const collector = _escapePrintText(document.getElementById('p-collector')?.value || '');
  const sellerSign = _escapePrintText(document.getElementById('p-seller-sign')?.value || '');
  const subtotal = _escapePrintText(document.getElementById('p-subtotal')?.textContent || '฿0');
  const discount = Number(document.getElementById('p-discount')?.value || 0);
  const grand = _escapePrintText(document.getElementById('p-grand')?.textContent || '฿0');

  const rows = Array.from(document.querySelectorAll('#printA5Editor tbody tr')).map((r, idx) => {
    const name = _escapePrintText(r.querySelector('td:nth-child(2) input')?.value || '');
    const qty = Number(r.querySelector('.p-qty')?.value || 0).toLocaleString();
    const price = Number(r.querySelector('.p-price')?.value || 0).toLocaleString();
    const line = _escapePrintText(r.querySelector('.p-line')?.textContent || '฿0');
    return `
      <tr>
        <td>${idx + 1}</td>
        <td><div class="print-a5-static-text">${name}</div></td>
        <td class="num"><div class="print-a5-static-text" style="text-align:right">${qty}</div></td>
        <td class="num"><div class="print-a5-static-text" style="text-align:right">${price}</div></td>
        <td class="num">${line}</td>
      </tr>
    `;
  }).join('');

  copySheet.innerHTML = `
    <div class="print-a5-watermark">${watermark}</div>
    <div class="print-a5-header">
      <div class="print-a5-brand">
        <div class="print-a5-badge">${badge}</div>
        <div class="print-a5-title">${title}</div>
      </div>
      <div class="print-a5-meta">
        <div class="print-a5-meta-row"><span>เล่มที่</span><div class="print-a5-static-text" style="text-align:right">${book}</div></div>
        <div class="print-a5-meta-row"><span>เลขที่</span><div class="print-a5-static-text" style="text-align:right">${no}</div></div>
        <div class="print-a5-meta-row"><span>วันที่</span><div class="print-a5-static-text" style="text-align:right">${date}</div></div>
      </div>
    </div>
    <div class="print-a5-party">
      <div class="print-a5-field">
        <label>ผู้ขาย</label>
        <div class="print-a5-static-text">${seller}</div>
      </div>
      <div class="print-a5-field">
        <label>ลูกค้า</label>
        <div class="print-a5-static-text">${customer}</div>
      </div>
    </div>
    <div class="print-a5-table-wrap">
      <table class="print-a5-table">
        <thead>
          <tr>
            <th>#</th>
            <th>รายการ</th>
            <th class="num">จำนวน</th>
            <th class="num">ราคา/ชิ้น</th>
            <th class="num">รวม</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="print-a5-grow"></div>
    <div class="print-a5-lower">
      <div class="print-a5-note">
        <label>หมายเหตุ</label>
        <div style="min-height:20px;white-space:pre-wrap;line-height:1.3;">${note}</div>
      </div>
      <div class="print-a5-summary">
        <div class="print-a5-totals">
          <div class="print-a5-total-row"><span>รวมก่อนลด</span><strong>${subtotal}</strong></div>
          <div class="print-a5-total-row"><span>ส่วนลด</span><span>฿${discount.toLocaleString()}</span></div>
          <div class="print-a5-total-row grand"><span>ยอดสุทธิ</span><span>${grand}</span></div>
        </div>
      </div>
    </div>
    <div class="print-a5-signatures">
      <div>
        <label>ผู้รับสินค้า</label>
        <div class="print-a5-static-text" style="text-align:center">${receiver}</div>
      </div>
      <div>
        <label>ผู้รับเงิน</label>
        <div class="print-a5-static-text" style="text-align:center">${collector}</div>
      </div>
      <div>
        <label>ผู้ขาย</label>
        <div class="print-a5-static-text" style="text-align:center">${sellerSign}</div>
      </div>
    </div>
    <div class="print-a5-foot">
      <span>${watermark}</span>
      <span>สำเนา</span>
    </div>
  `;
}

function _syncPrintA5Tax() {
  const taxSheet = document.getElementById('printA5Tax');
  const taxWrap = document.getElementById('printA5TaxPage');
  if (!taxSheet || !taxWrap) return;

  const enabled = _isPrintTaxEnabled();
  taxWrap.style.display = enabled ? '' : 'none';
  if (!enabled) return;

  _ensurePrintTaxState();

  const customerSource = document.getElementById('p-customer')?.value || '';
  const dateSource = document.getElementById('p-date')?.value || '';
  if (!printTaxState.customerName || printTaxState.customerName === customerSource) {
    printTaxState.customerName = customerSource;
  }
  if (!printTaxState.date || printTaxState.date === dateSource) {
    printTaxState.date = dateSource;
  }

  const items = _getPrintLineItems();
  const subtotalValue = items.reduce((sum, item) => sum + item.line, 0);
  const discountValue = Math.max(0, Number(document.getElementById('p-discount')?.value || 0));
  const grandValue = Math.max(0, subtotalValue - discountValue);
  const totalSplit = _splitBahtSatang(grandValue);
  const rows = items.map(item => {
    const unitSplit = _splitBahtSatang(item.price);
    const lineSplit = _splitBahtSatang(item.line);
    return `
      <tr>
        <td class="ctr">${item.qty ? item.qty.toLocaleString() : ''}</td>
        <td>${_escapePrintText(item.name || '')}</td>
        <td class="num">${unitSplit.baht}${unitSplit.satang !== '00' ? '.' + unitSplit.satang : ''}</td>
        <td class="num">${lineSplit.baht}</td>
        <td class="ctr">${lineSplit.satang === '00' ? '-' : lineSplit.satang}</td>
      </tr>
    `;
  }).join('');

  const fillerRows = Math.max(0, 8 - items.length);
  const emptyRows = Array.from({ length: fillerRows }).map(() => `
    <tr>
      <td>&nbsp;</td><td></td><td></td><td></td><td></td>
    </tr>
  `).join('');

  taxSheet.innerHTML = `
    <div class="print-tax-topline">
      <div>เล่มที่ <input value="${_escapePrintText(printTaxState.bookNo)}" oninput="updatePrintTaxField('bookNo', this.value)"></div>
      <div class="center">บิลเงินสด</div>
      <div class="right">เลขที่ <input value="${_escapePrintText(printTaxState.receiptNo)}" oninput="updatePrintTaxField('receiptNo', this.value)" style="width:86px;text-align:right"></div>
    </div>
    <div class="print-tax-header">
      <div class="print-tax-docname"><input value="${_escapePrintText(printTaxState.docName)}" oninput="updatePrintTaxField('docName', this.value)" style="width:100%;text-align:center;font-weight:800;color:#1e3a8a"></div>
      <div class="print-tax-company"><input value="${_escapePrintText(printTaxState.sellerName)}" oninput="updatePrintTaxField('sellerName', this.value)" style="width:100%;text-align:center;font-size:22px;font-weight:800"></div>
      <div class="print-tax-meta">
        <input oninput="updatePrintTaxField('sellerAddress', this.value)" value="${_escapePrintText(printTaxState.sellerAddress)}" style="width:100%;text-align:center">
        <div style="display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:4px;">
          <span>เลขประจำตัวผู้เสียภาษี</span>
          <input value="${_escapePrintText(printTaxState.sellerTaxId)}" oninput="updatePrintTaxField('sellerTaxId', this.value)" style="width:190px;text-align:center">
          <span>โทร.</span>
          <input value="${_escapePrintText(printTaxState.sellerPhone)}" oninput="updatePrintTaxField('sellerPhone', this.value)" style="width:120px;text-align:center">
        </div>
      </div>
    </div>
    <div class="print-tax-grid">
      <div class="print-tax-box">
        <label>นาม</label>
        <input value="${_escapePrintText(printTaxState.customerName)}" oninput="updatePrintTaxField('customerName', this.value)">
      </div>
      <div class="print-tax-box">
        <label>วันที่</label>
        <input value="${_escapePrintText(printTaxState.date)}" oninput="updatePrintTaxField('date', this.value)">
      </div>
      <div class="print-tax-box">
        <label>ที่อยู่</label>
        <textarea oninput="updatePrintTaxField('customerAddress', this.value)">${_escapePrintText(printTaxState.customerAddress)}</textarea>
      </div>
      <div class="print-tax-box">
        <label>เลขประจำตัวผู้เสียภาษี</label>
        <input value="${_escapePrintText(printTaxState.customerTaxId)}" oninput="updatePrintTaxField('customerTaxId', this.value)">
      </div>
    </div>
    <div class="print-tax-table-wrap">
      <table class="print-tax-table">
        <thead>
          <tr>
            <th style="width:12%" class="ctr">จำนวน</th>
            <th>รายการ</th>
            <th style="width:16%" class="num">หน่วยละ</th>
            <th style="width:14%" class="num">จำนวนเงิน บาท</th>
            <th style="width:8%" class="ctr">สต.</th>
          </tr>
        </thead>
        <tbody>${rows}${emptyRows}</tbody>
      </table>
    </div>
    <div class="print-tax-total">
      <div class="print-tax-total-card">
        <div class="print-a5-total-row"><span>รวมก่อนลด</span><strong>฿${subtotalValue.toLocaleString()}</strong></div>
        <div class="print-a5-total-row"><span>ส่วนลด</span><span>฿${discountValue.toLocaleString()}</span></div>
        <div class="print-a5-total-row grand"><span>รวมเงิน</span><span>${totalSplit.baht}${totalSplit.satang !== '00' ? '.' + totalSplit.satang : ''}</span></div>
      </div>
    </div>
    <div class="print-tax-signs">
      <div class="print-tax-sign">
        ผู้รับเงิน
        <div class="line">${_escapePrintText(document.getElementById('p-collector')?.value || '')}</div>
      </div>
      <div class="print-tax-sign">
        ผู้รับสินค้า
        <div class="line">${_escapePrintText(document.getElementById('p-receiver')?.value || '')}</div>
      </div>
    </div>
  `;
}

function _recalcPrintA5() {
  const rows = document.querySelectorAll('#printA5Editor tbody tr');
  let sub = 0;
  rows.forEach(r => {
    const q = Number(r.querySelector('.p-qty')?.value || 0);
    const p = Number(r.querySelector('.p-price')?.value || 0);
    const line = q * p;
    sub += line;
    const o = r.querySelector('.p-line');
    if (o) o.textContent = '฿' + line.toLocaleString();
  });
  const disc = Math.max(0, Number(document.getElementById('p-discount')?.value || 0));
  const grand = Math.max(0, sub - disc);
  const s = document.getElementById('p-subtotal');
  const g = document.getElementById('p-grand');
  if (s) s.textContent = '฿' + sub.toLocaleString();
  if (g) g.textContent = '฿' + grand.toLocaleString();
  _syncPrintA5Copy();
  _syncPrintA5Tax();
}

// Override: no popup, open editable in-page template
function printBillA5(id) {
  const bill = (billsCache || []).find(b => b.id === id);
  if (!bill) return;

  const escapeAttr = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const rows = (bill.items || []).map((it, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><input value="${escapeAttr(it.name || '')}" style="width:100%"></td>
      <td class="num"><input class="p-qty" type="number" min="0" step="1" value="${Number(it.qty || 0)}" style="width:100%;text-align:right"></td>
      <td class="num"><input class="p-price" type="number" min="0" step="0.01" value="${Number(it.price || 0)}" style="width:100%;text-align:right"></td>
      <td class="num p-line">฿0</td>
    </tr>
  `).join('');

  const title = (bill.name && String(bill.name).trim()) ? bill.name : `บิล #${bill.no}`;
  const today = bill.date || new Date().toISOString().slice(0, 10);
  const sheet = document.getElementById('printA5Sheet');
  if (!sheet) return;
  sheet.innerHTML = `
    <div class="print-a5-toolbar">
      <button class="print-a5-btn primary" onclick="window.print()">พิมพ์ A5</button>
      <button class="print-a5-btn" onclick="closePrintTemplate()">ปิด</button>
      <div class="print-a5-tool-group">
        <span class="print-a5-tool-label">หน้าที่สอง</span>
        <select id="p-copy-mode" class="print-a5-tool-select">
          <option value="copy" selected>แสดงหน้าสำเนา</option>
          <option value="off">ไม่แสดง</option>
        </select>
        <span class="print-a5-tool-label">ลายน้ำ</span>
        <input id="p-copy-watermark" class="print-a5-tool-input" value="สำเนา">
        <span class="print-a5-tool-label">หน้าที่สาม</span>
        <select id="p-tax-mode" class="print-a5-tool-select">
          <option value="tax" selected>บิลใช้เสียภาษี</option>
          <option value="off">ไม่แสดง</option>
        </select>
      </div>
    </div>
    <div class="print-a5-stack">
      <div class="print-a5-page">
        <div class="print-a5-copy-title">ต้นฉบับ</div>
        <div id="printA5Editor" class="print-a5-sheet">
          <div class="print-a5-header">
            <div class="print-a5-brand">
              <div class="print-a5-badge"><input id="p-badge" value="บิลเงินสด" style="width:110px"></div>
              <div class="print-a5-title"><input id="p-title" value="ใบเสร็จรับเงิน / Cash Sale" style="width:100%"></div>
            </div>
            <div class="print-a5-meta">
              <div class="print-a5-meta-row"><span>เล่มที่</span><input id="p-book" value="" style="width:60px"></div>
              <div class="print-a5-meta-row"><span>เลขที่</span><input id="p-no" value="" style="width:60px"></div>
              <div class="print-a5-meta-row"><span>วันที่</span><input id="p-date" value="${escapeAttr(today)}"></div>
            </div>
          </div>
          <div class="print-a5-party">
            <div class="print-a5-field">
              <label>ผู้ขาย</label>
              <input id="p-seller" value="Leo Auto">
            </div>
            <div class="print-a5-field">
              <label>ลูกค้า</label>
              <input id="p-customer" value="">
            </div>
          </div>
          <div class="print-a5-table-wrap">
            <table class="print-a5-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>รายการ</th>
                  <th class="num">จำนวน</th>
                  <th class="num">ราคา/ชิ้น</th>
                  <th class="num">รวม</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div class="print-a5-grow"></div>
          <div class="print-a5-lower">
            <div class="print-a5-note">
              <label>หมายเหตุ</label>
              <textarea id="p-note" placeholder="เช่น รับเงินสดครบแล้ว / นัดรับสินค้า / ข้อมูลเพิ่มเติม"></textarea>
            </div>
            <div class="print-a5-summary">
              <div class="print-a5-totals">
                <div class="print-a5-total-row"><span>รวมก่อนลด</span><strong id="p-subtotal">฿0</strong></div>
                <div class="print-a5-total-row"><span>ส่วนลด</span><input id="p-discount" type="number" min="0" step="0.01" value="0"></div>
                <div class="print-a5-total-row grand"><span>ยอดสุทธิ</span><span id="p-grand">฿0</span></div>
              </div>
            </div>
          </div>
          <div class="print-a5-signatures">
            <div>
              <label>ผู้รับสินค้า</label>
              <input id="p-receiver" value="">
            </div>
            <div>
              <label>ผู้รับเงิน</label>
              <input id="p-collector" value="">
            </div>
            <div>
              <label>ผู้ขาย</label>
              <input id="p-seller-sign" value="">
            </div>
          </div>
          <div class="print-a5-foot">
            <span></span>
            <span>ต้นฉบับ</span>
          </div>
        </div>
      </div>
      <div id="printA5CopyPage" class="print-a5-page">
        <div class="print-a5-copy-title"></div>
        <div id="printA5Copy" class="print-a5-sheet print-a5-sheet-copy"></div>
      </div>
      <div id="printA5TaxPage" class="print-a5-page">
        <div class="print-a5-copy-title">บิลใช้เสียภาษี</div>
        <div id="printA5Tax" class="print-a5-sheet print-tax-sheet"></div>
      </div>
    </div>
  `;

  document.getElementById('printTemplateModal')?.classList.add('open');
  sheet.oninput = (e) => {
    if (e.target.matches('.p-qty,.p-price,#p-discount,#p-title,#p-badge,#p-date,#p-book,#p-no,#p-seller,#p-customer,#p-note,#p-receiver,#p-collector,#p-seller-sign')) {
      _recalcPrintA5();
    }
  };
  sheet.onchange = (e) => {
    if (e.target.matches('#p-copy-mode,#p-copy-watermark,#p-tax-mode,.p-qty,.p-price,#p-discount,#p-title,#p-badge,#p-date,#p-book,#p-no,#p-seller,#p-customer,#p-note,#p-receiver,#p-collector,#p-seller-sign')) {
      _syncPrintA5Copy();
      _syncPrintA5Tax();
    }
  };
  _recalcPrintA5();
  _syncPrintA5Copy();
  _syncPrintA5Tax();
}

// Stable entrypoint for A5 button (avoid conflicts with duplicated printBillA5 definitions)
function openPrintTemplateA5(id) {
  const bill = (billsCache || []).find(b => b.id === id);
  if (!bill) {
    alert('ไม่พบบิลสำหรับพิมพ์');
    return;
  }
  // Reuse the latest in-page template renderer
  printBillA5(id);
  const modal = document.getElementById('printTemplateModal');
  if (modal && !modal.classList.contains('open')) {
    modal.classList.add('open');
  }
}


/* ────────────────── SORT ────────────────── */
let currentSortMode = 'newest';

const SORT_LABELS = {
  newest:     'ใหม่ล่าสุด',
  oldest:     'เก่าที่สุด',
  price_asc:  'ราคา ↑',
  price_desc: 'ราคา ↓',
  stock_desc: 'Stock ↓',
  stock_asc:  'Stock ↑',
  name_asc:   'ชื่อ A→Z',
  pn_asc:     'Part #',
};

function applySort(data) {
  const arr = [...data];
  switch (currentSortMode) {
    case 'oldest':     return arr;
    case 'price_asc':  return arr.sort((a,b) => (a.Price||0) - (b.Price||0));
    case 'price_desc': return arr.sort((a,b) => (b.Price||0) - (a.Price||0));
    case 'stock_desc': return arr.sort((a,b) => (b.Stock||0) - (a.Stock||0));
    case 'stock_asc':  return arr.sort((a,b) => (a.Stock||0) - (b.Stock||0));
    case 'name_asc':   return arr.sort((a,b) => (a['Part Name']||'').localeCompare(b['Part Name']||''));
    case 'pn_asc':     return arr.sort((a,b) => (a['Part Number']||'').localeCompare(b['Part Number']||''));
    case 'newest':
    default:            return arr.reverse();
  }
}

function setSort(mode) {
  currentSortMode = mode;
  document.getElementById('sortLabel').textContent = SORT_LABELS[mode] || mode;
  document.querySelectorAll('.sort-opt').forEach(el => {
    const oc = el.getAttribute('onclick') || '';
    el.classList.toggle('active', oc.includes(`'${mode}'`));
  });
  document.getElementById('sortDrop').classList.remove('open');
  filterLocal();
}

function toggleSortDrop(e) {
  if (e) e.stopPropagation();
  document.getElementById('sortDrop').classList.toggle('open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.sort-drop-wrap')) {
    document.getElementById('sortDrop')?.classList.remove('open');
  }
});

function _syncLRStock() {
  const lhEl = document.getElementById('m_stock_lh');
  const rhEl = document.getElementById('m_stock_rh');
  const lh = Number(lhEl?.value || 0);
  const rh = Number(rhEl?.value || 0);
  const lhFilled = lhEl && lhEl.value !== '';
  const rhFilled = rhEl && rhEl.value !== '';
  if (lhFilled || rhFilled) {
    const stockEl = document.getElementById('m_stock');
    if (stockEl) stockEl.value = lh + rh;
  }
}
function _syncUsedLRStock() {
  const lhEl = document.getElementById('m_used_stock_lh');
  const rhEl = document.getElementById('m_used_stock_rh');
  const lh = Number(lhEl?.value || 0);
  const rh = Number(rhEl?.value || 0);
  const lhFilled = lhEl && lhEl.value !== '';
  const rhFilled = rhEl && rhEl.value !== '';
  if (lhFilled || rhFilled) {
    const stockEl = document.getElementById('m_used_stock');
    if (stockEl) stockEl.value = lh + rh;
  }
}
window._costValueVisible = false;
function toggleCostValue() {
  window._costValueVisible = !window._costValueVisible;
  const el = document.getElementById('s-value');
  if (!el) return;
  const amount = Number(el.dataset.amount || window._costValueAmount || 0);
  el.innerText = window._costValueVisible ? `฿${amount.toLocaleString()}` : 'ซ่อน';
}
document.addEventListener('DOMContentLoaded', initInventory);

/* ══════════════════════════════════════
   STOCK INTELLIGENCE DASHBOARD
══════════════════════════════════════ */
let siCurrentTab = 'all';
let siSortKey = '_totalStock';
let siSortAsc = true;

function renderStockDashboard() {
  const raw = window.globalData || [];

  // Distinguish "still loading" vs "loaded but empty inventory".
  if (!inventoryLoaded) {
    document.getElementById('si-total').textContent = '…';
    document.getElementById('si-table-sub').textContent = 'กำลังโหลดข้อมูล…';
    document.getElementById('si-tbody').innerHTML = '';
    setTimeout(() => { if (inventoryLoaded) renderStockDashboard(); }, 800);
    return;
  }

  if (!raw.length) {
    document.getElementById('si-total').textContent = '0';
    document.getElementById('si-total-meta').textContent = '0 ชิ้นรวม · ยังไม่มีสินค้า';
    document.getElementById('si-low').textContent = '0';
    document.getElementById('si-low-meta').textContent = 'ไม่มีสินค้าเหลือน้อย';
    document.getElementById('si-deadstock').textContent = '0';
    document.getElementById('si-dead-meta').textContent = 'ไม่มี dead stock';
    document.getElementById('si-value').textContent = '฿0';
    document.getElementById('si-value-meta').textContent = 'มูลค่ารวมยังเท่ากับ 0';
    document.getElementById('si-table-sub').textContent = 'ยังไม่มีรายการสินค้า';
    document.getElementById('si-dist-bars').innerHTML = '';
    document.getElementById('si-hotlist').innerHTML = '<div style="color:rgba(255,255,255,0.25);font-size:12px;text-align:center;padding:12px;">ยังไม่มีข้อมูลสินค้า</div>';
    document.getElementById('si-brand-bars').innerHTML = '';
    document.getElementById('si-tbody').innerHTML = '';
    const empty = document.getElementById('si-empty');
    if (empty) empty.style.display = 'block';
    return;
  }
  const data = raw.map(p => ({
    PartNumber: p['Part Number'] || p.PartNumber || '',
    Name:       p['Part Name']  || p.PartName  || p.Name || '',
    Brand:      p.Brand || '',
    Series:     p.Series || '',
    Stock_New:  p.Stock  || p.Stock_New  || 0,
    Stock_Used: p.Used_Stock || p.Stock_Used || 0,
    Price_New:  p.Price  || p.Price_New  || 0,
    Price_Used: p.Used_Price || p.Price_Used || 0,
    _totalStock: (p.Stock || p.Stock_New || 0) + (p.Used_Stock || p.Stock_Used || 0),
    _value: ((p.Stock || p.Stock_New || 0) * (p.Price || p.Price_New || 0)) +
            ((p.Used_Stock || p.Stock_Used || 0) * (p.Used_Price || p.Price_Used || 0))
  }));

  window._siData = data; // cache for siRender

  if (!data.length) {
    document.getElementById('si-total').textContent = '—';
    return;
  }

  // KPI
  const totalParts   = data.length;
  const totalUnits   = data.reduce((s, p) => s + p._totalStock, 0);
  const lowItems     = data.filter(p => p._totalStock > 0 && p._totalStock <= 3).length;
  const outItems     = data.filter(p => p._totalStock === 0).length;
  const deadItems    = data.filter(p => p._totalStock >= 5).length;
  const totalValue   = data.reduce((s, p) => s + p._value, 0);

  document.getElementById('si-total').textContent = totalParts;
  document.getElementById('si-total-meta').textContent = `${totalUnits} ชิ้นรวม · หมด ${outItems} รายการ`;
  document.getElementById('si-low').textContent = lowItems;
  document.getElementById('si-low-meta').textContent = `รวมหมด ${outItems} + เหลือน้อย ${lowItems}`;
  document.getElementById('si-deadstock').textContent = deadItems;
  document.getElementById('si-dead-meta').textContent = `stock ≥ 5 อาจค้างนาน`;
  document.getElementById('si-value').textContent = '฿' + Math.round(totalValue).toLocaleString();
  document.getElementById('si-value-meta').textContent = `เฉลี่ย ฿${Math.round(totalValue / totalParts).toLocaleString()} / part`;

  // Dist bars
  const distGroups = [
    { label: '🔴 หมด (0)',    count: outItems,                                   color: '#f87171' },
    { label: '🟠 เหลือ 1',    count: data.filter(p=>p._totalStock===1).length,   color: '#fb923c' },
    { label: '🟡 เหลือ 2',    count: data.filter(p=>p._totalStock===2).length,   color: '#fbbf24' },
    { label: '🟢 เหลือ 3–4',  count: data.filter(p=>p._totalStock>=3&&p._totalStock<=4).length, color: '#4ade80' },
    { label: '🔵 ≥ 5',        count: deadItems,                                  color: '#a78bfa' },
  ];
  const maxDist = Math.max(...distGroups.map(d => d.count), 1);
  document.getElementById('si-dist-bars').innerHTML = distGroups.map(d => `
    <div class="si-dist-row">
      <div class="si-dist-lbl">${d.label}</div>
      <div class="si-dist-track"><div class="si-dist-bar" style="width:${Math.round(d.count/maxDist*100)}%;background:${d.color};"></div></div>
      <div class="si-dist-cnt">${d.count}</div>
    </div>`).join('');

  // Hot items: ราคาแรงใกล้หมด
  const hotItems = [...data]
    .filter(p => p._totalStock > 0 && p._totalStock <= 3 && (p.Price_New || 0) > 0)
    .sort((a, b) => (b.Price_New || 0) - (a.Price_New || 0))
    .slice(0, 6);
  document.getElementById('si-hotlist').innerHTML = hotItems.length
    ? hotItems.map(p => `
      <div class="si-hot-row">
        <div class="si-hot-pn">${p.PartNumber}</div>
        <div class="si-hot-name">${p.Name || '—'}</div>
        <div class="si-hot-price">฿${(p.Price_New||0).toLocaleString()}</div>
        <div class="si-hot-stock">เหลือ ${p._totalStock}</div>
      </div>`).join('')
    : '<div style="color:rgba(255,255,255,0.25);font-size:12px;text-align:center;padding:12px;">ไม่มีสินค้าในกลุ่มนี้</div>';

  // Brand bars
  const brandMap = {};
  data.forEach(p => { const b = p.Brand || 'อื่นๆ'; brandMap[b] = (brandMap[b]||0)+1; });
  const brands = Object.entries(brandMap).sort((a,b)=>b[1]-a[1]);
  const maxB = brands[0]?.[1] || 1;
  const brandColors = ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#fb923c'];
  document.getElementById('si-brand-bars').innerHTML = brands.map(([b, cnt], i) => `
    <div class="an-brand-row">
      <div style="font-size:11px;color:rgba(255,255,255,0.55);width:68px;flex-shrink:0;">${b}</div>
      <div style="flex:1;height:10px;background:rgba(255,255,255,0.05);border-radius:5px;overflow:hidden;">
        <div style="height:100%;border-radius:5px;background:${brandColors[i%brandColors.length]};width:${Math.round(cnt/maxB*100)}%;transition:width 0.8s;"></div>
      </div>
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);width:24px;text-align:right;">${cnt}</div>
    </div>`).join('');

  siRender();
}

function siTab(el, tab) {
  document.querySelectorAll('.si-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  siCurrentTab = tab;
  siRender();
}

function siSort(key) {
  if (siSortKey === key) siSortAsc = !siSortAsc;
  else { siSortKey = key; siSortAsc = true; }
  siRender();
}

function siRender() {
  const data = window._siData || [];

  const q = (document.getElementById('si-search')?.value || '').toLowerCase();

  const filtered = data.filter(p => {
    const matchQ = !q || (p.PartNumber||'').toLowerCase().includes(q) || (p.Name||'').toLowerCase().includes(q);
    if (!matchQ) return false;
    const t = p._totalStock;
    switch (siCurrentTab) {
      case 'out':     return t === 0;
      case 'qty1':    return t === 1;
      case 'qty2':    return t === 2;
      case 'qty3':    return t === 3;
      case 'low':     return t > 0 && t <= 3;
      case 'dead':    return t >= 5;
      case 'hotprice':return t > 0 && t <= 3 && (p.Price_New||0) > 0;
      case 'highval': return p._value > 0;
      default:        return true;
    }
  });

  // sort
  filtered.sort((a, b) => {
    let va = a[siSortKey], vb = b[siSortKey];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (siCurrentTab === 'hotprice') { va = a.Price_New||0; vb = b.Price_New||0; }
    if (siCurrentTab === 'highval')  { va = a._value; vb = b._value; }
    if (va < vb) return siSortAsc ? -1 : 1;
    if (va > vb) return siSortAsc ? 1 : -1;
    return 0;
  });

  const titles = {
    all:'รายการสินค้าทั้งหมด', out:'🔴 สินค้าหมด', qty1:'🟠 สินค้าเหลือ 1 ชิ้น',
    qty2:'🟡 สินค้าเหลือ 2 ชิ้น', qty3:'🟡 สินค้าเหลือ 3 ชิ้น',
    low:'⚠️ สินค้าเหลือน้อย (≤3)', dead:'💤 สินค้าจมทุน (stock ≥ 5)',
    hotprice:'🔥 สินค้าราคาแรงใกล้หมด', highval:'💰 มูลค่าสต็อกสูงสุด'
  };
  document.getElementById('si-table-title').textContent = titles[siCurrentTab] || '';
  document.getElementById('si-table-sub').textContent = `${filtered.length} รายการ`;

  const tbody = document.getElementById('si-tbody');
  const empty = document.getElementById('si-empty');

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = filtered.map(p => {
    const t = p._totalStock;
    let badge, rowColor = '';
    if (t === 0)          { badge = `<span class="si-badge si-badge-out">หมด</span>`; rowColor = 'rgba(248,113,113,0.04)'; }
    else if (t === 1)     { badge = `<span class="si-badge si-badge-qty1">เหลือ 1</span>`; rowColor = 'rgba(251,146,60,0.04)'; }
    else if (t <= 3)      { badge = `<span class="si-badge si-badge-low">เหลือน้อย</span>`; rowColor = 'rgba(251,191,36,0.03)'; }
    else if (t >= 5)      { badge = `<span class="si-badge si-badge-dead">จมทุน</span>`; }
    else                  { badge = `<span class="si-badge si-badge-ok">ปกติ</span>`; }
    const val = p._value > 0 ? '฿'+Math.round(p._value).toLocaleString() : '—';
    const priceNew = p.Price_New ? '฿'+(p.Price_New).toLocaleString() : '—';
    return `<tr class="si-tr" style="background:${rowColor}">
      <td class="si-td" style="font-weight:700;color:#fbbf24;">${p.PartNumber||'—'}</td>
      <td class="si-td" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${p.Name||'—'}</td>
      <td class="si-td" style="color:rgba(255,255,255,0.5);">${p.Brand||'—'}</td>
      <td class="si-td" style="text-align:right;color:#6ee7b7;">${p.Stock_New||0}</td>
      <td class="si-td" style="text-align:right;color:#fcd34d;">${p.Stock_Used||0}</td>
      <td class="si-td" style="text-align:right;font-weight:700;">${t}</td>
      <td class="si-td" style="text-align:right;">${priceNew}</td>
      <td class="si-td" style="text-align:right;color:#a78bfa;">${val}</td>
      <td class="si-td">${badge}</td>
    </tr>`;
  }).join('');
}
// รายชื่อตีมทั้งหมด (ว่างๆ คือตีมเริ่มต้น)
  const themeList = ['', 'theme-red', 'theme-green'];
  let currentThemeIdx = 0;

  function toggleTheme() {
    if (themeList[currentThemeIdx] !== '') {
      document.body.classList.remove(themeList[currentThemeIdx]);
    }
    
    currentThemeIdx = (currentThemeIdx + 1) % themeList.length;
    
    if (themeList[currentThemeIdx] !== '') {
      document.body.classList.add(themeList[currentThemeIdx]);
    }

    const btn = document.getElementById('themeBtn');
    if (currentThemeIdx === 0) btn.innerHTML = '🎨'; // Default
    else if (currentThemeIdx === 1) btn.innerHTML = '🔥'; // Red
    else if (currentThemeIdx === 2) btn.innerHTML = '🌿'; // Green
  }
// Focus management for all existing modal workflows.
let lastModalFocus = null;
const modalObserver = new MutationObserver(changes => {
  for (const change of changes) {
    const modal = change.target;
    if (!modal.matches('.modal-overlay')) continue;
    if (modal.classList.contains('open')) {
      lastModalFocus = document.activeElement;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const title = modal.querySelector('.modal-title');
      modal.setAttribute('aria-label', title?.textContent.trim() || 'รายละเอียด');
      modal.querySelector('input:not([type="hidden"]), button, select, textarea')?.focus();
    } else if (lastModalFocus) {
      lastModalFocus.focus();
    }
  }
});
document.querySelectorAll('.modal-overlay').forEach(modal => modalObserver.observe(modal, {attributes:true, attributeFilter:['class']}));
document.querySelectorAll('.modal-close').forEach(button => button.setAttribute('aria-label', 'ปิดหน้าต่าง'));
document.addEventListener('keydown', event => {
  const modal = [...document.querySelectorAll('.modal-overlay.open')].pop();
  if (!modal || document.querySelector('#fancyOverlay.open')) return;
  if (event.key === 'Escape') {
    if (modal.id === 'manageModal') closeManageModal();
    else if (modal.id === 'receiveModal') closeReceiveModal();
    else if (modal.id === 'lightboxModal') closeLightbox();
    else modal.classList.remove('open');
  }
  if (event.key === 'Tab') {
    const controls = [...modal.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});

document.addEventListener('click', event => {
  if (!event.target.closest('.bill-search-wrap, .bill-dropdown')) document.getElementById('billSearchResults').style.display = 'none';
});
