require('dotenv').config();
const express=require('express'),cookieParser=require('cookie-parser'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),path=require('path');
const {createClient}=require('@supabase/supabase-js');
const crypto=require('crypto');
const multer=require('multer'),unzipper=require('unzipper');
const app=express();
app.set('trust proxy',1);
app.use(express.json({limit:'60mb'})); app.use(cookieParser()); app.use(express.static('public'));

const AI_MAX_CONCURRENCY=Math.max(1,Math.min(4,Number(process.env.AI_MAX_CONCURRENCY||2)));
const AI_QUEUE_MAX=Math.max(5,Math.min(100,Number(process.env.AI_QUEUE_MAX||30)));
const AI_REQUEST_WINDOW_MS=10*60*1000;
const AI_USER_LIMITS={chat:30,tutor:20,study_pack:4,youtube_transcript:4};
const aiWaiters=[],aiActive=new Set(),aiUserUsage=new Map();
let aiRunning=0;
function pruneAiUsage(now=Date.now()){
  for(const [key,times] of aiUserUsage){const fresh=times.filter(t=>now-t<AI_REQUEST_WINDOW_MS);if(fresh.length)aiUserUsage.set(key,fresh);else aiUserUsage.delete(key)}
}
function checkAiUserLimit(userId,kind){
  if(!userId)return {ok:true};
  pruneAiUsage();
  const key=String(userId)+':'+kind, times=aiUserUsage.get(key)||[], limit=AI_USER_LIMITS[kind]||20;
  if(times.length>=limit){const retry=Math.max(1,Math.ceil((AI_REQUEST_WINDOW_MS-(Date.now()-times[0]))/60000));return {ok:false,retryMinutes:retry}}
  times.push(Date.now());aiUserUsage.set(key,times);return {ok:true};
}
async function withAiSlot(task){
  if(aiRunning>=AI_MAX_CONCURRENCY&&aiWaiters.length>=AI_QUEUE_MAX)throw Error('AI is busy right now. Please try again in a few minutes.');
  return new Promise((resolve,reject)=>{
    const run=async()=>{aiRunning++;try{resolve(await task())}catch(e){reject(e)}finally{aiRunning--;pumpAiQueue()}};
    aiWaiters.push(run);pumpAiQueue();
  });
}
function pumpAiQueue(){while(aiRunning<AI_MAX_CONCURRENCY&&aiWaiters.length)aiWaiters.shift()()}

const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
const SECRET=process.env.JWT_SECRET, PRICE=Number(process.env.SUBSCRIPTION_PRICE||800), PAYNO=process.env.PAYMENT_NUMBER||'0736501740';
const OPENAI_KEY=process.env.OPENAI_API_KEY||'', GEMINI_KEY=process.env.GEMINI_API_KEY||'', AI_MODEL=process.env.GEMINI_MODEL||'gemini-3.5-flash-lite', AI_FALLBACK_MODEL=process.env.GEMINI_FALLBACK_MODEL||'gemini-3.6-flash', YT_KEY=process.env.YOUTUBE_API_KEY||'';
const WHATSAPP_TOKEN=process.env.WHATSAPP_ACCESS_TOKEN||'', WHATSAPP_PHONE_ID=process.env.WHATSAPP_PHONE_NUMBER_ID||'', WHATSAPP_TO=String(process.env.WHATSAPP_ADMIN_TO||'').replace(/\s+/g,'').replace(/^\+254/,'254').replace(/^0/,'254'), WHATSAPP_API_VERSION=process.env.WHATSAPP_API_VERSION||'v25.0', WHATSAPP_TEMPLATE=process.env.WHATSAPP_TEMPLATE_NAME||'medstudy_subscription_pending', WHATSAPP_TEMPLATE_LANG=process.env.WHATSAPP_TEMPLATE_LANG||'en_US';
const TELEGRAM_TOKEN=process.env.TELEGRAM_BOT_TOKEN||'', TELEGRAM_CHAT_ID=String(process.env.TELEGRAM_CHAT_ID||'').trim();
const phone=v=>String(v||'').replace(/\s+/g,'').replace(/^\+254/,'0');
const safe=u=>({id:u.id,email:u.email,phone:u.phone,role:u.role,subscription_status:u.subscription_status,subscription_started_at:u.subscription_started_at,subscription_ends_at:u.subscription_ends_at,created_at:u.created_at});
async function session(res,u,deviceId,req){let did=String(deviceId||'').trim();if(!/^[A-Za-z0-9._:-]{16,200}$/.test(did))throw Error('A valid device identifier is required.');let active=await db.from('device_sessions').select('id,device_id').eq('user_id',u.id).gt('expires_at',new Date().toISOString());if(active.error)throw Error(active.error.message);let same=(active.data||[]).find(x=>x.device_id===did);if(!same&&(active.data||[]).length>=2)throw Error('This account is already active on two devices. Sign out from one device before signing in here.');await db.from('device_sessions').delete().eq('user_id',u.id).eq('device_id',did);let sid=crypto.randomUUID(),expiresAt=new Date(Date.now()+604800000).toISOString();let ins=await db.from('device_sessions').insert({id:sid,user_id:u.id,device_id:did,expires_at:expiresAt,user_agent:String(req.headers['user-agent']||'').slice(0,500)});if(ins.error)throw Error(ins.error.message);let token=jwt.sign({sub:u.id,role:u.role,sid},SECRET,{expiresIn:'7d'});res.cookie('medstudy_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:604800000});}
const lastSeenCache=new Map();
async function user(req){try{let t=req.cookies.medstudy_session;if(!t)return null;let p=jwt.verify(t,SECRET);if(!p.sid)return null;let sess=await db.from('device_sessions').select('id,user_id,device_id,expires_at').eq('id',p.sid).eq('user_id',p.sub).gt('expires_at',new Date().toISOString()).maybeSingle();if(sess.error||!sess.data)return null;let did=String(req.headers['x-device-id']||'').trim();if(!did||did!==sess.data.device_id)return null;let {data}=await db.from('app_users').select('id,email,phone,role,subscription_status,subscription_started_at,subscription_ends_at,created_at').eq('id',p.sub).single();if(!data)return null;if(data.role!=='developer'&&data.subscription_status==='active'&&data.subscription_ends_at&&new Date(data.subscription_ends_at)<=new Date()){await db.from('app_users').update({subscription_status:'locked',updated_at:new Date().toISOString()}).eq('id',data.id);data.subscription_status='locked';}const now=Date.now(),seen=lastSeenCache.get(p.sid)||0;if(now-seen>300000){lastSeenCache.set(p.sid,now);db.from('device_sessions').update({last_seen_at:new Date(now).toISOString()}).eq('id',p.sid).then(()=>{},()=>{})}return data}catch{return null}}
const auth=async(req,res,next)=>{req.user=await user(req);if(!req.user)return res.status(401).json({error:'Sign in required'});next()};
const access=async(req,res,next)=>{req.user=await user(req);if(!req.user)return res.status(401).json({error:'Sign in required'});if(req.user.role!=='developer'&&(req.user.subscription_status!=='active'||!req.user.subscription_ends_at||new Date(req.user.subscription_ends_at)<=new Date()))return res.status(402).json({error:'Your subscription has expired. Please renew your KSh 800 subscription.'});next()};
const admin=async(req,res,next)=>{req.user=await user(req);if(!req.user||req.user.role!=='developer')return res.status(403).json({error:'Developer access only'});next()};
app.get('/health',(q,s)=>s.status(200).json({status:'healthy',uptime:Math.round(process.uptime()),ai:{active:aiRunning,queued:aiWaiters.length,limit:AI_MAX_CONCURRENCY}}));
app.get('/api/config',(q,s)=>s.json({price:PRICE,paymentNumber:PAYNO,aiConfigured:!!GEMINI_KEY,aiProvider:'Gemini free tier',aiModel:AI_MODEL,youtubeSearchConfigured:!!YT_KEY,whatsappConfigured:!!(WHATSAPP_TOKEN&&WHATSAPP_PHONE_ID&&WHATSAPP_TO),telegramConfigured:!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)}));
app.post('/api/auth/signup',async(req,res)=>{let email=String(req.body.email||'').trim().toLowerCase()||null,ph=phone(req.body.phone)||null,p=String(req.body.password||'');if(!email&&!ph)return res.status(400).json({error:'Email or phone required'});if(p.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});let filters=[];if(email)filters.push('email.eq.'+email);if(ph)filters.push('phone.eq.'+ph);let q=await db.from('app_users').select('id').or(filters.join(','));if(q.data&&q.data.length)return res.status(409).json({error:'Account already exists'});let h=await bcrypt.hash(p,12),r=await db.from('app_users').insert({email,phone:ph,password_hash:h}).select('id,email,phone,role,subscription_status,subscription_started_at,subscription_ends_at,created_at').single();if(r.error)return res.status(500).json({error:r.error.message});try{await session(res,r.data,req.headers['x-device-id'],req)}catch(e){await db.from('app_users').delete().eq('id',r.data.id);return res.status(409).json({error:e.message})}res.json({user:safe(r.data)})});
app.post('/api/auth/login',async(req,res)=>{let id=String(req.body.identity||'').trim(),em=id.toLowerCase(),ph=phone(id),filters=['email.eq.'+em,'phone.eq.'+ph],q=await db.from('app_users').select('*').or(filters.join(',')).limit(1).maybeSingle();if(q.error||!q.data||!(await bcrypt.compare(String(req.body.password||''),q.data.password_hash)))return res.status(401).json({error:'Incorrect sign-in details'});if(q.data.role!=='developer'&&q.data.subscription_status==='active'&&q.data.subscription_ends_at&&new Date(q.data.subscription_ends_at)<=new Date()){await db.from('app_users').update({subscription_status:'locked',updated_at:new Date().toISOString()}).eq('id',q.data.id);q.data.subscription_status='locked'}try{await session(res,q.data,req.headers['x-device-id'],req)}catch(e){return res.status(409).json({error:e.message})}res.json({user:safe(q.data)})});
app.post('/api/auth/logout',async(q,s)=>{try{let t=q.cookies.medstudy_session;if(t){let p=jwt.verify(t,SECRET);if(p.sid)await db.from('device_sessions').delete().eq('id',p.sid)}}catch{}s.clearCookie('medstudy_session');s.json({ok:true})});
app.get('/api/me',async(q,s)=>s.json({user:await user(q)}));
app.get('/api/learner/preferences',auth,async(req,res)=>{let r=await db.from('learner_preferences').select('*').eq('user_id',req.user.id).maybeSingle();if(r.error)return res.status(500).json({error:r.error.message});if(!r.data){let x=await db.from('learner_preferences').insert({user_id:req.user.id}).select('*').single();return res.json({preferences:x.data})}res.json({preferences:r.data})});
app.post('/api/learner/preferences',auth,async(req,res)=>{let b=req.body,p={user_id:req.user.id,pace:String(b.pace||'balanced'),explanation_depth:String(b.explanation_depth||'moderate'),question_style:String(b.question_style||'mixed'),daily_goal_minutes:Math.max(5,Math.min(240,Number(b.daily_goal_minutes||30))),preferred_subjects:Array.isArray(b.preferred_subjects)?b.preferred_subjects:[],weak_topics:Array.isArray(b.weak_topics)?b.weak_topics:[],updated_at:new Date().toISOString()};let r=await db.from('learner_preferences').upsert(p,{onConflict:'user_id'}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{preferences:r.data})});
app.post('/api/ai/chat',access,async(req,res)=>{if(!GEMINI_KEY)return res.status(503).json({error:'Student AI tutor is not configured yet. Add a Gemini API key to the Railway service as GEMINI_API_KEY.'});let message=String(req.body.message||'').trim();if(!message)return res.status(400).json({error:'Message required'});let pref=await db.from('learner_preferences').select('*').eq('user_id',req.user.id).maybeSingle();let recent=await db.from('ai_chat_messages').select('role,content').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(12);let context='Learner preferences: '+JSON.stringify(pref.data||{})+'\\nRecent conversation: '+JSON.stringify((recent.data||[]).reverse());let resource=null;if(req.body.resourceId){let rr=await db.from('resources').select('id,title,subject,topic').eq('id',req.body.resourceId).maybeSingle();resource=rr.data||null}let system='You are MedStudy Space Learner Helper, a patient medical-study coach. Tailor explanations to the learner preferences. Teach, question, correct and encourage without doing the learner work for them. If a source resource is supplied, stay grounded in that resource and clearly say when information is outside it. Prefer concise explanations, clinical/anatomical examples when useful, active recall, and spaced review. Never claim certainty when the source is unclear. '+context+(resource?'\\nCurrent resource: '+JSON.stringify(resource):'');try{let answer=await ai(system+'\\n\\nSTUDENT MESSAGE:\\n'+message);await db.from('ai_chat_messages').insert([{user_id:req.user.id,resource_id:req.body.resourceId||null,role:'user',content:message},{user_id:req.user.id,resource_id:req.body.resourceId||null,role:'assistant',content:answer}]);await db.from('study_activity').insert({user_id:req.user.id,resource_id:req.body.resourceId||null,activity_type:'tutor_chat',metadata:{adaptive:true,provider:'gemini'}});res.json({answer})}catch(e){res.status(502).json({error:e.message})}});
app.get('/api/youtube/search',access,async(req,res)=>{if(!YT_KEY)return res.status(503).json({error:'YouTube search is not configured yet. Please add a YouTube Data API key in Railway.'});let q=String(req.query.q||'').trim();if(q.length<2)return res.status(400).json({error:'Enter at least 2 characters'});try{let uu=new URL('https://www.googleapis.com/youtube/v3/search');uu.searchParams.set('part','snippet');uu.searchParams.set('q',q);uu.searchParams.set('type','video');uu.searchParams.set('maxResults','20');uu.searchParams.set('regionCode','KE');uu.searchParams.set('key',YT_KEY);let rr=await fetch(uu);let dd=await rr.json().catch(()=>({}));if(!rr.ok){console.error('YouTube search HTTP '+rr.status,JSON.stringify(dd));return res.status(502).json({error:dd.error?.message||'YouTube search failed. Check that YouTube Data API v3 is enabled for the API key.'})}let items=(dd.items||[]).filter(x=>x.id?.videoId);res.json({results:items.map(x=>({id:x.id.videoId,title:x.snippet.title,channel:x.snippet.channelTitle,description:x.snippet.description,thumbnail:x.snippet.thumbnails?.medium?.url,url:'https://www.youtube.com/watch?v='+x.id.videoId,embeddable:true}))})}catch(err){console.error('YouTube search exception:',err.message);res.status(502).json({error:'YouTube search is temporarily unavailable. Please try again.'})}});
app.get('/api/topics',async(q,s)=>{let r=await db.from('anatomy_topics').select('*').order('sort_order');s.status(r.error?500:200).json(r.error?{error:r.error.message}:{topics:r.data})});
app.get('/api/subjects',async(q,s)=>{let r=await db.from('subjects').select('*').order('sort_order').order('name');s.status(r.error?500:200).json(r.error?{error:r.error.message}:{subjects:r.data})});
app.get('/api/subjects/:id/topics',async(q,s)=>{let r=await db.from('subject_topics').select('*').eq('subject_id',q.params.id).order('sort_order').order('name');s.status(r.error?500:200).json(r.error?{error:r.error.message}:{topics:r.data})});
app.get('/api/books',access,async(q,s)=>{let r=await db.from('book_references').select('*').order('title');s.status(r.error?500:200).json(r.error?{error:r.error.message}:{books:r.data})});

app.get('/api/resources',access,async(q,s)=>{let r=await db.from('resources').select('*').order('subject').order('topic').order('created_at');s.status(r.error?500:200).json(r.error?{error:r.error.message}:{resources:r.data})});
app.get('/api/notebooks',access,async(req,res)=>{let r=await db.from('resources').select('*').eq('created_by',req.user.id).eq('description','AI study notebook created from a public YouTube video.').order('created_at',{ascending:false});if(r.error)return res.status(500).json({error:r.error.message});let ids=(r.data||[]).map(x=>x.id),packs=[];if(ids.length){let p=await db.from('ai_study_packs').select('resource_id,updated_at').in('resource_id',ids);if(!p.error)packs=p.data||[]}let pm={};packs.forEach(p=>pm[p.resource_id]=p);res.json({notebooks:(r.data||[]).map(x=>({...x,packUpdatedAt:pm[x.id]?.updated_at||null}))})});
app.get('/api/resources/:id',access,async(req,res)=>{let r=await db.from('resources').select('*').eq('id',req.params.id).single();if(r.error)return res.status(404).json({error:'Lecture not found'});res.json({resource:r.data})});
async function notifyWhatsAppPending(p,user){if(!WHATSAPP_TOKEN||!WHATSAPP_PHONE_ID||!WHATSAPP_TO)return {ok:false,skipped:true};try{let endpoint='https://graph.facebook.com/'+WHATSAPP_API_VERSION+'/'+encodeURIComponent(WHATSAPP_PHONE_ID)+'/messages';let body={messaging_product:'whatsapp',to:WHATSAPP_TO,type:'template',template:{name:WHATSAPP_TEMPLATE,language:{code:WHATSAPP_TEMPLATE_LANG},components:[{type:'body',parameters:[{type:'text',text:String(user.email||user.phone||user.id)},{type:'text',text:String(user.phone||'')},{type:'text',text:'KSh '+PRICE},{type:'text',text:String(p.mpesa_code||'')}]}]}};let r=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+WHATSAPP_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error?.message||'WhatsApp notification failed');return {ok:true,id:d.messages?.[0]?.id||null}}catch(e){console.error('WhatsApp pending notification:',e.message);return {ok:false,error:e.message}}}
async function notifyTelegramPending(p,user){
  if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT_ID)return {ok:false,skipped:true};
  try{
    let text='🔔 New MedStudy Space payment\\n\\nStudent: '+(user.email||user.phone||user.id)+'\\nPhone: '+(user.phone||'')+'\\nAmount: KSh '+PRICE+'\\nM-Pesa code: '+(p.mpesa_code||'')+'\\n\\nOpen the Admin panel to approve or reject.';
    let r=await fetch('https://api.telegram.org/bot'+encodeURIComponent(TELEGRAM_TOKEN)+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text})});
    let d=await r.json().catch(()=>({}));
    if(!r.ok||!d.ok)throw Error(d.description||'Telegram notification failed');
    return {ok:true,id:d.result?.message_id||null}
  }catch(e){console.error('Telegram pending notification:',e.message);return {ok:false,error:e.message}}
}
app.post('/api/payments',auth,async(req,res)=>{
  if(req.user.role==='developer')return res.json({status:'active'});
  let code=String(req.body.mpesaCode||'').trim().toUpperCase();if(!/^[A-Z0-9]{8,20}$/.test(code))return res.status(400).json({error:'Enter your M-Pesa transaction code'});
  let x=await db.from('payments').select('id').eq('mpesa_code',code).maybeSingle();if(x.data)return res.status(409).json({error:'Code already submitted'});
  let r=await db.from('payments').insert({user_id:req.user.id,amount:PRICE,payment_number:PAYNO,mpesa_code:code}).select('id,status').single();if(r.error)return res.status(500).json({error:r.error.message});
  await db.from('app_users').update({subscription_status:'pending'}).eq('id',req.user.id);
  let tg=await notifyTelegramPending({mpesa_code:code},req.user);
  res.json({payment:r.data,telegramNotification:tg.ok?'sent':'not_sent'})
});
app.get('/api/admin/payments',admin,async(q,s)=>{let r=await db.from('payments').select('id,user_id,amount,payment_number,mpesa_code,status,created_at,verified_at,verified_by').order('created_at',{ascending:false});if(r.error)return s.status(500).json({error:r.error.message});let ids=[...new Set((r.data||[]).map(x=>x.user_id).filter(Boolean))];let users=ids.length?await db.from('app_users').select('id,email,phone,subscription_status,subscription_started_at,subscription_ends_at').in('id',ids):{data:[],error:null};if(users.error)return s.status(500).json({error:users.error.message});let byId=Object.fromEntries((users.data||[]).map(u=>[u.id,{email:u.email,phone:u.phone}]));s.json({payments:(r.data||[]).map(x=>({...x,app_users:byId[x.user_id]||null}))})});
app.post('/api/admin/payments/:id/:action',admin,async(req,res)=>{let action=req.params.action;if(!['approve','reject'].includes(action))return res.status(400).json({error:'Invalid action'});let p=await db.from('payments').select('*').eq('id',req.params.id).single();if(p.error)return res.status(404).json({error:'Payment not found'});let verifiedAt=new Date().toISOString();await db.from('payments').update({status:action==='approve'?'approved':'rejected',verified_at:verifiedAt,verified_by:req.user.id}).eq('id',p.data.id);if(action==='approve'){let d=new Date(verifiedAt);d.setMonth(d.getMonth()+6);await db.from('app_users').update({subscription_status:'active',subscription_started_at:verifiedAt,subscription_ends_at:d.toISOString(),updated_at:verifiedAt}).eq('id',p.data.user_id)}else{await db.from('app_users').update({subscription_status:'locked',updated_at:verifiedAt}).eq('id',p.data.user_id)}res.json({ok:true})});
app.post('/api/admin/subjects',admin,async(req,res)=>{let name=String(req.body.name||'').trim(),description=String(req.body.description||'').trim();if(!name)return res.status(400).json({error:'Subject name required'});let r=await db.from('subjects').insert({name,description}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{subject:r.data})});
app.post('/api/admin/subjects/:id/topics',admin,async(req,res)=>{let name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Topic name required'});let r=await db.from('subject_topics').insert({subject_id:req.params.id,name}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{topic:r.data})});
app.post('/api/admin/books',admin,async(req,res)=>{let b=req.body,title=String(b.title||'').trim(),url=String(b.url||'').trim();if(!title||!url)return res.status(400).json({error:'Book title and URL are required'});let r=await db.from('book_references').insert({title,authors:String(b.authors||'').trim()||null,edition:String(b.edition||'').trim()||null,url,notes:String(b.notes||'').trim()||null,subject_id:b.subject_id||null,topic_id:b.topic_id||null,created_by:req.user.id}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{book:r.data})});
app.post('/api/admin/topics',admin,async(req,res)=>{let name=String(req.body.name||'').trim(),group=String(req.body.group_name||'General anatomy').trim();if(!name)return res.status(400).json({error:'Name required'});let r=await db.from('anatomy_topics').insert({name,group_name:group}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{topic:r.data})});
app.post('/api/admin/resources',admin,async(req,res)=>{let b=req.body,title=String(b.title||'').trim(),url=String(b.url||'').trim();if(!title||!url)return res.status(400).json({error:'Title and URL are required'});let r=await db.from('resources').insert({kind:b.kind||'video',title,subject:String(b.subject||'Anatomy').trim(),topic:String(b.topic||'General anatomy').trim(),subject_id:b.subject_id||null,topic_id:b.topic_id||null,description:String(b.description||'').trim()||null,url,page:b.page||null,created_by:req.user.id}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{resource:r.data})});
async function ensureStorage(){try{let x=await db.storage.getBucket('medstudy-resources');let opts={public:false,fileSizeLimit:'100MB',allowedMimeTypes:['application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.oasis.opendocument.presentation','text/plain','audio/mpeg','audio/mp4','audio/wav','audio/x-m4a']};if(x.error)await db.storage.createBucket('medstudy-resources',opts);else await db.storage.updateBucket('medstudy-resources',opts)}catch(e){console.error('Storage setup:',e.message)}}
function safeName(v){return String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)}
app.post('/api/admin/resources/upload',admin,async(req,res)=>{let b=req.body,title=String(b.title||'').trim(),mime=String(b.mimeType||''),base=String(b.fileBase64||'').replace(/^data:[^,]+,/,'');if(!title||!mime||!base)return res.status(400).json({error:'Title, file type and file are required'});let allowed=['application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.oasis.opendocument.presentation'];if(!allowed.includes(mime))return res.status(400).json({error:'Only PDF, PPT, PPTX or ODP lecture files are supported'});let buf;try{buf=Buffer.from(base,'base64')}catch{return res.status(400).json({error:'Invalid file data'})}if(buf.length>40*1024*1024)return res.status(413).json({error:'File is too large. Maximum is 40 MB on this setup.'});let sid=b.subject_id||null,tid=b.topic_id||null,sub= sid?await db.from('subjects').select('name').eq('id',sid).single():{data:null},top=tid?await db.from('subject_topics').select('name').eq('id',tid).single():{data:null};let resource=await db.from('resources').insert({kind:'slides',title,subject:sub.data?.name||String(b.subject||'General'),topic:top.data?.name||String(b.topic||'General'),subject_id:sid,topic_id:tid,description:String(b.description||'').trim()||null,created_by:req.user.id}).select('*').single();if(resource.error)return res.status(400).json({error:resource.error.message});let pathKey='resources/'+resource.data.id+'/'+crypto.randomUUID()+'-'+safeName(b.fileName||'lecture.pdf');let up=await db.storage.from('medstudy-resources').upload(pathKey,buf,{contentType:mime,upsert:false});if(up.error){await db.from('resources').delete().eq('id',resource.data.id);return res.status(400).json({error:up.error.message})}let rf=await db.from('resource_files').insert({resource_id:resource.data.id,subject_id:sid,topic_id:tid,title,storage_path:pathKey,mime_type:mime,size_bytes:buf.length,created_by:req.user.id}).select('*').single();if(rf.error){await db.storage.from('medstudy-resources').remove([pathKey]);await db.from('resources').delete().eq('id',resource.data.id);return res.status(400).json({error:rf.error.message})}res.json({resource:resource.data,file:rf.data})});
const zipUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:260*1024*1024}});
function importSubjectName(root,path){let r=String(root||'').trim().replace(/[_-]+/g,' ').replace(/\\s+/g,' ');let u=r.toUpperCase();if(u==='BIOCHEMISTRY')return 'Biochemistry';if(u==='BEHAVIOURAL SCIENCE'||u==='BEHAVIORAL SCIENCE')return 'Behavioral Science';if(u==='DR BEDA SLIDES')return 'Anatomy';if(u==='MODULES')return /SOCIAL AND BEHAVIOURAL|SOCIAL AND BEHAVIORAL|BEHAVIOUR|BEHAVIOR|PSYCH|HEALTHCARE|ANTHROPOLOGY|SOCIOLOGY/i.test(path)?'Behavioral Science':'Behavioral Science';return r||'Imported Resources'}
async function ensureImportTopic(subjectName,topicName){let s=await db.from('subjects').select('id').eq('name',subjectName).maybeSingle();if(s.error)throw Error(s.error.message);let sid=s.data?.id;if(!sid){let ins=await db.from('subjects').insert({name:subjectName,description:'Imported course content.',sort_order:90}).select('id').single();if(ins.error)throw Error(ins.error.message);sid=ins.data.id}let clean=String(topicName||'General').replace(/\\+/g,'/').split('/').filter(Boolean).pop()||'General';let t=await db.from('subject_topics').select('id').eq('subject_id',sid).eq('name',clean).maybeSingle();if(t.error)throw Error(t.error.message);if(t.data)return {sid,tid:t.data.id,name:clean};let ins=await db.from('subject_topics').insert({subject_id:sid,name:clean}).select('id').single();if(ins.error)throw Error(ins.error.message);return {sid,tid:ins.data.id,name:clean}}
async function importZipFile(req,res){if(!req.file)return res.status(400).json({error:'ZIP file is required'});let archive;try{archive=await unzipper.Open.buffer(req.file.buffer)}catch(e){return res.status(400).json({error:'The uploaded ZIP could not be opened: '+e.message})}let imported=0,skipped=0,errors=[];for(const entry of archive.files){let path=String(entry.path||'').replace(/^\\/,'');if(entry.type!=='File'||!path||path.startsWith('__MACOSX/')||path.includes('/.')){skipped++;continue}let ext=path.toLowerCase().split('.').pop();let mimeMap={pdf:'application/pdf',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',odp:'application/vnd.oasis.opendocument.presentation'};if(!mimeMap[ext]){skipped++;continue}if(entry.uncompressedSize>100*1024*1024){errors.push(path+': file exceeds 100 MB');continue}let parts=path.split('/').filter(Boolean);let subject=importSubjectName(parts[0],path);if(!subject){skipped++;continue}let topic=parts.length>2?parts[1]:'General';let title=parts[parts.length-1].replace(/\\.[^.]+$/,'');try{let loc=await ensureImportTopic(subject,topic);let exists=await db.from('resources').select('id').eq('title',title).eq('subject',subject).eq('topic',loc.name).maybeSingle();if(exists.error)throw Error(exists.error.message);if(exists.data){skipped++;continue}let buf=await entry.buffer();let resource=await db.from('resources').insert({kind:'slides',title,subject,topic:loc.name,subject_id:loc.sid,topic_id:loc.tid,description:'Imported from '+req.file.originalname,created_by:req.user.id}).select('*').single();if(resource.error)throw Error(resource.error.message);let pathKey='resources/'+resource.data.id+'/'+crypto.randomUUID()+'-'+safeName(parts[parts.length-1]);let up=await db.storage.from('medstudy-resources').upload(pathKey,buf,{contentType:mimeMap[ext],upsert:false});if(up.error){await db.from('resources').delete().eq('id',resource.data.id);throw Error(up.error.message)}let rf=await db.from('resource_files').insert({resource_id:resource.data.id,subject_id:loc.sid,topic_id:loc.tid,title,storage_path:pathKey,mime_type:mimeMap[ext],size_bytes:buf.length,created_by:req.user.id}).select('*').single();if(rf.error){await db.storage.from('medstudy-resources').remove([pathKey]);await db.from('resources').delete().eq('id',resource.data.id);throw Error(rf.error.message)}if(ext==='pdf'){try{let parsed=await (await import('pdf-parse')).default(buf);if(parsed.text?.trim())await db.from('lecture_transcripts').insert({resource_id:resource.data.id,source:'imported-pdf',language:'en',transcript:parsed.text.trim()})}catch(e){errors.push(title+': PDF stored but text extraction failed')}}imported++}catch(e){errors.push(path+': '+e.message)}}res.json({ok:true,source:req.file.originalname,imported,skipped,errors})}
app.post('/api/admin/import-zip',admin,zipUpload.single('zip'),importZipFile);
app.get('/api/resources/:id/file-url',access,async(req,res)=>{let f=await db.from('resource_files').select('*').eq('resource_id',req.params.id).maybeSingle();if(f.error||!f.data)return res.status(404).json({error:'File not found'});let u=await db.storage.from('medstudy-resources').createSignedUrl(f.data.storage_path,3600);if(u.error)return res.status(500).json({error:u.error.message});res.json({url:u.data.signedUrl,file:f.data})});
function youtubeId(url){try{let u=new URL(url);if(u.hostname==='youtu.be')return u.pathname.slice(1).split('/')[0];if(u.hostname.includes('youtube.com')){if(u.pathname.startsWith('/embed/'))return u.pathname.split('/')[2];if(u.pathname.startsWith('/shorts/'))return u.pathname.split('/')[2];return u.searchParams.get('v')}}catch{}return null}
function extractText(node){
  if(!node)return '';
  if(typeof node==='string')return node;
  if(Array.isArray(node))return node.map(extractText).filter(Boolean).join('\n');
  if(typeof node==='object'){
    if(typeof node.text==='string')return node.text;
    if(typeof node.output_text==='string')return node.output_text;
    for(const k of ['content','parts','output','steps','candidates']){
      if(node[k]){const t=extractText(node[k]);if(t)return t}
    }
  }
  return '';
}
async function fetchTranscript(url){
  let id=youtubeId(url);
  if(!id)throw Error('This lecture does not have a supported YouTube video URL.');
  try{
    const mod=await import('youtube-transcript-plus');
    let last;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const result=await mod.fetchTranscript(id,{
          retries:1,
          retryDelay:800,
          userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36'
        });
        let text=result.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
        if(text.length>=50)return {text,language:result[0]?.lang||'en'};
        last=Error('No transcript was returned.');
      }catch(e){last=e}
      await new Promise(r=>setTimeout(r,1000*(attempt+1)));
    }
    throw last||Error('No transcript was returned.');
  }catch(e){
    throw Error('Could not fetch a YouTube transcript. The video may have captions disabled, or YouTube may be blocking transcript requests from the server.');
  }
}
async function geminiYouTubeTranscript(url,userId=null){
  const limit=checkAiUserLimit(userId,'youtube_transcript');if(!limit.ok)throw Error('AI transcription limit reached. Please try again in about '+limit.retryMinutes+' minute(s).');
  return withAiSlot(async()=>{
  if(!GEMINI_KEY)throw Error('AI is not configured. Add GEMINI_API_KEY to the Railway service variables.');
  let id=youtubeId(url);
  if(!id)throw Error('Paste a valid public YouTube video link.');
  let youtubeUrl='https://www.youtube.com/watch?v='+encodeURIComponent(id);
  let prompt='Create an accurate transcript of the spoken content in this public YouTube lecture. Preserve important medical terminology, punctuation and useful timestamps when available. Do not summarize or invent content. If a word is genuinely unclear, write [unclear]. Return only the transcript.';
  let models=[AI_MODEL,AI_FALLBACK_MODEL,'gemini-3.6-flash','gemini-3.5-flash'].filter((x,i,a)=>x&&a.indexOf(x)===i);
  let last='Gemini could not process this YouTube video.';
  for(const model of models){
    for(let attempt=0;attempt<2;attempt++){
      try{
        let rr=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-goog-api-key':GEMINI_KEY},
          body:JSON.stringify({
            model,
            input:[
              {type:'video',uri:youtubeUrl},
              {type:'text',text:prompt}
            ]
          })
        });
        let dd=await rr.json().catch(()=>({}));
        if(rr.ok){
          let text=String(dd.output_text||extractText(dd.steps)||extractText(dd)).trim();
          if(text.length>=50)return {text,model};
          last='Gemini returned an empty or very short transcript.';
          break;
        }
        last=dd.error?.message||('Gemini returned HTTP '+rr.status);
        console.error('Gemini YouTube HTTP '+rr.status+' using '+model+' attempt '+(attempt+1)+': '+last);
        if(rr.status===400||rr.status===401||rr.status===403||rr.status===404)break;
        if(rr.status!==429&&rr.status!==500&&rr.status!==502&&rr.status!==503&&rr.status!==504)break;
        await new Promise(r=>setTimeout(r,1500*(attempt+1)));
      }catch(e){
        last=e.message;
        console.error('Gemini YouTube '+model+' attempt '+(attempt+1)+': '+e.message);
        await new Promise(r=>setTimeout(r,1500*(attempt+1)));
      }
    }
  }
  throw Error(last);
  });
}
async function fetchJsonWithTimeout(url,options={},timeoutMs=90000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal})}
  catch(e){if(e.name==='AbortError')throw Error('The AI request timed out. Please try again.');throw e}
  finally{clearTimeout(timer)}
}
async function ai(prompt,userId=null,kind='chat'){
  const limit=checkAiUserLimit(userId,kind);if(!limit.ok)throw Error('AI request limit reached. Please try again in about '+limit.retryMinutes+' minute(s).');
  return withAiSlot(async()=>{
  if(!GEMINI_KEY)throw Error('Student AI tutor is not configured yet. Add GEMINI_API_KEY to the Railway service variables.');
  let models=[AI_MODEL,AI_FALLBACK_MODEL,'gemini-3.5-flash'].filter((x,i,a)=>x&&a.indexOf(x)===i),last='Gemini AI request failed';
  for(const model of models){
    try{
      let rr=await fetchJsonWithTimeout('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(GEMINI_KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:String(prompt)}]}]})});
      let dd=await rr.json().catch(()=>({}));
      if(rr.ok){let tt=extractText(dd.candidates?.[0]?.content||dd);if(tt)return tt.trim();last='Gemini returned an empty response'}
      else{last=dd.error?.message||('Gemini '+model+' returned HTTP '+rr.status);console.error('Gemini model '+model+' HTTP '+rr.status+': '+last);if(![429,500,502,503,504].includes(rr.status))break}
    }catch(err){last=err.message;console.error('Gemini model '+model+': '+err.message)}
  }
  throw Error('Student AI is temporarily busy. Please try again in a few seconds. '+last)
  });
}
const studyPackSchema={type:'object',properties:{overview:{type:'string'},objectives:{type:'array',items:{type:'string'}},notes:{type:'array',items:{type:'object',properties:{heading:{type:'string'},points:{type:'array',items:{type:'string'}}},required:['heading','points']}},key_structures:{type:'array',items:{type:'string'}},clinical_correlations:{type:'array',items:{type:'string'}},must_remember:{type:'array',items:{type:'string'}},summary:{type:'string'},questions:{type:'array',minItems:10,maxItems:10,items:{type:'object',properties:{type:{type:'string'},question:{type:'string'},options:{type:'array',minItems:4,maxItems:4,items:{type:'string'}},answer:{type:'integer',minimum:0,maximum:3},explanation:{type:'string'}},required:['type','question','options','answer','explanation']}},flashcards:{type:'array',minItems:12,maxItems:12,items:{type:'object',properties:{front:{type:'string'},back:{type:'string'}},required:['front','back']}}},required:['overview','objectives','notes','key_structures','clinical_correlations','must_remember','summary','questions','flashcards']};
async function aiJson(prompt,userId=null,kind='study_pack'){
  const limit=checkAiUserLimit(userId,kind);if(!limit.ok)throw Error('AI study-pack limit reached. Please try again in about '+limit.retryMinutes+' minute(s).');
  return withAiSlot(async()=>{
  if(!GEMINI_KEY)throw Error('Student AI tutor is not configured yet. Add GEMINI_API_KEY to the Railway service variables.');
  let models=[AI_MODEL,AI_FALLBACK_MODEL,'gemini-3.5-flash'].filter((x,i,a)=>x&&a.indexOf(x)===i),last='Gemini JSON generation failed';
  for(const model of models){
    try{
      let rr=await fetchJsonWithTimeout('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(GEMINI_KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:String(prompt)}]}],generationConfig:{responseMimeType:'application/json',responseSchema:studyPackSchema,temperature:0.2}})});
      let dd=await rr.json().catch(()=>({}));
      if(rr.ok){let raw=String(extractText(dd.candidates?.[0]?.content||dd)||'').trim();if(raw)return raw;last='Gemini returned an empty JSON response'}
      else{last=dd.error?.message||('Gemini '+model+' returned HTTP '+rr.status);console.error('Gemini JSON '+model+' HTTP '+rr.status+': '+last);if(![429,500,502,503,504].includes(rr.status))break}
    }catch(err){last=err.message;console.error('Gemini JSON '+model+': '+err.message)}
  }
  throw Error('Study-pack AI is temporarily busy. Please try again later. '+last)
  });
}
function cleanJson(t){
  let x=String(t||'').replace(/^\uFEFF/,'').trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  let start=-1,depth=0,inString=false,escaped=false;
  for(let i=0;i<x.length;i++){let ch=x[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}if(ch==='{'||ch==='['){if(start<0)start=i;depth++}else if(ch==='}'||ch===']'){if(start>=0){depth--;if(depth===0)return x.slice(start,i+1)}}}
  return x
}
function parseStudyPack(raw){
  let text=cleanJson(raw),attempts=[text,text.replace(/,\s*([}\]])/g,'$1'),text.replace(/([,{]\s*)([A-Za-z_$][\w$-]*)\s*:/g,'$1"$2":').replace(/,\s*([}\]])/g,'$1')];
  for(const candidate of attempts){try{return JSON.parse(candidate)}catch(e){}}
  throw Error('The AI returned an invalid study-pack format. Please try generating the notebook again.')
}
function normalizeStudyPack(pack){
  if(!pack||typeof pack!=='object')throw Error('The AI returned an empty study pack.');
  let qs=Array.isArray(pack.questions)?pack.questions:[],fs=Array.isArray(pack.flashcards)?pack.flashcards:[];
  if(qs.length!==10||fs.length!==12)throw Error('The AI returned an incomplete study pack. Please try generating the notebook again.');
  pack.questions=qs.map((q,i)=>({type:'mcq',question:String(q.question||('Question '+(i+1))),options:Array.isArray(q.options)?q.options.slice(0,4).map(String):[],answer:Number.isInteger(q.answer)?q.answer:0,explanation:String(q.explanation||'')}));
  pack.flashcards=fs.map(f=>({front:String(f.front||''),back:String(f.back||'')}));
  if(pack.questions.some(q=>q.options.length!==4||q.answer<0||q.answer>3))throw Error('The AI returned an invalid MCQ set. Please try generating the notebook again.');
  return pack
}
async function getTranscriptFor(resource,allowManual=true){let c=await db.from('lecture_transcripts').select('*').eq('resource_id',resource.id).maybeSingle();if(c.data)return c.data;if(!allowManual)throw Error('No transcript available for this lecture.');if(resource.kind==='slides'){let f=await db.from('resource_files').select('*').eq('resource_id',resource.id).maybeSingle();if(f.data&&f.data.mime_type==='application/pdf'){let file=await db.storage.from('medstudy-resources').download(f.data.storage_path);if(!file.error){try{const pdfParse=(await import('pdf-parse')).default;let parsed=await pdfParse(file.data);if(parsed.text?.trim()){let r=await db.from('lecture_transcripts').insert({resource_id:resource.id,source:'uploaded-pdf',language:'en',transcript:parsed.text}).select('*').single();if(r.error)throw Error(r.error.message);return r.data}}catch(e){throw Error('The PDF was uploaded, but its text could not be extracted: '+e.message)}}}}let tr;try{tr=await fetchTranscript(resource.url)}catch(primary){tr=await geminiYouTubeTranscript(resource.url,userId)}let r=await db.from('lecture_transcripts').insert({resource_id:resource.id,source:tr.model?'gemini-youtube-video':'youtube',language:tr.language||'en',transcript:tr.text}).select('*').single();if(r.error)throw Error(r.error.message);return r.data}
function studyMetaFromTitle(title){let t=String(title||'').replace(/\s+/g,' ').trim().replace(/^\s*(ANATOMY|ANATOMICAL|LECTURE|VIDEO)\s*[:\-–]\s*/i,'').replace(/\s+[-–]\s+BY\s+DR\.?\s+MITESH\s+DAVE.*$/i,'').replace(/\s+BY\s+DR\.?\s+MITESH\s+DAVE.*$/i,'').trim();let l=t.toLowerCase(),subject='Medical Studies';if(/embry|fertil|blast|cleavage|implant/.test(l))subject='Embryology';else if(/histolog|cell|tissue/.test(l))subject='Histology';else if(/physiolog/.test(l))subject='Physiology';else if(/biochem/.test(l))subject='Biochemistry';else if(/anatom|osteolog|dissection|viva|larynx|stomach|liver|intestin|spleen|kidney|heart|brain|lung|nerve|muscle|plexus/.test(l))subject='Anatomy';return {subject,topic:(t||'Imported lecture').slice(0,140)}}
async function getSavedStudyPack(resourceId){
  let r=await db.from('ai_study_packs').select('*').eq('resource_id',resourceId).maybeSingle();
  if(r.error)throw Error(r.error.message);
  return r.data||null;
}
async function generateOrReuseStudyPack(resource,userId){
  let saved=await getSavedStudyPack(resource.id);
  if(saved)return saved;
  const ownerJobId=crypto.randomUUID();
  let lock=await db.from('ai_generation_locks').insert({resource_id:resource.id,owner_job_id:ownerJobId,status:'working'}).select('*').single();
  if(lock.error){
    const started=Date.now();
    while(Date.now()-started<150000){
      saved=await getSavedStudyPack(resource.id);
      if(saved)return saved;
      let current=await db.from('ai_generation_locks').select('*').eq('resource_id',resource.id).maybeSingle();
      if(!current.data){
        lock=await db.from('ai_generation_locks').insert({resource_id:resource.id,owner_job_id:ownerJobId,status:'working'}).select('*').single();
        if(!lock.error)break;
      }else if(Date.now()-new Date(current.data.updated_at||current.data.created_at).getTime()>5*60*1000){
        await db.from('ai_generation_locks').delete().eq('resource_id',resource.id).eq('owner_job_id',current.data.owner_job_id);
      }
      await new Promise(r=>setTimeout(r,2000));
    }
    saved=await getSavedStudyPack(resource.id);
    if(saved)return saved;
    throw Error('This study pack is already being generated. Please wait a moment and open the notebook again.');
  }
  try{
    saved=await getSavedStudyPack(resource.id);
    if(saved)return saved;
    let tr=await getTranscriptFor(resource);
    let pack=await generatePack(resource,tr.transcript,userId);
    let r=await db.from('ai_study_packs').insert({resource_id:resource.id,notes:pack,questions:pack.questions||[],flashcards:pack.flashcards||[],model:AI_MODEL}).select('*').single();
    if(r.error){
      let existing=await getSavedStudyPack(resource.id);
      if(existing)return existing;
      throw Error(r.error.message);
    }
    return r.data;
  }finally{
    await db.from('ai_generation_locks').delete().eq('resource_id',resource.id).eq('owner_job_id',ownerJobId);
  }
}
async function generatePack(resource,transcript,userId=null){
  let source=String(transcript||'').trim();
  if(!source)throw Error('The lecture transcript is empty.');
  let prompt=['Create a complete medical study pack for the lecture titled "'+resource.title+'". Use ONLY information supported by the transcript below; do not invent facts. Preserve important medical terminology. Return JSON matching the requested schema. Make exactly 10 useful MCQs and exactly 12 flashcards. Each MCQ must have exactly 4 options and answer must be the zero-based correct option index. Make the notes comprehensive but concise. Prioritize high-yield anatomy, relationships, actions, innervation, blood supply, clinical correlations and exam-relevant facts only when the transcript actually covers them.','','LECTURE TRANSCRIPT:',source.slice(0,220000)].join('\n');
  return normalizeStudyPack(parseStudyPack(await aiJson(prompt,userId,'study_pack')));
}
const youtubeJobs=new Map();

async function processYoutubeNotebook(jobId,url,userId){
  const job=youtubeJobs.get(jobId);if(!job)return;
  try{
    job.status='working';job.message='Getting the lecture transcript…';
    let id=youtubeId(url),title='YouTube Lecture · '+id,meta=studyMetaFromTitle(title);
    try{let o=await fetchJsonWithTimeout('https://www.youtube.com/oembed?url='+encodeURIComponent(url)+'&format=json',{method:'GET'},20000);if(o.ok){let d=await o.json();if(d.title){title=String(d.title).slice(0,180);meta=studyMetaFromTitle(title)}}}catch{}
    let tr;
    try{tr=await fetchTranscript(url);job.message='Transcript found. Building your study pack…'}
    catch(primary){job.message='YouTube captions are unavailable. AI is transcribing the lecture now…';tr=await geminiYouTubeTranscript(url,userId)}
    let existing=await db.from('resources').select('*').eq('url',url).eq('created_by',userId).maybeSingle();if(existing.error)throw Error(existing.error.message);
    let resource;
    if(existing.data){resource=existing.data;let meta2=studyMetaFromTitle(resource.title||title);let upd=await db.from('resources').update({subject:meta2.subject,topic:meta2.topic}).eq('id',resource.id).select('*').single();if(!upd.error)resource=upd.data}
    else{let ins=await db.from('resources').insert({kind:'video',title,subject:meta.subject,topic:meta.topic,description:'AI study notebook created from a public YouTube video.',url,created_by:userId}).select('*').single();if(ins.error)throw Error(ins.error.message);resource=ins.data}
    if(!resource||!resource.id||!resource.kind)throw Error('The YouTube resource could not be created. Please try again.');
    let saved=await db.from('lecture_transcripts').upsert({resource_id:resource.id,source:tr.model?'gemini-youtube-video':'youtube',language:tr.language||'en',transcript:tr.text,updated_at:new Date().toISOString()},{onConflict:'resource_id'}).select('*').single();if(saved.error)throw Error(saved.error.message);
    job.transcript=saved.data;job.resource=resource;
    let existingPack=await db.from('ai_study_packs').select('*').eq('resource_id',resource.id).maybeSingle();if(existingPack.error)throw Error(existingPack.error.message);
    let pr;
    if(existingPack.data){pr={data:existingPack.data,error:null};job.message='Existing study pack found. Opening your saved notebook…'}
    else{job.message='Transcript ready. Generating notes, MCQs and flashcards…';let savedPack=await generateOrReuseStudyPack(resource,userId);pr={data:savedPack,error:null}}
    await db.from('study_activity').insert({user_id:userId,resource_id:resource.id,activity_type:'lecture_open',metadata:{source:'youtube-notebook',transcription_model:tr.model||'youtube'}});
    job.status='complete';job.message='Notebook ready.';job.pack=pr.data
  }catch(e){console.error('YouTube notebook:',e.message);job.status='error';job.message=e.message||'YouTube notebook generation failed.'}
  setTimeout(()=>youtubeJobs.delete(jobId),30*60*1000)
}
app.post('/api/youtube/notebook',access,async(req,res)=>{
  let url=String(req.body.url||'').trim();
  if(!youtubeId(url))return res.status(400).json({error:'Paste a valid public YouTube video link.'});
  let jobId=crypto.randomUUID();
  youtubeJobs.set(jobId,{userId:req.user.id,status:'queued',message:'Starting YouTube notebook…',createdAt:Date.now()});
  processYoutubeNotebook(jobId,url,req.user.id);
  res.status(202).json({jobId});
});

app.get('/api/youtube/notebook/:jobId',access,async(req,res)=>{
  let job=youtubeJobs.get(req.params.jobId);
  if(!job||job.userId!==req.user.id)return res.status(404).json({error:'Notebook job not found or expired.'});
  res.json({status:job.status,message:job.message,resource:job.resource||null,transcript:job.transcript||null,pack:job.pack||null});
});

app.post('/api/resources/:id/ai/generate',access,async(req,res)=>{
  let rr=await db.from('resources').select('*').eq('id',req.params.id).single();if(rr.error)return res.status(404).json({error:'Lecture not found'});
  try{let pack=await generateOrReuseStudyPack(rr.data,req.user.id);res.json({pack})}catch(e){res.status(400).json({error:e.message})}
});
app.get('/api/resources/:id/ai',access,async(req,res)=>{let r=await db.from('ai_study_packs').select('*').eq('resource_id',req.params.id).maybeSingle();res.json({pack:r.data||null})});
app.post('/api/resources/:id/transcribe-audio',admin,async(req,res)=>{if(!OPENAI_KEY)return res.status(503).json({error:'Voice transcription is not configured. Add OPENAI_API_KEY to the Railway service before using voice transcription.'});let mime=String(req.body.mimeType||''),base=String(req.body.fileBase64||'').replace(/^data:[^,]+,/,'');if(!base)return res.status(400).json({error:'Audio file is required'});let allowed=['audio/mpeg','audio/mp4','audio/wav','audio/x-m4a','audio/webm'];if(!allowed.includes(mime))return res.status(400).json({error:'Use MP3, M4A/MP4, WAV or WebM audio'});let buf=Buffer.from(base,'base64');if(buf.length>25*1024*1024)return res.status(413).json({error:'Audio is too large for this transcription upload. Use a shorter file or split the lecture into parts.'});let fd=new FormData();fd.append('model','gpt-4o-transcribe');fd.append('file',new Blob([buf],{type:mime}),safeName(req.body.fileName||'lecture-audio'));let rr=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+OPENAI_KEY},body:fd});let data=await rr.json().catch(()=>({}));if(!rr.ok)return res.status(400).json({error:data.error?.message||'Voice transcription failed'});let text=String(data.text||'').trim();if(text.length<50)return res.status(400).json({error:'The transcription was empty or too short'});let r=await db.from('lecture_transcripts').upsert({resource_id:req.params.id,source:'authorized-audio-asr',language:'en',transcript:text,updated_at:new Date().toISOString()},{onConflict:'resource_id'}).select('*').single();if(r.error)return res.status(400).json({error:r.error.message});res.json({transcript:r.data})});
app.post('/api/resources/:id/transcript',admin,async(req,res)=>{let text=String(req.body.transcript||'').trim();if(text.length<50)return res.status(400).json({error:'Transcript is too short'});let r=await db.from('lecture_transcripts').upsert({resource_id:req.params.id,source:'manual',language:String(req.body.language||'en'),transcript:text,updated_at:new Date().toISOString()},{onConflict:'resource_id'}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{transcript:r.data})});
app.post('/api/resources/:id/tutor',access,async(req,res)=>{let rr=await db.from('resources').select('*').eq('id',req.params.id).single();if(rr.error)return res.status(404).json({error:'Lecture not found'});let tr=await getTranscriptFor(rr.data),question=String(req.body.question||'').trim();if(!question)return res.status(400).json({error:'Ask a question first'});let context=tr.transcript.slice(0,60000);let answer=await ai(`You are a source-grounded anatomy tutor. Answer the student's question using ONLY the lecture transcript below. If the transcript does not support the answer, say that it is not covered in this lecture. Explain clearly at medical-student level and do not fabricate.\n\nQUESTION:\n${question}\n\nLECTURE TRANSCRIPT:\n${context}`,req.user.id,'tutor');await db.from('study_activity').insert({user_id:req.user.id,resource_id:rr.data.id,activity_type:'tutor_chat',metadata:{question}});res.json({answer})});
app.post('/api/activity',access,async(req,res)=>{let type=String(req.body.type||''),valid=['lecture_open','lecture_complete','notes_review','quiz_attempt','flashcard_review','tutor_chat','break_game'];if(!valid.includes(type))return res.status(400).json({error:'Invalid activity'});let r=await db.from('study_activity').insert({user_id:req.user.id,resource_id:req.body.resourceId||null,activity_type:type,metadata:req.body.metadata||{}}).select('id').single();res.status(r.error?400:200).json({ok:!r.error,id:r.data?.id})});
app.post('/api/quiz/attempt',access,async(req,res)=>{let total=Math.max(0,Number(req.body.total||0)),score=Math.max(0,Number(req.body.score||0)),answers=Array.isArray(req.body.answers)?req.body.answers:[];let r=await db.from('quiz_attempts').insert({user_id:req.user.id,resource_id:req.body.resourceId||null,total,score,answers}).select('id').single();if(r.error)return res.status(400).json({error:r.error.message});await db.from('study_activity').insert({user_id:req.user.id,resource_id:req.body.resourceId||null,activity_type:'quiz_attempt',metadata:{score,total}});res.json({ok:true,id:r.data.id})});
app.post('/api/notes',access,async(req,res)=>{let resourceId=req.body.resourceId,body=String(req.body.body||'');let r=await db.from('user_notes').upsert({user_id:req.user.id,resource_id:resourceId,body,updated_at:new Date().toISOString()},{onConflict:'user_id,resource_id'}).select('*').single();res.status(r.error?400:200).json(r.error?{error:r.error.message}:{note:r.data})});
app.get('/api/notes/:resourceId',access,async(req,res)=>{let r=await db.from('user_notes').select('*').eq('user_id',req.user.id).eq('resource_id',req.params.resourceId).maybeSingle();res.json({note:r.data||null})});
function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:process.env.APP_TIMEZONE||'Africa/Nairobi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function streakFromDates(dates){let set=new Set(dates),today=localDate(),d=new Date(today+'T00:00:00Z');let streak=0;for(let i=0;i<370;i++){let key=d.toISOString().slice(0,10);if(!set.has(key)){if(i===0){d.setUTCDate(d.getUTCDate()-1);continue}break}streak++;d.setUTCDate(d.getUTCDate()-1)}let longest=0,run=0,prev=null;for(const x of [...set].sort()){if(prev){let a=new Date(prev+'T00:00:00Z'),b=new Date(x+'T00:00:00Z');if((b-a)/86400000===1)run++;else run=1}else run=1;longest=Math.max(longest,run);prev=x}return {current:streak,longest}}
app.get('/api/progress',access,async(req,res)=>{let a=await db.from('study_activity').select('resource_id,activity_type,created_at,metadata').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(2000);let q=await db.from('quiz_attempts').select('resource_id,score,total,created_at').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(1000);let r=await db.from('resources').select('id,title,topic');let acts=a.data||[],qs=q.data||[],dates=[...new Set(acts.filter(x=>['lecture_open','lecture_complete','notes_review','quiz_attempt','flashcard_review','break_game'].includes(x.activity_type)).map(x=>new Date(x.created_at).toLocaleDateString('en-CA',{timeZone:process.env.APP_TIMEZONE||'Africa/Nairobi'})))];let st=streakFromDates(dates),completed=new Set(acts.filter(x=>x.activity_type==='lecture_complete').map(x=>x.resource_id)).size,totalQ=qs.reduce((n,x)=>n+(x.total||0),0),correct=qs.reduce((n,x)=>n+(x.score||0),0);let recent=acts.slice(0,12);res.json({streak:st,lecturesCompleted:completed,quizAnswered:totalQ,accuracy:totalQ?Math.round(correct/totalQ*100):0,activityCount:acts.length,recent,resources:r.data||[]})});
app.post('/api/games/score',access,async(req,res)=>{let game=String(req.body.game||'').slice(0,40),score=Math.max(0,Math.floor(Number(req.body.score||0))),duration=Math.max(1,Math.floor(Number(req.body.duration||60)));if(!game)return res.status(400).json({error:'Game required'});let r=await db.from('game_scores').insert({user_id:req.user.id,game,score,duration_seconds:duration}).select('*').single();await db.from('study_activity').insert({user_id:req.user.id,activity_type:'break_game',metadata:{game,score,duration}});res.status(r.error?400:200).json(r.error?{error:r.error.message}:{score:r.data})});
app.get('/api/games/scores',access,async(req,res)=>{let r=await db.from('game_scores').select('game,score,duration_seconds,created_at').eq('user_id',req.user.id).order('score',{ascending:false}).limit(20);res.json({scores:r.data||[]})});
async function ensureAdmin(){let e=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase(),p=String(process.env.ADMIN_PASSWORD||'');if(!e||!p)return;let q=await db.from('app_users').select('id').eq('email',e).maybeSingle();let h=await bcrypt.hash(p,12);if(q.data)await db.from('app_users').update({password_hash:h,role:'developer',subscription_status:'active'}).eq('id',q.data.id);else await db.from('app_users').insert({email:e,password_hash:h,role:'developer',subscription_status:'active'})}
app.use((q,s)=>s.sendFile(path.join(__dirname,'public','index.html')));
Promise.all([ensureAdmin(),ensureStorage()]).finally(()=>app.listen(Number(process.env.PORT||3000),()=>console.log('MedStudy running')));
