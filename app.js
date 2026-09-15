// =======================================================================
// UFUQ Branch Inspection System — Frontend logic
//
// Talks ONLY to the "inspection-api" Edge Function (see backend README).
// Contains zero database credentials beyond the public Supabase
// "publishable" key, which is safe to ship in a browser by design.
// =======================================================================

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs'
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs'

const FUNCTION_URL = 'https://tnrujxfqvfoqwvclamsi.supabase.co/functions/v1/inspection-api'
const PUBLISHABLE_KEY = 'sb_publishable_UDxeC8HSBNNj2eOugUvtZw_V8u5Ku2e'
const TOKEN_STORAGE_KEY = 'ufuqToken'

// ----------------------------------------------------------------- State

let sessionToken = ''
let appData = { branches: [], forms: [], groups: [], products: [] }
let selectedPrintBranches = new Set()
const photoDataUrls = [null, null]

// Temperature photos for the "forms" flow: each form keeps its own pair,
// independently — add/replace/clear one form's photos without touching
// another form's.
const formPhotos = {}
function getFormPhotos(formId) {
  return formPhotos[formId] || [null, null]
}
let expandedFormIds = new Set()
let pendingPhotoUrls = [null, null]
let pendingPhotoFormTargets = new Set()

// Fixed bilingual checklist, transcribed verbatim from the original
// inspection sheet. Kept as data (not hardcoded HTML) so it's easy to
// adjust in one place if the checklist itself ever changes.
const INSPECTION_CHECKLIST = [
  { en: 'The packaging is intact and free from any damage or leakage', ar: 'العبوة سليمة وخالية من أي تلف أو تسريب' },
  { en: 'Packaging is clean and free from dust or transportation residues', ar: 'نظافة العبوة وعدم وجود أتربة أو آثار نقل' },
  { en: 'Matches the label information (Product name – Dates)', ar: 'مطابقة بطاقة البيان (اسم المنتج – التواريخ)' },
  { en: 'The packaging is intact and free from any damage or leakage', ar: 'العبوة سليمة وخالية من أي تلف أو تسريب' },
  { en: 'Printing is clear, with no smudges or erasures', ar: 'وضوح الطباعة وعدم وجود كشط أو محو' },
  { en: 'Overall product appearance complies with internal specifications', ar: 'الشكل العام للمنتج مطابق للمواصفة الداخلية' },
  { en: 'Color is natural and shows no changes', ar: 'اللون طبيعي وعدم وجود تغيرات' },
  { en: 'Taste and smell are normal (upon inspection)', ar: 'الطعم والرائحة طبيعية (عند الفحص)' },
  { en: 'No foreign particles or objects present', ar: 'عدم وجود شوائب أو أجسام غريبة' },
  { en: 'Maintaining the appropriate temperature according to product type', ar: 'الالتزام بدرجة الحرارة المناسبة حسب نوع المنتج' },
  { en: 'Products are arranged safely inside the transportation vehicle', ar: 'ترتيب المنتجات داخل وسيلة النقل بشكل آمن' },
  { en: 'Vehicle is clean and free from any strange odors', ar: 'نظافة السيارة وخلوها من أي روائح غريبة' },
  { en: 'Products are not stacked in a way that could cause damage', ar: 'عدم تكديس المنتجات بشكل يسبب تلفها' },
  { en: 'Recording temperature measurements for random products', ar: 'تسجيل قياس درجة الحرارة لمنتجات عشوائية' },
]

// -------------------------------------------------------------- Helpers

const el = (id) => document.getElementById(id)

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]),
  )
}

function showMessage(elementId, text) {
  const target = el(elementId)
  target.textContent = text
  target.classList.remove('hidden')
}

function fillSelect(elementId, items, valueKey, labelKey, placeholder) {
  const options = items.map((item) => `<option value="${item[valueKey]}">${escapeHtml(item[labelKey])}</option>`)
  el(elementId).innerHTML = `<option value="">${placeholder}</option>${options.join('')}`
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// ------------------------------------------------------------------ API

async function callApi(action, payload = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY }
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`

  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...payload }),
  })

  const result = await response.json().catch(() => ({ message: 'استجابة غير صالحة من الخادم.' }))
  if (!response.ok || result.success === false) {
    throw new Error(result.message || 'حدث خطأ غير متوقع.')
  }
  return result
}

// -------------------------------------------------------------- PDF text

async function extractTextFromPdf(file) {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  let text = ''
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    text += content.items.map((item) => item.str || '').join(' ') + '\n'
  }
  return text
}

// -------------------------------------------------------------- Actions

async function login() {
  try {
    const password = el('password').value
    const { token } = await callApi('login', { password })
    sessionToken = token
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
    enterApp()
    await boot()
  } catch (error) {
    showMessage('loginMsg', error.message)
  }
}

function enterApp() {
  el('login').classList.add('hidden')
  el('app').classList.remove('hidden')
  el('runDate').value = todayISO()
  el('homeCurrentDate').textContent = todayISO()
}

async function boot() {
  appData = await callApi('bootstrap')
  fillSelect('dateGroupSelect', appData.groups, 'id', 'name', 'اختر المجموعة')
  fillSelect('dateProductSelect', appData.products, 'id', 'name', 'كل منتجات المجموعة (تحديث جماعي)')
  fillSelect('newProductGroup', appData.groups, 'id', 'name', 'بدون مجموعة')
  renderForms()
  renderGroupManagement()
  renderBranchCheckboxes()
  renderBranchesAdmin()
  renderPhotoFormTargets()
  renderPhotoAssignments()
  renderPendingPhotoTiles()
}

// --------------------------------------------------------- Screen navigation

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'))
  el(screenId).classList.remove('hidden')
}

function goHome() {
  showScreen('homeScreen')
}

async function saveDate() {
  try {
    const { display, date } = await callApi('date', { date: el('runDate').value })
    showMessage('dateMsg', `تم ضبط التاريخ: ${display}`)
    el('homeCurrentDate').textContent = date
  } catch (error) {
    showMessage('dateMsg', error.message)
  }
}

async function resetDay() {
  if (!confirm('سيتم حذف علامات ✓ لليوم فقط. هل تريد المتابعة؟')) return
  try {
    const { message } = await callApi('reset', { date: el('runDate').value })
    alert(message)
  } catch (error) {
    alert(error.message)
  }
}

async function uploadInvoices() {
  const files = [...el('pdfs').files]
  if (!files.length) return showMessage('uploadMsg', 'اختر ملفات PDF أولًا.')

  el('pdfProgress').classList.remove('hidden')
  el('pdfBar').style.width = '0%'

  const extracted = []
  for (let i = 0; i < files.length; i++) {
    el('pdfStatus').textContent = `جاري قراءة ${i + 1} من ${files.length}: ${files[i].name}`
    try {
      extracted.push({ name: files[i].name, text: await extractTextFromPdf(files[i]) })
    } catch {
      extracted.push({ name: files[i].name, text: '' })
    }
    el('pdfBar').style.width = `${Math.round(((i + 1) / files.length) * 70)}%`
  }

  try {
    const { results } = await callApi('invoices', { date: el('runDate').value, files: extracted })
    el('pdfBar').style.width = '100%'
    el('pdfStatus').textContent = 'اكتملت المعالجة'
    showMessage('uploadMsg', formatInvoiceResults(results))
  } catch (error) {
    showMessage('uploadMsg', error.message)
  }
}

function formatInvoiceResults(results) {
  return results
    .map((r) => {
      const lines = [
        `${r.success ? '✅' : '❌'} ${r.file}`,
        `الفرع: ${r.branch || 'غير محدد'}`,
        `المطابق: ${r.matchedCodes?.join(', ') || 'لا يوجد'}`,
        `الأكواد غير الموجودة في قاعدة المنتجات: ${r.unknownCodes?.join(', ') || 'لا يوجد'}`,
      ]
      return lines.join('\n')
    })
    .join('\n\n')
}

function onDateGroupChange() {
  const groupId = el('dateGroupSelect').value
  const filtered = groupId ? appData.products.filter((p) => String(p.group_id) === groupId) : appData.products
  fillSelect('dateProductSelect', filtered, 'id', 'name', 'كل منتجات المجموعة (تحديث جماعي)')
}

async function saveDates() {
  const groupId = el('dateGroupSelect').value
  const productId = el('dateProductSelect').value
  if (!groupId && !productId) return alert('اختر مجموعة أو منتج على الأقل.')

  const payload = {
    production_date: el('dateProd').value,
    expiry_date: el('dateExp').value,
    notes: el('dateNote').value,
  }

  try {
    if (productId) {
      // A specific product was picked → update just that one.
      await callApi('dates-product', { product_id: productId, ...payload })
      alert('تم حفظ بيانات المنتج.')
    } else {
      // Only a group was picked, no specific product → update the whole group at once.
      const { updated } = await callApi('dates-group', { group_id: groupId, ...payload })
      alert(`تم تحديث ${updated} منتج دفعة واحدة.`)
    }
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function addGroup() {
  try {
    const { group } = await callApi('groups', { name: el('newGroup').value })
    alert(`تمت إضافة المجموعة: ${group.name}`)
    el('newGroup').value = ''
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function addProduct() {
  try {
    const { product } = await callApi('products', {
      code: el('newProductCode').value,
      name: el('newProductName').value,
      group_id: el('newProductGroup').value || null,
    })
    alert(`تمت إضافة المنتج: ${product.name}`)
    el('newProductCode').value = ''
    el('newProductName').value = ''
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

// ------------------------------------------------------ Branches management

function renderBranchesAdmin() {
  el('branchesList').innerHTML = appData.branches
    .map(
      (b) => `
      <div class="admin-row" data-branch-id="${b.id}">
        <input type="text" class="admin-code" value="${escapeHtml(b.code)}" data-branch-code="${b.id}">
        <input type="text" class="admin-name" value="${escapeHtml(b.name)}" data-branch-name="${b.id}">
        <button class="secondary" data-save-branch="${b.id}">حفظ</button>
        <button class="danger" data-delete-branch="${b.id}">حذف</button>
      </div>`,
    )
    .join('') || '<p class="hint">لا توجد فروع بعد.</p>'
}

async function addBranch() {
  try {
    const { branch } = await callApi('branches', { code: el('newBranchCode').value, name: el('newBranchName').value })
    alert(`تمت إضافة الفرع: ${branch.name}`)
    el('newBranchCode').value = ''
    el('newBranchName').value = ''
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function saveBranchRow(id) {
  try {
    await callApi('branches-update', {
      id,
      code: document.querySelector(`[data-branch-code="${id}"]`).value,
      name: document.querySelector(`[data-branch-name="${id}"]`).value,
    })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function deleteBranchRow(id) {
  if (!confirm('حذف الفرع؟ هيتشال من كل النماذج المرتبط بيها، وسجلاته القديمة هتفضل محفوظة للأرشيف.')) return
  try {
    await callApi('branches-delete', { id })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

// ------------------------------------------------------ Groups & Products management

function renderGroupManagement() {
  el('groupsList').innerHTML = appData.groups
    .map(
      (g) => `
      <div class="admin-row" data-group-id="${g.id}">
        <input type="color" class="swatch-input" value="${g.color || '#eef2f5'}" data-group-color="${g.id}">
        <input type="text" class="admin-name" value="${escapeHtml(g.name)}" data-group-name="${g.id}">
        <button class="secondary" data-save-group="${g.id}">حفظ</button>
        <button class="danger" data-delete-group="${g.id}">حذف</button>
      </div>`,
    )
    .join('') || '<p class="hint">لا توجد مجموعات بعد.</p>'

  el('productsList').innerHTML = appData.products
    .map((p) => {
      const groupOptions = appData.groups
        .map((g) => `<option value="${g.id}" ${g.id === p.group_id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
        .join('')
      return `
        <div class="admin-row" data-product-id="${p.id}">
          <input type="text" class="admin-code" value="${escapeHtml(p.code)}" data-product-code="${p.id}">
          <input type="text" class="admin-name" value="${escapeHtml(p.name)}" data-product-name="${p.id}">
          <select data-product-group="${p.id}"><option value="">بدون مجموعة</option>${groupOptions}</select>
          <button class="secondary" data-save-product="${p.id}">حفظ</button>
          <button class="danger" data-delete-product="${p.id}">حذف</button>
        </div>`
    })
    .join('') || '<p class="hint">لا توجد منتجات بعد.</p>'
}

async function saveGroupRow(id) {
  try {
    await callApi('groups-update', {
      id,
      name: document.querySelector(`[data-group-name="${id}"]`).value,
      color: document.querySelector(`[data-group-color="${id}"]`).value,
    })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function deleteGroupRow(id) {
  if (!confirm('حذف المجموعة؟ المنتجات التابعة لها هتفضل موجودة بس من غير مجموعة.')) return
  try {
    await callApi('groups-delete', { id })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function saveProductRow(id) {
  try {
    await callApi('products-update', {
      id,
      code: document.querySelector(`[data-product-code="${id}"]`).value,
      name: document.querySelector(`[data-product-name="${id}"]`).value,
      group_id: document.querySelector(`[data-product-group="${id}"]`).value || null,
    })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function deleteProductRow(id) {
  if (!confirm('حذف المنتج؟ (هيتعطل من القوائم، وسجلاته القديمة هتفضل محفوظة للأرشيف).')) return
  try {
    await callApi('products-delete', { id })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

// ------------------------------------------------------ Custom print builder

function renderBranchCheckboxes() {
  el('printBranches').innerHTML = appData.branches
    .map(
      (b) => `
      <label class="branch-check">
        <input type="checkbox" value="${b.id}" ${selectedPrintBranches.has(b.id) ? 'checked' : ''}>
        ${escapeHtml(b.code)} - ${escapeHtml(b.name)}
      </label>`,
    )
    .join('')
}

function onBranchCheckboxChange(e) {
  const checkbox = e.target.closest('input[type="checkbox"]')
  if (!checkbox) return
  const id = Number(checkbox.value)

  if (checkbox.checked && selectedPrintBranches.size >= 3) {
    checkbox.checked = false
    alert('الحد الأقصى 3 فروع في الورقة الواحدة.')
    return
  }
  if (checkbox.checked) selectedPrintBranches.add(id)
  else selectedPrintBranches.delete(id)
}

// A single reusable "upload tile" used for every photo slot in the app
// (custom print + each form's own photos): dashed box with a camera icon
// while empty, the photo itself with a remove (×) button once set.
function photoTileInnerHTML(dataUrl) {
  if (dataUrl) {
    return `<img src="${dataUrl}"><button type="button" class="photo-tile-remove" data-remove-photo>×</button>`
  }
  return `<span class="photo-tile-icon">📷</span><span>إضافة صورة</span><input type="file" accept="image/*" capture="environment">`
}

function renderCustomPrintPhotoTiles() {
  ;[0, 1].forEach((slot) => {
    const tile = el(`photoTile${slot}`)
    tile.classList.toggle('has-photo', !!photoDataUrls[slot])
    tile.innerHTML = photoTileInnerHTML(photoDataUrls[slot])
  })
}

function onCustomPhotoTileChange(e) {
  const input = e.target.closest('input[type="file"]')
  if (!input) return
  const slot = Number(input.closest('.photo-tile').dataset.slot)
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    photoDataUrls[slot] = reader.result
    renderCustomPrintPhotoTiles()
  }
  reader.readAsDataURL(file)
}

function onCustomPhotoTileClick(e) {
  const removeBtn = e.target.closest('[data-remove-photo]')
  if (!removeBtn) return
  const slot = Number(removeBtn.closest('.photo-tile').dataset.slot)
  photoDataUrls[slot] = null
  renderCustomPrintPhotoTiles()
}

async function previewAndPrint() {
  if (!selectedPrintBranches.size) return alert('اختر فرع واحد على الأقل.')
  try {
    const { date, branches, products } = await callApi('print-sheet', {
      date: el('runDate').value,
      branch_ids: [...selectedPrintBranches],
    })
    openPrintWindow(buildPrintDocument([{ date, location: el('printLocation').value, branches, products, photos: photoDataUrls }]))
  } catch (error) {
    alert(error.message)
  }
}

// -------------------------------------------------- Shared print template
//
// One shared builder used by: the custom print builder, a single form, and
// "print all forms". Each entry in `sections` becomes its own product table
// + its own checklist/signature page (page-break-before between them), so
// every branch group gets an independently signable sheet.

function buildProductTableHTML(section) {
  const { date, location, branches, products } = section
  const branchHeaders = branches.map((b) => `<th>${escapeHtml(b.code)}<br><small>${escapeHtml(b.name)}</small></th>`).join('')

  const rows = products
    .map((p) => {
      const color = p.group?.color || '#ffffff'
      const checks = branches.map((b) => `<td class="check-mark">${p.checks[b.id] ? '✓' : ''}</td>`).join('')
      return `
        <tr style="background:${color}">
          <td class="cell-name">${escapeHtml(p.code)} ${escapeHtml(p.name)}</td>
          ${checks}
          <td>${p.dates.production_date || ''}</td>
          <td>${p.dates.expiry_date || ''}</td>
          <td>${escapeHtml(p.dates.notes || '')}</td>
        </tr>`
    })
    .join('')

  return `
    <table class="header-table">
      <tr><td><b>Date : ${date}</b></td><td><b>Location : ${escapeHtml(location || 'Riyadh Factory')}</b></td></tr>
    </table>
    <table class="product-table">
      <tr><th>Product Code / Name</th>${branchHeaders}<th>Production Date</th><th>Expiry Date</th><th>Notes</th></tr>
      ${rows}
    </table>`
}

function buildChecklistHTML(sectionPhotos) {
  const photos = sectionPhotos || [null, null]
  const checklistRows = INSPECTION_CHECKLIST.map(
    (item) => `
      <tr>
        <td class="mark-box"></td>
        <td class="check-en">${escapeHtml(item.en)}</td>
        <td class="check-ar">${escapeHtml(item.ar)}</td>
      </tr>`,
  ).join('')

  const photosHtml = [0, 1]
    .map((i) =>
      photos[i]
        ? `<img class="temp-photo" src="${photos[i]}">`
        : `<div class="temp-photo temp-photo-empty">صورة ${i + 1}</div>`,
    )
    .join('')

  return `
    <h2>Product / Vehicle Inspection — فحص المنتج والمركبة</h2>
    <p>Please mark ✓ or X — يرجى وضع علامة ✓ أو X</p>
    <table class="checklist-table">
      <tr><th></th><th>Item</th><th>البند</th></tr>
      ${checklistRows}
    </table>

    <div class="photos-row">${photosHtml}</div>

    <h2>Third: Product Condition — حالة المنتج</h2>
    <table>
      <tr>
        <td>Compliant and ready for distribution<br>مطابق وجاهز للتوزيع</td>
        <td>Non-compliant (to be held and not dispatched)<br>غير مطابق (يتم الحجز وعدم الإرسال)</td>
      </tr>
    </table>
    <p>Details of non-compliance (if any) — تفاصيل عدم المطابقة (إن وجدت): ______________________</p>

    <div class="sign-grid">
      <div>Driver signature — توقيع السائق</div>
      <div>Vehicle No — رقم المركبة</div>
      <div>Verified By — تم التحقق بواسطة</div>
      <div>Approved By — اعتماد</div>
    </div>`
}

function buildPrintDocument(sections) {
  const body = sections
    .map(
      (section, index) => `
      <div class="${index > 0 ? 'page-break' : ''}">
        ${buildProductTableHTML(section)}
      </div>
      <div class="page-break">
        ${buildChecklistHTML(section.photos)}
      </div>`,
    )
    .join('')

  return `
    <html dir="rtl">
      <head>
        <title>نموذج فحص - ${sections[0]?.date || todayISO()}</title>
        <style>
          * { box-sizing: border-box; }
          @page { size: A4; margin: 7mm; }
          body { font-family: Arial, 'Segoe UI', sans-serif; font-size: 12px; }
          h2 { margin: 0 0 3px; font-size: 13px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 4px; table-layout: fixed; }
          th, td { border: 1px solid #888; padding: 0.5px 3px; text-align: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

          /* Product table: many rows must fit on a single page */
          .product-table th, .product-table td { font-size: 7px; line-height: 1.25; padding: 0.5px 2px; }
          .product-table th { font-size: 7.5px; padding: 2px; }
          .cell-name { text-align: right !important; }

          .header-table td { font-size: 11px; padding: 3px 6px; }

          th { background: #eef2f5; }
          .page-break { page-break-before: always; }
          .mark-box { width: 20px; }
          .check-en { text-align: left !important; white-space: normal; }
          .check-ar { text-align: right !important; white-space: normal; }
          .checklist-table th, .checklist-table td { font-size: 10px; padding: 2px 5px; white-space: normal; }
          .photos-row { display: flex; gap: 8px; margin: 6px 0; }
          .temp-photo { flex: 1; height: 110px; object-fit: cover; border: 1px solid #999; border-radius: 6px; }
          .temp-photo-empty { display: flex; align-items: center; justify-content: center; color: #999; background: #f5f5f5; font-size: 11px; }
          .sign-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 10px; }
          .sign-grid div { border-top: 1px solid #333; padding-top: 4px; font-size: 10px; }
          @media print { button { display: none; } }
        </style>
      </head>
      <body>
        ${body}
        <br>
        <button onclick="window.print()">طباعة</button>
      </body>
    </html>`
}

function openPrintWindow(html) {
  const printWindow = window.open('', '_blank')
  printWindow.document.write(html)
  printWindow.document.close()
}

// ------------------------------------------------------------ Forms UI

function renderForms() {
  el('forms').innerHTML = appData.forms
    .map((form) => {
      const summaryLine = formBranchSummary(form)
      const hasBranches = (form.form_branches || []).length > 0
      const branchCheckboxes = appData.branches
        .map((b) => {
          const checked = (form.form_branches || []).some((fb) => fb.branch_id === b.id)
          return `<label class="branch-check"><input type="checkbox" value="${b.id}" ${checked ? 'checked' : ''}> ${escapeHtml(b.code)} - ${escapeHtml(b.name)}</label>`
        })
        .join('')
      const [photo0, photo1] = getFormPhotos(form.id)
      const hasPhotos = photo0 || photo1
      const isExpanded = expandedFormIds.has(form.id)

      return `
        <div class="form-tile ${isExpanded ? 'expanded' : ''}" data-form-id="${form.id}">
          <div class="form-tile-summary" data-toggle-form="${form.id}">
            <span class="form-badge">${form.form_no}</span>
            <div class="form-summary-text">
              <div class="form-title">النموذج ${form.form_no} ${hasPhotos ? '<span class="photo-indicator" title="فيه صور">📷</span>' : ''}</div>
              <div class="form-branches-line ${hasBranches ? '' : 'empty'}">${escapeHtml(summaryLine)}</div>
            </div>
            <span class="form-expand-arrow">▾</span>
          </div>

          <div class="form-tile-details">
            <label class="branch-edit-label">فروع هذا النموذج:</label>
            <div class="branches-grid form-branch-edit" data-form-branches="${form.id}">${branchCheckboxes}</div>
            <button class="secondary" data-save-form-branches="${form.id}">حفظ فروع النموذج</button>

            <button data-open-form="${form.id}">عرض وطباعة هذا النموذج</button>
          </div>
        </div>`
    })
    .join('')
}

async function saveFormBranches(formId) {
  const container = document.querySelector(`[data-form-branches="${formId}"]`)
  const branchIds = [...container.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => Number(cb.value))
  try {
    await callApi('forms-update', { form_id: formId, branch_ids: branchIds })
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function openForm(formId) {
  try {
    const { date, branches, products } = await callApi('form', { id: formId, date: el('runDate').value })
    if (!branches.length) return alert('النموذج ده لسه مفيهوش فروع متحددة. حدد الفروع الأول من تحت اسم النموذج.')
    openPrintWindow(buildPrintDocument([{ date, location: el('printLocation')?.value, branches, products, photos: getFormPhotos(formId) }]))
  } catch (error) {
    alert(error.message)
  }
}

async function printAllForms() {
  try {
    const { forms } = await callApi('forms-all', { date: el('runDate').value })
    if (!forms.length) return alert('مفيش أي نموذج متحدد له فروع لسه.')
    const sections = forms.map((f) => ({
      date: f.date,
      location: el('printLocation')?.value,
      branches: f.branches,
      products: f.products,
      photos: getFormPhotos(f.form.id),
    }))
    openPrintWindow(buildPrintDocument(sections))
  } catch (error) {
    alert(error.message)
  }
}

// -------------------------------------------- External photo assignment flow
// One shared "pending" photo pair (outside the forms list). The user
// uploads photo 1/2, ticks which form(s) they belong to, then applies —
// which copies that pair into each target form's own independent slot.
// Repeatable with different photos/targets each time.

function renderPendingPhotoTiles() {
  ;[0, 1].forEach((slot) => {
    const tile = el(`photoTilePending${slot}`)
    tile.classList.toggle('has-photo', !!pendingPhotoUrls[slot])
    tile.innerHTML = photoTileInnerHTML(pendingPhotoUrls[slot])
  })
}

function onPendingPhotoTileChange(e) {
  const input = e.target.closest('input[type="file"]')
  if (!input) return
  const slot = Number(input.closest('.photo-tile').dataset.slot)
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    pendingPhotoUrls[slot] = reader.result
    renderPendingPhotoTiles()
  }
  reader.readAsDataURL(file)
}

function onPendingPhotoTileClick(e) {
  const removeBtn = e.target.closest('[data-remove-photo]')
  if (!removeBtn) return
  const slot = Number(removeBtn.closest('.photo-tile').dataset.slot)
  pendingPhotoUrls[slot] = null
  renderPendingPhotoTiles()
}

function formBranchSummary(form) {
  const names = (form.form_branches || []).map((fb) => `${fb.branches.code} (${fb.branches.name})`)
  return names.length ? names.join('، ') : 'لا توجد فروع بعد'
}

function renderPhotoFormTargets() {
  el('photoFormTargets').innerHTML = appData.forms
    .map((f) => {
      const summary = formBranchSummary(f)
      return `
      <label class="branch-check branch-check-detailed">
        <input type="checkbox" value="${f.id}" ${pendingPhotoFormTargets.has(f.id) ? 'checked' : ''}>
        <span>
          <span class="branch-check-title">النموذج ${f.form_no}</span>
          <span class="branch-check-subtitle">${escapeHtml(summary)}</span>
        </span>
      </label>`
    })
    .join('')
}

function onPhotoFormTargetChange(e) {
  const checkbox = e.target.closest('input[type="checkbox"]')
  if (!checkbox) return
  const id = Number(checkbox.value)
  if (checkbox.checked) pendingPhotoFormTargets.add(id)
  else pendingPhotoFormTargets.delete(id)
}

function applyPendingPhotosToForms() {
  if (!pendingPhotoUrls[0] && !pendingPhotoUrls[1]) return alert('ارفع صورة واحدة على الأقل الأول.')
  if (!pendingPhotoFormTargets.size) return alert('حدد نموذج واحد على الأقل تتطبق عليه الصور.')

  pendingPhotoFormTargets.forEach((formId) => {
    formPhotos[formId] = [pendingPhotoUrls[0], pendingPhotoUrls[1]]
  })

  pendingPhotoUrls = [null, null]
  pendingPhotoFormTargets = new Set()
  renderPendingPhotoTiles()
  renderPhotoFormTargets()
  renderForms()
  renderPhotoAssignments()
}

function renderPhotoAssignments() {
  const assigned = appData.forms.filter((f) => {
    const [p0, p1] = getFormPhotos(f.id)
    return p0 || p1
  })
  if (!assigned.length) {
    el('photoAssignments').innerHTML = ''
    return
  }
  el('photoAssignments').innerHTML = `
    <label class="branch-edit-label">النماذج اللي عندها صور دلوقتي:</label>
    <div class="admin-list">
      ${assigned
        .map(
          (f) => `
        <div class="admin-row assignment-row">
          <span class="admin-name">النموذج ${f.form_no}</span>
          <span></span>
          <button class="danger" data-clear-assignment="${f.id}">مسح صور هذا النموذج</button>
        </div>`,
        )
        .join('')}
    </div>`
}

function clearFormPhotoAssignment(formId) {
  delete formPhotos[formId]
  renderForms()
  renderPhotoAssignments()
}

function toggleFormExpand(formId) {
  if (expandedFormIds.has(formId)) expandedFormIds.delete(formId)
  else expandedFormIds.add(formId)
  renderForms()
}

// --------------------------------------------------------- Event wiring

function bindEvents() {
  el('loginButton').addEventListener('click', login)
  el('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login() })
  el('saveDateButton').addEventListener('click', saveDate)
  el('resetDayButton').addEventListener('click', resetDay)
  el('uploadButton').addEventListener('click', uploadInvoices)
  el('dateGroupSelect').addEventListener('change', onDateGroupChange)
  el('saveDatesButton').addEventListener('click', saveDates)
  el('addGroupButton').addEventListener('click', addGroup)
  el('addProductButton').addEventListener('click', addProduct)
  el('printAllFormsButton').addEventListener('click', printAllForms)
  el('addBranchButton').addEventListener('click', addBranch)

  // Delegated click handler for the dynamically rendered form tiles
  // (expand/collapse, view/print, save branches)
  el('forms').addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save-form-branches]')
    if (saveBtn) return saveFormBranches(Number(saveBtn.dataset.saveFormBranches))
    const openBtn = e.target.closest('[data-open-form]')
    if (openBtn) return openForm(Number(openBtn.dataset.openForm))
    const toggle = e.target.closest('[data-toggle-form]')
    if (toggle) return toggleFormExpand(Number(toggle.dataset.toggleForm))
  })

  // External "add photos" flow (outside the forms list)
  el('pendingPhotoRow').addEventListener('change', onPendingPhotoTileChange)
  el('pendingPhotoRow').addEventListener('click', onPendingPhotoTileClick)
  el('photoFormTargets').addEventListener('change', onPhotoFormTargetChange)
  el('applyPhotosButton').addEventListener('click', applyPendingPhotosToForms)
  el('photoAssignments').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear-assignment]')
    if (btn) clearFormPhotoAssignment(Number(btn.dataset.clearAssignment))
  })

  // Delegated handlers for the branches admin list
  el('branchesList').addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save-branch]')
    if (saveBtn) return saveBranchRow(Number(saveBtn.dataset.saveBranch))
    const delBtn = e.target.closest('[data-delete-branch]')
    if (delBtn) return deleteBranchRow(Number(delBtn.dataset.deleteBranch))
  })

  // Delegated handlers for the groups/products admin lists
  el('groupsList').addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save-group]')
    if (saveBtn) return saveGroupRow(Number(saveBtn.dataset.saveGroup))
    const delBtn = e.target.closest('[data-delete-group]')
    if (delBtn) return deleteGroupRow(Number(delBtn.dataset.deleteGroup))
  })
  el('productsList').addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save-product]')
    if (saveBtn) return saveProductRow(Number(saveBtn.dataset.saveProduct))
    const delBtn = e.target.closest('[data-delete-product]')
    if (delBtn) return deleteProductRow(Number(delBtn.dataset.deleteProduct))
  })

  // Custom print builder
  el('printBranches').addEventListener('change', onBranchCheckboxChange)
  el('screen-print').addEventListener('change', onCustomPhotoTileChange)
  el('screen-print').addEventListener('click', onCustomPhotoTileClick)
  el('previewPrintButton').addEventListener('click', previewAndPrint)

  // Home dashboard navigation
  document.querySelectorAll('[data-screen]').forEach((tile) => {
    tile.addEventListener('click', () => showScreen(tile.dataset.screen))
  })
  document.querySelectorAll('[data-go-home]').forEach((btn) => {
    btn.addEventListener('click', goHome)
  })
}

// -------------------------------------------------------------- Startup

async function restoreSession() {
  const saved = localStorage.getItem(TOKEN_STORAGE_KEY)
  if (!saved) return
  sessionToken = saved
  try {
    enterApp()
    await boot()
  } catch {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    sessionToken = ''
    el('login').classList.remove('hidden')
    el('app').classList.add('hidden')
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents()
  restoreSession()
})
