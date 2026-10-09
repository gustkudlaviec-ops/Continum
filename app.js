const $=s=>document.querySelector(s),esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const MAX=9;let books=[],view="";
/* ---------- Camada de dados local e biblioteca compartilhada em SQLite ---------- */
const mem={pdfs:{},books:[]};let idb=null,remoteAvailable=false;
const openDB=()=>new Promise(r=>{try{const q=indexedDB.open("continum",1);q.onupgradeneeded=()=>{q.result.createObjectStore("books",{keyPath:"id"});q.result.createObjectStore("pdfs")};q.onsuccess=()=>r(q.result);q.onerror=()=>r(null)}catch(e){r(null)}});
const io=(st,mode,fn)=>new Promise(r=>{if(!idb)return r(null);try{const t=idb.transaction(st,mode),rq=fn(t.objectStore(st));t.oncomplete=()=>r(rq&&rq.result);t.onerror=()=>r(null)}catch(e){r(null)}});
const setDbStatus=(message,error=false)=>{const el=$("#dbStatus");el.textContent=message;el.classList.toggle("error",error)};
const localAll=async()=>idb?(await io("books","readonly",s=>s.getAll()))||[]:mem.books;
const localPut=async b=>{if(idb)await io("books","readwrite",s=>s.put(b));else{mem.books=mem.books.filter(x=>x.id!=b.id);mem.books.push(b)}};
const localPdf=async id=>idb?await io("pdfs","readonly",s=>s.get(id)):mem.pdfs[id];
async function migrateLegacyLocalDB(){
 if(typeof indexedDB.databases!=="function")return;
 const databases=await indexedDB.databases();if(!databases.some(db=>db.name==="estante"))return;
 const legacy=await new Promise((resolve,reject)=>{const request=indexedDB.open("estante");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error("Não foi possível abrir o banco local antigo."))});
 try{
  const records=await new Promise((resolve,reject)=>{const tx=legacy.transaction(["books","pdfs"],"readonly"),bookRequest=tx.objectStore("books").getAll(),pdfStore=tx.objectStore("pdfs"),pdfKeys=pdfStore.getAllKeys(),pdfValues=pdfStore.getAll();
   tx.oncomplete=()=>resolve({books:bookRequest.result||[],pdfs:(pdfKeys.result||[]).map((key,index)=>[key,pdfValues.result[index]])});tx.onerror=()=>reject(tx.error||new Error("Não foi possível ler os livros locais antigos."))});
  const currentBooks=new Map((await localAll()).map(book=>[book.id,book]));
  for(const book of records.books)if(!currentBooks.has(book.id))await localPut(book);
  for(const [key,value] of records.pdfs)if(!await localPdf(key)&&idb)await io("pdfs","readwrite",store=>store.put(value,key));
 }finally{legacy.close()}
 await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase("estante");request.onsuccess=resolve;request.onerror=()=>reject(request.error||new Error("Não foi possível concluir a migração do banco local."));request.onblocked=()=>{console.warn("O banco local antigo será removido quando as abas antigas forem fechadas.");resolve()}});
}
async function apiJSON(url,options={}){const headers={...options.headers};if(!(options.body instanceof FormData))headers["Content-Type"]="application/json";
 const response=await fetch(url,{credentials:"same-origin",...options,headers});
 let body;try{body=await response.json()}catch{throw new Error("Resposta inválida do servidor da biblioteca.")}
 if(!response.ok)throw new Error(body.error||"Não foi possível acessar a biblioteca compartilhada.");return body}
const saveRemoteMetadata=b=>apiJSON("/api/books",{method:"POST",body:JSON.stringify(b)});
async function saveRemoteBook(b,file){const form=new FormData();form.append("metadata",new Blob([JSON.stringify(b)],{type:"application/json"}));form.append("pdf",file,file.name||`${b.title}.pdf`);
 return apiJSON("/api/books/upload",{method:"POST",headers:{},body:form})}
const DB={put:async b=>{await localPut(b);if(remoteAvailable){try{await saveRemoteMetadata(b)}catch(e){console.error(e);setDbStatus(`Não foi possível sincronizar "${b.title}": ${e.message}`,true)}}},
 publish:async(b,file)=>{if(!remoteAvailable)throw new Error("A biblioteca compartilhada está indisponível. Conecte-se ao servidor e tente novamente.");
  const saved=await saveRemoteBook(b,file);b.uploadedAt=saved.uploadedAt;await localPut(b);if(idb)await io("pdfs","readwrite",s=>s.put(file,b.id));else mem.pdfs[b.id]=file},
 getPdf:async id=>{const cached=await localPdf(id);if(cached)return cached;if(!remoteAvailable)return null;
  const response=await fetch(`/api/books/${encodeURIComponent(id)}/pdf`,{credentials:"same-origin"});if(!response.ok){let message="Não foi possível baixar o PDF compartilhado.";try{message=(await response.json()).error||message}catch{}throw new Error(message)}return response.blob()}};
/* ---------- Regras de cada andar ---------- */
const shelfable=()=>books.filter(b=>b.type!="volume");
const score=b=>(b.rating||3.5)*Math.log(2+b.reads)+Math.max(0,5-(Date.now()-b.added)/864e5)*2;
function shelves(){const S=shelfable(),used=new Set(),take=(arr)=>{const o=arr.filter(b=>!used.has(b.id)).slice(0,MAX);o.forEach(b=>used.add(b.id));return o};
 const top=take([...S].sort((a,b)=>b.reads-a.reads)),rec=take([...S].sort((a,b)=>b.added-a.added)),
 dst=take([...S].sort((a,b)=>score(b)-score(a))),day=Math.floor(Date.now()/864e5);
 const rest=S.filter(b=>!used.has(b.id)).sort((a,b)=>rng(a.id+day)()-rng(b.id+day)());
 return[["🔥 Mais lidos",top],["🆕 Recentes",rec],["⭐ Destaques",dst],["🎲 Descubra",rest.slice(0,MAX)]]}
/* ---------- Aparência pseudoaleatória harmoniosa ---------- */
function rng(seed){let h=1779033703^String(seed).length;for(let i=0;i<String(seed).length;i++){h=Math.imul(h^String(seed).charCodeAt(i),3432918353);h=h<<13|h>>>19}return()=>{h=Math.imul(h^h>>>16,2246822507);h=Math.imul(h^h>>>13,3266489909);return((h^=h>>>16)>>>0)/4294967296}}
const HUES=[8,22,38,48,95,150,175,200,215,265,330];
function look(b){const r=rng(b.id),h=(HUES[Math.floor(r()*HUES.length)]+r()*10)%360,sa=28+r()*20,l=26+r()*16;return{h,s:sa,l,bg:`hsl(${h} ${sa}% ${l}%)`,w:Math.round(26+r()*20),hh:.8+r()*.18,rot:0}}
const coverBg=b=>b.cover?`url(${b.cover}) center/cover`:look(b).bg;
/* ---------- Continum 3D library (three.js) ---------- */
let R,S,CAM,GRP,RAY,DIST=4.5,yaw=0,pitch=.05,tyaw=0,tpitch=.05,hov=null,anim=null,lock=false;const items=new Map(),PLY=[0,1,2,3].map(k=>.125+.53*(3-k));
const M=(c,r=.7,o={})=>new THREE.MeshStandardMaterial({color:c,roughness:r,...o});
const put=(g,m,x,y,z,p)=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;(p||S).add(o);return o};
const bx=(w,h,d,x,y,z,m,p)=>put(new THREE.BoxGeometry(w,h,d),m,x,y,z,p);
function init3d(){const st=$("#stage");
 try{R=new THREE.WebGLRenderer({antialias:true})}catch(e){st.innerHTML='<p style="padding:30px;color:#eee">Seu navegador não suporta WebGL.</p>';return false}
 R.setPixelRatio(Math.min(devicePixelRatio,2));R.shadowMap.enabled=true;R.shadowMap.type=THREE.PCFSoftShadowMap;st.prepend(R.domElement);
 const sr=document.createElement("div");sr.className="sr";sr.id="sr";st.append(sr);
 S=new THREE.Scene();S.background=new THREE.Color(0x2a1014);CAM=new THREE.PerspectiveCamera(34,1,.1,40);
 S.add(new THREE.HemisphereLight(0xffe6d0,0x2a1214,.8));
 const k=new THREE.DirectionalLight(0xfff0dc,.95);k.position.set(1.6,3.2,3);k.target.position.set(0,1.1,0);S.add(k.target);k.castShadow=true;k.shadow.mapSize.set(2048,2048);
 Object.assign(k.shadow.camera,{left:-1.8,right:1.8,top:2.6,bottom:-.4,near:.5,far:9});k.shadow.camera.updateProjectionMatrix();k.shadow.bias=-.0006;S.add(k);
 const w=new THREE.DirectionalLight(0xbcd0ff,.25);w.position.set(-3,2,1.5);S.add(w);
 room();furniture();props();GRP=new THREE.Group();S.add(GRP);RAY=new THREE.Raycaster();
 new ResizeObserver(fit).observe(st);fit();bind(R.domElement);loop();return true}
function fit(){const st=$("#stage"),w=st.clientWidth,h=st.clientHeight;if(!w||!h)return;R.setSize(w,h,false);CAM.aspect=w/h;CAM.updateProjectionMatrix();const t=2*Math.tan(CAM.fov*Math.PI/360);DIST=Math.max(2.75/t,1.75/(t*CAM.aspect))}
function room(){const wall=new THREE.Mesh(new THREE.PlaneGeometry(9,5.5),M(0x6a1c27,.95));wall.position.set(0,2.6,-.17);wall.receiveShadow=true;S.add(wall);
 bx(9,.95,.03,0,.475,-.155,M(0x22181a,.6));bx(9,.04,.05,0,.97,-.14,M(0x2f2224,.5));
 const fl=new THREE.Mesh(new THREE.PlaneGeometry(9,7),M(0x4b2f21,.45));fl.rotation.x=-Math.PI/2;fl.position.set(0,0,3);fl.receiveShadow=true;S.add(fl);
 const c=document.createElement("canvas");c.width=512;c.height=384;const g=c.getContext("2d");g.fillStyle="#6e2630";g.fillRect(0,0,512,384);g.strokeStyle="#d2aa63";g.lineWidth=6;g.strokeRect(18,18,476,348);g.lineWidth=2;g.strokeRect(32,32,448,320);g.fillStyle="#2b3a4a";
 for(let i=0;i<7;i++){g.save();g.translate(80+i*58,192);g.rotate(Math.PI/4);g.fillRect(-18,-18,36,36);g.restore()}
 const rug=new THREE.Mesh(new THREE.PlaneGeometry(2.8,2.1),new THREE.MeshStandardMaterial({map:new THREE.CanvasTexture(c),roughness:1}));rug.rotation.x=-Math.PI/2;rug.position.set(.3,.003,1.2);rug.receiveShadow=true;S.add(rug)}
function furniture(){const m=M(0xf1ede4,.5),T=.03,H=PLY[0]+.53,Z=.02,D=.32;
 bx(T,H,D,-.5+T/2,H/2,Z,m);bx(T,H,D,.5-T/2,H/2,Z,m);bx(1,T,D,0,H-T/2,Z,m);bx(.94,H,.012,0,H/2,-.134,M(0xe4ded2,.8));
 PLY.forEach(y=>bx(.94,T,D-.01,0,y-T/2,Z+.005,m));bx(.94,.095,.03,0,.0475,.17,m)}
function props(){const cer=M(0xefe9df,.35),yT=PLY[0]+.53;
 const vase=(x,y,c,s=1)=>{const pts=[[0,0],[.03,0],[.04,.03],[.045,.07],[.03,.11],[.018,.14],[.022,.16]].map(a=>new THREE.Vector2(a[0]*s,a[1]*s));put(new THREE.LatheGeometry(pts,24),M(c,.4,{side:THREE.DoubleSide}),x,y,.02)};
 put(new THREE.CylinderGeometry(.05,.038,.08,20),cer,.25,yT+.04,.02);
 for(let i=0;i<9;i++){const a=i/9*6.28,l=put(new THREE.SphereGeometry(.055,10,8),M(0x3f6b3a,.8),.25+Math.cos(a)*.04,yT+.15+(i%3)*.04,.02+Math.sin(a)*.04);l.scale.set(.5,1.6,.5);l.rotation.z=-Math.cos(a)*.5;l.rotation.x=Math.sin(a)*.5}
 vase(.2,PLY[0],0xa8402c);vase(.33,PLY[0],0x7b2d3a,.75);
 const fr=new THREE.Group();fr.position.set(-.33,PLY[1]+.1,-.06);fr.rotation.x=-.1;S.add(fr);
 put(new THREE.BoxGeometry(.15,.2,.014),M(0x2b1d17,.5),0,0,0,fr);put(new THREE.BoxGeometry(.12,.17,.004),M(0xd9cdb6,.9),0,0,.008,fr);put(new THREE.CircleGeometry(.032,24),M(0x6a4a3a,.9),0,.01,.0105,fr);vase(-.14,PLY[1],0xc8b79a,.7);
 put(new THREE.CylinderGeometry(.07,.055,.07,24,1,true),M(0xb98a52,.9,{side:THREE.DoubleSide}),.3,PLY[2]+.035,.02);put(new THREE.CylinderGeometry(.055,.055,.006,24),M(0xb98a52,.9),.3,PLY[2]+.003,.02);
 put(new THREE.CylinderGeometry(.012,.02,.03,12),M(0xc9a15a,.3),.1,PLY[2]+.015,.03);put(new THREE.SphereGeometry(.055,24,18),M(0x2f5c7a,.45),.1,PLY[2]+.085,.03);
 [0x2f4a5a,0x8a3b2a,0x3d5a3a].forEach((c,i)=>{const o=bx(.2-i*.015,.032,.15,-.3+(i%2?.01:-.005),PLY[3]+.016+i*.032,.03,M(c,.7));o.rotation.y=(i-1)*.05});vase(-.3,PLY[3]+.096,0xd9c9a9,.7)}
/* lombadas e capas */
function spineTex(b,L,w,h){const ch=640,cw=Math.max(64,Math.round(w/h*ch)),c=document.createElement("canvas");c.width=cw;c.height=ch;const g=c.getContext("2d"),gr=g.createLinearGradient(0,0,cw,0);
 gr.addColorStop(0,`hsl(${L.h} ${L.s}% ${L.l+5}%)`);gr.addColorStop(.5,L.bg);gr.addColorStop(1,`hsl(${L.h} ${L.s}% ${L.l-5}%)`);g.fillStyle=gr;g.fillRect(0,0,cw,ch);
 g.fillStyle="rgba(255,255,255,.22)";[.07,.93].forEach(y=>{g.fillRect(0,ch*y,cw,4);g.fillRect(0,ch*y+9,cw,2)});
 if(b.type=="collection"){g.fillStyle="#d8b46a";g.fillRect(0,ch*.14,cw,6);g.fillRect(0,ch*.86,cw,6)}
 g.translate(cw/2,ch/2);g.rotate(Math.PI/2);g.fillStyle="#fff";g.textAlign="center";g.textBaseline="middle";
 let fs=Math.min(cw*.4,44);g.font=`600 ${fs}px Georgia,serif`;while(g.measureText(b.title).width>ch*.58&&fs>14){fs-=2;g.font=`600 ${fs}px Georgia,serif`}
 g.fillText(b.title,-ch*.08,0);g.font=`${Math.min(cw*.22,22)}px sans-serif`;g.globalAlpha=.75;g.fillText((b.author||"").split(" ").pop(),ch*.34,0);return new THREE.CanvasTexture(c)}
function coverMat(b){const L=look(b),c=document.createElement("canvas");c.width=360;c.height=540;const g=c.getContext("2d"),t=new THREE.CanvasTexture(c);
 const paint=img=>{const gr=g.createLinearGradient(0,0,360,540);gr.addColorStop(0,`hsl(${L.h} ${L.s}% ${L.l+8}%)`);gr.addColorStop(1,`hsl(${L.h} ${L.s}% ${L.l-6}%)`);g.fillStyle=gr;g.fillRect(0,0,360,540);
  if(img)g.drawImage(img,0,0,360,540);else{g.strokeStyle="rgba(255,255,255,.4)";g.strokeRect(20,20,320,500);g.fillStyle="#fff";g.textAlign="center";g.font="600 38px Georgia,serif";let ln="",y=180;
   b.title.split(" ").forEach(w=>{const tl=ln?ln+" "+w:w;if(g.measureText(tl).width>280&&ln){g.fillText(ln,180,y);y+=46;ln=w}else ln=tl});g.fillText(ln,180,y);g.font="22px sans-serif";g.fillText(b.author||"",180,480)}t.needsUpdate=true};
 paint();if(b.cover){const i=new Image;i.onload=()=>paint(i);i.src=b.cover}return new THREE.MeshStandardMaterial({map:t,roughness:.6})}
function item(b){let e=items.get(b.id);if(e)return e;const L=look(b),r=rng(b.id+"3"),w=.034+r()*.03,h=.27+r()*.1,d=.19+r()*.04;
 const c=new THREE.Color().setHSL(L.h/360,L.s/100,L.l/100),pg=M(0xeee4cf,.9),cv=M(c.multiplyScalar(.92),.75),sp=new THREE.MeshStandardMaterial({map:spineTex(b,L,w,h),roughness:.65});
 const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),[cv,cv.clone(),pg,pg,sp,pg]);m.castShadow=m.receiveShadow=true;m.rotation.set(0,(r()-.5)*.03,(r()-.5)*.025);
 e={b,m,dim:{w,h,d},t:new THREE.Vector3(),out:false,fresh:true,q0:m.quaternion.clone()};GRP.add(m);items.set(b.id,e);return e}
/* A biblioteca é dinâmica: as posições vêm dos dados. */
function render(){if(!S&&!init3d())return;const lists=shelves(),keep=new Set(),sr=$("#sr");sr.innerHTML="";
 lists.forEach(([lab,list],k)=>{const s=k%2?-1:1;let x=-s*.44;list.forEach(b=>{const e=item(b),{w,h,d}=e.dim;keep.add(b.id);e.out=false;e.t.set(x+s*w/2,PLY[k]+h/2+.002,.14-d/2);x+=s*(w+.003);
  if(e.fresh){e.fresh=false;e.m.position.set(e.t.x,e.t.y+.4,e.t.z);e.m.scale.setScalar(.01)}
  const bt=document.createElement("button");bt.textContent=`${b.title}, ${b.author||""}`;bt.onclick=()=>open3d(e);sr.append(bt)})});
 items.forEach((e,id)=>{if(!keep.has(id))e.out=true})}
function loop(){requestAnimationFrame(loop);const now=performance.now();yaw+=(tyaw-yaw)*.06;pitch+=(tpitch-pitch)*.06;const cp=Math.cos(pitch);
 CAM.position.set(Math.sin(yaw)*cp*DIST,1.2+Math.sin(pitch)*DIST,Math.cos(yaw)*cp*DIST);CAM.lookAt(0,1.2,0);
 items.forEach((e,id)=>{const m=e.m;if(anim&&anim.e===e)return;const h=hov===e&&!lock;
  m.position.x+=(e.t.x-m.position.x)*.12;m.position.y+=(e.t.y-m.position.y)*.12;m.position.z+=(e.t.z+(h?.06:0)-m.position.z)*.2;
  const s=m.scale.x+((e.out?.001:1)-m.scale.x)*.12;m.scale.setScalar(s);
  if(e.out&&s<.02){GRP.remove(m);m.geometry.dispose();m.material.forEach(x=>{x.map&&x.map.dispose();x.dispose()});items.delete(id)}});
 if(anim){const p=Math.min(1,(now-anim.t0)/620),k=1-Math.pow(1-p,3),m=anim.e.m;m.position.lerpVectors(anim.p0,anim.p1,k);m.position.z+=Math.sin(Math.PI*k)*.12;m.quaternion.copy(anim.q0).slerp(anim.q1,k);m.scale.setScalar(1+(anim.s1-1)*k);
  if(p>=1){const e=anim.e;anim=null;detail(e.b);setTimeout(()=>{e.m.position.copy(e.t);e.m.quaternion.copy(e.q0);e.m.scale.setScalar(1);lock=false},260)}}
 R.render(S,CAM)}
function open3d(e){if(anim||!e)return;lock=true;hov=null;tyaw=yaw;tpitch=pitch;$("#tip").style.opacity=0;const m=e.m;m.material[0]=coverMat(e.b);CAM.updateMatrixWorld();
 const q1=CAM.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.05,-Math.PI/2+.35,0)));
 anim={e,t0:performance.now(),p0:m.position.clone(),p1:new THREE.Vector3(0,0,-1.55).applyMatrix4(CAM.matrixWorld),q0:m.quaternion.clone(),q1,s1:2.3}}
function pick(ev){const r=R.domElement.getBoundingClientRect();RAY.setFromCamera(new THREE.Vector2((ev.clientX-r.left)/r.width*2-1,-((ev.clientY-r.top)/r.height)*2+1),CAM);
 const h=RAY.intersectObjects(GRP.children,false)[0];return h&&[...items.values()].find(e=>e.m===h.object)}
function bind(cv){cv.addEventListener("pointermove",ev=>{if(lock)return;const r=cv.getBoundingClientRect();tyaw=((ev.clientX-r.left)/r.width-.5)*.8;tpitch=.05-((ev.clientY-r.top)/r.height-.5)*.12;
  if(ev.pointerType=="mouse"){const e=pick(ev);hov=e||null;cv.style.cursor=e?"pointer":"default";if(e)tip(e.b,ev.clientX,ev.clientY);else $("#tip").style.opacity=0}});
 cv.addEventListener("pointerleave",()=>{hov=null;if(!lock)tyaw=0;$("#tip").style.opacity=0});
 cv.addEventListener("click",ev=>{if(lock)return;const e=pick(ev);if(e)open3d(e)})}
function tip(b,x,y){const t=$("#tip");t.innerHTML=`<b>${esc(b.title)}</b>${esc(b.author||"")}<br><small>${b.type=="collection"?"Coleção · ":""}${b.reads} leituras</small>`;t.style.left=Math.min(innerWidth-220,x+14)+"px";t.style.top=Math.max(6,y-64)+"px";t.style.opacity=1}
/* ---------- Detalhe do livro / coleção ---------- */
function detail(b,parent){const ov=$("#ovD"),vols=books.filter(x=>x.coll==b.id).sort((a,c)=>a.n-c.n),isC=b.type=="collection";
 ov.innerHTML=`<div class="card" role="dialog" aria-label="${esc(b.title)}"><div class="cv" style="background:${coverBg(b)}">${b.cover?"":esc(b.title)}</div><div>
 <h2>${esc(b.title)}</h2><div>${esc(b.author||"Autor desconhecido")}</div>
 <div class="meta">${[b.genre,b.lang,b.pages&&b.pages+" págs.",b.reads+" leituras",b.rating&&"★ "+b.rating.toFixed(1),b.uploadedAt&&"Enviado em "+new Date(b.uploadedAt).toLocaleDateString("pt-BR",{timeZone:"UTC"}),parent&&"Coleção: "+parent.title,isC&&vols.length+" livros"].filter(Boolean).map(esc).join(" · ")}</div>
 <p>${esc(b.desc||"Sem descrição.")}</p><div>${(b.tags||[]).map(t=>`<span class="tag">#${esc(t)}</span>`).join("")}</div>
 ${isC?`<div class="vols">${vols.map((v,i)=>`<button data-v="${v.id}"><b>${String(i+1).padStart(2,"0")}</b> ${esc(v.title)}</button>`).join("")}</div>`:""}
 <div class="row" style="margin-top:12px">${isC?"":`<button class="btn p" id="dRead">LER ONLINE</button>`}<button class="btn" id="dFav">${b.fav?"★ FAVORITADO":"☆ FAVORITAR"}</button><button class="btn" id="dBack">${parent?"← VOLTAR À COLEÇÃO":"VOLTAR PARA CONTINUM"}</button></div></div></div>`;
 ov.classList.add("on");
 ov.onclick=e=>{if(e.target==ov)ov.classList.remove("on")};
 $("#dBack").onclick=()=>parent?detail(parent):ov.classList.remove("on");
 $("#dFav").onclick=async()=>{b.fav=!b.fav;await DB.put(b);detail(b,parent);lists()};
 if($("#dRead"))$("#dRead").onclick=()=>read(b);
 ov.querySelectorAll("[data-v]").forEach(x=>x.onclick=()=>detail(books.find(v=>v.id==x.dataset.v),b))}
/* ---------- Leitor de PDF (sob demanda) ---------- */
let pdf=null,pn=1,zoom=1;
async function read(b){const rd=$("#rd"),pg=$("#rPg");rd.classList.add("on");$("#rT").textContent=b.title;pg.innerHTML=`<div class="msg">Carregando…</div>`;
 b.reads++;await DB.put(b);render();
 let blob;try{blob=await DB.getPdf(b.id)}catch(e){console.error(e);pg.innerHTML=`<div class="msg">${esc(e.message)}</div>`;return}
 if(!blob||!window.pdfjsLib){pg.innerHTML=`<div class="msg">${blob?"Leitor indisponível.":"Este é um livro de demonstração, sem PDF anexado.<br>Use “+ Adicionar livro” para enviar um PDF e lê-lo aqui."}</div>`;pdf=null;return}
 try{pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  pdf=await pdfjsLib.getDocument({data:await blob.arrayBuffer()}).promise;pn=1;zoom=1;draw()}catch(e){pg.innerHTML=`<div class="msg">Não foi possível abrir este PDF.</div>`}}
async function draw(){if(!pdf)return;const p=await pdf.getPage(pn),w=Math.min(innerWidth-24,900)*zoom,v0=p.getViewport({scale:1}),v=p.getViewport({scale:w/v0.width*devicePixelRatio});
 const cv=document.createElement("canvas");cv.width=v.width;cv.height=v.height;cv.style.width=w+"px";await p.render({canvasContext:cv.getContext("2d"),viewport:v}).promise;
 $("#rPg").replaceChildren(cv);$("#rInfo").textContent=`${pn} / ${pdf.numPages}`}
const go=d=>{if(pdf&&pn+d>=1&&pn+d<=pdf.numPages){pn+=d;draw();$("#rPg").scrollTop=0}};
$("#rP").onclick=()=>go(-1);$("#rN").onclick=()=>go(1);$("#rZi").onclick=()=>{zoom=Math.min(3,zoom+.25);draw()};$("#rZo").onclick=()=>{zoom=Math.max(.5,zoom-.25);draw()};
$("#rFs").onclick=()=>document.fullscreenElement?document.exitFullscreen():$("#rd").requestFullscreen?.();
$("#rBack").onclick=()=>{$("#rd").classList.remove("on");pdf=null;if(document.fullscreenElement)document.exitFullscreen()};
addEventListener("keydown",e=>{if($("#rd").classList.contains("on")){if(e.key=="ArrowRight")go(1);if(e.key=="ArrowLeft")go(-1);if(e.key=="Escape")$("#rBack").click()}else if(e.key=="Escape"){$("#ovD").classList.remove("on");$("#ovA").classList.remove("on")}});
let tx=0;$("#rPg").addEventListener("touchstart",e=>tx=e.touches[0].clientX,{passive:true});$("#rPg").addEventListener("touchend",e=>{const d=e.changedTouches[0].clientX-tx;if(zoom<=1&&Math.abs(d)>60)go(d<0?1:-1)});
/* ---------- Pesquisa, favoritos, recomendações ---------- */
function mini(b){const p=b.coll&&books.find(x=>x.id==b.coll);return`<button class="mini" data-id="${b.id}"><div class="cv" style="background:${coverBg(b)}">${b.cover?"":esc(b.title)}</div><b>${esc(b.title)}</b><small>${esc(b.author||"")}${p?" · "+esc(p.title):""}</small></button>`}
function lists(){const q=$("#q").value.trim().toLowerCase(),r=$("#res");let h="",L=[];
 if(q){view="";L=books.filter(b=>[b.title,b.author,b.genre,(b.tags||[]).join(" "),(books.find(x=>x.id==b.coll)||{}).title].join(" ").toLowerCase().includes(q));h=`<h3>${L.length} resultado(s)</h3>`}
 else if(view=="fav"){L=books.filter(b=>b.fav);h=`<h3>Seus favoritos</h3>`+(L.length?"":"<p>Favorite um livro para vê-lo aqui.</p>")}
 else if(view=="rec"){const fg=new Set(books.filter(b=>b.fav).map(b=>b.genre)),seen=b=>b.type=="volume";L=books.filter(b=>!seen(b)&&!b.fav).sort((a,b)=>(fg.has(b.genre)*3+score(b)/4)-(fg.has(a.genre)*3+score(a)/4)).slice(0,8);h=`<h3>${fg.size?"Com base nos seus favoritos":"Em alta agora"}</h3>`}
 else{r.innerHTML="";return}
 r.innerHTML=h+L.map(mini).join("");r.querySelectorAll(".mini").forEach(m=>m.onclick=()=>{const b=books.find(x=>x.id==m.dataset.id);detail(b,b.coll&&books.find(x=>x.id==b.coll))})}
$("#q").oninput=lists;
$("#bFav").onclick=()=>{view=view=="fav"?"":"fav";$("#q").value="";sync();lists()};$("#bRec").onclick=()=>{view=view=="rec"?"":"rec";$("#q").value="";sync();lists()};
const sync=()=>{$("#bFav").classList.toggle("on",view=="fav");$("#bRec").classList.toggle("on",view=="rec")};
/* ---------- Adicionar livro / coleção ---------- */
let files=[],meta=[];
$("#bAdd").onclick=()=>{files=[];const o=$("#ovA");o.classList.add("on");o.onclick=e=>{if(e.target==o)o.classList.remove("on")};
 o.innerHTML=`<div class="card add" role="dialog" aria-label="Adicionar livro"><h2>+ Adicionar livro</h2>
 <label class="drop" id="dz" for="fi">Arraste PDFs aqui ou toque para selecionar<br><small id="fn"></small><input id="fi" type="file" accept="application/pdf" multiple hidden></label>
 <div class="seg"><button class="btn on" data-m="single">LIVRO INDIVIDUAL</button><button class="btn" data-m="collection">COLEÇÃO</button></div>
 <label>Título (ou nome da coleção)</label><input type="text" id="mT"><label>Autor</label><input type="text" id="mA">
 <div class="row"><div style="flex:1"><label>Gênero</label><input type="text" id="mG"></div><div style="flex:1"><label>Idioma</label><input type="text" id="mL" value="Português"></div></div>
 <label>Tags (separadas por vírgula)</label><input type="text" id="mTg"><label>Descrição</label><textarea id="mD" rows="3"></textarea>
 <div class="row" style="margin-top:14px"><button class="btn p" id="mOk" disabled>PUBLICAR</button><button class="btn" id="mX">CANCELAR</button></div></div>`;
 let mode="single";const seg=o.querySelectorAll("[data-m]");seg.forEach(s=>s.onclick=()=>{mode=s.dataset.m;seg.forEach(x=>x.classList.toggle("on",x==s))});
 const pick=async fl=>{files=[...fl].filter(f=>f.type=="application/pdf"||/\.pdf$/i.test(f.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));if(!files.length)return;
  $("#fn").textContent=files.map(f=>f.name).join(", ");if(files.length>1)seg[1].click();
  meta=[];for(const f of files)meta.push(await analyze(f));
  $("#mT").value=files.length>1?"":meta[0].title;$("#mA").value=meta[0].author;$("#mOk").disabled=false};
 $("#fi").onchange=e=>pick(e.target.files);const dz=$("#dz");dz.ondragover=e=>{e.preventDefault();dz.classList.add("h")};dz.ondragleave=()=>dz.classList.remove("h");dz.ondrop=e=>{e.preventDefault();dz.classList.remove("h");pick(e.dataTransfer.files)};
 $("#mX").onclick=()=>o.classList.remove("on");
 $("#mOk").onclick=async()=>{const button=$("#mOk");button.disabled=true;const base={author:$("#mA").value,genre:$("#mG").value||"Geral",lang:$("#mL").value,tags:$("#mTg").value.split(",").map(s=>s.trim()).filter(Boolean),desc:$("#mD").value,reads:0,rating:0,added:Date.now()};
  const uid=()=>"u"+Math.random().toString(36).slice(2,9),T=$("#mT").value;
  try{
   if(mode=="single"||files.length==1){const id=uid(),m=meta[0],b={...base,id,title:T||m.title,type:"single",pages:m.pages,cover:m.cover};await DB.publish(b,files[0]);books.push(b)}
   else{const cid=uid(),first=meta[0],c={...base,id:cid,title:T||"Nova coleção",type:"collection",cover:first.cover};await DB.put(c);books.push(c);
    for(let i=0;i<files.length;i++){const id=uid(),v={...base,id,title:meta[i].title,type:"volume",coll:cid,n:i,pages:meta[i].pages,cover:meta[i].cover};await DB.publish(v,files[i]);books.push(v)}}
   setDbStatus("PDF salvo na biblioteca compartilhada com a data de envio registrada.");o.classList.remove("on");render();lists()
  }catch(e){console.error(e);setDbStatus(`Não foi possível publicar o PDF: ${e.message}`,true);button.disabled=false}};
};
async function analyze(f){const m={title:f.name.replace(/\.pdf$/i,"").replace(/[_-]+/g," "),author:"",pages:0,cover:""};
 try{pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";const d=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;m.pages=d.numPages;
  const i=(await d.getMetadata()).info||{};if(i.Title)m.title=i.Title;if(i.Author)m.author=i.Author;
  const p=await d.getPage(1),v0=p.getViewport({scale:1}),v=p.getViewport({scale:300/v0.width}),c=document.createElement("canvas");c.width=v.width;c.height=v.height;
  await p.render({canvasContext:c.getContext("2d"),viewport:v}).promise;m.cover=c.toDataURL("image/jpeg",.6)}catch(e){}return m}
/* ---------- Seed de demonstração ---------- */
function seed(){const N=["O Farol","A Ilha","O Mapa","A Estação","O Jardim","A Cidade","O Relógio","A Coroa","O Rio","A Sombra","O Vale","A Torre"],T=["do Fim","das Marés","de Cinzas","da Aurora","do Silêncio","de Vidro"],
 A=["Helena Duarte","Caio Menezes","Iara Lemos","Tomás Reis","Beatriz Aragão","Otávio Lins","Nina Falcão"],G=["Romance","Ficção científica","Fantasia","Mistério","Poesia","Ensaio"],out=[],now=Date.now();
 for(let i=0;i<44;i++){const r=rng("s"+i),t=N[i%12]+" "+T[(i*5+Math.floor(i/12))%6];out.push({id:"d"+i,title:t,author:A[Math.floor(r()*7)],genre:G[Math.floor(r()*6)],lang:"Português",type:"single",reads:Math.floor(r()*r()*900),rating:3+r()*2,added:now-Math.floor(r()*r()*120)*864e5,tags:[G[i%6].toLowerCase()],desc:"Livro de demonstração. Substitua por PDFs reais usando “+ Adicionar livro”."})}
 out.push({id:"dc",title:"Crônicas do Reino Esquecido",author:"Iara Lemos",genre:"Fantasia",lang:"Português",type:"collection",reads:640,rating:4.7,added:now-3*864e5,tags:["fantasia","saga"],desc:"Coleção completa em três volumes."});
 ["A Pedra do Norte","O Rei sem Nome","A Última Maré"].forEach((t,n)=>out.push({id:"dv"+n,title:t,author:"Iara Lemos",genre:"Fantasia",lang:"Português",type:"volume",coll:"dc",n,reads:0,rating:4.6,added:now,tags:["fantasia"],desc:"Volume "+(n+1)+" da saga."}));return out}
async function initializeLibrary(){
 idb=await openDB();
 if(idb){try{await migrateLegacyLocalDB()}catch(e){console.error("A migração do banco local antigo falhou.",e);setDbStatus(`Não foi possível migrar os dados locais antigos: ${e.message}`,true)}}
 else setDbStatus("Armazenamento local indisponível; os arquivos serão mantidos no banco compartilhado.",true);
 const localBooks=await localAll(),localById=new Map(localBooks.map(b=>[b.id,b]));
 try{
  let shared=(await apiJSON("/api/books")).books;remoteAvailable=true;
  const sharedById=new Map(shared.map(b=>[b.id,b]));
  for(const b of localBooks){const stored=sharedById.get(b.id),file=stored&&!stored.hasPdf?await localPdf(b.id):!stored?await localPdf(b.id):null;
   if(file){await saveRemoteBook(b,file);sharedById.set(b.id,{...b,hasPdf:true})}
   else if(!stored){await saveRemoteMetadata(b);sharedById.set(b.id,b)}
  }
  shared=(await apiJSON("/api/books")).books;
  if(!shared.length){for(const b of seed())await saveRemoteMetadata(b);shared=(await apiJSON("/api/books")).books}
  books=shared.map(b=>({...b,fav:!!localById.get(b.id)?.fav}));
  for(const b of books)await localPut(b);
  setDbStatus("Biblioteca compartilhada ativa · PDFs ficam disponíveis para todas as contas.");
 }catch(e){
  remoteAvailable=false;books=localBooks.length?localBooks:seed();
  console.error("Não foi possível carregar a biblioteca compartilhada.",e);
  setDbStatus(`Biblioteca compartilhada indisponível; exibindo apenas dados deste dispositivo. ${e.message}`,true);
 }
 render()
}
void initializeLibrary();