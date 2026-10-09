/* Transactional local authority. The original localStorage record remains a recovery copy. */
(function(root){
  'use strict';
  const TABLES=['meta','sources','receipts','revisions','deliveries'];
  const clone=value=>JSON.parse(JSON.stringify(value));
  const failed=(code,error,extra)=>Object.assign({ok:false,code,error},extra||{});
  const message={STORAGE:'The local database could not be read or saved. Your previous committed record is unchanged.',CORRUPT:'The local database did not reconcile. Automatic intake and saving are paused; recover from a verified backup.',CAS:'This workspace changed in another view. Reload and review before saving.',MIGRATION:'Storage migration needs a verified private backup of this exact record.',STAGED:'Storage migration was interrupted. Resume its verified migration before saving; the original record is preserved.'};
  async function hashState(state){
    const bytes=new TextEncoder().encode(JSON.stringify(state));
    const digest=await root.crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  }
  /* AX5b (his go, Oct 9 about 1:30 PM: "the 8, 9, and 5b"; his choice A for its gate): the revision log only grows, and its seal is the
     SHA-256 of its JSON. A delivery with new rows re-hashed all of it (339 MB, about 2.8 s). SHA-256 reads its input in order, so the
     hash's running state after the existing log can be kept (control.revisionsMid) and only the new revisions fed to it: the seal is
     the very same value, so older builds, restores and every full read check it exactly as before. The running state is used only when
     it is for this exact log (count and last sequence) and finishing it gives the stored seal; otherwise the whole log is hashed as before. */
  const SHA_K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const shaW=new Uint32Array(64);
  function shaStart(){return {h:new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),buf:new Uint8Array(64),n:0,len:0};}
  function shaBlock(h,b,o){
    const w=shaW;
    for(let i=0;i<16;i++)w[i]=(b[o+4*i]<<24)|(b[o+4*i+1]<<16)|(b[o+4*i+2]<<8)|b[o+4*i+3];
    for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3))+w[i-7]+(((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10))+w[i-16];}
    let a=h[0],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],k=h[7],bb=h[1];
    for(let i=0;i<64;i++){
      const t1=(k+(((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7)))+((e&f)^(~e&g))+SHA_K[i]+w[i])|0;
      const t2=((((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)))+((a&bb)^(a&c)^(bb&c)))|0;
      k=g;g=f;f=e;e=(d+t1)|0;d=c;c=bb;bb=a;a=(t1+t2)|0;
    }
    h[0]+=a;h[1]+=bb;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=k;
  }
  function shaFeed(s,bytes){
    let i=0;const n=bytes.length;s.len+=n;
    if(s.n){while(i<n&&s.n<64)s.buf[s.n++]=bytes[i++];if(s.n<64)return s;shaBlock(s.h,s.buf,0);s.n=0;}
    for(;i+64<=n;i+=64)shaBlock(s.h,bytes,i);
    while(i<n)s.buf[s.n++]=bytes[i++];
    return s;
  }
  function shaCopy(s){return {h:new Uint32Array(s.h),buf:new Uint8Array(s.buf),n:s.n,len:s.len};}
  function shaHex(s0){
    const s=shaCopy(s0),bits=s.len*8,pad=new Uint8Array(((s.n<56)?56:120)-s.n+8);pad[0]=0x80;
    const hi=Math.floor(bits/4294967296),lo=bits>>>0,L=pad.length;
    pad[L-8]=hi>>>24;pad[L-7]=hi>>>16;pad[L-6]=hi>>>8;pad[L-5]=hi;pad[L-4]=lo>>>24;pad[L-3]=lo>>>16;pad[L-2]=lo>>>8;pad[L-1]=lo;
    const len=s.len;shaFeed(s,pad);s.len=len;
    return Array.from(s.h,x=>(x>>>0).toString(16).padStart(8,'0')).join('');
  }
  const shaText=new TextEncoder();
  // The JSON of a list, without its closing bracket: '[' then each item, comma separated (JSON.stringify's own form).
  function logOpen(rows){const s=shaFeed(shaStart(),shaText.encode('['));for(let i=0;i<rows.length;i++){if(i)shaFeed(s,shaText.encode(','));shaFeed(s,shaText.encode(JSON.stringify(rows[i])));}return s;}
  function logAppend(s,count,rows){for(let i=0;i<rows.length;i++){if(count+i)shaFeed(s,shaText.encode(','));shaFeed(s,shaText.encode(JSON.stringify(rows[i])));}return s;}
  const logSeal=s=>shaHex(shaFeed(shaCopy(s),shaText.encode(']')));
  // Long hashing runs in slices of about 25 ms so it never holds a tap; a message channel yields even in a hidden window, where timers
  // slow to once a second.
  const yieldNow=()=>new Promise(resolve=>{if(typeof MessageChannel==='undefined'){setTimeout(resolve,0);return;}const c=new MessageChannel();c.port1.onmessage=()=>{c.port1.close();resolve();};c.port2.postMessage(0);});
  const clock=()=>typeof performance!=='undefined'?performance.now():Date.now();
  async function feedSliced(s,bytes){let t=clock();for(let o=0;o<bytes.length;o+=1<<20){shaFeed(s,bytes.subarray(o,Math.min(bytes.length,o+(1<<20))));if(clock()-t>25){await yieldNow();t=clock();}}return s;}
  // The running hash of a whole list (one write-out, as hashState does), kept only if finishing it gives the list's stored seal.
  async function logRebuild(rows,seal){const bytes=shaText.encode(JSON.stringify(rows)),s=await feedSliced(shaStart(),bytes.subarray(0,bytes.length-1));return logSeal(s)===seal?s:null;}
  const midSave=(s,rows)=>({v:1,h:Array.from(s.h),buf:Array.from(s.buf.subarray(0,s.n)),len:s.len,count:rows.length,last:rows.length?rows[rows.length-1].sequence:0});
  function midLoad(o,rows,seal){
    if(!o||o.v!==1||!Array.isArray(o.h)||o.h.length!==8||!Array.isArray(o.buf)||o.buf.length>63||!Number.isSafeInteger(o.len)||o.count!==rows.length||o.last!==(rows.length?rows[rows.length-1].sequence:0))return null;
    try{const s={h:new Uint32Array(o.h),buf:new Uint8Array(64),n:o.buf.length,len:o.len};s.buf.set(o.buf);return logSeal(s)===seal?s:null;}catch(e){return null;}
  }
  /* AX5b, the source rows: their seal stays the SHA-256 of all rows' JSON (sourcesSHA256, unchanged for reads, restores and older builds).
     For each committed (frozen) rows array the hash's running state is kept in memory every 1,024 rows. The next save finds the first
     row that is not the very same frozen row (a delivery appends new rows and replaces today's) and hashes only from the last kept state
     before it. The kept states of an array are built once per app session and kept only if they give its stored seal; a save that
     changes most rows (a restore, a roll-up) hashes everything as before. */
  const ROW_STEP=1024,rowStates=new WeakMap(),shaComma=shaText.encode(',');
  async function rowsHash(rows,base,start){
    const states=base?base.slice(0,start/ROW_STEP+1):[shaFeed(shaStart(),shaText.encode('['))],s=shaCopy(states[states.length-1]);let t=clock();
    for(let i=start;i<rows.length;i++){
      if(i>start&&i%ROW_STEP===0)states.push(shaCopy(s));
      if(i)shaFeed(s,shaComma);shaFeed(s,shaText.encode(JSON.stringify(rows[i])));
      if(clock()-t>25){await yieldNow();t=clock();}
    }
    return {seal:logSeal(s),states};
  }
  async function sourcesSeal(prev,prevSeal,rows){
    let same=0;const n=Math.min(prev.length,rows.length);while(same<n&&prev[same]===rows[same])same++;
    if(!isSealed(prev)||same<rows.length/2)return {seal:await hashState(rows),states:null};
    let base=rowStates.get(prev)||null;
    if(!base)try{const built=await rowsHash(prev,null,0);if(built.seal===prevSeal){base=built.states;rowStates.set(prev,base);}}catch(e){base=null;}
    if(!base)return {seal:await hashState(rows),states:null};
    return rowsHash(rows,base,Math.min(Math.floor(same/ROW_STEP),base.length-1)*ROW_STEP);
  }
  // Schema 2 (V3.0, Glow): the committed record and the health source rows are hashed separately, and
  // committed source rows are frozen and shared between copies, so a save that changes no source row
  // (every tap) never copies, compares or re-hashes them. Whether rows changed is an identity check:
  // an unchanged record keeps the very same frozen array.
  function recordPart(state){const out={};for(const name of Object.keys(state))if(name!=='sourceRecords')out[name]=state[name];return out;}
  function shareClone(state){const out={};for(const name of Object.keys(state))out[name]=name==='sourceRecords'&&Array.isArray(state[name])?state[name]:clone(state[name]);return out;}
  function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}return value;}
  // WebKit's Object.isFrozen walks every element of an array (V8 answers at once), and with 26,000 rows a
  // per-lookup isFrozen hung his Mac on first open of V3.0. Sealed row arrays are remembered here instead;
  // isSealed() is the O(1) test every caller uses (V3.0.1).
  const sealedRows=new WeakSet();
  function isSealed(rows){return Array.isArray(rows)&&sealedRows.has(rows);}
  function freezeSources(state){if(state&&Array.isArray(state.sourceRecords)&&!sealedRows.has(state.sourceRecords)){for(const row of state.sourceRecords)deepFreeze(row);Object.freeze(state.sourceRecords);sealedRows.add(state.sourceRecords);}return state;}
  function create(options){
    const opts=options||{},idb=opts.indexedDB||root.indexedDB,local=opts.localStorage||root.localStorage;
    const key=opts.key||'health-tracker-v1',dbName=opts.dbName||'health-tracker',markerKey=opts.markerKey||key+'.idb-authority',schema=opts.schema===2?2:1;
    const validate=opts.validateState||(()=>null);
    const sourceSignature=opts.sourceSignature||(record=>{const value=Object.assign({},record);delete value.importedAt;delete value.lastSeenAt;delete value.lastRetrievedAt;return JSON.stringify(value);});
    let database=null,opening=null;
    function marker(){
      const raw=local.getItem(markerKey);
      if(raw==null)return null;
      const value=JSON.parse(raw);
      if(!value||value.version!==1||value.database!==dbName||typeof value.authorityId!=='string')throw new Error('marker');
      return value;
    }
    function connect(){
      if(database)return Promise.resolve(database);
      if(opening)return opening;
      opening=new Promise((resolve,reject)=>{
        if(!idb){reject(new Error('unavailable'));return;}
        const req=idb.open(dbName,2);
        let settled=false;
        req.onupgradeneeded=()=>{
          const db=req.result;
          if(!db.objectStoreNames.contains('records'))db.createObjectStore('records');
          for(const name of TABLES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:name==='revisions'?'sequence':'id',autoIncrement:name==='revisions'});
        };
        req.onblocked=()=>{if(!settled){settled=true;reject(new Error('blocked'));}};
        req.onerror=()=>{if(!settled){settled=true;reject(req.error);}};
        req.onsuccess=()=>{
          if(settled){req.result.close();return;}
          settled=true;database=req.result;
          database.onversionchange=()=>{database.close();database=null;opening=null;};
          resolve(database);
        };
      }).finally(()=>{opening=null;});
      return opening;
    }
    function transaction(db,names,mode,run){
      return new Promise(resolve=>{
        let tx,result={ok:true},aborted=null;
        try{
          tx=db.transaction(names,mode);
          tx.oncomplete=()=>resolve(result);
          tx.onabort=()=>resolve(aborted||failed('STORAGE',message.STORAGE,{detail:tx.error?String(tx.error.name)+': '+String(tx.error.message).slice(0,200):'transaction aborted'}));
          tx.onerror=()=>{};
          run(tx,value=>{result=value;},value=>{aborted=value;try{tx.abort();}catch(e){resolve(value);}});
        }catch(e){if(tx)try{tx.abort();}catch(ignored){}resolve(failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)}));}
      });
    }
    function gather(tx,requests,done,abort){
      const values={};let remaining=requests.length;
      for(const [name,request] of requests){
        request.onsuccess=()=>{
          values[name]=request.result;
          if(--remaining===0)try{done(values);}catch(e){abort(failed('STORAGE',message.STORAGE));}
        };
      }
    }
    // The last record this tab verified or committed, kept privately so an ordinary save need not
    // re-read and re-hash the whole store first (about a third of every tap, V1.12). It is only a
    // starting point: the write transaction still compares the stored control hash, audit and
    // revision, and a mismatch drops the cache and retries once from a full read.
    let verified=null;
    // The control record's seal: one whole-state hash (schema 1), or the record and the source rows
    // hashed apart (schema 2) so a tap re-hashes only the record.
    async function sealFields(state,wholeSHA){return schema===1?{stateSHA256:wholeSHA||await hashState(state)}:{recordSHA256:await hashState(recordPart(state)),sourcesSHA256:await hashState(state.sourceRecords)};}
    async function sealMatches(control,state,wholeSHA){const f=await sealFields(state,wholeSHA);return Object.keys(f).every(k=>control[k]===f[k]);}
    async function snapshot(){
      const db=await connect();
      return transaction(db,TABLES,'readonly',(tx,set,abort)=>{
        gather(tx,[['control',tx.objectStore('meta').get('authority')],['app',tx.objectStore('meta').get('app')],['sources',tx.objectStore('sources').getAll()],['receipts',tx.objectStore('receipts').getAll()],['revisions',tx.objectStore('revisions').getAll()],['deliveries',tx.objectStore('deliveries').getAll()]],value=>set(Object.assign({ok:true},value)),abort);
      });
    }
    async function auditIdentity(revisions,deliveries){
      const [revisionsSHA256,deliveriesSHA256]=await Promise.all([hashState(revisions),hashState(deliveries)]);
      return {revisionCount:revisions.length,deliveryCount:deliveries.length,revisionsSHA256,deliveriesSHA256};
    }
    function parts(state,skipSources){
      const app={},order=Object.keys(state);
      for(const name of order)if(name!=='sourceRecords'&&name!=='importReceipts')app[name]=state[name];
      const rows=(values)=>{
        if(!Array.isArray(values))throw new Error('rows');
        const seen=new Set();
        return values.map((value,index)=>{
          if(!value||typeof value.id!=='string'||!value.id||seen.has(value.id))throw new Error('identity');
          seen.add(value.id);return {id:value.id,order:index,value};
        });
      };
      // skipSources: the caller already knows no source row changed, so the rows are not wrapped or compared.
      return {app:{id:'app',value:app,keyOrder:order},sources:skipSources?[]:rows(state.sourceRecords),receipts:rows(state.importReceipts)};
    }
    async function reconcile(value){
      if(!value.ok)return value;
      const c=value.control,a=value.app;
      if(!c){
        if(a||value.sources.length||value.receipts.length||value.revisions.length||value.deliveries.length)return failed('CORRUPT',message.CORRUPT);
        return {ok:true,state:null,authority:'legacy',needsMigration:true};
      }
      if(c.schema!==schema||!a||!Array.isArray(a.keyOrder)||c.sourceCount!==value.sources.length||c.receiptCount!==value.receipts.length)return failed('CORRUPT',message.CORRUPT);
      if(!c.audit||c.audit.revisionCount!==value.revisions.length||c.audit.deliveryCount!==value.deliveries.length)return failed('CORRUPT',message.CORRUPT);
      // Schema 2: pruned history leaves gaps (sequences only increase), and a compaction writes 'rollup' revisions.
      const badRevision=(row,index)=>schema===2&&row.entity==='rollup'?!(Number.isInteger(row.sequence)&&(index===0||row.sequence>value.revisions[index-1].sequence)&&typeof row.generation==='string'&&row.generation&&Number.isInteger(row.revision)&&row.revision>=1&&row.summary&&typeof row.summary==='object'):
        (schema===2?!(Number.isInteger(row.sequence)&&(index===0||row.sequence>value.revisions[index-1].sequence)):row.sequence!==index+1)||row.entity!=='source'||typeof row.generation!=='string'||!row.generation||!Number.isInteger(row.revision)||row.revision<1||typeof row.sourceId!=='string'||(!row.before&&!row.after)||(row.before&&row.before.id!==row.sourceId)||(row.after&&row.after.id!==row.sourceId);
      if(value.revisions.some(badRevision))return failed('CORRUPT',message.CORRUPT);
      if(value.deliveries.some(row=>!row.value||typeof row.generation!=='string'||!row.generation||!Number.isInteger(row.revision)||row.revision<1||typeof row.value.digest!=='string'||row.id!==JSON.stringify([row.generation,row.value.digest])))return failed('CORRUPT',message.CORRUPT);
      const audit=await auditIdentity(value.revisions,value.deliveries);
      if(audit.revisionsSHA256!==c.audit.revisionsSHA256||audit.deliveriesSHA256!==c.audit.deliveriesSHA256)return failed('CORRUPT',message.CORRUPT);
      function unpack(rows){
        rows.sort((x,y)=>x.order-y.order);
        if(rows.some((row,index)=>row.order!==index||!row.value||row.id!==row.value.id))throw new Error('order');
        return rows.map(row=>row.value);
      }
      const sourceRecords=unpack(value.sources),importReceipts=unpack(value.receipts),state={};
      for(const name of a.keyOrder){
        if(name==='sourceRecords')state[name]=sourceRecords;
        else if(name==='importReceipts')state[name]=importReceipts;
        else if(Object.prototype.hasOwnProperty.call(a.value,name))state[name]=a.value[name];
        else return failed('CORRUPT',message.CORRUPT);
      }
      if(!a.keyOrder.includes('sourceRecords')||!a.keyOrder.includes('importReceipts')||validate(state))return failed('CORRUPT',message.CORRUPT);
      if(schema===1?await hashState(state)!==c.stateSHA256:(await hashState(recordPart(state))!==c.recordSHA256||await hashState(state.sourceRecords)!==c.sourcesSHA256))return failed('CORRUPT',message.CORRUPT);
      if(schema===2)freezeSources(state);
      return {ok:true,state,authority:'indexeddb',control:c,revisions:value.revisions,deliveries:value.deliveries};
    }
    async function read(includeAudit=false){
      try{
        const mark=marker(),value=await reconcile(await snapshot());
        if(!value.ok)return value;
        if(!value.control)return mark?failed('CORRUPT',message.CORRUPT):value;
        if(!mark)return failed('STAGED',message.STAGED,{blockedMigration:true,needsMigration:true});
        if(mark.authorityId!==value.control.authorityId)return failed('CORRUPT',message.CORRUPT);
        verified={state:schema===2?shareClone(value.state):clone(value.state),control:value.control,revisions:value.revisions,deliveries:value.deliveries};
        return Object.assign({ok:true,state:value.state,authority:'indexeddb',revision:value.state.revision,generation:value.state.rewardGeneration},includeAudit?{control:value.control,revisions:value.revisions,deliveries:value.deliveries}:{});
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    async function migrate(state,options){
      verified=null;
      try{
        const supplied=clone(state),problem=validate(supplied),sha=await hashState(supplied),backup=options&&options.backup;
        if(problem||!backup||backup.verified!==true||typeof backup.id!=='string'||!backup.id||!/^[a-f0-9]{64}$/.test(backup.sha256||'')||backup.stateSHA256!==sha)return failed('MIGRATION',message.MIGRATION);
        const mark=marker();
        if(mark){const current=await read();return current.ok?Object.assign(current,{alreadyMigrated:true}):current;}
        let current=await reconcile(await snapshot());
        if(!current.ok)return current;
        if(current.control){
          if(!(await sealMatches(current.control,supplied,sha))||current.control.migration.stateSHA256!==sha)return failed('STAGED',message.STAGED,{blockedMigration:true});
        }else{
          const p=parts(supplied),authorityId=root.crypto.randomUUID(),db=await connect();
          const control={id:'authority',schema,authorityId,...(await sealFields(supplied,sha)),sourceCount:p.sources.length,receiptCount:p.receipts.length,audit:await auditIdentity([],[]),migration:{at:new Date().toISOString(),stateSHA256:sha,backup:clone(backup)}};
          const saved=await transaction(db,TABLES,'readwrite',(tx,set,abort)=>{
            gather(tx,[['control',tx.objectStore('meta').get('authority')],['sourceCount',tx.objectStore('sources').count()],['receiptCount',tx.objectStore('receipts').count()],['revisionCount',tx.objectStore('revisions').count()],['deliveryCount',tx.objectStore('deliveries').count()]],old=>{
              if(old.control||old.sourceCount||old.receiptCount||old.revisionCount||old.deliveryCount){abort(failed('CAS',message.CAS));return;}
              tx.objectStore('meta').put(control);tx.objectStore('meta').put(p.app);
              for(const row of p.sources)tx.objectStore('sources').put(row);
              for(const row of p.receipts)tx.objectStore('receipts').put(row);
              set({ok:true});
            },abort);
          });
          if(!saved.ok)return saved;
          current=await reconcile(await snapshot());
          if(!current.ok)return current;
        }
        if(!current.control||!(await sealMatches(current.control,supplied,sha)))return failed('CORRUPT',message.CORRUPT);
        try{
          local.setItem(markerKey,JSON.stringify({version:1,database:dbName,authorityId:current.control.authorityId}));
          const savedMarker=marker();
          if(!savedMarker||savedMarker.authorityId!==current.control.authorityId)throw new Error('marker');
        }catch(e){return failed('STAGED',message.STAGED,{blockedMigration:true,needsMigration:true});}
        const complete=await read();
        return complete.ok?Object.assign(complete,{migrated:true,snapshotSafe:true}):complete;
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    // V3.0: copy a record another engine has just verified (the V2.x database) into this empty schema-2
    // database, with its revision and delivery audit, then take authority here. The source database is
    // only read, never written, so the previous app version can still open it (rollback).
    async function adopt(state,from){
      verified=null;
      if(schema!==2||!from||typeof from.database!=='string'||from.database===dbName)return failed('MIGRATION',message.MIGRATION);
      try{
        const mark=marker();
        if(mark){const current=await read();return current.ok?Object.assign(current,{alreadyAdopted:true}):current;}
        const supplied=clone(state),problem=validate(supplied);if(problem)return failed('MIGRATION',message.MIGRATION);
        const revisions=Array.isArray(from.revisions)?from.revisions:[],deliveries=Array.isArray(from.deliveries)?from.deliveries:[];
        const seal=await sealFields(supplied),audit=await auditIdentity(revisions,deliveries);
        let current=await reconcile(await snapshot());
        if(!current.ok)return current;
        if(current.control){
          if(!(await sealMatches(current.control,supplied))||JSON.stringify(current.control.audit)!==JSON.stringify(audit))return failed('STAGED',message.STAGED,{blockedMigration:true});
        }else{
          const p=parts(supplied),authorityId=root.crypto.randomUUID(),db=await connect();
          const control={id:'authority',schema,authorityId,...seal,sourceCount:p.sources.length,receiptCount:p.receipts.length,audit,adopted:{at:new Date().toISOString(),from:{database:from.database,authorityId:typeof from.authorityId==='string'?from.authorityId:null,stateSHA256:typeof from.stateSHA256==='string'?from.stateSHA256:null,revision:supplied.revision||0}}};
          const saved=await transaction(db,TABLES,'readwrite',(tx,set,abort)=>{
            gather(tx,[['control',tx.objectStore('meta').get('authority')],['sourceCount',tx.objectStore('sources').count()],['receiptCount',tx.objectStore('receipts').count()],['revisionCount',tx.objectStore('revisions').count()],['deliveryCount',tx.objectStore('deliveries').count()]],old=>{
              if(old.control||old.sourceCount||old.receiptCount||old.revisionCount||old.deliveryCount){abort(failed('CAS',message.CAS));return;}
              tx.objectStore('meta').put(control);tx.objectStore('meta').put(p.app);
              for(const row of p.sources)tx.objectStore('sources').put(row);
              for(const row of p.receipts)tx.objectStore('receipts').put(row);
              for(const row of revisions)tx.objectStore('revisions').put(row);
              for(const row of deliveries)tx.objectStore('deliveries').put(row);
              set({ok:true});
            },abort);
          });
          if(!saved.ok)return saved;
          current=await reconcile(await snapshot());
          if(!current.ok)return current;
          if(!current.control||!(await sealMatches(current.control,supplied)))return failed('CORRUPT',message.CORRUPT);
        }
        try{
          local.setItem(markerKey,JSON.stringify({version:1,database:dbName,authorityId:current.control.authorityId}));
          const savedMarker=marker();
          if(!savedMarker||savedMarker.authorityId!==current.control.authorityId)throw new Error('marker');
        }catch(e){return failed('STAGED',message.STAGED,{blockedMigration:true,needsMigration:true});}
        const complete=await read();
        return complete.ok?Object.assign(complete,{adopted:true,snapshotSafe:true}):complete;
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    // Schema 2: "was this file delivered?" is one keyed lookup, not a full verified read of the store
    // (about a quarter of a second per file at 22 MB). Any later write still checks the whole seal.
    async function findDelivery(digest){
      try{
        const db=await connect();
        return await transaction(db,['meta','deliveries'],'readonly',(tx,set)=>{
          const app=tx.objectStore('meta').get('app');
          app.onsuccess=()=>{
            const generation=app.result&&app.result.value&&app.result.value.rewardGeneration;
            if(typeof generation!=='string'){set({ok:true,delivery:null});return;}
            const found=tx.objectStore('deliveries').get(JSON.stringify([generation,digest]));
            found.onsuccess=()=>set({ok:true,delivery:found.result?clone(found.result.value):null});
          };
        });
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    async function write(state,options){
      const cached=verified;verified=null;
      const result=await writeFrom(state,options,cached);
      // A cached starting point that another tab has since overtaken fails its CAS check; the same
      // save is then tried once from a full read, exactly as before the cache existed.
      if(cached&&!result.ok&&result.code==='CAS'){verified=null;return writeFrom(state,options,null);}
      return result;
    }
    async function writeFrom(state,options,cached){
      const config=options||{};
      if(config.delivery&&(config.replaceRewards||config.replayDeliveries))return failed('DELIVERY_RESTORE','An automatic delivery cannot also replace the workspace. Finish the reviewed restore before catching up on deliveries.');
      try{
        const previous=cached?{ok:true,authority:'indexeddb',state:cached.state,control:cached.control,revisions:cached.revisions,deliveries:cached.deliveries}:await read(true);if(!previous.ok)return previous;
        verified=null;
        if(previous.authority!=='indexeddb')return failed('MIGRATION',message.MIGRATION);
        const expectedRevision=config.expectedRevision===undefined?(state.revision||0):config.expectedRevision;
        const expectedGeneration=config.expectedGeneration===undefined?state.rewardGeneration:config.expectedGeneration;
        if(expectedRevision!==previous.state.revision||expectedGeneration!==previous.state.rewardGeneration)return failed('CAS',message.CAS);
        const next=schema===2?shareClone(state):clone(state),problem=validate(next);if(problem)return failed('INVALID','The proposed record was refused: '+problem);
        // Schema 2: the very same frozen array as the committed record means no source row changed.
        const sourcesSame=schema===2&&next.sourceRecords===previous.state.sourceRecords&&isSealed(next.sourceRecords);
        next.revision=expectedRevision+1;
        // The delivery ledger is scoped by generation, so deliveries already recorded would retire
        // every re-delivered file as a duplicate and the data would never come back. replayDeliveries
        // rotates the generation for exactly that reason, and unlike replaceRewards it does not
        // relax the claim or evidence guards below — nothing is being replaced, only re-read.
        next.rewardGeneration=config.replaceRewards||config.replayDeliveries?root.crypto.randomUUID():expectedGeneration;
        const nextParts=parts(next,sourcesSame),oldParts=parts(previous.state,sourcesSame);
        const oldSources=new Map(oldParts.sources.map(row=>[row.id,row])),newSources=new Map(nextParts.sources.map(row=>[row.id,row]));
        const oldReceipts=new Map(oldParts.receipts.map(row=>[row.id,row])),newReceipts=new Map(nextParts.receipts.map(row=>[row.id,row]));
        const removedSources=oldParts.sources.filter(row=>!newSources.has(row.id)),removedReceipts=oldParts.receipts.filter(row=>!newReceipts.has(row.id));
        // V3.1 compaction (schema 2): rolled-up minute rows leave the store, and their revision history
        // leaves with them, replaced by one 'rollup' revision that records what was pruned and its hash.
        const compaction=schema===2&&config.compaction&&typeof config.compaction==='object'?config.compaction:null;
        if(compaction&&removedReceipts.length)return failed('REMOVAL','A compaction removes source rows only.');
        if((removedSources.length||removedReceipts.length)&&!config.allowSourceRemoval&&!compaction)return failed('REMOVAL','Source history cannot disappear during an ordinary save. Use an explicit reviewed restore or undo.');
        const lostClaims=Object.keys(previous.state.rewards&&previous.state.rewards.claims||{}).some(id=>!Object.prototype.hasOwnProperty.call(next.rewards&&next.rewards.claims||{},id));
        if(lostClaims)return failed('CLAIMS','A save cannot erase existing reward claims. Reconcile corrections or merge the preserved ledger before restoring.');
        const lostEvidence=Object.keys(previous.state.rewards&&previous.state.rewards.evidence||{}).some(id=>!Object.prototype.hasOwnProperty.call(next.rewards&&next.rewards.evidence||{},id));
        if(lostEvidence&&!config.replaceRewards)return failed('EVIDENCE','An ordinary save cannot erase existing reward evidence. Keep its reservation and record a retraction instead.');
        const delivery=config.delivery?clone(config.delivery):null;
        if(delivery&&(typeof delivery.digest!=='string'||!delivery.digest))return failed('INVALID','A delivery needs its content digest before it can be saved.');
        const rowSeal=schema===2&&!sourcesSame?await sourcesSeal(previous.state.sourceRecords,previous.control.sourcesSHA256,next.sourceRecords):null;   // AX5b
        const seal=schema===1?{stateSHA256:await hashState(next)}:{recordSHA256:await hashState(recordPart(next)),sourcesSHA256:sourcesSame?previous.control.sourcesSHA256:rowSeal.seal};
        const priorSeal=JSON.stringify(schema===1?[previous.control.stateSHA256]:[previous.control.recordSHA256,previous.control.sourcesSHA256]),db=await connect(),at=new Date().toISOString();
        const newRevisions=[],changedSources=[];let committedControl=null;
        const prunedIds=compaction?new Set(removedSources.map(row=>row.id)):null;
        const pruned=prunedIds?previous.revisions.filter(row=>row.entity==='source'&&prunedIds.has(row.sourceId)):[];
        const keptRevisions=pruned.length?previous.revisions.filter(row=>!(row.entity==='source'&&prunedIds.has(row.sourceId))):previous.revisions;
        const lastSequence=previous.revisions.length?previous.revisions[previous.revisions.length-1].sequence:0;
        function revision(sourceId,before,after){newRevisions.push({sequence:lastSequence+newRevisions.length+1,entity:'source',sourceId,at,generation:next.rewardGeneration,revision:next.revision,deliveryDigest:delivery?delivery.digest:null,before,after});}
        for(const row of nextParts.sources){
          const before=oldSources.get(row.id);
          if(before&&before.value===row.value){if(before.order!==row.order)changedSources.push(row);continue;}   // AX5b: the same frozen row is unchanged; no need to write it out twice to compare
          const different=!before||JSON.stringify(before.value)!==JSON.stringify(row.value);
          if(!before||sourceSignature(before.value)!==sourceSignature(row.value))revision(row.id,before?before.value:null,row.value);
          if(different||before.order!==row.order)changedSources.push(row);
        }
        if(compaction)newRevisions.push({sequence:lastSequence+newRevisions.length+1,entity:'rollup',at,generation:next.rewardGeneration,revision:next.revision,summary:Object.assign(clone(compaction),{removedRows:removedSources.length,prunedRevisions:pruned.length,prunedSHA256:await hashState(pruned)})});
        else for(const row of removedSources)revision(row.id,row.value,null);
        const deliveryRow=delivery?{id:JSON.stringify([next.rewardGeneration,delivery.digest]),value:delivery,at,revision:next.revision,generation:next.rewardGeneration,sourceRevisionCount:newRevisions.length}:null;
        const nextDeliveries=deliveryRow?previous.deliveries.concat(deliveryRow).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0):previous.deliveries;
        // AX5b: new revisions are fed to the kept running hash. With none to resume (first time, an older build's write, the save after a
        // roll-up) it is rebuilt from the existing log and kept only if it gives the log's stored seal; a roll-up itself prunes the log, so
        // it hashes the whole log as before and leaves the rebuild to the next save.
        let revisionsMid=previous.control.revisionsMid||null,revisionsSHA256=previous.control.audit.revisionsSHA256;
        if(newRevisions.length||pruned.length){
          const all=keptRevisions.concat(newRevisions);let resumed=null;
          if(schema===2&&!pruned.length){resumed=midLoad(previous.control.revisionsMid,previous.revisions,previous.control.audit.revisionsSHA256);if(!resumed&&previous.revisions.length>=newRevisions.length)try{resumed=await logRebuild(previous.revisions,previous.control.audit.revisionsSHA256);}catch(e){resumed=null;}}
          if(resumed){logAppend(resumed,previous.revisions.length,newRevisions);revisionsSHA256=logSeal(resumed);revisionsMid=midSave(resumed,all);}
          else{revisionsSHA256=await hashState(all);revisionsMid=null;}
        }
        const deliveriesSHA256=deliveryRow?await hashState(nextDeliveries):previous.control.audit.deliveriesSHA256;
        const audit={revisionCount:keptRevisions.length+newRevisions.length,deliveryCount:nextDeliveries.length,revisionsSHA256,deliveriesSHA256};
        const saved=await transaction(db,TABLES,'readwrite',(tx,set,abort)=>{
          const requests=[['control',tx.objectStore('meta').get('authority')],['app',tx.objectStore('meta').get('app')],['sourceCount',tx.objectStore('sources').count()],['receiptCount',tx.objectStore('receipts').count()],['revisionCount',tx.objectStore('revisions').count()],['deliveryCount',tx.objectStore('deliveries').count()]];
          if(delivery)requests.push(['delivery',tx.objectStore('deliveries').get(JSON.stringify([expectedGeneration,delivery.digest]))]);
          gather(tx,requests,old=>{
            if(!old.control||!old.app||JSON.stringify(schema===1?[old.control.stateSHA256]:[old.control.recordSHA256,old.control.sourcesSHA256])!==priorSeal||JSON.stringify(old.control.audit)!==JSON.stringify(previous.control.audit)||old.app.value.revision!==expectedRevision||old.app.value.rewardGeneration!==expectedGeneration){abort(failed('CAS',message.CAS));return;}
            if(old.sourceCount!==old.control.sourceCount||old.receiptCount!==old.control.receiptCount||old.revisionCount!==old.control.audit.revisionCount||old.deliveryCount!==old.control.audit.deliveryCount){abort(failed('CORRUPT',message.CORRUPT));return;}
            if(old.delivery){set({ok:true,duplicateDelivery:true,state:previous.state,revision:expectedRevision,generation:expectedGeneration});return;}
            for(const row of pruned)tx.objectStore('revisions').delete(row.sequence);
            for(const row of newRevisions)tx.objectStore('revisions').add(row);
            for(const row of changedSources)tx.objectStore('sources').put(row);
            for(const row of removedSources)tx.objectStore('sources').delete(row.id);
            for(const row of nextParts.receipts){
              const before=oldReceipts.get(row.id);
              if(!before||JSON.stringify(before)!==JSON.stringify(row))tx.objectStore('receipts').put(row);
            }
            for(const row of removedReceipts)tx.objectStore('receipts').delete(row.id);
            if(deliveryRow)tx.objectStore('deliveries').add(deliveryRow);
            tx.objectStore('meta').put(nextParts.app);
            committedControl=Object.assign({},old.control,seal,{sourceCount:next.sourceRecords.length,receiptCount:nextParts.receipts.length,audit,revisionsMid,lastCommit:{at,revision:next.revision,deliveryDigest:delivery?delivery.digest:null}});
            tx.objectStore('meta').put(committedControl);
            set({ok:true,snapshotSafe:true,sourceRevisionCount:newRevisions.length,revision:next.revision,generation:next.rewardGeneration});
          },abort);
        });
        if(saved.ok&&!saved.duplicateDelivery){if(schema===2){freezeSources(next);if(rowSeal&&rowSeal.states)rowStates.set(next.sourceRecords,rowSeal.states);}state.revision=next.revision;state.rewardGeneration=next.rewardGeneration;verified={state:next,control:committedControl,revisions:newRevisions.length||pruned.length?keptRevisions.concat(newRevisions):previous.revisions,deliveries:nextDeliveries};}
        else if(saved.ok&&saved.duplicateDelivery&&cached)verified=cached;
        return saved;
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    async function list(name,id){
      try{
        const ready=await read(true);if(!ready.ok)return ready;
        if(ready.authority!=='indexeddb')return {ok:true,items:[],delivery:null};
        const rows=ready[name];
        // Copies: these rows are also the cached starting point for the next write.
        if(id===undefined)return {ok:true,items:clone(rows.filter(row=>name!=='deliveries'||row.generation===ready.state.rewardGeneration).map(row=>name==='deliveries'?row.value:row))};
        const found=rows.find(row=>row.id===JSON.stringify([ready.state.rewardGeneration,id]));
        return {ok:true,delivery:found?clone(found.value):null};
      }catch(e){return failed('STORAGE',message.STORAGE,{detail:String((e&&e.name)||'Error')+': '+String((e&&e.message)||'').slice(0,200)});}
    }
    return {open:read,read,migrate,adopt,write,writeClaims:write,schema,readDelivery:digest=>schema===2?findDelivery(digest):list('deliveries',digest),deliveries:()=>list('deliveries'),revisions:()=>list('revisions'),close(){if(database)database.close();database=null;opening=null;},markerKey,dbName};
  }
  // sealRows (AX5b): freeze and share rows a save is about to commit, so copies of the record share them and the save compares only what changed.
  const api={create,hashState,isSealed,sealRows:rows=>freezeSources({sourceRecords:rows}).sourceRecords,sha:{start:shaStart,feed:shaFeed,hex:shaHex,copy:shaCopy,logOpen,logAppend,logSeal,logRebuild,midSave,midLoad,rowsHash,sourcesSeal}};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.HealthStore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
