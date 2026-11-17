/* shared by player.html and manager.html: heartbeat + "server stopped" notice */
(()=>{const SID=Math.random().toString(36).slice(2);let fails=0;
 const bar=on=>{let b=document.getElementById('srvbar');if(!b&&on){b=document.createElement('div');b.id='srvbar';b.textContent='The server has stopped. Close this tab, or start it again with start.bat and reload this page.';document.body.prepend(b)}if(b)b.hidden=!on};
 const beat=()=>fetch('/api/ping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid:SID}),keepalive:true}).then(()=>{if(fails>=3)bar(false);fails=0}).catch(()=>{if(++fails>=3)bar(true)});
 beat();setInterval(beat,1000);
 addEventListener('pagehide',()=>navigator.sendBeacon('/api/bye',new Blob([JSON.stringify({sid:SID})],{type:'application/json'})));})();

/* "Nov 12, 2026 (3 days ago)" */
window.fmtWhen=iso=>{if(!iso)return'';const d=new Date(iso);if(isNaN(d))return'';const day=x=>new Date(x).setHours(0,0,0,0),n=Math.round((day(Date.now())-day(d))/864e5),
 pl=(k,u)=>k+' '+u+(k==1?'':'s')+' ago',rel=n<=0?'today':n==1?'yesterday':n<30?pl(n,'day'):n<365?pl(Math.floor(n/30),'month'):pl(Math.floor(n/365),'year');
 return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' ('+rel+')'};
