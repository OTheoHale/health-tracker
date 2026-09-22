/* Manual volume events and saved meals. No targets, action confirmations or awards.
   Ingredient nutrition describes `quantity` of `unit`; meal ingredient quantities use
   that same unit, and meal.servings is the recipe yield. Food snapshots never follow
   later template edits. merge() mutates only these collections, atomically; callers
   must not run the legacy food merge afterward. Deletes win over old exports.
   Undo may restore the caller's complete pre-operation state snapshot. */
(function(root){
  'use strict';
  const KEYS=['waterEvents','waterCandidates','ingredients','meals','foods','mealWaterTombstones'];
  const NUTRIENTS=['calories','proteinG','carbsG','fatG','fiberG','sodiumMg'];
  const UNITS={'US fl oz':29.5735295625,ml:1,l:1000};
  const clone=x=>JSON.parse(JSON.stringify(x));
  const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
  const owns=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
  const fail=error=>({ok:false,error});
  const idOK=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
  const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0&&x<=1e9;
  const text=(x,n)=>typeof x==='string'&&x.trim().length>0&&x.length<=n;
  const timeOK=x=>x===''||typeof x==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  function dateOK(x){
    if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;
    const t=new Date(x+'T00:00:00Z');
    return Number.isFinite(t.getTime())&&t.toISOString().slice(0,10)===x;
  }
  const stampOK=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
  const near=(a,b)=>Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
  function stable(x){
    if(Array.isArray(x))return '['+x.map(stable).join(',')+']';
    if(object(x))return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
    return JSON.stringify(x);
  }
  function sameTemplate(a,b){
    const data=r=>Object.fromEntries(Object.entries(r).filter(([key])=>!['mwVersion','revision','createdAt','updatedAt'].includes(key)));
    return stable(data(a))===stable(data(b));
  }
  function makeId(prefix){
    const value=root.crypto&&root.crypto.randomUUID?root.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    return prefix+'-'+value;
  }
  function ensure(state){
    if(!object(state))return state;
    for(const k of KEYS.slice(0,-1))if(state[k]===undefined)state[k]=[];
    if(state.mealWaterTombstones===undefined)state.mealWaterTombstones={water:[],food:[]};
    return state;
  }
  function meta(previous){
    const time=new Date(Math.max(Date.now(),(Date.parse(previous&&previous.updatedAt)||0)+1)).toISOString();
    return {mwVersion:1,revision:(previous&&previous.revision||0)+1,createdAt:previous&&previous.createdAt||time,updatedAt:time};
  }
  function metaOK(r){return r.mwVersion===1&&Number.isSafeInteger(r.revision)&&r.revision>0&&stampOK(r.createdAt)&&stampOK(r.updatedAt)&&Date.parse(r.updatedAt)>=Date.parse(r.createdAt);}
  function nutrition(value){
    if(value!==undefined&&value!==null&&(!object(value)||Object.keys(value).some(k=>!NUTRIENTS.includes(k))))return null;
    const n={};for(const k of NUTRIENTS)n[k]=value&&value[k]!==undefined?value[k]:null;
    return n;
  }
  function nutritionOK(n){return object(n)&&Object.keys(n).every(k=>NUTRIENTS.includes(k))&&NUTRIENTS.every(k=>n[k]===null||typeof n[k]==='number'&&Number.isFinite(n[k])&&n[k]>=0&&n[k]<=1e12);}
  function waterOK(r,candidate){
    return object(r)&&idOK(r.id)&&dateOK(r.date)&&timeOK(r.time)&&positive(r.value)&&owns(UNITS,r.unit)&&
      Number.isFinite(r.volumeMl)&&near(r.volumeMl,r.value*UNITS[r.unit])&&
      (candidate?r.origin==='imported'&&r.status==='held'&&idOK(r.sourceId):r.origin==='self-reported'&&metaOK(r));
  }
  function ingredientOK(r){return object(r)&&idOK(r.id)&&text(r.label,80)&&positive(r.quantity)&&text(r.unit,30)&&nutritionOK(r.nutrition)&&metaOK(r);}
  function recipeOK(r,ingredients){
    return object(r)&&idOK(r.id)&&text(r.label,80)&&positive(r.servings)&&metaOK(r)&&Array.isArray(r.ingredients)&&r.ingredients.length>0&&r.ingredients.length<=200&&
      new Set(r.ingredients.map(i=>i&&i.ingredientId)).size===r.ingredients.length&&r.ingredients.every(i=>object(i)&&idOK(i.ingredientId)&&positive(i.quantity)&&text(i.unit,30)&&ingredients.some(x=>x.id===i.ingredientId&&x.unit===i.unit));
  }
  function totals(snapshot,servings){
    const out={};for(const k of NUTRIENTS)out[k]=0;
    for(const i of snapshot.ingredients)for(const k of NUTRIENTS){
      if(out[k]===null)continue;
      out[k]=i.nutrition[k]===null?null:out[k]+i.nutrition[k]*(i.quantity/i.referenceQuantity)*(servings/snapshot.yieldServings);
    }
    return out;
  }
  function snapshotOK(s){
    return object(s)&&idOK(s.id)&&text(s.label,80)&&Number.isSafeInteger(s.revision)&&s.revision>0&&positive(s.yieldServings)&&Array.isArray(s.ingredients)&&s.ingredients.length>0&&s.ingredients.length<=200&&
      new Set(s.ingredients.map(i=>i&&i.ingredientId)).size===s.ingredients.length&&s.ingredients.every(i=>object(i)&&idOK(i.ingredientId)&&text(i.label,80)&&Number.isSafeInteger(i.ingredientRevision)&&i.ingredientRevision>0&&positive(i.quantity)&&positive(i.referenceQuantity)&&text(i.unit,30)&&nutritionOK(i.nutrition));
  }
  function foodOK(f){
    if(!object(f)||!idOK(f.id)||typeof f.date!=='string')return false;
    if(f.mwVersion===undefined)return true; // Preserve existing, source-attributed entries unchanged.
    if(!metaOK(f)||!dateOK(f.date)||!timeOK(f.time)||!text(f.label,80))return false;
    if(f.origin!==undefined&&typeof f.origin!=='string'||f.location!==undefined&&!['home','away','unknown'].includes(f.location)||
      f.timePrecision!==undefined&&!['exact','approximate'].includes(f.timePrecision)||f.actionId!==undefined&&f.actionId!==null&&!idOK(f.actionId)||
      f.tag!==undefined&&!['first','main','dinner','snack','drink','other'].includes(f.tag)||f.notes!==undefined&&(typeof f.notes!=='string'||f.notes.length>4000))return false;
    if(f.mealSnapshot===undefined)return true;
    if(!snapshotOK(f.mealSnapshot)||!positive(f.servings)||f.mealId!==f.mealSnapshot.id||!nutritionOK(f.nutrition))return false;
    const expected=totals(f.mealSnapshot,f.servings);
    return nutritionOK(expected)&&NUTRIENTS.every(k=>expected[k]===null?f.nutrition[k]===null:typeof f.nutrition[k]==='number'&&near(expected[k],f.nutrition[k]));
  }
  function validate(state){
    if(!object(state))return 'Meal and water state is malformed.';
    const s=Object.assign({},state);ensure(s);
    for(const k of KEYS.slice(0,-1))if(!Array.isArray(s[k]))return 'The '+k+' collection is malformed.';
    const seen=new Set();
    for(const k of KEYS.slice(0,-1))for(const r of s[k]){
      if(!r||!idOK(r.id)||seen.has(r.id))return 'A meal or water ID is missing, invalid or duplicated.';
      seen.add(r.id);
    }
    if(s.waterEvents.some(r=>!waterOK(r,false)))return 'A water event has invalid volume, units, date or revision.';
    if(s.waterCandidates.some(r=>!waterOK(r,true)))return 'An imported water candidate is malformed; imported volume stays held.';
    if(s.ingredients.some(r=>!ingredientOK(r)))return 'An ingredient quantity, nutrition or revision is malformed.';
    if(s.meals.some(r=>!recipeOK(r,s.ingredients)))return 'A meal has invalid servings or ingredient references.';
    if(s.foods.some(r=>!foodOK(r)))return 'A food entry or frozen meal snapshot is malformed.';
    const t=s.mealWaterTombstones;
    if(!object(t)||!Array.isArray(t.water)||!Array.isArray(t.food))return 'Meal and water deletion records are malformed.';
    const deleted=new Set();
    for(const kind of ['water','food'])for(const r of t[kind]){
      if(!object(r)||!idOK(r.id)||!Number.isSafeInteger(r.revision)||r.revision<1||!stampOK(r.updatedAt)||deleted.has(r.id)||seen.has(r.id))return 'A meal or water deletion record is invalid or conflicts with an active record.';
      deleted.add(r.id);
    }
    return null;
  }
  function transaction(state,work){
    const error=validate(state);if(error)return fail(error);
    const next={};for(const k of KEYS)if(state[k]!==undefined)next[k]=clone(state[k]);ensure(next);
    const result=work(next);if(!result.ok)return result;
    const invalid=validate(next);if(invalid)return fail(invalid);
    for(const k of KEYS)state[k]=next[k];
    return result.record?Object.assign({},result,{record:clone(result.record)}):result;
  }
  function idAvailable(state,id){
    return idOK(id)&&!KEYS.slice(0,-1).some(k=>state[k].some(x=>x.id===id))&&!['water','food'].some(k=>state.mealWaterTombstones[k].some(x=>x.id===id));
  }
  function addWater(state,fields){
    const f=fields||{};
    return transaction(state,s=>{
      const id=f.id===undefined?makeId('water'):f.id;
      const record=Object.assign({id,date:f.date,time:f.time===undefined?'':f.time,value:f.value,unit:f.unit,volumeMl:f.value*UNITS[f.unit],origin:'self-reported'},meta());
      if(!waterOK(record,false))return fail('Enter a positive volume, a supported unit and a valid date/time.');
      const existing=s.waterEvents.find(x=>x.id===id);
      if(existing){return ['date','time','value','unit'].every(k=>existing[k]===record[k])?{ok:true,record:existing,unchanged:true}:fail('That water ID already belongs to a different entry.');}
      if(!idAvailable(s,id))return fail('That ID is already used or was deleted.');
      s.waterEvents.push(record);return {ok:true,record};
    });
  }
  function editWater(state,id,changes){
    return transaction(state,s=>{
      const r=s.waterEvents.find(x=>x.id===id);if(!r)return fail('Water entry not found.');
      const c=changes||{};if(Object.keys(c).some(k=>!['date','time','value','unit'].includes(k)))return fail('Only water date, time, volume and units may be edited.');
      if(Object.keys(c).every(k=>r[k]===c[k]))return {ok:true,record:r,unchanged:true};
      const next=Object.assign({},r,c,meta(r));next.volumeMl=next.value*UNITS[next.unit];
      if(!waterOK(next,false))return fail('Enter a positive volume, a supported unit and a valid date/time.');
      Object.assign(r,next);return {ok:true,record:r};
    });
  }
  function remove(state,id,kind){
    return transaction(state,s=>{
      const key=kind==='water'?'waterEvents':'foods',i=s[key].findIndex(x=>x.id===id);
      if(i<0)return s.mealWaterTombstones[kind].some(x=>x.id===id)?{ok:true,unchanged:true}:fail('Entry not found.');
      const r=s[key][i],m=meta(r);s.mealWaterTombstones[kind].push({id,revision:m.revision,updatedAt:m.updatedAt});
      s[key].splice(i,1);return {ok:true,record:r};
    });
  }
  function waterSummary(state,date){
    const events=(state.waterEvents||[]).filter(x=>x.date===date);
    const candidates=(state.waterCandidates||[]).filter(x=>x.date===date);
    const mins=t=>t?+t.slice(0,2)*60 + +t.slice(3):null;
    const possibleDuplicates=[];
    for(const c of candidates)for(const m of events){
      const ct=mins(c.time),mt=mins(m.time);
      if(Math.abs(c.volumeMl-m.volumeMl)<=Math.max(1,m.volumeMl*.1)&&(ct===null||mt===null||Math.abs(ct-mt)<=60))possibleDuplicates.push({manualId:m.id,candidateId:c.id,reason:'Similar volume on the same day; review before combining.'});
    }
    const volumeMl=events.reduce((n,x)=>n+x.volumeMl,0);
    return {date,manual:{volumeMl,usFlOz:Number((volumeMl/UNITS['US fl oz']).toPrecision(15)),events:clone(events),originalUnits:events.map(x=>({id:x.id,value:x.value,unit:x.unit}))},legacy:{count:state.hydration&&state.hydration[date]||0,unit:'glasses',volumeMl:null},heldCandidates:clone(candidates),possibleDuplicates};
  }
  function saveIngredient(state,fields){
    const f=fields||{};
    return transaction(state,s=>{
      const id=f.id===undefined?makeId('ingredient'):f.id,r=s.ingredients.find(x=>x.id===id);
      if(!r&&!idAvailable(s,id))return fail('That ID is already used or was deleted.');
      const next=Object.assign({},r||{},f,{id},meta(r));next.nutrition=nutrition(f.nutrition===undefined&&r?r.nutrition:f.nutrition);
      if(!ingredientOK(next))return fail('Supply an ingredient name, positive reference quantity, unit and valid known nutrition.');
      if(r&&sameTemplate(r,next))return {ok:true,record:r,unchanged:true};
      if(r)Object.assign(r,next);else s.ingredients.push(next);return {ok:true,record:next};
    });
  }
  function saveMeal(state,fields){
    const f=fields||{};
    return transaction(state,s=>{
      const id=f.id===undefined?makeId('meal'):f.id,r=s.meals.find(x=>x.id===id);
      if(!r&&!idAvailable(s,id))return fail('That ID is already used or was deleted.');
      const next=Object.assign({},r||{},clone(f),{id},meta(r));
      if(!recipeOK(next,s.ingredients))return fail('Supply a meal name, positive serving yield and saved ingredient quantities in their reference units.');
      if(r&&sameTemplate(r,next))return {ok:true,record:r,unchanged:true};
      if(r)Object.assign(r,next);else s.meals.push(next);return {ok:true,record:next};
    });
  }
  function consumeMeal(state,fields){
    const f=fields||{};
    return transaction(state,s=>{
      const id=f.id===undefined?makeId('food'):f.id,existing=s.foods.find(x=>x.id===id),time=f.time===undefined?'':f.time;
      if(existing)return existing.mealId===f.mealId&&existing.date===f.date&&existing.time===time&&existing.servings===f.servings?{ok:true,record:existing,unchanged:true}:fail('That food ID already belongs to a different entry.');
      if(!idAvailable(s,id))return fail('That ID is already used or was deleted.');
      const meal=s.meals.find(x=>x.id===f.mealId);if(!meal)return fail('Saved meal not found.');
      if(!positive(f.servings)||!dateOK(f.date)||!timeOK(time))return fail('Enter positive servings and a valid date/time.');
      const snapshot={id:meal.id,label:meal.label,revision:meal.revision,yieldServings:meal.servings,ingredients:meal.ingredients.map(i=>{const source=s.ingredients.find(x=>x.id===i.ingredientId);return {ingredientId:source.id,ingredientRevision:source.revision,label:source.label,quantity:i.quantity,unit:i.unit,referenceQuantity:source.quantity,nutrition:clone(source.nutrition)};})};
      const r=Object.assign({id,date:f.date,time,label:meal.label,origin:'self-reported',location:'unknown',timePrecision:time?'exact':'approximate',actionId:null,tag:'other',notes:'',mealId:meal.id,servings:f.servings,mealSnapshot:snapshot,nutrition:totals(snapshot,f.servings)},meta());
      s.foods.push(r);return {ok:true,record:r};
    });
  }
  function editConsumption(state,id,changes){
    return transaction(state,s=>{
      const r=s.foods.find(x=>x.id===id);if(!r)return fail('Food entry not found.');
      const c=changes||{};
      if(Object.keys(c).some(k=>!['date','time','label','tag','notes','location','timePrecision','actionId','servings'].includes(k)))return fail('Food identity and saved ingredient snapshots cannot be overwritten.');
      if(owns(c,'servings')&&!r.mealSnapshot)return fail('This legacy entry has no saved portion snapshot.');
      if(Object.keys(c).every(k=>r[k]===c[k]))return {ok:true,record:r,unchanged:true};
      const next=Object.assign({},r,c,meta(r));
      if(next.mealSnapshot)next.nutrition=totals(next.mealSnapshot,next.servings);
      if(!foodOK(next))return fail('Supply a valid food label, date, time and positive servings.');
      Object.assign(r,next);return {ok:true,record:r};
    });
  }
  function merge(state,incoming){
    const e=validate(incoming);if(e)return fail(e);
    const inc=clone(incoming);ensure(inc);
    return transaction(state,s=>{
      const counts={waterEvents:0,waterCandidates:0,ingredients:0,meals:0,foods:0,tombstones:0};
      for(const kind of ['water','food'])for(const t of inc.mealWaterTombstones[kind]){
        const current=s.mealWaterTombstones[kind].find(x=>x.id===t.id);
        if(!current){s.mealWaterTombstones[kind].push(clone(t));counts.tombstones++;}
        else if(t.revision>current.revision||t.revision===current.revision&&t.updatedAt>current.updatedAt)Object.assign(current,t);
      }
      for(const key of KEYS.slice(0,-1)){
        const kind=key==='waterEvents'?'water':key==='foods'?'food':null;
        const tombs=kind?s.mealWaterTombstones[kind]:[];
        const previousLength=s[key].length;
        s[key]=s[key].filter(r=>!tombs.some(t=>t.id===r.id));
        counts[key]+=previousLength-s[key].length;
        for(const r of inc[key]){
          if(tombs.some(t=>t.id===r.id))continue;
          const i=s[key].findIndex(x=>x.id===r.id);
          if(i<0){s[key].push(clone(r));counts[key]++;continue;}
          const old=s[key][i],rr=r.revision||0,ro=old.revision||0;
          if(stable(r)===stable(old))continue;
          if(rr>ro){s[key][i]=clone(r);counts[key]++;}
          else if(rr===ro&&rr===0){
            if((Date.parse(r.updatedAt)||0)>(Date.parse(old.updatedAt)||0)){s[key][i]=clone(r);counts[key]++;}
            else if((Date.parse(r.updatedAt)||0)===(Date.parse(old.updatedAt)||0))return fail('Conflicting '+key+' entry '+r.id+' needs explicit reconciliation.');
          }else if(rr===ro)return fail('Conflicting '+key+' revision for '+r.id+' needs explicit reconciliation.');
        }
      }
      return {ok:true,counts};
    });
  }
  const api={ensure,validate,addWater,editWater,deleteWater:(s,id)=>remove(s,id,'water'),waterSummary,saveIngredient,saveMeal,consumeMeal,editConsumption,deleteConsumption:(s,id)=>remove(s,id,'food'),merge};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.MealWater=api;
})(typeof globalThis!=='undefined'?globalThis:this);
