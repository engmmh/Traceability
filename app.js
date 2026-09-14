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
}

async function boot() {
  appData = await callApi('bootstrap')
  fillSelect('groupSelect', appData.groups, 'id', 'name', 'اختر المجموعة')
  fillSelect('newProductGroup', appData.groups, 'id', 'name', 'بدون مجموعة')
  fillSelect('productSelect', appData.products, 'id', 'name', 'اختر المنتج')
  fillSelect('productFilterGroup', appData.groups, 'id', 'name', 'كل المنتجات')
  renderForms()
  renderGroupManagement()
  renderBranchCheckboxes()
}

async function saveDate() {
  try {
    const { display } = await callApi('date', { date: el('runDate').value })
    showMessage('dateMsg', `تم ضبط التاريخ: ${display}`)
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

async function saveGroupDates() {
  try {
    const { updated } = await callApi('dates-group', {
      group_id: el('groupSelect').value,
      production_date: el('groupProd').value,
      expiry_date: el('groupExp').value,
      notes: el('groupNote').value,
    })
    alert(`تم تحديث ${updated} منتج.`)
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

async function saveProductDate() {
  try {
    await callApi('dates-product', {
      product_id: el('productSelect').value,
      production_date: el('prodProd').value,
      expiry_date: el('prodExp').value,
      notes: el('prodNote').value,
    })
    alert('تم حفظ بيانات المنتج.')
    await boot()
  } catch (error) {
    alert(error.message)
  }
}

function onProductFilterChange() {
  const groupId = el('productFilterGroup').value
  const filtered = groupId ? appData.products.filter((p) => String(p.group_id) === groupId) : appData.products
  fillSelect('productSelect', filtered, 'id', 'name', 'اختر المنتج')
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
          <span class="admin-code">${escapeHtml(p.code)}</span>
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

function onPhotoChange(e, slot) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    photoDataUrls[slot] = reader.result
    el(`photoPreview${slot}`).src = reader.result
    el(`photoPreview${slot}`).classList.remove('hidden')
  }
  reader.readAsDataURL(file)
}

async function previewAndPrint() {
  if (!selectedPrintBranches.size) return alert('اختر فرع واحد على الأقل.')
  try {
    const { date, branches, products } = await callApi('print-sheet', {
      date: el('runDate').value,
      branch_ids: [...selectedPrintBranches],
    })
    openPrintWindow(buildPrintDocument([{ date, location: el('printLocation').value, branches, products }]))
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
    <table>
      <tr><td><b>Date : ${date}</b></td><td><b>Location : ${escapeHtml(location || 'Riyadh Factory')}</b></td></tr>
    </table>
    <table>
      <tr><th>Product Code / Name</th>${branchHeaders}<th>Production Date</th><th>Expiry Date</th><th>Notes</th></tr>
      ${rows}
    </table>`
}

function buildChecklistHTML() {
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
      photoDataUrls[i]
        ? `<img class="temp-photo" src="${photoDataUrls[i]}">`
        : `<div class="temp-photo temp-photo-empty">صورة ${i + 1}</div>`,
    )
    .join('')

  return `
    <h2>Product / Vehicle Inspection — فحص المنتج والمركبة</h2>
    <p>Please mark ✓ or X — يرجى وضع علامة ✓ أو X</p>
    <table>
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
        ${buildChecklistHTML()}
      </div>`,
    )
    .join('')

  return `
    <html dir="rtl">
      <head>
        <title>نموذج فحص - ${sections[0]?.date || todayISO()}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: Arial, 'Segoe UI', sans-serif; padding: 16px; font-size: 12px; }
          h2 { margin: 0 0 4px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 10px; }
          th, td { border: 1px solid #888; padding: 4px 6px; text-align: center; }
          th { background: #eef2f5; }
          .cell-name { text-align: right; }
          .page-break { page-break-before: always; }
          .mark-box { width: 26px; }
          .check-en { text-align: left; }
          .check-ar { text-align: right; }
          .photos-row { display: flex; gap: 10px; margin: 10px 0; }
          .temp-photo { flex: 1; height: 160px; object-fit: cover; border: 1px solid #999; border-radius: 6px; }
          .temp-photo-empty { display: flex; align-items: center; justify-content: center; color: #999; background: #f5f5f5; }
          .sign-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
          .sign-grid div { border-top: 1px solid #333; padding-top: 4px; font-size: 11px; }
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
      const branchPills = (form.form_branches || [])
        .map((fb) => `<span class="pill">${escapeHtml(fb.branches.code)} - ${escapeHtml(fb.branches.name)}</span>`)
        .join('')
      const branchCheckboxes = appData.branches
        .map((b) => {
          const checked = (form.form_branches || []).some((fb) => fb.branch_id === b.id)
          return `<label class="branch-check"><input type="checkbox" value="${b.id}" ${checked ? 'checked' : ''}> ${escapeHtml(b.code)} - ${escapeHtml(b.name)}</label>`
        })
        .join('')
      return `
        <div class="form-tile" data-form-id="${form.id}">
          <h3>النموذج ${form.form_no}</h3>
          <div class="pills-row">${branchPills || '<span class="hint">لسه مفيش فروع متحددة</span>'}</div>
          <details>
            <summary>تعديل الفروع</summary>
            <div class="branches-grid form-branch-edit" data-form-branches="${form.id}">${branchCheckboxes}</div>
            <button class="secondary" data-save-form-branches="${form.id}">حفظ فروع النموذج</button>
          </details>
          <button data-open-form="${form.id}">عرض وطباعة هذا النموذج</button>
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
    if (!branches.length) return alert('النموذج ده لسه مفيهوش فروع متحددة. دوس "تعديل الفروع" الأول.')
    openPrintWindow(buildPrintDocument([{ date, location: el('printLocation')?.value, branches, products }]))
  } catch (error) {
    alert(error.message)
  }
}

async function printAllForms() {
  try {
    const { forms } = await callApi('forms-all', { date: el('runDate').value })
    if (!forms.length) return alert('مفيش أي نموذج متحدد له فروع لسه.')
    const sections = forms.map((f) => ({ date: f.date, location: el('printLocation')?.value, branches: f.branches, products: f.products }))
    openPrintWindow(buildPrintDocument(sections))
  } catch (error) {
    alert(error.message)
  }
}

// --------------------------------------------------------- Event wiring

function bindEvents() {
  el('loginButton').addEventListener('click', login)
  el('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login() })
  el('saveDateButton').addEventListener('click', saveDate)
  el('resetDayButton').addEventListener('click', resetDay)
  el('uploadButton').addEventListener('click', uploadInvoices)
  el('saveGroupDatesButton').addEventListener('click', saveGroupDates)
  el('saveProductDateButton').addEventListener('click', saveProductDate)
  el('addGroupButton').addEventListener('click', addGroup)
  el('addProductButton').addEventListener('click', addProduct)
  el('productFilterGroup').addEventListener('change', onProductFilterChange)
  el('printAllFormsButton').addEventListener('click', printAllForms)

  // Delegated click handler for the dynamically rendered form tiles (view/print + save branches)
  el('forms').addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-open-form]')
    if (openBtn) return openForm(Number(openBtn.dataset.openForm))
    const saveBtn = e.target.closest('[data-save-form-branches]')
    if (saveBtn) return saveFormBranches(Number(saveBtn.dataset.saveFormBranches))
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
  el('photo1').addEventListener('change', (e) => onPhotoChange(e, 0))
  el('photo2').addEventListener('change', (e) => onPhotoChange(e, 1))
  el('previewPrintButton').addEventListener('click', previewAndPrint)
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
