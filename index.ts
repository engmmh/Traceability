// =======================================================================
// UFUQ Branch Inspection System — Backend Edge Function
//
// Single entry point. The frontend (GitHub Pages) sends every request as
// POST { action: string, ...payload } and gets back { success, ...data }.
//
// Responsibilities of this file ONLY:
//   - authentication (password login + signed session tokens)
//   - reading/writing the Supabase database
//   - branch detection / product code extraction from invoice text
//   - injection rules, daily checkmarks, resets
//
// It must NEVER contain UI/HTML — see project rule: "Frontend vs Backend
// code must never be mixed."
// =======================================================================

import { createClient } from '@supabase/supabase-js'

// -----------------------------------------------------------------------
// 1. Environment & Supabase client
// -----------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_PASSWORD = Deno.env.get('APP_PASSWORD')
const JWT_SECRET = Deno.env.get('JWT_SECRET')

if (!SUPABASE_URL || !SERVICE_KEY || !APP_PASSWORD || !JWT_SECRET) {
  throw new Error(
    'Missing required secrets. Expected SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ' +
    '(auto-provided by Supabase) plus APP_PASSWORD and JWT_SECRET (set these yourself ' +
    'under Edge Functions -> Secrets).'
  )
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// -----------------------------------------------------------------------
// 2. HTTP helpers
// -----------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS })
}

class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// -----------------------------------------------------------------------
// 3. Small text/date utilities
// -----------------------------------------------------------------------

function normalizeCode(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function isValidDate(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))
}

function formatDMY(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

// -----------------------------------------------------------------------
// 4. Authentication (HMAC-signed session tokens, no external JWT library)
// -----------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const withPadding = padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')
  const binary = atob(withPadding)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function signHmac(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

const SESSION_LIFETIME_SECONDS = 12 * 60 * 60 // 12 hours

async function issueSessionToken(): Promise<string> {
  const claims = { role: 'admin', exp: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS }
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = toBase64Url(await signHmac(body))
  return `${body}.${signature}`
}

async function verifySessionToken(request: Request): Promise<void> {
  const header = request.headers.get('authorization') || ''
  const raw = header.replace(/^Bearer\s+/i, '').trim()
  const [body, signature] = raw.split('.')
  if (!body || !signature) throw new ApiError('UNAUTHORIZED', 401)

  const expectedSignature = await signHmac(body)
  const providedSignature = fromBase64Url(signature)
  if (providedSignature.length !== expectedSignature.length) throw new ApiError('UNAUTHORIZED', 401)

  // constant-time comparison
  let diff = 0
  for (let i = 0; i < providedSignature.length; i++) diff |= providedSignature[i] ^ expectedSignature[i]
  if (diff !== 0) throw new ApiError('UNAUTHORIZED', 401)

  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(body)))
  if (!claims?.exp || claims.exp < Math.floor(Date.now() / 1000)) throw new ApiError('UNAUTHORIZED', 401)
}

// -----------------------------------------------------------------------
// 5. Branch detection (kept identical to the legacy Apps Script logic)
// -----------------------------------------------------------------------

const BRANCH_CODE_PATTERNS: RegExp[] = [
  /(?:BR[-\\/]?\s*|B\s*)(\d+)/i, // BR-123 / B123 / BR123 / BR/22/ / BR\22\
  /\bفرع\s*(\d+)\b/i,
]

function detectBranch(invoiceText: string, branches: any[]): any | null {
  const upperText = normalizeText(invoiceText)

  // Special case kept from the legacy system
  if (upperText.includes('AT TAAWUN')) {
    return branches.find(
      (b) => normalizeText(b.code) === 'TAAWUN' || normalizeText(b.name).includes('TAAWUN'),
    ) ?? null
  }

  // Direct match against code / name / aliases
  for (const branch of branches) {
    const candidates = [branch.code, branch.name, ...(branch.aliases || [])]
      .filter(Boolean)
      .map(normalizeText)
    if (candidates.some((c: string) => c && upperText.includes(c))) return branch
  }

  // Fallback: extract a branch number from common code patterns
  for (const pattern of BRANCH_CODE_PATTERNS) {
    const match = invoiceText.match(pattern)
    if (!match) continue
    const number = String(parseInt(match[1], 10))
    const branch = branches.find((b) => {
      const digits = String(b.code || '').match(/\d+/)
      return digits && String(parseInt(digits[0], 10)) === number
    })
    if (branch) return branch
  }

  return null
}

// -----------------------------------------------------------------------
// 6. Product code extraction + injection rules
// -----------------------------------------------------------------------

function extractProductCodes(invoiceText: string): string[] {
  const matches = invoiceText.match(/\b\d{7}\b|\bsk-[\w\d.-]+/gi) || []
  return [...new Set(matches.map(normalizeCode))]
}

/** Business rule: certain codes imply extra codes must also be checked. */
function applyInjectionRules(codes: string[]): string[] {
  const result = new Set(codes)
  for (const code of codes) {
    if (code.includes('8000855')) {
      result.add('6000740')
      result.add('6000742')
    }
    if (code.includes('8000854')) {
      result.add('6000741')
      result.add('6000742')
    }
  }
  return [...result]
}

// -----------------------------------------------------------------------
// 7. Database helpers
// -----------------------------------------------------------------------

async function ensureDailyRun(runDate: string) {
  const { data, error } = await db
    .from('daily_runs')
    .upsert({ run_date: runDate }, { onConflict: 'run_date' })
    .select('id, run_date')
    .single()
  if (error) throw error
  return data
}

// -----------------------------------------------------------------------
// 8. Action handlers
// -----------------------------------------------------------------------

async function handleLogin(body: any) {
  if (body?.password !== APP_PASSWORD) {
    return jsonResponse({ success: false, message: '❌ الرقم السري غير صحيح.' }, 401)
  }
  return jsonResponse({ success: true, token: await issueSessionToken() })
}

async function handleBootstrap() {
  const [branches, forms, groups, products] = await Promise.all([
    db.from('branches').select('*').eq('active', true).order('name'),
    db
      .from('forms')
      .select('id, form_no, name, active, form_branches(branch_id, display_order, branches(id, code, name))')
      .eq('active', true)
      .order('form_no'),
    db.from('product_groups').select('*').eq('active', true).order('name'),
    db
      .from('products')
      .select('id, code, name, group_id, default_shelf_life_days, active, notes, product_dates(production_date, expiry_date, notes)')
      .eq('active', true)
      .order('name'),
  ])
  for (const result of [branches, forms, groups, products]) if (result.error) throw result.error

  return jsonResponse({
    success: true,
    branches: branches.data,
    forms: forms.data,
    groups: groups.data,
    products: products.data,
  })
}

async function handleSetDate(body: any) {
  if (!isValidDate(body.date)) return jsonResponse({ success: false, message: 'اختر تاريخًا صحيحًا.' }, 400)
  await ensureDailyRun(body.date)
  return jsonResponse({ success: true, date: body.date, display: `Date : ${formatDMY(body.date)}` })
}

async function handleCreateGroup(body: any) {
  const name = String(body.name ?? '').trim()
  if (!name) return jsonResponse({ success: false, message: 'اسم المجموعة مطلوب.' }, 400)

  const { data, error } = await db
    .from('product_groups')
    .insert({ name, code: String(body.code ?? '').trim() || null, notes: body.notes ?? null })
    .select()
    .single()
  if (error) throw error
  return jsonResponse({ success: true, group: data })
}

async function handleCreateProduct(body: any) {
  const code = normalizeCode(body.code)
  const name = String(body.name ?? '').trim()
  if (!code || !name) return jsonResponse({ success: false, message: 'كود المنتج واسم المنتج مطلوبان.' }, 400)

  const { data, error } = await db
    .from('products')
    .insert({
      code,
      name,
      group_id: body.group_id || null,
      default_shelf_life_days: body.default_shelf_life_days || null,
      notes: body.notes ?? null,
    })
    .select()
    .single()
  if (error) throw error
  return jsonResponse({ success: true, product: data })
}

async function handleUpdateGroupDates(body: any) {
  if (!body.group_id) return jsonResponse({ success: false, message: 'اختر المجموعة.' }, 400)

  const { data: products, error: productsError } = await db
    .from('products')
    .select('id')
    .eq('group_id', body.group_id)
    .eq('active', true)
  if (productsError) throw productsError

  const rows = (products || []).map((p) => ({
    product_id: p.id,
    production_date: body.production_date || null,
    expiry_date: body.expiry_date || null,
    notes: body.notes || null,
    updated_at: new Date().toISOString(),
  }))

  if (rows.length) {
    const { error } = await db.from('product_dates').upsert(rows, { onConflict: 'product_id' })
    if (error) throw error
  }
  return jsonResponse({ success: true, updated: rows.length })
}

async function handleUpdateProductDate(body: any) {
  if (!body.product_id) return jsonResponse({ success: false, message: 'اختر المنتج.' }, 400)

  const { error } = await db.from('product_dates').upsert(
    {
      product_id: body.product_id,
      production_date: body.production_date || null,
      expiry_date: body.expiry_date || null,
      notes: body.notes || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_id' },
  )
  if (error) throw error
  return jsonResponse({ success: true })
}

async function handleProcessInvoices(body: any) {
  const runDate = body.date || todayISO()
  const run = await ensureDailyRun(runDate)

  const [branchesResult, productsResult, formsResult] = await Promise.all([
    db.from('branches').select('*').eq('active', true),
    db.from('products').select('id, code, name').eq('active', true),
    db.from('forms').select('id, form_no, form_branches(branch_id)'),
  ])
  for (const result of [branchesResult, productsResult, formsResult]) if (result.error) throw result.error

  const branches = branchesResult.data || []
  const productByCode = new Map<string, { id: number; code: string; name: string }>(
    productsResult.data!.map((p: any) => [normalizeCode(p.code), p]),
  )

  const formIdsByBranch = new Map<number, number[]>()
  for (const form of formsResult.data || []) {
    for (const link of form.form_branches || []) {
      if (!formIdsByBranch.has(link.branch_id)) formIdsByBranch.set(link.branch_id, [])
      formIdsByBranch.get(link.branch_id)!.push(form.id)
    }
  }

  const invoices: Array<{ name: string; text: string }> = Array.isArray(body.files) ? body.files : []
  const results = []

  for (const invoice of invoices) {
    const text = String(invoice.text || '')
    const branch = detectBranch(text, branches)
    const codes = applyInjectionRules(extractProductCodes(text))
    const matchedCodes = codes.filter((c) => productByCode.has(c))
    const unknownCodes = codes.filter((c) => !productByCode.has(c))

    const { data: invoiceRow, error: invoiceError } = await db
      .from('invoice_files')
      .insert({
        daily_run_id: run.id,
        file_name: invoice.name || 'invoice.pdf',
        detected_branch_id: branch?.id ?? null,
        detected_branch_text: branch?.name ?? null,
        extracted_code_count: codes.length,
        matched_code_count: matchedCodes.length,
        unknown_code_count: unknownCodes.length,
        status: branch ? 'processed' : 'branch_not_found',
      })
      .select()
      .single()
    if (invoiceError) throw invoiceError

    const codeRows = codes.map((code) => ({
      invoice_file_id: invoiceRow.id,
      product_code: code,
      normalized_code: code,
      matched_product_id: productByCode.get(code)?.id ?? null,
    }))
    if (codeRows.length) {
      const { error } = await db.from('invoice_codes').insert(codeRows)
      if (error) throw error
    }

    if (branch && matchedCodes.length && formIdsByBranch.has(branch.id)) {
      const checkRows: any[] = []
      for (const code of matchedCodes) {
        for (const formId of formIdsByBranch.get(branch.id)!) {
          checkRows.push({
            daily_run_id: run.id,
            form_id: formId,
            branch_id: branch.id,
            product_id: productByCode.get(code)!.id,
            checked: true,
            source_invoice_id: invoiceRow.id,
          })
        }
      }
      if (checkRows.length) {
        const { error } = await db
          .from('daily_checks')
          .upsert(checkRows, { onConflict: 'daily_run_id,form_id,branch_id,product_id' })
        if (error) throw error
      }
    }

    results.push({
      file: invoice.name,
      success: true,
      branch: branch ? `${branch.code} (${branch.name})` : null,
      matchedCodes,
      unknownCodes,
      updated: matchedCodes.length,
      forms: branch ? formIdsByBranch.get(branch.id) || [] : [],
    })
  }

  return jsonResponse({ success: true, date: runDate, totalFiles: invoices.length, results })
}

async function handleGetForm(body: any) {
  const date = body.date || todayISO()
  const run = await ensureDailyRun(date)
  const formId = Number(body.id)

  const { data: form, error: formError } = await db
    .from('forms')
    .select('id, form_no, name, form_branches(branch_id, display_order, branches(id, code, name))')
    .eq('id', formId)
    .single()
  if (formError) throw formError

  const { data: formProducts, error: fpError } = await db
    .from('form_products')
    .select('row_order, products(id, code, name, group_id, product_dates(production_date, expiry_date, notes))')
    .eq('form_id', formId)
    .order('row_order')
  if (fpError) throw fpError

  const { data: checks, error: checksError } = await db
    .from('daily_checks')
    .select('branch_id, product_id, checked')
    .eq('daily_run_id', run.id)
    .eq('form_id', formId)
  if (checksError) throw checksError

  const checkedSet = new Set(
    (checks || []).filter((c) => c.checked).map((c) => `${c.branch_id}:${c.product_id}`),
  )

  const products = (formProducts || []).map((row: any) => ({
    row_order: row.row_order,
    ...row.products,
    checks: Object.fromEntries(
      (form.form_branches || []).map((link: any) => [
        link.branch_id,
        checkedSet.has(`${link.branch_id}:${row.products.id}`),
      ]),
    ),
  }))

  return jsonResponse({ success: true, form, products, date })
}

async function handleResetDay(body: any) {
  const date = body.date || todayISO()
  const run = await ensureDailyRun(date)
  const { error } = await db.from('daily_checks').delete().eq('daily_run_id', run.id)
  if (error) throw error
  return jsonResponse({
    success: true,
    date,
    message: 'تم مسح علامات ✓ فقط. المنتجات والتواريخ والمجموعات لم تتأثر.',
  })
}

// -----------------------------------------------------------------------
// 9. Router
// -----------------------------------------------------------------------

async function route(action: string, body: any, request: Request): Promise<Response> {
  if (action === 'ping') return jsonResponse({ success: true, time: new Date().toISOString() })
  if (action === 'login') return handleLogin(body)

  // every other action requires a valid session token
  await verifySessionToken(request)

  switch (action) {
    case 'bootstrap':      return handleBootstrap()
    case 'date':           return handleSetDate(body)
    case 'groups':         return handleCreateGroup(body)
    case 'products':       return handleCreateProduct(body)
    case 'dates-group':    return handleUpdateGroupDates(body)
    case 'dates-product':  return handleUpdateProductDate(body)
    case 'invoices':       return handleProcessInvoices(body)
    case 'form':           return handleGetForm(body)
    case 'reset':          return handleResetDay(body)
    default:
      return jsonResponse({ success: false, message: 'إجراء غير معروف.' }, 400)
  }
}

// -----------------------------------------------------------------------
// 10. Entry point
// -----------------------------------------------------------------------

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    const body = await request.json().catch(() => ({}))
    const action = String(body?.action || '')
    return await route(action, body, request)
  } catch (error: any) {
    if (error instanceof ApiError) {
      const message = error.status === 401 ? 'انتهت الجلسة أو رمز الدخول غير صالح.' : error.message
      return jsonResponse({ success: false, message }, error.status)
    }
    console.error(error)
    return jsonResponse({ success: false, message: error?.message || 'حدث خطأ غير متوقع.' }, 500)
  }
})
