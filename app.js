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

const FUNCTION_URL = 'https://tnrujxfqvfoqwvclamsi.supabase.co/functions/v1/inspection-api-v2'
const PUBLISHABLE_KEY = 'sb_publishable_UDxeC8HSBNNj2eOugUvtZw_V8u5Ku2e'
const TOKEN_STORAGE_KEY = 'ufuqToken'

// ----------------------------------------------------------------- State

let sessionToken = ''
let appData = { branches: [], forms: [], groups: [], products: [] }

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
  renderForms()
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

// ------------------------------------------------------------ Forms UI

function renderForms() {
  el('forms').innerHTML = appData.forms
    .map((form) => {
      const branchPills = (form.form_branches || [])
        .map((fb) => `<span class="pill">${escapeHtml(fb.branches.code)} - ${escapeHtml(fb.branches.name)}</span>`)
        .join('')
      return `
        <div class="form-tile">
          <h3>النموذج ${form.form_no}</h3>
          <div>${branchPills || '<span class="hint">لم يتم ربط الفروع بعد</span>'}</div>
          <button data-open-form="${form.id}">عرض النموذج</button>
        </div>`
    })
    .join('')
}

async function openForm(formId) {
  try {
    const { form, products } = await callApi('form', { id: formId, date: el('runDate').value })
    const printWindow = window.open('', '_blank')
    printWindow.document.write(buildPrintableForm(form, products))
    printWindow.document.close()
  } catch (error) {
    alert(error.message)
  }
}

function buildPrintableForm(form, products) {
  const branchColumns = form.form_branches
    .map((fb) => `<th>${escapeHtml(fb.branches.code)}</th>`)
    .join('')

  const rows = products
    .map((product) => {
      const checkCells = form.form_branches
        .map((fb) => `<td class="check-mark">${product.checks[fb.branch_id] ? '✓' : ''}</td>`)
        .join('')
      const dates = product.product_dates?.[0] || {}
      return `
        <tr>
          <td>${product.row_order}</td>
          <td>${escapeHtml(product.name)}<br><small>${escapeHtml(product.code)}</small></td>
          ${checkCells}
          <td>${dates.production_date || ''}</td>
          <td>${dates.expiry_date || ''}</td>
        </tr>`
    })
    .join('')

  return `
    <html dir="rtl">
      <head>
        <title>${escapeHtml(form.name)}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #999; padding: 8px; text-align: center; }
          th { background: #eee; }
        </style>
      </head>
      <body>
        <h2>${escapeHtml(form.name)}</h2>
        <table>
          <tr><th>#</th><th>المنتج</th>${branchColumns}<th>الإنتاج</th><th>الانتهاء</th></tr>
          ${rows}
        </table>
        <br>
        <button onclick="window.print()">طباعة</button>
      </body>
    </html>`
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

  // Delegated click handler for the dynamically rendered "view form" buttons
  el('forms').addEventListener('click', (e) => {
    const button = e.target.closest('[data-open-form]')
    if (button) openForm(Number(button.dataset.openForm))
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
