'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto'),zlib=require('zlib'),os=require('os');
const PORT=3211,DATA=path.join(__dirname,'data'),PUB=path.join(__dirname,'public');
const OPEN=(process.argv.find(a=>a.startsWith('--open='))||'').slice(7);
const VID=/\.(mp4|webm|mov|m4v)$/i,SUB=/\.(srt|vtt)$/i,BLOCK=/\.(exe|bat|cmd|ps1|msi|vbs|vbe|js|jse|wsf|scr|com|lnk|reg|jar|hta|cpl|dll|sh)$/i,JUNK=/^(thumbs\.db|desktop\.ini)$|^[.~]/i;
/* ---- storage: atomic JSON writes with .bak ---- */
const wr=(f,o)=>{const p=path.join(DATA,f);fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(o));if(fs.existsSync(p))fs.copyFileSync(p,p+'.bak');fs.renameSync(t,p)};
const rd=(f,d)=>{const p=path.join(DATA,f);for(const q of[p,p+'.bak']){try{return JSON.parse(fs.readFileSync(q,'utf8'))}catch{}}return d};
let settings=rd('settings.json',{courses:[]}),progress=rd('progress.json',{courses:{},prefs:{}}),notes=rd('notes.json',{courses:{}});
if(settings.courses.some(c=>c.pending))settings.courses=settings.courses.filter(c=>!c.pending); /* drop unfinished adds from an interrupted session */
const saveS=()=>wr('settings.json',settings),saveP=()=>wr('progress.json',progress),saveN=()=>wr('notes.json',notes);
const idxF=id=>'index/'+id+'.json',getIdx=id=>rd(idxF(id),null),course=id=>settings.courses.find(c=>c.id===id);
const prog=id=>progress.courses[id]??={lessons:{},lastLesson:null};
/* ---- scanning (read-only) ---- */
function scan(root){const vids=[],files=[],subs=[];
 const walk=d=>{for(const e of fs.readdirSync(path.join(root,d),{withFileTypes:true})){const rel=d?d+'/'+e.name:e.name;
  if(e.isDirectory()){if(!e.name.startsWith('.'))walk(rel)}else if(e.isFile()&&!JUNK.test(e.name)){
   if(VID.test(e.name)){const s=fs.statSync(path.join(root,rel));vids.push({key:e.name.toLowerCase(),rel,size:s.size,mtime:Math.floor(s.mtimeMs)})}
   else if(SUB.test(e.name))subs.push(rel);else if(!BLOCK.test(e.name))files.push(rel)}}};
 walk('');const seen={};for(const v of vids)(seen[v.key]??=[]).push(v.rel);
 for(const v of vids){const dir=path.posix.dirname(v.rel),bn=path.posix.basename(v.rel).replace(VID,'').toLowerCase()+'.';
  v.subs=subs.filter(s=>path.posix.dirname(s)===dir&&path.posix.basename(s).toLowerCase().startsWith(bn))}
 return{vids,files,dups:Object.values(seen).filter(a=>a.length>1)}}
function doScan(c){let r;try{r=scan(c.path)}catch(e){return{ok:false,error:'Cannot read folder: '+e.message}}
 if(r.dups.length)return{ok:false,duplicates:r.dups};
 const om=new Map(((getIdx(c.id)||{}).videos||[]).map(v=>[v.key,v]));let added=0;
 for(const v of r.vids){const o=om.get(v.key);if(o&&o.size===v.size&&o.mtime===v.mtime&&o.dur!=null)v.dur=o.dur;else{v.dur=null;if(!o)added++}}
 const nk=new Set(r.vids.map(v=>v.key)),removed=[...om.keys()].filter(k=>!nk.has(k)).length;
 wr(idxF(c.id),{scanned:new Date().toISOString(),videos:r.vids,files:r.files});
 return{ok:true,id:c.id,added,removed,needDur:r.vids.filter(v=>v.dur==null).map(v=>v.key),rel:Object.fromEntries(r.vids.filter(v=>v.dur==null).map(v=>[v.key,v.rel]))}}
const lastOf=(vs,P)=>{let l=null;for(const v of vs){const r=P[v.key];if(r&&r.lastWatched&&(!l||r.lastWatched>l.lastWatched))l={key:v.key,rel:v.rel,dur:v.dur,currentTime:r.currentTime,progress:r.progress,lastWatched:r.lastWatched}}return l};
function summary(c){const i=getIdx(c.id),P=(progress.courses[c.id]||{}).lessons||{},vs=i?i.videos:[];
 return{id:c.id,name:c.name||path.basename(c.path),description:c.description||'',author:c.author||'',imageName:c.image?path.basename(c.image):'',image:!!c.image&&fs.existsSync(path.join(DATA,'covers',path.basename(c.image))),path:c.path,exists:fs.existsSync(c.path),indexed:!!i,last:lastOf(vs,P),sections:new Set(vs.map(v=>v.rel.includes('/')?v.rel.split('/')[0]:'\0')).size,total:vs.length,done:vs.filter(v=>(P[v.key]||{}).completed).length,files:i?i.files.length:0,totalDur:vs.reduce((a,v)=>a+(v.dur>0?v.dur:0),0)}}
/* ---- folder browser for the Manager (lists folder names only) ---- */
const SKIP=/^(\$.*|System Volume Information|\..*)$/i;
const drives=async()=>{if(process.platform!=='win32')return[{name:'/',path:'/'}];const L='CDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),ok=await Promise.all(L.map(l=>Promise.race([fs.promises.access(l+':\\').then(()=>true,()=>false),new Promise(r=>setTimeout(()=>r(false),800))])));return L.filter((l,i)=>ok[i]).map(l=>({name:l+':',path:l+':\\'}))};
const quickPlaces=()=>{const h=os.homedir(),q=[{name:'Home',path:h}];for(const n of['Desktop','Documents','Videos','Downloads']){const p=path.join(h,n);if(fs.existsSync(p))q.push({name:n,path:p})}return q};
async function listDir(p){p=String(p||'').trim();if(!p)return{path:'',parent:null,items:await drives()};
 if(/^[A-Za-z]:$/.test(p))p+='\\';if(!path.isAbsolute(p))return{error:'Enter a full path, for example E:\\Courses'};p=path.resolve(p);
 let st;try{st=await fs.promises.stat(p)}catch{return{error:'Folder not found'}}if(!st.isDirectory())return{error:'That path is a file, not a folder'};
 let es;try{es=await fs.promises.readdir(p,{withFileTypes:true})}catch{return{error:'Cannot open this folder (no permission)'}}
 const par=path.dirname(p);return{path:p,parent:par===p?'':par,items:es.filter(e=>e.isDirectory()&&!SKIP.test(e.name)).map(e=>({name:e.name,path:path.join(p,e.name)})).sort((a,b)=>ncmp(a.name,b.name))}}
async function countVideos(p){let n=0,seen=0;const st=[p];while(st.length){const d=st.pop();let es;try{es=await fs.promises.readdir(d,{withFileTypes:true})}catch{continue}
 for(const e of es){if(++seen>20000)return{n,capped:true};if(e.isDirectory()){if(!SKIP.test(e.name))st.push(path.join(d,e.name))}else if(VID.test(e.name))n++}}return{n,capped:false}}
/* ---- helpers ---- */
const send=(res,o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const body=req=>new Promise(r=>{let b='';req.on('data',d=>{b+=d;if(b.length>5e6)req.destroy()});req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})});
function media(req,res,file){let st;try{st=fs.statSync(file)}catch{res.writeHead(404);return res.end()}
 const mt={'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'}[path.extname(file).toLowerCase()]||'application/octet-stream';
 let s=0,e=st.size-1,code=200;const m=/bytes=(\d*)-(\d*)/.exec(req.headers.range||'');
 if(m){code=206;if(m[1]!==''){s=+m[1];if(m[2]!=='')e=Math.min(+m[2],e)}else if(m[2]!==''){s=Math.max(0,st.size-+m[2])}}
 if(s>e||s>=st.size){res.writeHead(416,{'Content-Range':'bytes */'+st.size});return res.end()}
 const h={'Content-Type':mt,'Accept-Ranges':'bytes','Content-Length':e-s+1};if(code===206)h['Content-Range']=`bytes ${s}-${e}/${st.size}`;
 res.writeHead(code,h);const rs=fs.createReadStream(file,{start:s,end:e});rs.on('error',()=>res.destroy());res.on('close',()=>rs.destroy());rs.pipe(res)}
function subtitle(res,file){let b=fs.readFileSync(file),t=b.toString('utf8');if(t.includes('\uFFFD'))try{t=new TextDecoder('gbk').decode(b)}catch{}
 t=t.replace(/^\uFEFF/,'').replace(/\r/g,'');if(!/^WEBVTT/.test(t))t='WEBVTT\n\n'+t.replace(/(\d\d:\d\d:\d\d),(\d{3})/g,'$1.$2');
 res.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8'});res.end(t)}
/* ---- helpers: zip, order, covers ---- */
const CT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})(),crc=b=>{let c=0xFFFFFFFF;for(const x of b)c=CT[(c^x)&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0};
function zip(en){const bs=[],cd=[];let off=0;for(const[n,d]of en){const nb=Buffer.from(n),c=crc(d),h=Buffer.alloc(30),e=Buffer.alloc(46);
 h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(c,14);h.writeUInt32LE(d.length,18);h.writeUInt32LE(d.length,22);h.writeUInt16LE(nb.length,26);bs.push(h,nb,d);
 e.writeUInt32LE(0x02014b50,0);e.writeUInt16LE(20,4);e.writeUInt16LE(20,6);e.writeUInt16LE(0x800,8);e.writeUInt32LE(c,16);e.writeUInt32LE(d.length,20);e.writeUInt32LE(d.length,24);e.writeUInt16LE(nb.length,28);e.writeUInt32LE(off,42);cd.push(e,nb);off+=30+nb.length+d.length}
 const cb=Buffer.concat(cd),z=Buffer.alloc(22);z.writeUInt32LE(0x06054b50,0);z.writeUInt16LE(en.length,8);z.writeUInt16LE(en.length,10);z.writeUInt32LE(cb.length,12);z.writeUInt32LE(off,16);return Buffer.concat([...bs,cb,z])}
function unzip(b){let e=b.length-22;while(e>=0&&b.readUInt32LE(e)!==0x06054b50)e--;if(e<0)throw new Error('Not a zip');const n=b.readUInt16LE(e+10),out={};let p=b.readUInt32LE(e+16);
 for(let i=0;i<n;i++){const m=b.readUInt16LE(p+10),cs=b.readUInt32LE(p+20),nl=b.readUInt16LE(p+28),el=b.readUInt16LE(p+30),cl=b.readUInt16LE(p+32),lo=b.readUInt32LE(p+42),nm=b.toString('utf8',p+46,p+46+nl),s=lo+30+b.readUInt16LE(lo+26)+b.readUInt16LE(lo+28),raw=b.subarray(s,s+cs);out[nm]=m===8?zlib.inflateRawSync(raw):raw;p+=46+nl+el+cl}return out}
const rawBody=(req,max=2e8)=>new Promise(r=>{const a=[];let n=0;req.on('data',d=>{n+=d.length;if(n>max)return req.destroy();a.push(d)});req.on('end',()=>r(Buffer.concat(a)))});
const ncmp=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'}).compare,dirOf=r=>r.includes('/')?r.slice(0,r.lastIndexOf('/')):'';
const mv=(a,k,to)=>{const i=a.indexOf(k);if(i<0)return a;a.splice(i,1);a.splice(to==='top'?0:to==='bottom'?a.length:to==='up'?Math.max(0,i-1):to==='down'?Math.min(a.length,i+1):i,0,k);return a};
function curOrder(c,dir){const vs=getIdx(c.id).videos.filter(v=>dirOf(v.rel)===dir),ks=vs.map(v=>v.key),o=((c.order||{})[dir]||[]).filter(k=>ks.includes(k));
 return[...o,...vs.filter(v=>!o.includes(v.key)).sort((a,b)=>ncmp(path.posix.basename(a.rel),path.posix.basename(b.rel))).map(v=>v.key)]}
function saveCover(name,ext,buf){const d=path.join(DATA,'covers'),b=(String(name).replace(/[<>:"\/\\|?*\x00-\x1f]/g,'_').slice(0,100).trim())||'course';fs.mkdirSync(d,{recursive:true});
 let f=`${b}.${ext}`,i=2;while(fs.existsSync(path.join(d,f)))f=`${b} (${i++}).${ext}`;fs.writeFileSync(path.join(d,f),buf);return f} /* never overwrites images */
/* ---- routes ---- */
async function route(req,res,u){const p=u.pathname,m=req.method;
 if(p.startsWith('/api/')){const a=p.slice(5),raw=m==='POST'&&(a==='import'||a==='course/image')?await rawBody(req):null,b=m==='POST'&&!raw?await body(req):{},c=course(b.id);
  if(a==='fs/list'){const r=await listDir(b.path);r.quick=quickPlaces();return send(res,r)}
  if(a==='fs/count'){const p=String(b.path||'');if(!path.isAbsolute(p))return send(res,{n:0,capped:false});return send(res,await countVideos(path.resolve(p)))}
  if(a==='ping'){sess.set(String(b.sid),Date.now());seen=true;return send(res,{ok:true})}
  if(a==='bye'){sess.delete(String(b.sid));return send(res,{ok:true})}
  if(a==='state')return send(res,{courses:settings.courses.filter(c=>!c.pending).map(summary),prefs:progress.prefs});
  if(a==='export'){const en=[['backup.json',Buffer.from(JSON.stringify({type:'learning-platform-backup',version:2,settings:{courses:settings.courses.filter(c=>!c.pending)},progress,notes},null,2))]],seen=new Set();
   for(const k of settings.courses){const f=k.image&&path.basename(k.image),q=f&&path.join(DATA,'covers',f);if(q&&!seen.has(f)&&fs.existsSync(q)){seen.add(f);en.push(['covers/'+f,fs.readFileSync(q)])}}
   res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="learning-backup.zip"'});return res.end(zip(en))}
  if(a==='import'){let d,z={};try{if(raw[0]===0x7B)d=JSON.parse(raw.toString('utf8'));else{z=unzip(raw);d=JSON.parse(z['backup.json'].toString('utf8'))}}catch{return send(res,{ok:false,error:'Invalid backup file. Nothing was changed.'})}
   const s=d.settings,q=d.progress;if(d.type!=='learning-platform-backup'||!s||!Array.isArray(s.courses)||!s.courses.every(x=>x&&/^[\w-]+$/.test(x.id)&&typeof x.path==='string')||!q||typeof q.courses!=='object')return send(res,{ok:false,error:'Invalid backup file. Nothing was changed.'});
   settings={courses:s.courses.map(x=>{const o={id:x.id,path:x.path,name:String(x.name||path.basename(x.path)),description:String(x.description||'').slice(0,2000),author:String(x.author||'').slice(0,200),order:x.order&&typeof x.order==='object'?x.order:{},image:''},f=path.basename(String(x.image||'')),buf=z['covers/'+f],ex=path.join(DATA,'covers',f);
    if(f&&buf&&/\.(jpe?g|png|webp)$/i.test(f))o.image=fs.existsSync(ex)&&fs.readFileSync(ex).equals(buf)?f:saveCover(o.name,f.split('.').pop().toLowerCase(),buf);else if(f&&fs.existsSync(ex))o.image=f;return o})};
   progress={courses:q.courses,prefs:q.prefs||{}};if(d.notes&&typeof d.notes.courses==='object')notes={courses:d.notes.courses};saveS();saveP();saveN();return send(res,{ok:true})}
  if(a==='quit'){send(res,{ok:true});console.log('Server stopped.');return setTimeout(()=>process.exit(0),200)}
  if(a==='course/add'){const d=b.path&&path.isAbsolute(String(b.path))?path.resolve(String(b.path)):null;if(!d)return send(res,{ok:false,error:'Enter a full folder path, for example E:\\Courses'});
   if(!fs.existsSync(d)||!fs.statSync(d).isDirectory())return send(res,{ok:false,error:'Folder not found'});
   if(settings.courses.some(x=>x.path.toLowerCase()===d.toLowerCase()))return send(res,{ok:false,error:'This folder is already a course'});
   const n={id:crypto.randomUUID().slice(0,8),path:d,name:path.basename(d),pending:true},r=doScan(n);if(r.ok){settings.courses.push(n);saveS();progress.prefs.lastDir=path.dirname(d);saveP()}return send(res,r)}
  if(a==='courseinfo'||a.startsWith('courseinfo/')){const k=course(a.slice(11));if(!k)return send(res,{ok:false},404);const i=getIdx(k.id)||{videos:[],files:[]};return send(res,{ok:true,course:summary(k),videos:i.videos,files:i.files,progress:prog(k.id),order:k.order||{},notes:notes.courses[k.id]||{},prefs:progress.prefs})}
  if(a==='course/image'){const k=course(u.searchParams.get('id')),r=raw||Buffer.alloc(0),ext=r[0]===0xFF&&r[1]===0xD8?'jpg':r[0]===0x89&&r[1]===0x50?'png':r.toString('latin1',0,4)==='RIFF'&&r.toString('latin1',8,12)==='WEBP'?'webp':null;
   if(!k||!ext||r.length>8e6)return send(res,{ok:false,error:'Unsupported or too large image'},400);k.image=saveCover(k.name||path.basename(k.path),ext,r);saveS();return send(res,{ok:true})}
  if(!c&&/^(course|video|note|bookmark|progress\/(save|reset|bulk)|open)/.test(a))return send(res,{ok:false,error:'Unknown course'},404);
  if(a==='progress/bulk'){const i=getIdx(c.id),ks=new Set(i?i.videos.map(v=>v.key):[]),L=prog(c.id).lessons;for(const k of(Array.isArray(b.keys)?b.keys:[])){if(!ks.has(String(k)))continue;const r=L[k]??={lessonId:String(k),currentTime:0,duration:0,progress:0,completed:false};r.completed=!!b.completed}saveP();return send(res,{ok:true})}
  if(a==='bookmark/save'){const k=String(b.key||'');if(!k)return send(res,{ok:false},400);const items=(Array.isArray(b.items)?b.items:[]).slice(0,200).map(x=>({id:+x.id||Date.now(),t:Math.max(0,Math.floor(+x.t||0)),note:String(x.note||'').slice(0,300)})),n=notes.courses[c.id]??={lessons:{}};n.bookmarks??={};
   if(items.length)n.bookmarks[k]=items;else delete n.bookmarks[k];saveN();return send(res,{ok:true})}
  if(a==='note/save'){const t=String(b.text||'').slice(0,20000),n=notes.courses[c.id]??={lessons:{}};n.lessons??={};
   if(b.key){const k=String(b.key);if(t.trim())n.lessons[k]=t;else delete n.lessons[k]}else{if(t.trim())n.course=t;else delete n.course}saveN();return send(res,{ok:true})}
  if(a==='course/commit'){delete c.pending;saveS();return send(res,{ok:true})}
  if(a==='course/discard'){if(!c.pending)return send(res,{ok:false,error:'Not a pending course'});settings.courses=settings.courses.filter(x=>x!==c);try{fs.unlinkSync(path.join(DATA,idxF(c.id)))}catch{}saveS();return send(res,{ok:true})}
  if(a==='course/meta'){if(typeof b.name==='string'&&b.name.trim())c.name=b.name.trim().slice(0,200);c.description=String(b.description||'').slice(0,2000);c.author=String(b.author||'').slice(0,200);saveS();return send(res,{ok:true})}
  if(a==='course/move'){const ids=settings.courses.map(x=>x.id);mv(ids,c.id,b.to);settings.courses=ids.map(i=>course(i));saveS();return send(res,{ok:true})}
  if(a==='course/image-clear'){const f=path.basename(c.image||''),shared=settings.courses.some(x=>x!==c&&x.image&&path.basename(x.image)===f);let deleted=false;c.image='';if(f&&!shared){try{fs.unlinkSync(path.join(DATA,'covers',f));deleted=true}catch{}}saveS();return send(res,{ok:true,deleted,shared})}
  if(a==='course/ui'){prog(c.id).sidebarWidth=Math.min(800,Math.max(240,+b.sidebarWidth||360));saveP();return send(res,{ok:true})}
  if(a==='video/move'||a==='video/order-reset'){const i=getIdx(c.id),v=i&&i.videos.find(x=>x.key===b.key),dir=a==='video/move'?(v?dirOf(v.rel):null):String(b.dir||'');if(dir===null)return send(res,{ok:false,error:'Unknown video'},404);
   c.order??={};if(a==='video/move')c.order[dir]=mv(curOrder(c,dir),b.key,b.to);else delete c.order[dir];saveS();return send(res,{ok:true})}
  if(a==='course/update'){if(!fs.existsSync(c.path))return send(res,{ok:false,error:'Course folder not found. Use "Change location".'});return send(res,doScan(c))}
  if(a==='course/relocate'){const d=b.path&&path.isAbsolute(String(b.path))?path.resolve(String(b.path)):null;if(!d)return send(res,{ok:false,error:'Enter a full folder path, for example E:\\Courses'});if(!fs.existsSync(d)||!fs.statSync(d).isDirectory())return send(res,{ok:false,error:'Folder not found'});const o=c.path;c.path=d;const r=doScan(c);if(!r.ok)c.path=o;else saveS();return send(res,r)}
  if(a==='course/remove'){settings.courses=settings.courses.filter(x=>x!==c);delete progress.courses[c.id];try{fs.unlinkSync(path.join(DATA,idxF(c.id)))}catch{}saveS();saveP();return send(res,{ok:true})}
  if(a==='course/durations'){const i=getIdx(c.id);for(const v of i.videos){const d=(b.durations||{})[v.key];if(typeof d==='number')v.dur=d}wr(idxF(c.id),i);return send(res,{ok:true})}
  if(a==='progress/save'){const r=b.rec||{},n=x=>Number.isFinite(+x)?+x:0;prog(c.id).lessons[String(b.key)]={lessonId:String(b.key),currentTime:n(r.currentTime),duration:n(r.duration),progress:n(r.progress),completed:!!r.completed,autoDone:!!r.autoDone,lastWatched:r.lastWatched||null};
   if(b.lastLesson)prog(c.id).lastLesson=String(b.lastLesson);saveP();return send(res,{ok:true})}
  if(a==='progress/reset'){if(b.key)delete prog(c.id).lessons[b.key];else progress.courses[c.id]={lessons:{},lastLesson:null,sidebarWidth:prog(c.id).sidebarWidth};saveP();return send(res,{ok:true})}
  if(a==='prefs'){for(const k of['speed','volume','cc','lastDir'])if(k in b)progress.prefs[k]=k==='lastDir'?String(b[k]).slice(0,500):b[k];saveP();return send(res,{ok:true})}
  if(a==='open'){const i=getIdx(c.id);if(!i||!i.files.includes(b.rel))return send(res,{ok:false,error:'File not in course list'},400);cp.execFile('explorer.exe',[path.join(c.path,b.rel)]);return send(res,{ok:true})}
  return send(res,{ok:false,error:'Not found'},404)}
 let cv=/^\/cover\/(\w+)$/.exec(p);if(cv){const c=course(cv[1]),f=c&&c.image&&path.join(DATA,'covers',path.basename(c.image));if(!f||!fs.existsSync(f)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'Content-Type':{'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[path.extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache'});return fs.createReadStream(f).pipe(res)}
 let q=/^\/(media|sub)\/(\w+)\/(.+)$/.exec(p);
 if(q){const c=course(q[2]),i=c&&getIdx(c.id);if(!i){res.writeHead(404);return res.end()}const k=decodeURIComponent(q[3]);
  if(q[1]==='media'){const v=i.videos.find(v=>v.key===k);return v?media(req,res,path.join(c.path,v.rel)):(res.writeHead(404),res.end())}
  if(i.videos.some(v=>v.subs.includes(k)))return subtitle(res,path.join(c.path,k));res.writeHead(404);return res.end()}
 const f=p==='/'?(fs.existsSync(path.join(PUB,'player.html'))?'player.html':'manager.html'):path.basename(p),fp=path.join(PUB,f);
 if(!fs.existsSync(fp)){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'}[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(fp).pipe(res)}
/* ---- heartbeat: pages ping every second; server exits when all pages are gone ---- */
const sess=new Map(),HB=+process.env.HB_TIMEOUT||90000;let seen=false,emptySince=0,lastTick=Date.now();
setInterval(()=>{const now=Date.now(),slept=now-lastTick>5000;lastTick=now;if(slept){emptySince=0;for(const k of sess.keys())sess.set(k,now);return}
 for(const[k,t]of sess)if(now-t>HB)sess.delete(k);if(!seen)return;if(sess.size){emptySince=0;return}
 if(!emptySince)emptySince=now;if(now-emptySince>=5000){console.log('All pages closed. Server stopped.');process.exit(0)}},1000);
const srv=http.createServer(async(req,res)=>{const h=req.headers.host||'',o=req.headers.origin;
 if(!/^(127\.0\.0\.1|localhost):\d+$/.test(h)||(o&&!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o))){res.writeHead(403);return res.end()}
 try{await route(req,res,new URL(req.url,'http://x'))}catch(e){console.error(e);if(!res.headersSent)send(res,{ok:false,error:String(e.message)},500)}});
const openUrl=()=>cp.execFile('explorer.exe',[`http://127.0.0.1:${PORT}/${OPEN}.html`]);
srv.on('error',e=>{if(e.code==='EADDRINUSE'){if(OPEN)openUrl();else console.log('Server already running on port '+PORT);setTimeout(()=>process.exit(0),500)}else{console.error(e);process.exit(1)}});
srv.listen(PORT,'127.0.0.1',()=>{console.log(`Learning server running at http://127.0.0.1:${PORT}\nClose this window or press Ctrl+C to stop.`);if(OPEN)openUrl()});
