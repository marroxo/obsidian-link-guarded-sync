const {Plugin,PluginSettingTab,Setting,Notice,Modal,requestUrl}=require('obsidian');
const ENDPOINTS={production:'https://obsidian.markojelly.lol/link/Link/',test:'https://obsidian.markojelly.lol/link-mobile-test/Link/'};
const encoder=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
async function hash(b){return hex(await crypto.subtle.digest('SHA-256',b));}
function valid(path){return typeof path==='string' && path.length>0 && !path.startsWith('/') && !path.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.obsidian'||/[\\:<>"|?*]/.test(x)||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(x));}
function plan(base,local,remote){
 if(local===remote)return 'equal';
 if(base===null && local===null && remote!==null)return 'download-new';
 if(base!==null && local===base && remote!==null)return 'download-update';
 if(local!==null && ((base===null&&remote===null)||(base!==null&&base===remote)))return 'upload';
 return 'conflict';
}
function to64(buf){const a=new Uint8Array(buf);let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode(...a.subarray(i,i+32768));return btoa(s);}
function from64(s){const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;}
function etagHeader(headers){const values=Object.entries(headers||{}).filter(([key])=>key.toLowerCase()==='etag').map(([,value])=>value);return values.length&&values.every(v=>v===values[0])?values[0]:undefined;}
function strongValidator(headers,digest){const tag=etagHeader(headers);if(typeof tag!=='string'||!tag)throw Error('Server validator missing or ambiguous');if(/^W\//i.test(tag))throw Error('Server validator is weak');if(tag!=='"sha256-'+digest+'"')throw Error('Server validator does not match downloaded content');return tag;}
function baseline(base,path){return Object.prototype.hasOwnProperty.call(base,path)?base[path]:null;}
function setbase(base,path,value){Object.defineProperty(base,path,{value,writable:true,enumerable:true,configurable:true});}
function archiveConflicts(data,items){const archive=data.conflictArchive||[],keyOf=c=>JSON.stringify([c.path,c.base,c.reason,c.local,c.remote]),known=new Set(archive.map(keyOf));for(const c of items){const key=keyOf(c);if(!known.has(key)){archive.push({...c,archivedAt:new Date().toISOString()});known.add(key);}}data.conflictArchive=archive;}
class LinkSync extends Plugin {
 safe(path){const config=(this.app.vault.configDir||'.obsidian').toLowerCase();return valid(path)&&!path.split('/').some(x=>x.toLowerCase()===config);}
 async onload(){this.data=Object.assign({username:'',password:'',base:{},conflicts:[],endpoint:'production'},await this.loadData());this.busy=false;this.pendingSync=false;this.active=true;this.expectedWrites=new Map();this.addSettingTab(new LinkSettings(this.app,this));this.addCommand({id:'sync',name:'Sync Link vault',callback:()=>this.sync().catch(e=>new Notice('Link sync failed: '+e.message))});this.register(()=>{this.active=false;this.pendingSync=false;clearTimeout(this.syncTimer);});const resume=()=>{if(this.active&&document.visibilityState==='visible')this.autoSync();};this.registerDomEvent(document,'visibilitychange',resume);this.app.workspace.onLayoutReady(resume);const changed=file=>{this.onVaultChange(file).catch(()=>{if(this.active&&document.visibilityState==='visible')this.scheduleSync();});};this.registerEvent(this.app.vault.on('modify',changed));this.registerEvent(this.app.vault.on('create',changed));}
 async onVaultChange(file){if(!this.active||document.visibilityState!=='visible'||!file?.path||!this.safe(file.path))return;const path=file.path,expected=this.expectedWrites.get(path);if(expected){let actual;try{actual=await hash(await this.app.vault.adapter.readBinary(path));}catch{}if(!this.active||document.visibilityState!=='visible')return;if(this.expectedWrites.get(path)===expected){if(actual===expected.digest)return;this.expectedWrites.delete(path);}}this.scheduleSync();}
 markOwnWrite(path,digest){this.expectedWrites??=new Map();this.expectedWrites.set(path,{digest});}
 scheduleSync(){if(!this.data.username||!this.data.password)return;clearTimeout(this.syncTimer);if(this.busy){this.pendingSync=true;return;}this.syncTimer=setTimeout(()=>{this.syncTimer=null;if(document.visibilityState==='visible')this.autoSync();},2000);}
 autoSync(){if(!this.data.username||!this.data.password)return;if(this.busy){this.pendingSync=true;return;}this.sync().catch(e=>new Notice('Link sync failed: '+e.message));}
 finishSync(){this.authContext=null;this.busy=false;if(this.pendingSync){this.pendingSync=false;this.scheduleSync();}}
 endpoint(){const key=this.data.endpoint??'production';if(!Object.prototype.hasOwnProperty.call(ENDPOINTS,key))throw Error('Invalid vault selection');return ENDPOINTS[key];}
 async selectEndpoint(key){if(!Object.prototype.hasOwnProperty.call(ENDPOINTS,key))throw Error('Invalid vault selection');if(key===(this.data.endpoint??'production'))return;if(this.busy||this.data.initialized||this.data.initializing||Object.keys(this.data.base||{}).length||(this.data.conflicts||[]).length||(this.data.conflictArchive||[]).length||Object.keys(this.data.preimages||{}).length)throw Error('Vault already started syncing. Use a separate empty vault.');if(this.data.username||this.data.password)throw Error('Clear credentials before changing the vault connection.');const old=this.data.endpoint;this.busy=true;this.data.endpoint=key;try{await this.saveData(this.data);}catch(e){this.data.endpoint=old;throw e;}finally{this.busy=false;}}
 async call(method,path,body,extra={}){
  if(path && !this.safe(path))throw Error('Unsafe path');
  let target=this.endpoint()+path.split('/').map(encodeURIComponent).join('/');if(method==='GET'){this.readSeq=(this.readSeq||0)+1;target+='?link_sync='+Date.now()+'-'+this.readSeq;}
  const auth=this.authContext||this.data,credentials=btoa(unescape(encodeURIComponent(auth.username+':'+auth.password)));
  return requestUrl({url:target,method,headers:{Authorization:'Basic '+credentials,'Cache-Control':'no-cache, no-store','Pragma':'no-cache',...extra},body,throw:false});
 }
 async listRemote(){
  const queue=[''],out=[];
  while(queue.length){const parent=queue.pop(),r=await this.call('PROPFIND',parent,undefined,{Depth:'1'});if(r.status!==207)throw Error('Remote listing '+r.status);
   const xml=new DOMParser().parseFromString(r.text,'application/xml');if(xml.querySelector('parsererror'))throw Error('Invalid remote listing');
   for(const node of Array.from(xml.getElementsByTagNameNS('DAV:','response'))){
    const href=node.getElementsByTagNameNS('DAV:','href')[0]?.textContent;if(!href)throw Error('Invalid href');
    const root=new URL(this.endpoint()),u=new URL(href,root);if(u.origin!==root.origin||!u.pathname.startsWith(root.pathname))throw Error('Unexpected remote href');
    const path=decodeURIComponent(u.pathname.slice(root.pathname.length)).replace(/\/$/,'');if(!path||path===parent)continue;if(!this.safe(path))throw Error('Unsafe remote name');
    if(node.getElementsByTagNameNS('DAV:','collection').length)queue.push(path);else out.push(path);
   }
   if(out.length+queue.length>5000)throw Error('Too many entries');
  }return out;
 }
 async listLocal(){const out=[];const walk=async dir=>{const ls=await this.app.vault.adapter.list(dir);for(const f of ls.files){if(this.safe(f))out.push(f);}for(const d of ls.folders){if(this.safe(d))await walk(d);}};await walk('');return out;}
 async ensureParents(path){const parts=path.split('/');parts.pop();let p='';for(const n of parts){p=p?p+'/'+n:n;let r=await this.call('PROPFIND',p,undefined,{Depth:'0'});if(r.status===207)continue;if(r.status!==404)throw Error('Folder check '+r.status);r=await this.call('MKCOL',p);if(r.status!==201&&r.status!==204){r=await this.call('PROPFIND',p,undefined,{Depth:'0'});if(r.status!==207)throw Error('Folder create failed');}}}
 async ensureLocalParents(path){let p='';for(const part of path.split('/').slice(0,-1)){p=p?p+'/'+part:part;if(!(await this.app.vault.adapter.exists(p)))await this.app.vault.adapter.mkdir(p);}}
 async resolve(item,choice,mergedText){
  if(this.busy)throw Error('Already running');
  const matches=this.data.conflicts.filter(c=>c.path===item.path);if(matches.length!==1||!this.safe(item.path))throw Error('Conflict changed; sync and review it again');const current=matches[0];if(current.base!==item.base||current.local!==item.local||current.remote!==item.remote)throw Error('Conflict changed; sync and review it again');
  if(item.local==null||item.remote==null)throw Error('Deletion conflicts require separate review');
  if(baseline(this.data.base,item.path)!==(item.base??null))throw Error('Baseline changed; sync again');
  this.busy=true;this.expectedWrites?.clear();this.authContext={username:this.data.username,password:this.data.password};
  try{
   const local=from64(item.local),remote=from64(item.remote),path=item.path;
   if(!(await this.app.vault.adapter.exists(path)))throw Error('Local file changed; sync again');
   if(await hash(await this.app.vault.adapter.readBinary(path))!==await hash(local))throw Error('Local file changed; sync again');
   const before=await this.call('GET',path);if(before.status!==200||await hash(before.arrayBuffer)!==await hash(remote))throw Error('Remote file changed; sync again');
   const etag=strongValidator(before.headers,await hash(remote));
   let chosen;if(choice==='local')chosen=local;else if(choice==='remote')chosen=remote;else if(choice==='merged'&&typeof mergedText==='string')chosen=encoder.encode(mergedText).buffer;else throw Error('Invalid choice');
   if(chosen.byteLength>8*1024*1024)throw Error('Content exceeds limit');
   if(await hash(await this.app.vault.adapter.readBinary(path))!==await hash(local))throw Error('Local file changed; sync again');
   let oldText,newText,file;
   if(await hash(chosen)!==await hash(local)){
    if(!path.toLowerCase().endsWith('.md'))throw Error('Binary replacement requires separate review');
    try{oldText=new TextDecoder('utf-8',{fatal:true}).decode(local);newText=new TextDecoder('utf-8',{fatal:true}).decode(chosen);
      if(await hash(encoder.encode(oldText))!==await hash(local)||await hash(encoder.encode(newText))!==await hash(chosen))throw Error('Not lossless UTF-8');
    }catch{throw Error('Only lossless UTF-8 notes can be applied locally');}
    file=this.app.vault.getFileByPath(path);if(!file)throw Error('Local note unavailable');
    this.data.preimages=this.data.preimages||{};this.data.preimages[await hash(local)]=item.local;await this.saveData(this.data);
   }
   if(await hash(chosen)!==await hash(remote)){
    const r=await this.call('PUT',path,chosen,{'If-Match':etag});if(![200,201,204].includes(r.status))throw Error('Remote resolution not confirmed: '+r.status);
   }
   if(file){this.markOwnWrite(path,await hash(chosen));await this.app.vault.process(file,current=>{if(current!==oldText)throw Error('Local file changed; sync again');return newText;});}
   const after=await this.call('GET',path);if(after.status!==200||await hash(after.arrayBuffer)!==await hash(chosen)||await hash(await this.app.vault.adapter.readBinary(path))!==await hash(chosen))throw Error('Outcome changed or uncertain; sync again');
   strongValidator(after.headers,await hash(chosen));
   const previousBase=baseline(this.data.base,path), previousConflicts=this.data.conflicts;
   archiveConflicts(this.data,[current]);setbase(this.data.base,path,await hash(chosen));this.data.conflicts=previousConflicts.filter(c=>c!==current);
   try{await this.saveData(this.data);}catch(e){if(previousBase===null)delete this.data.base[path];else setbase(this.data.base,path,previousBase);this.data.conflicts=previousConflicts;throw e;}
   new Notice('Link conflict applied');
  }finally{this.finishSync();}
 }

 async sync(){
  if(this.busy)throw Error('Already running');if(!this.data.username||!this.data.password)throw Error('Configure credentials on this device');this.busy=true;this.expectedWrites?.clear();this.authContext={username:this.data.username,password:this.data.password};
  try{const local=new Set(await this.listLocal());
   if(!this.data.initialized&&!this.data.initializing){if(local.size)throw Error('First sync requires an empty vault. Back up and review existing files first.');this.data.initializing=true;try{await this.saveData(this.data);}catch(e){this.data.initializing=false;throw e;}}
   const remote=new Set(await this.listRemote()),all=new Set([...local,...remote,...Object.keys(this.data.base)]),conflicts=[];let count=0;
   for(const path of Array.from(all).sort()){
    if(!this.safe(path))throw Error('Unsafe path');let lb=null,rb=null,lh=null,rh=null,etag=null;
    if(local.has(path)){lb=await this.app.vault.adapter.readBinary(path);lh=await hash(lb);}
    if(remote.has(path)){const r=await this.call('GET',path);if(r.status===304)throw Error('Server returned a cached response; retry sync');if(r.status!==200)throw Error('Remote read '+r.status);rb=r.arrayBuffer;rh=await hash(rb);etag=strongValidator(r.headers,rh);}
    const prior=baseline(this.data.base,path);let action=plan(prior,lh,rh);if(!this.data.initialized&&action==='upload')action='conflict';
    if(action==='equal'){if(lh===null)delete this.data.base[path];else setbase(this.data.base,path,lh);continue;}
    if(action==='download-new'){
     await this.ensureLocalParents(path);
     this.markOwnWrite(path,rh);try{await this.app.vault.createBinary(path,rb);}catch(e){
      if(!(await this.app.vault.adapter.exists(path)))throw e;
      conflicts.push({path,base:prior,reason:'Local file appeared',local:to64(await this.app.vault.adapter.readBinary(path)),remote:to64(rb)});continue;
     }
     setbase(this.data.base,path,rh);count++;continue;
    }
    if(action==='download-update' && path.toLowerCase().endsWith('.md')){
     let oldText,newText;try{oldText=new TextDecoder('utf-8',{fatal:true}).decode(lb);newText=new TextDecoder('utf-8',{fatal:true}).decode(rb);
      if(await hash(encoder.encode(oldText))!==lh || await hash(encoder.encode(newText))!==rh)throw Error('Not lossless UTF-8');
     }catch{conflicts.push({path,base:prior,reason:'Cannot safely update non-text data',local:to64(lb),remote:to64(rb)});continue;}
     const file=this.app.vault.getFileByPath(path);if(!file){conflicts.push({path,base:prior,reason:'Local file unavailable',local:to64(lb),remote:to64(rb)});continue;}
     this.data.preimages=this.data.preimages||{};this.data.preimages[lh]=to64(lb);await this.saveData(this.data);
     this.markOwnWrite(path,rh);try{await this.app.vault.process(file,current=>{if(current!==oldText)throw Error('Local note changed');return newText;});}
     catch{conflicts.push({path,base:prior,reason:'Local note changed during update',local:to64(lb),remote:to64(rb)});continue;}
     setbase(this.data.base,path,rh);count++;continue;
    }
    if(action==='upload'){
     await this.ensureParents(path);const condition=rh===null?{'If-None-Match':'*'}:{'If-Match':etag};const r=await this.call('PUT',path,lb,condition);
     if(r.status===412){const fresh=await this.call('GET',path);if(fresh.status!==200&&fresh.status!==404)throw Error('Remote conflict read '+fresh.status);conflicts.push({path,base:prior,reason:'Remote changed during upload',local:to64(lb),remote:fresh.status===200?to64(fresh.arrayBuffer):null});continue;}if(![200,201,204].includes(r.status))throw Error('Remote write '+r.status);
     setbase(this.data.base,path,lh);count++;continue;
    }
    conflicts.push({path,base:prior,reason:'Both changed, remote changed, or deletion',local:lb===null?null:to64(lb),remote:rb===null?null:to64(rb)});
   }
   const oldConflicts=this.data.conflicts||[];archiveConflicts(this.data,oldConflicts);this.data.conflicts=conflicts;const finishing=!this.data.initialized&&conflicts.length===0;if(finishing){this.data.initialized=true;this.data.initializing=false;}try{await this.saveData(this.data);}catch(e){this.data.conflicts=oldConflicts;if(finishing){this.data.initialized=false;this.data.initializing=true;}throw e;}new Notice('Link: '+count+' changed; '+conflicts.length+' need review');
  }finally{this.finishSync();}
 }
}
class LinkSettings extends PluginSettingTab{
 constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
 display(){const el=this.containerEl;el.empty();el.createEl('h2',{text:'Link guarded sync'});
  new Setting(el).setName('Vault connection').setDesc('Choose before the first sync. Use a separate empty vault for testing.').addDropdown(d=>d.addOption('production','Link production vault').addOption('test','Isolated test vault').setValue(this.plugin.data.endpoint??'production').onChange(v=>this.plugin.selectEndpoint(v).then(()=>this.display()).catch(e=>{new Notice(e.message);this.display();})));
  new Setting(el).setName('Username').addText(t=>t.setValue(this.plugin.data.username).onChange(async v=>{this.plugin.data.username=v;await this.plugin.saveData(this.plugin.data);}));
  new Setting(el).setName('Password').setDesc('Stored on this device in the plugin settings.').addText(t=>{t.inputEl.type='password';t.setValue(this.plugin.data.password).onChange(async v=>{this.plugin.data.password=v;await this.plugin.saveData(this.plugin.data);});});
  new Setting(el).setName('Sync now').addButton(b=>b.setButtonText('Sync').onClick(()=>this.plugin.sync().then(()=>this.display()).catch(e=>new Notice('Link sync failed: '+e.message))));
  el.createEl('p',{text:'Sync runs after saved edits, on opening or returning to Obsidian, and manually. The first sync requires an empty vault. Unchanged notes may be updated from the server; conflicting edits require review. Deletions are not propagated.'});
  for(const c of this.plugin.data.conflicts||[])new Setting(el).setName(c.path).setDesc(c.reason).addButton(b=>b.setButtonText('Review').onClick(()=>new ConflictView(this.app,c,this.plugin).open()));
  for(const c of this.plugin.data.conflictArchive||[])new Setting(el).setName(c.path).setDesc('Archived '+(c.archivedAt||'time unknown')).addButton(b=>b.setButtonText('View history').onClick(()=>new ConflictHistory(this.app,c).open()));
 }
}
class ConflictHistory extends Modal{
 constructor(app,item){super(app);this.item=item;}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:this.item.path});el.createEl('p',{text:'Archived '+(this.item.archivedAt||'time unknown')+'; read only. Run sync and review the current conflict before applying changes.'});for(const side of ['local','remote']){el.createEl('h3',{text:side+' snapshot'});const value=this.item[side];let content='Unavailable';if(value!=null){try{content=new TextDecoder('utf-8',{fatal:true}).decode(from64(value));}catch{content='Binary snapshot stored in plugin settings.';}}el.createEl('pre').textContent=content;}}
 onClose(){this.contentEl.empty();}
}
class ConflictView extends Modal{
 constructor(app,item,plugin){super(app);this.item={...item};this.plugin=plugin;}
 onOpen(){const el=this.contentEl;this.modalEl.classList.add('link-conflict-modal');const updateViewport=()=>{const viewport=window.visualViewport;this.modalEl.style.setProperty('--link-visible-height',Math.max(1,(viewport?.height??window.innerHeight)-16)+'px');this.modalEl.style.setProperty('--link-visible-top',Math.max(0,viewport?.offsetTop??0)+8+'px');};this.viewportUpdate=updateViewport;window.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('scroll',updateViewport);updateViewport();const body=el.createDiv({cls:'link-conflict-body'});body.createEl('h2',{text:this.item.path});for(const side of ['local','remote']){body.createEl('h3',{text:side});const value=this.item[side];let text='Unavailable';if(value!=null){try{text=new TextDecoder('utf-8',{fatal:true}).decode(from64(value));}catch{text='Binary content; inspect the saved copy on this device.';}}const pre=body.createEl('pre');pre.textContent=text;}
  if(this.item.local==null||this.item.remote==null){body.createEl('p',{text:'Deletion conflicts require separate review; both sides are preserved.'});return;}
  const apply=(choice,text)=>this.plugin.resolve(this.item,choice,text).then(()=>this.close()).catch(e=>new Notice('Link: '+e.message));
  new Setting(body).setName('Use local version').addButton(b=>b.setButtonText('Use local').onClick(()=>apply('local')));
  new Setting(body).setName('Use remote version').addButton(b=>b.setButtonText('Use remote').onClick(()=>apply('remote')));
  let merged;try{merged=new TextDecoder('utf-8',{fatal:true}).decode(from64(this.item.local));}catch{}
  if(merged!==undefined){let textarea;new Setting(body).setName('Merged text').addTextArea(t=>{textarea=t.inputEl;textarea.classList.add('link-conflict-textarea');t.setValue(merged).onChange(v=>{merged=v;});});
   const footer=el.createDiv({cls:'link-conflict-footer'});const done=footer.createEl('button',{text:'Hide keyboard'});done.addEventListener('click',()=>textarea.blur());const submit=footer.createEl('button',{text:'Apply merged',cls:'mod-cta'});submit.addEventListener('click',()=>apply('merged',merged));}
 }
 onClose(){window.removeEventListener('resize',this.viewportUpdate);window.visualViewport?.removeEventListener('resize',this.viewportUpdate);window.visualViewport?.removeEventListener('scroll',this.viewportUpdate);this.modalEl.classList.remove('link-conflict-modal');this.modalEl.style.removeProperty('--link-visible-height');this.modalEl.style.removeProperty('--link-visible-top');this.contentEl.empty();}
}
module.exports=LinkSync;module.exports._test={valid,plan,strongValidator};
