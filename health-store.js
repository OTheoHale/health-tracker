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
  function create(options){
    const opts=options||{},idb=opts.indexedDB||root.indexedDB,local=opts.localStorage||root.localStorage;
    const key=opts.key||'health-tracker-v1',dbName=opts.dbName||'health-tracker',markerKey=key+'.idb-authority';
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
    function parts(state){
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
      return {app:{id:'app',value:app,keyOrder:order},sources:rows(state.sourceRecords),receipts:rows(state.importReceipts)};
    }
    async function reconcile(value){
      if(!value.ok)return value;
      const c=value.control,a=value.app;
      if(!c){
        if(a||value.sources.length||value.receipts.length||value.revisions.length||value.deliveries.length)return failed('CORRUPT',message.CORRUPT);
        return {ok:true,state:null,authority:'legacy',needsMigration:true};
      }
      if(c.schema!==1||!a||!Array.isArray(a.keyOrder)||c.sourceCount!==value.sources.length||c.receiptCount!==value.receipts.length)return failed('CORRUPT',message.CORRUPT);
      if(!c.audit||c.audit.revisionCount!==value.revisions.length||c.audit.deliveryCount!==value.deliveries.length)return failed('CORRUPT',message.CORRUPT);
      if(value.revisions.some((row,index)=>row.sequence!==index+1||row.entity!=='source'||typeof row.generation!=='string'||!row.generation||!Number.isInteger(row.revision)||row.revision<1||typeof row.sourceId!=='string'||(!row.before&&!row.after)||(row.before&&row.before.id!==row.sourceId)||(row.after&&row.after.id!==row.sourceId)))return failed('CORRUPT',message.CORRUPT);
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
      if(!a.keyOrder.includes('sourceRecords')||!a.keyOrder.includes('importReceipts')||validate(state)||await hashState(state)!==c.stateSHA256)return failed('CORRUPT',message.CORRUPT);
      return {ok:true,state,authority:'indexeddb',control:c,revisions:value.revisions,deliveries:value.deliveries};
    }
    async function read(includeAudit=false){
      try{
        const mark=marker(),value=await reconcile(await snapshot());
        if(!value.ok)return value;
        if(!value.control)return mark?failed('CORRUPT',message.CORRUPT):value;
        if(!mark)return failed('STAGED',message.STAGED,{blockedMigration:true,needsMigration:true});
        if(mark.authorityId!==value.control.authorityId)return failed('CORRUPT',message.CORRUPT);
        verified={state:clone(value.state),control:value.control,revisions:value.revisions,deliveries:value.deliveries};
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
          if(current.control.stateSHA256!==sha||current.control.migration.stateSHA256!==sha)return failed('STAGED',message.STAGED,{blockedMigration:true});
        }else{
          const p=parts(supplied),authorityId=root.crypto.randomUUID(),db=await connect();
          const control={id:'authority',schema:1,authorityId,stateSHA256:sha,sourceCount:p.sources.length,receiptCount:p.receipts.length,audit:await auditIdentity([],[]),migration:{at:new Date().toISOString(),stateSHA256:sha,backup:clone(backup)}};
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
        if(!current.control||current.control.stateSHA256!==sha)return failed('CORRUPT',message.CORRUPT);
        try{
          local.setItem(markerKey,JSON.stringify({version:1,database:dbName,authorityId:current.control.authorityId}));
          const savedMarker=marker();
          if(!savedMarker||savedMarker.authorityId!==current.control.authorityId)throw new Error('marker');
        }catch(e){return failed('STAGED',message.STAGED,{blockedMigration:true,needsMigration:true});}
        const complete=await read();
        return complete.ok?Object.assign(complete,{migrated:true,snapshotSafe:true}):complete;
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
        const next=clone(state),problem=validate(next);if(problem)return failed('INVALID','The proposed record was refused: '+problem);
        next.revision=expectedRevision+1;
        // The delivery ledger is scoped by generation, so deliveries already recorded would retire
        // every re-delivered file as a duplicate and the data would never come back. replayDeliveries
        // rotates the generation for exactly that reason, and unlike replaceRewards it does not
        // relax the claim or evidence guards below — nothing is being replaced, only re-read.
        next.rewardGeneration=config.replaceRewards||config.replayDeliveries?root.crypto.randomUUID():expectedGeneration;
        const nextParts=parts(next),oldParts=parts(previous.state);
        const oldSources=new Map(oldParts.sources.map(row=>[row.id,row])),newSources=new Map(nextParts.sources.map(row=>[row.id,row]));
        const oldReceipts=new Map(oldParts.receipts.map(row=>[row.id,row])),newReceipts=new Map(nextParts.receipts.map(row=>[row.id,row]));
        const removedSources=oldParts.sources.filter(row=>!newSources.has(row.id)),removedReceipts=oldParts.receipts.filter(row=>!newReceipts.has(row.id));
        if((removedSources.length||removedReceipts.length)&&!config.allowSourceRemoval)return failed('REMOVAL','Source history cannot disappear during an ordinary save. Use an explicit reviewed restore or undo.');
        const lostClaims=Object.keys(previous.state.rewards&&previous.state.rewards.claims||{}).some(id=>!Object.prototype.hasOwnProperty.call(next.rewards&&next.rewards.claims||{},id));
        if(lostClaims)return failed('CLAIMS','A save cannot erase existing reward claims. Reconcile corrections or merge the preserved ledger before restoring.');
        const lostEvidence=Object.keys(previous.state.rewards&&previous.state.rewards.evidence||{}).some(id=>!Object.prototype.hasOwnProperty.call(next.rewards&&next.rewards.evidence||{},id));
        if(lostEvidence&&!config.replaceRewards)return failed('EVIDENCE','An ordinary save cannot erase existing reward evidence. Keep its reservation and record a retraction instead.');
        const delivery=config.delivery?clone(config.delivery):null;
        if(delivery&&(typeof delivery.digest!=='string'||!delivery.digest))return failed('INVALID','A delivery needs its content digest before it can be saved.');
        const stateSHA256=await hashState(next),priorSHA256=previous.control.stateSHA256,db=await connect(),at=new Date().toISOString();
        const newRevisions=[],changedSources=[];let committedControl=null;
        function revision(sourceId,before,after){newRevisions.push({sequence:previous.revisions.length+newRevisions.length+1,entity:'source',sourceId,at,generation:next.rewardGeneration,revision:next.revision,deliveryDigest:delivery?delivery.digest:null,before,after});}
        for(const row of nextParts.sources){
          const before=oldSources.get(row.id),different=!before||JSON.stringify(before.value)!==JSON.stringify(row.value);
          if(!before||sourceSignature(before.value)!==sourceSignature(row.value))revision(row.id,before?before.value:null,row.value);
          if(different||before.order!==row.order)changedSources.push(row);
        }
        for(const row of removedSources)revision(row.id,row.value,null);
        const deliveryRow=delivery?{id:JSON.stringify([next.rewardGeneration,delivery.digest]),value:delivery,at,revision:next.revision,generation:next.rewardGeneration,sourceRevisionCount:newRevisions.length}:null;
        const nextDeliveries=deliveryRow?previous.deliveries.concat(deliveryRow).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0):previous.deliveries;
        const [revisionsSHA256,deliveriesSHA256]=await Promise.all([newRevisions.length?hashState(previous.revisions.concat(newRevisions)):previous.control.audit.revisionsSHA256,deliveryRow?hashState(nextDeliveries):previous.control.audit.deliveriesSHA256]);
        const audit={revisionCount:previous.revisions.length+newRevisions.length,deliveryCount:nextDeliveries.length,revisionsSHA256,deliveriesSHA256};
        const saved=await transaction(db,TABLES,'readwrite',(tx,set,abort)=>{
          const requests=[['control',tx.objectStore('meta').get('authority')],['app',tx.objectStore('meta').get('app')],['sourceCount',tx.objectStore('sources').count()],['receiptCount',tx.objectStore('receipts').count()],['revisionCount',tx.objectStore('revisions').count()],['deliveryCount',tx.objectStore('deliveries').count()]];
          if(delivery)requests.push(['delivery',tx.objectStore('deliveries').get(JSON.stringify([expectedGeneration,delivery.digest]))]);
          gather(tx,requests,old=>{
            if(!old.control||!old.app||old.control.stateSHA256!==priorSHA256||JSON.stringify(old.control.audit)!==JSON.stringify(previous.control.audit)||old.app.value.revision!==expectedRevision||old.app.value.rewardGeneration!==expectedGeneration){abort(failed('CAS',message.CAS));return;}
            if(old.sourceCount!==old.control.sourceCount||old.receiptCount!==old.control.receiptCount||old.revisionCount!==old.control.audit.revisionCount||old.deliveryCount!==old.control.audit.deliveryCount){abort(failed('CORRUPT',message.CORRUPT));return;}
            if(old.delivery){set({ok:true,duplicateDelivery:true,state:previous.state,revision:expectedRevision,generation:expectedGeneration});return;}
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
            committedControl=Object.assign({},old.control,{stateSHA256,sourceCount:nextParts.sources.length,receiptCount:nextParts.receipts.length,audit,lastCommit:{at,revision:next.revision,deliveryDigest:delivery?delivery.digest:null}});
            tx.objectStore('meta').put(committedControl);
            set({ok:true,snapshotSafe:true,sourceRevisionCount:newRevisions.length,revision:next.revision,generation:next.rewardGeneration});
          },abort);
        });
        if(saved.ok&&!saved.duplicateDelivery){state.revision=next.revision;state.rewardGeneration=next.rewardGeneration;verified={state:next,control:committedControl,revisions:newRevisions.length?previous.revisions.concat(newRevisions):previous.revisions,deliveries:nextDeliveries};}
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
    return {open:read,read,migrate,write,writeClaims:write,readDelivery:digest=>list('deliveries',digest),deliveries:()=>list('deliveries'),revisions:()=>list('revisions'),close(){if(database)database.close();database=null;opening=null;},markerKey,dbName};
  }
  const api={create,hashState};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.HealthStore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
