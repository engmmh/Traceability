require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 100 } });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const APP_PASSWORD = process.env.APP_PASSWORD;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET || !APP_PASSWORD) {
  console.error('Missing required environment variables. Check .env.example.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}
function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function formatDMY(date) {
  const [y,m,d] = String(date).split('-');
  return `${d}/${m}/${y}`;
}
function auth(req,res,next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ success:false, message:'انتهت الجلسة أو رمز الدخول غير صالح.' }); }
}
async function ensureRun(runDate) {
  const { data, error } = await supabase.from('daily_runs').upsert({ run_date: runDate }, { onConflict:'run_date' }).select('id,run_date').single();
  if (error) throw error;
  return data;
}
async function first(query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

app.post('/api/login', (req,res) => {
  if (req.body?.password !== APP_PASSWORD) return res.status(401).json({ success:false, message:'❌ الرقم السري غير صحيح.' });
  const token = jwt.sign({ role:'admin' }, JWT_SECRET, { expiresIn:'12h' });
  res.json({ success:true, token });
});

app.get('/api/bootstrap', auth, async (req,res) => {
  try {
    const [branches, forms, groups, products] = await Promise.all([
      supabase.from('branches').select('*').eq('active',true).order('name'),
      supabase.from('forms').select('id,form_no,name,active,form_branches(branch_id,display_order,branches(id,code,name))').eq('active',true).order('form_no'),
      supabase.from('product_groups').select('*').eq('active',true).order('name'),
      supabase.from('products').select('id,code,name,group_id,default_shelf_life_days,active,notes,product_dates(production_date,expiry_date,notes)').eq('active',true).order('name')
    ]);
    for (const r of [branches,forms,groups,products]) if (r.error) throw r.error;
    res.json({ success:true, branches:branches.data, forms:forms.data, groups:groups.data, products:products.data });
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

app.post('/api/date', auth, async (req,res) => {
  try {
    const date = req.body?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({success:false,message:'اختر تاريخًا صحيحًا.'});
    await ensureRun(date);
    res.json({success:true,date,display:`Date : ${formatDMY(date)}`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

app.post('/api/groups', auth, async (req,res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const code = String(req.body?.code || '').trim() || null;
    if (!name) return res.status(400).json({success:false,message:'اسم المجموعة مطلوب.'});
    const {data,error} = await supabase.from('product_groups').insert({name,code,notes:req.body?.notes || null}).select().single();
    if (error) throw error;
    res.json({success:true,group:data});
  } catch(e) { res.status(400).json({success:false,message:e.message}); }
});

app.post('/api/products', auth, async (req,res) => {
  try {
    const code = normalizeCode(req.body?.code);
    const name = String(req.body?.name || '').trim();
    if (!code || !name) return res.status(400).json({success:false,message:'كود المنتج واسم المنتج مطلوبان.'});
    const payload = { code, name, group_id:req.body?.group_id || null, default_shelf_life_days:req.body?.default_shelf_life_days || null, notes:req.body?.notes || null };
    const {data,error} = await supabase.from('products').insert(payload).select().single();
    if (error) throw error;
    res.json({success:true,product:data});
  } catch(e) { res.status(400).json({success:false,message:e.message}); }
});

app.post('/api/dates/group', auth, async (req,res) => {
  try {
    const { group_id, production_date, expiry_date, notes } = req.body || {};
    if (!group_id) return res.status(400).json({success:false,message:'اختر المجموعة.'});
    const {data:products,error:pErr} = await supabase.from('products').select('id').eq('group_id',group_id).eq('active',true);
    if (pErr) throw pErr;
    const rows = products.map(p=>({product_id:p.id,production_date:production_date||null,expiry_date:expiry_date||null,notes:notes||null,updated_at:new Date().toISOString()}));
    if (rows.length) { const {error} = await supabase.from('product_dates').upsert(rows,{onConflict:'product_id'}); if(error) throw error; }
    res.json({success:true,updated:rows.length});
  } catch(e) { res.status(400).json({success:false,message:e.message}); }
});

app.post('/api/dates/product', auth, async (req,res) => {
  try {
    const {product_id,production_date,expiry_date,notes} = req.body || {};
    if (!product_id) return res.status(400).json({success:false,message:'اختر المنتج.'});
    const {error} = await supabase.from('product_dates').upsert({product_id,production_date:production_date||null,expiry_date:expiry_date||null,notes:notes||null,updated_at:new Date().toISOString()},{onConflict:'product_id'});
    if(error) throw error;
    res.json({success:true});
  } catch(e) { res.status(400).json({success:false,message:e.message}); }
});

function detectBranch(text, branches) {
  const upper = normalizeText(text);
  if (upper.includes('AT TAAWUN') || upper.includes('AT TAAWUN')) return branches.find(b => b.code === 'TAAWUN' || b.name.toUpperCase().includes('TAAWUN')) || { code:'TAAWUN', name:'At Taawun' };
  for (const b of branches) {
    const candidates = [b.code,b.name,...(b.aliases||[])].filter(Boolean).map(normalizeText);
    if (candidates.some(c => c && upper.includes(c))) return b;
  }
  const m = text.match(/(?:BR[-\\\/]?\s*|B\s*)(\d+)/i) || text.match(/\bفرع\s*(\d+)\b/i);
  if (m) {
    const n = String(parseInt(m[1],10));
    return branches.find(b => { const x=(b.code.match(/\d+/)||[])[0]; return x && String(parseInt(x,10))===n; }) || null;
  }
  return null;
}
function extractProductCodes(text) {
  const matches = text.match(/\b\d{7}\b|\bsk-[\w\d.-]+/gi) || [];
  return [...new Set(matches.map(normalizeCode))];
}
function injectedCodes(codes) {
  const out = new Set(codes);
  for (const c of codes) {
    if (c.includes('8000855')) { out.add('6000740'); out.add('6000742'); }
    if (c.includes('8000854')) { out.add('6000741'); out.add('6000742'); }
  }
  return [...out];
}

app.post('/api/invoices', auth, upload.array('files',100), async (req,res) => {
  try {
    const runDate = req.body?.date || todayISO();
    const run = await ensureRun(runDate);
    const {data:branches,error:bErr} = await supabase.from('branches').select('*').eq('active',true);
    if (bErr) throw bErr;
    const {data:products,error:pErr} = await supabase.from('products').select('id,code,name').eq('active',true);
    if (pErr) throw pErr;
    const productByCode = new Map(products.map(p=>[normalizeCode(p.code),p]));
    const {data:forms,error:fErr} = await supabase.from('forms').select('id,form_no,form_branches(branch_id)');
    if (fErr) throw fErr;
    const formIdsByBranch = new Map();
    for (const f of forms) for (const fb of (f.form_branches||[])) {
      if (!formIdsByBranch.has(fb.branch_id)) formIdsByBranch.set(fb.branch_id,[]);
      formIdsByBranch.get(fb.branch_id).push(f.id);
    }
    const results=[];
    for (const file of (req.files||[])) {
      let text='';
      try { text=(await pdfParse(file.buffer)).text || ''; } catch(e) {
        results.push({file:file.originalname,success:false,error:'تعذر قراءة PDF كنص. إذا كان الملف صورة/مسح ضوئيًا سنضيف OCR في المرحلة التالية.'});
        continue;
      }
      const branch = detectBranch(text,branches);
      const rawCodes = extractProductCodes(text);
      const codes = injectedCodes(rawCodes);
      const unknown = codes.filter(c=>!productByCode.has(c));
      const matched = codes.filter(c=>productByCode.has(c));
      const {data:invoice,error:iErr} = await supabase.from('invoice_files').insert({daily_run_id:run.id,file_name:file.originalname,detected_branch_id:branch?.id||null,detected_branch_text:branch?.name||null,extracted_code_count:codes.length,matched_code_count:matched.length,unknown_code_count:unknown.length,status:branch?'processed':'branch_not_found'}).select().single();
      if(iErr) throw iErr;
      const invoiceRows = codes.map(c=>({invoice_file_id:invoice.id,product_code:c,normalized_code:c,matched_product_id:productByCode.get(c)?.id||null}));
      if(invoiceRows.length) { const {error} = await supabase.from('invoice_codes').insert(invoiceRows); if(error) throw error; }
      if(branch && matched.length && formIdsByBranch.has(branch.id)) {
        const formIds=formIdsByBranch.get(branch.id);
        const rows=[];
        for(const c of matched) for(const formId of formIds) rows.push({daily_run_id:run.id,form_id:formId,branch_id:branch.id,product_id:productByCode.get(c).id,checked:true,source_invoice_id:invoice.id});
        if(rows.length) { const {error} = await supabase.from('daily_checks').upsert(rows,{onConflict:'daily_run_id,form_id,branch_id,product_id'}); if(error) throw error; }
      }
      results.push({file:file.originalname,success:true,branch:branch?`${branch.code} (${branch.name})`:null,matchedCodes:matched,unknownCodes:unknown,updated:matched.length,forms:branch?formIdsByBranch.get(branch.id)||[]:[]});
    }
    res.json({success:true,date:runDate,totalFiles:(req.files||[]).length,results});
  } catch(e) { console.error(e); res.status(500).json({success:false,message:e.message}); }
});

app.get('/api/forms/:id', auth, async (req,res) => {
  try {
    const date = req.query.date || todayISO();
    const run = await ensureRun(date);
    const formId = Number(req.params.id);
    const {data:form,error:fErr} = await supabase.from('forms').select('id,form_no,name,form_branches(branch_id,display_order,branches(id,code,name))').eq('id',formId).single();
    if(fErr) throw fErr;
    const {data:fp,error:pErr} = await supabase.from('form_products').select('row_order,products(id,code,name,group_id,product_dates(production_date,expiry_date,notes))').eq('form_id',formId).order('row_order');
    if(pErr) throw pErr;
    const {data:checks,error:cErr} = await supabase.from('daily_checks').select('branch_id,product_id,checked').eq('daily_run_id',run.id).eq('form_id',formId);
    if(cErr) throw cErr;
    const checkSet = new Set((checks||[]).filter(x=>x.checked).map(x=>`${x.branch_id}:${x.product_id}`));
    const products=(fp||[]).map(x=>({row_order:x.row_order,...x.products,checks:Object.fromEntries((form.form_branches||[]).map(fb=>[fb.branch_id,checkSet.has(`${fb.branch_id}:${x.products.id}`)]))}));
    res.json({success:true,form,products,date});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

app.post('/api/reset', auth, async (req,res) => {
  try {
    const date=req.body?.date || todayISO();
    const run=await ensureRun(date);
    const {error}=await supabase.from('daily_checks').delete().eq('daily_run_id',run.id);
    if(error) throw error;
    res.json({success:true,date,message:'تم مسح علامات ✓ فقط. المنتجات والتواريخ والمجموعات لم تتأثر.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

app.use((req,res,next)=>{
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(require('path').join(__dirname,'public','index.html'));
  next();
});

app.listen(PORT,()=>console.log(`UFUQ inspection server listening on ${PORT}`));
