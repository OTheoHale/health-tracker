/* Reviewable routine fields only. Building a proposal never reads a store,
   adopts a schedule, confirms an action or creates a reward entitlement.
   Existing identities and category assignments must be reconciled by the
   migration preview before these fallback IDs can be added. */
(function(root){
  'use strict';
  function validDate(date){
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
    const parsed=new Date(date+'T12:00:00Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date;
  }
  function monday(date){
    const parsed=new Date(date+'T12:00:00Z');
    parsed.setUTCDate(parsed.getUTCDate()-(parsed.getUTCDay()+6)%7);
    return parsed.toISOString().slice(0,10);
  }
  function build(date){
    if(!validDate(date))throw new RangeError('Choose a valid local calendar date for the proposal.');
    const start=monday(date),allDays=[0,1,2,3,4,5,6],additions=[];
    const daily=()=>({kind:'weekly',days:[...allDays]});
    const weekly=(count,days=allDays)=>({kind:'target',days:[...days],count,weeks:1,mode:'fixed',startDate:start});
    const target=(label,minutes=null)=>({label,minutes});
    function add(id,name,fields={}){
      const item={id,name,parentId:null,category:'personal-care',workspaceKind:'care',anchor:'midday',window:'',order:additions.length+1,
        recurrence:daily(),normal:target('Complete'),minimum:target('No lower full-credit target'),optional:false,
        scoring:{importance:3,difficulty:2,eligible:true},...fields};
      additions.push(item);return item;
    }
    function container(id,name,fields={}){
      return add(id,name,{kind:'container',normal:target('Summary of the independent items'),minimum:target('Summary only'),
        scoring:{importance:3,difficulty:2,eligible:false},...fields});
    }
    container('dw-morning-care','Morning care',{anchor:'morning',budgetQ:32});
    container('dw-oral-care','Oral care',{parentId:'dw-morning-care',anchor:'morning'});
    add('dw-brush','Brush teeth',{parentId:'dw-oral-care',anchor:'morning',matching:{kind:'toothbrushing',minimum:0},normal:target('Brush teeth; this does not confirm another care item')});
    add('dw-floss','Floss',{parentId:'dw-oral-care',anchor:'morning',normal:target('Floss')});
    add('dw-tongue','Tongue cleaning',{parentId:'dw-oral-care',anchor:'morning',normal:target('Clean tongue')});
    add('dw-rinse','Rinse / mouthwash',{parentId:'dw-oral-care',anchor:'morning',normal:target('Rinse / mouthwash')});
    add('dw-wash-face','Wash face',{parentId:'dw-morning-care',anchor:'morning',normal:target('Wash face')});
    container('dw-night-care','Night oral care',{anchor:'evening',budgetQ:32});
    add('dw-night-brush','Brush teeth',{parentId:'dw-night-care',anchor:'evening',matching:{kind:'toothbrushing',minimum:0},normal:target('Brush teeth; a morning brushing record is not a night record')});
    add('dw-night-floss','Floss',{parentId:'dw-night-care',anchor:'evening',normal:target('Floss')});
    add('dw-night-rinse','Rinse / mouthwash',{parentId:'dw-night-care',anchor:'evening',normal:target('Rinse / mouthwash')});
    add('dw-cardio','Cardio',{category:'health-physical',workspaceKind:'cardio',optional:true,
      recurrence:{...weekly(4),startDate:'2026-09-21',endDate:'2026-09-27'},
      normal:target('45 verified cardio minutes for the full daily target',45),minimum:target('20 verified cardio minutes qualify one distinct weekly day',20),
      matching:{kind:'workout',type:'cardio',minimum:20}});
    add('dw-strength','Strength training',{category:'health-physical',workspaceKind:'strength',optional:true,recurrence:weekly(4),
      normal:target('15 minutes of matching strength workout',15),minimum:target('No lower qualifying strength target'),
      matching:{kind:'workout',type:'strength',minimum:15}});
    add('dw-steps','12,000 daily steps',{category:'health-physical',workspaceKind:'steps',
      normal:target('12,000 total daily steps, including workout steps once'),minimum:target('No lower completion threshold'),matching:{kind:'steps',minimum:12000}});
    add('dw-prayer-am','Morning prayer',{category:'faith',workspaceKind:'prayer-am',anchor:'morning',optional:true,recurrence:weekly(3),
      normal:target('Morning prayer; shared goal is 3 paired days plus 2 additional single days')});
    add('dw-prayer-pm','Night prayer',{category:'faith',workspaceKind:'prayer-pm',anchor:'evening',optional:true,recurrence:weekly(3),
      normal:target('Night prayer; shared goal is 3 paired days plus 2 additional single days')});
    add('dw-church','Church',{category:'faith',workspaceKind:'church',optional:true,
      recurrence:{kind:'target',days:[0],count:1,weeks:4,mode:'rolling',startDate:start},
      normal:target('One actual Sunday attendance in the rolling 28-day window'),scoring:{importance:3,difficulty:3,eligible:true}});
    add('dw-journal','Journaling',{category:'health-mental',workspaceKind:'journal',optional:true,recurrence:weekly(3),normal:target('Journal for 15 minutes',15),minimum:target('No lower qualifying journal target'),scoring:{importance:3,difficulty:1,eligible:true}});
    add('dw-weekly-appointment','Weekly mental-health appointment',{category:'health-mental',workspaceKind:'appointment',optional:true,recurrence:weekly(1,[3,5]),
      normal:target('Attend once on Wednesday OR Friday; no appointment time is assumed')});
    for(const number of [1,2])add('dw-bathroom-'+number,'Bathroom '+number,{category:'fitness',workspaceKind:'bathroom',normal:target('Reported bathroom visit '+number+'; requires its own event'),scoring:{importance:3,difficulty:3,eligible:true}});
    add('dw-healthy-meal','Eat healthy',{category:'food',workspaceKind:'healthy-meal',normal:target('At least one self-assessed healthy breakfast, lunch or dinner'),
      minimum:target('Food logging alone does not confirm this goal'),scoring:{importance:3,difficulty:3,eligible:true}});
    function home(id,name,fields={}){
      return add(id,name,{category:'home',workspaceKind:'home',optional:true,recurrence:weekly(1),scoring:{importance:3,difficulty:1,eligible:true},...fields});
    }
    home('dw-trash','Take out trash',{deadlineDay:4,normal:target('Take out trash once this week by Thursday night')});
    home('dw-recycling','Take out recycling',{deadlineDay:4,normal:target('Take out recycling once this week by Thursday night')});
    home('dw-clean-bathroom','Clean bathroom',{normal:target('Clean bathroom once this week')});
    home('dw-clean-bedroom','Clean bedroom / room',{normal:target('Clean bedroom / room once this week')});
    home('dw-clean-office','Clean office',{normal:target('Clean office once this week')});
    home('dw-clean-gym','Clean gym',{normal:target('Clean gym once this week; this is a home task, not a workout')});
    container('dw-laundry','Laundry',{category:'home',workspaceKind:'home',optional:true,scoring:{importance:3,difficulty:1,eligible:false}});
    for(const [id,label] of [['whites','Whites'],['bedding','Bedding'],['towels','Towels'],['colors','Colors']])home('dw-laundry-'+id,label,{parentId:'dw-laundry',normal:target('Start one '+label.toLowerCase()+' load this week')});
    const notes=[
      'Reconcile each proposed activity with existing records first. These are fallback IDs, never permission to duplicate an existing action, its source evidence or its claims.',
      'Reparent the existing morning Brush, Floss and Rinse IDs under Oral care; preserve all dates, notes, evidence and prior entitlements. Wash face stays outside Oral care.',
      'Tongue cleaning and Wash face use visible, editable daily morning and importance 3 / difficulty 2 defaults. Those inherited settings are proposals, not previously settled personal ratings or timing.',
      'Preserve the existing three independent night Brush, Floss and Rinse leaves. No night Tongue cleaning or Wash face is proposed.',
      'Preserve the existing Cardio ID and its saved end date. The only explicitly dated cardio window is September 21–27, 2026; a later proposal date does not renew it.',
      'Preserve the September 21 generic laundry record with its unknown load type. Do not assign it to any weekly load or copy its completion; a later explicit mapping must reuse the same entitlement.',
      'Preserve all three existing job applications, Work on Twitter page, the Monday appointment and family tasks with their original IDs and dates. No recurrence or new completion is proposed for them.',
      'The proposed groups place Physical health and Mental health under a Health umbrella, with separate Personal care and Home. Review this mapping before adoption; preserve existing assignments until that mapping is explicit. Bathroom placement between personal care and physical tracking remains a review decision; its fitness fallback is not a settled placement.',
      'Use local Monday–Sunday weeks. Trash and recycling retain a Thursday end-of-day deadline even when uncommitted; late completion stays linked to its original week.',
      'No calorie-deficit scoring, photo/body-composition feature, water target or new healthfulness assessment is enabled by this proposal.'
    ];
    const policies=[
      'This is a candidate proposal requiring a migration preview. Building or viewing it changes no state; adoption creates no confirmations, evidence, completed occurrences or claims.',
      'Flexible opportunities become daily obligations only after an explicit day commitment or deliberate qualifying source confirmation. Import alone does not commit a day; all available days are not required failures.',
      'Containers summarize eligible leaves and have no independent award. Morning and night care each conserve a 32-quarter-unit budget (8 points), allocated by stable leaf IDs; reordering does not change shares.',
      'Care partials pay only confirmed leaf shares and break the proposed full-instance chain; pending evidence holds continuity. These candidate consistency choices remain visible for personal rule review.',
      'Cardio combines qualifying Watch-recorded workouts within a day: 20 minutes qualifies one weekly day, 45 closes the daily target, 60 anchors 10 proposed base points. Steps and exercise-minute aggregates do not substitute.',
      'Strength needs matching 15-minute workout evidence on four distinct days per week. One workout cannot be spent twice as cardio and strength. Imported or unsupported evidence remains pending.',
      'Prayer has one shared weekly goal: 3 days with both morning and night prayer, plus 2 additional distinct days with either. One day cannot fill both quotas; the goal card adds no award.',
      'Church requires one confirmed Sunday attendance within rolling 28-day coverage. Journaling requires 15 minutes on each of 3 distinct weekly days. The weekly appointment requires Wednesday OR Friday and is separate from the Monday one-off.',
      'Bathroom 1 and Bathroom 2 require distinct reported events. Proposed rule 4 applies the raw 3/3 rating at size 1/4 before quarter rounding, yielding 2.5 base points each; these are logs, not instructions to force events.',
      'Eat healthy has independently selectable breakfast, lunch and dinner tags on one daily entitlement. At least one self-attested healthy meal is the working target; extra selected tags or imported nutrition do not add awards.',
      'Each of the 10 weekly home leaves has importance 3 / difficulty 1 and 6.5 proposed base points. Four distinct laundry loads total 26; all 10 goals total 65 per completed week, never a daily allowance or a second parent/card award.',
      'The compatibility categories do not define new Profile grade weights or evidence eligibility. Taxonomy mapping and legacy-to-quarter-point adoption require their own visible previews and reversible snapshots.'
    ];
    const groups=[
      {id:'health-physical',name:'Physical health',umbrella:'health',icon:'run',order:1},
      {id:'health-mental',name:'Mental health',umbrella:'health',icon:'mind',order:2},
      {id:'personal-care',name:'Personal care',icon:'care',order:3},
      {id:'home',name:'Home',icon:'home',order:4}
    ];
    return {additions,notes,policies,groups};
  }
  const api={build};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.WorkspaceProposal=api;
})(typeof globalThis!=='undefined'?globalThis:this);
