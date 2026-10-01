/* Where I Stand: the reference tables, in the `norms.json` shape of docs/research/SCORES_SPEC_2026-09-26.md §C.
   A script rather than a fetched JSON file so the page has the tables on its first draw, offline included.
   Every number is a published population figure or a marked estimate (docs/research/NORMS_2026-09-26.md);
   none is anyone's personal reading. Tags: V verified in the source, S secondary, E estimate, R recalled,
   C commercial. One yardstick (decided Sept 26): FRIEND 2015 for VO2 max and fitness age.
   `p` holds published percentiles; the rung cut-offs between them are interpolated by scores.js, so a gap
   is measured to the real cut-off (45.12), not to its rounded label (45.1). */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.Norms=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const RUNGS=['poor','below','avg','good','trained','athlete','elite'];
  const LABELS={poor:'Poor',below:'Below',avg:'Avg',good:'Good',trained:'Trained',athlete:'Athlete',elite:'Elite'};
  const FRIEND='FRIEND 2015 Table 3 (Kaminsky 2015)',NHANES_PULSE='NHANES 1999–2008 resting pulse (Ostchega 2011)',VOSS='Voss 2015 (KORA), log-normal fit',GALLAGHER='Gallagher 2000';
  const friendTags={p:'V',cuts:'E',athlete:'V',elite:'E',appleLevels:'V'};
  return {
    version:1,
    rungs:RUNGS,labels:LABELS,
    metrics:{
      vo2_max:{label:'VO₂ max',unit:'ml/kg/min',dir:'up',kind:'ranked',precision:0.1,sd:9.9,weight:3,
        note:'Apple Watch estimate; it reads a little low for fit people, so the grade errs conservative',
        association:'+3.5 ml/kg/min goes with about 13% lower all-cause mortality (Kodama 2009); an association, not a prediction',
        male:{
          // Elite = De Pauw 2013 performance level 5 (71), held to age 35, then −10% a decade [E].
          '20-29':{p:{5:29.0,10:32.1,25:40.1,50:48.0,75:55.2,90:61.8,95:66.3},elite:71.0,appleLevels:{low:38,belowAverage:48,aboveAverage:57},source:FRIEND,tags:friendTags},
          '30-39':{p:{5:27.2,10:30.2,25:35.9,50:42.4,75:49.2,90:56.5,95:59.8},elite:71.0,appleLevels:{low:34,belowAverage:43,aboveAverage:52},source:FRIEND,tags:friendTags},
          '40-49':{p:{5:24.2,10:26.8,25:31.9,50:37.8,75:45.0,90:52.1,95:55.6},elite:63.9,appleLevels:{low:31,belowAverage:38,aboveAverage:47},source:FRIEND,tags:friendTags},
          '50-59':{p:{5:20.9,10:22.8,25:27.1,50:32.6,75:39.7,90:45.6,95:50.7},elite:57.5,appleLevels:{low:26,belowAverage:33,aboveAverage:41},source:FRIEND,tags:friendTags},
          '60-69':{p:{5:17.4,10:19.8,25:23.7,50:28.2,75:34.5,90:40.3,95:43.0},elite:51.8,appleLevels:{low:18,belowAverage:28,aboveAverage:36},source:FRIEND,tags:friendTags},
          '70-79':{p:{5:16.3,10:17.1,25:20.4,50:24.4,75:30.4,90:36.6,95:39.7},elite:46.6,appleLevels:{low:18,belowAverage:28,aboveAverage:36},source:FRIEND,tags:friendTags}
        }},
      // Lower is better. `shift` moves the seated NHANES pulse onto Apple's lower resting reading so the
      // ladder does not flatter (approved Sept 26). Athlete = the 5th percentile; Elite is an estimate.
      resting_heart_rate:{label:'Resting heart rate',unit:'bpm',dir:'down',kind:'ranked',precision:1,sd:11.1,weight:2,shift:-4,
        note:'30-day median; lower is better',
        association:'−10 bpm goes with about 9% lower all-cause mortality (Zhang 2016); an association, not a prediction',
        male:{
          '20-39':{p:{5:52,10:55,25:61,50:69,75:76,90:84,95:89},elite:40,source:NHANES_PULSE,tags:{p:'V',cuts:'E',athlete:'E',elite:'E',shift:'E'}},
          '40-59':{p:{5:52,10:55,25:61,50:68,75:77,90:85,95:90},elite:40,source:NHANES_PULSE,tags:{p:'V',cuts:'E',athlete:'E',elite:'E',shift:'E'}},
          '60-79':{p:{5:50,10:54,25:60,50:67,75:75,90:84,95:91},elite:40,source:NHANES_PULSE,tags:{p:'V',cuts:'E',athlete:'E',elite:'E',shift:'E'}}
        }},
      // Short resting SDNN, compared on the log scale; the personal band leads, this rank is rough.
      heart_rate_variability:{label:'HRV',unit:'ms',dir:'up',kind:'ranked',precision:1,sd:0.3986,logScale:true,weight:1,
        note:'30-day median of overnight readings (SDNN)',
        male:{
          '25-49':{p:{10:26,25:33,50:42,75:55,90:70,95:80.9},source:VOSS,tags:{p:'E',cuts:'E',athlete:'E'}},
          '50-74':{p:{10:17,25:23,50:30,75:40,90:52,95:60.9},source:VOSS,tags:{p:'E',cuts:'E',athlete:'E'}}
        }},
      // A step index, not percentiles (Tudor-Locke 2011); Athlete is an estimate; no Elite rung.
      step_count:{label:'Daily steps',unit:'steps',dir:'up',kind:'ranked',precision:100,sd:2500,weight:2,
        note:'30-day average',
        male:{all:{cuts:{below:5000,avg:7500,good:10000,trained:12500,athlete:15000},source:'Tudor-Locke 2011 step index',tags:{cuts:'V',athlete:'E'}}}},
      // Glow's own 60-second drop after a hard finish. At or under 12 is the one well-evidenced flag (Cole 1999).
      heart_rate_recovery:{label:'Recovery',unit:'bpm',dir:'up',kind:'ranked',precision:1,sd:8,weight:1,flagAtOrBelow:12,
        note:'heart-rate drop in 60 s, last 30 days',
        male:{all:{cuts:{below:13,avg:21,good:31,trained:41,athlete:46,elite:51},source:'Bands on Apple’s scale; ≤12 flag Cole 1999',tags:{cuts:'E',flag:'V'}}}},
      sleep_duration:{label:'Sleep',unit:'h',dir:'range',kind:'target',sd:1.0,weight:2,
        note:'30-night average',
        male:{all:{in:[7,9],lowOrange:6,source:'AASM / NSF 7–9 h',tags:{in:'R'}}}},
      body_fat_percentage:{label:'Body fat',unit:'%',dir:'range',kind:'target',sd:6.82,weight:2,
        note:'smart-scale reading; a scale and a DXA scan can differ by several points',
        male:{
          '20-39':{in:[8,19],over:[20,24],high:25,athlete:[6,13],source:GALLAGHER,tags:{in:'R'}},
          '40-59':{in:[11,21],over:[22,27],high:28,athlete:[6,13],source:GALLAGHER,tags:{in:'R'}},
          '60-79':{in:[13,24],over:[25,29],high:30,athlete:[6,13],source:GALLAGHER,tags:{in:'R'}}
        }},
      // V3.4 (B11, his decision Sept 30): one waist standard, waist-to-height (NICE NG246). The value is the ratio of
      // waist to height; the page prints the distance in inches. The IDF / ATP III centimetre cut-offs are gone.
      waist_circumference:{label:'Waist',unit:'ratio',ratio:'height',dir:'range',kind:'target',sd:0.06,weight:2,
        male:{all:{in:[0.4,0.49],over:[0.5,0.59],high:0.6,source:'NICE NG246 · waist-to-height ratio',tags:{in:'V'}}}},
      walking_speed:{label:'Walking speed',unit:'m/s',kind:'floor',floor:1.0,warn:0.8,source:'Studenski 2011; Bohannon 2011',tags:{floor:'R'}},
      six_minute_walking_test_distance:{label:'Six-minute walk',unit:'m',kind:'floor',source:'Enright & Sherrill 1998',tags:{floor:'V'}},
      respiratory_rate:{label:'Breathing rate',unit:'per min',kind:'flag'},
      apple_sleeping_wrist_temperature:{label:'Wrist temperature',unit:'°',kind:'flag'},
      blood_oxygen_saturation:{label:'Blood oxygen',unit:'%',kind:'flag'}
    },
    /* V3.4 (§1 Bars, B11): colour tiers that rest on published break points. A row is [upper limit, tone, word]; a value
       sits in the first row whose limit it is under. `convention` names the cut-offs no source publishes (his rule: the
       ⓘ says so). Body fat for men: Gallagher 2000's 8/20/25 per cent cuts for ages 20–39 (shifted with age by the same
       paper), ACE's athlete and fitness bands for purple and blue; the 30 and 35 reds are stated conventions. */
    tiers:{
      body_fat_percentage:{source:'Gallagher 2000 (healthy and obese cut-offs, by age); ACE (athlete, fitness)',convention:'The light-red, red and dark-red split above the obese cut-off (Obese I, II, III) is a convention, five points apart; no study publishes body-fat obesity classes.',
        male:{'20-39':[[6,'caution','Very low'],[14,'purple','Elite'],[18,'blue','Fit'],[20,'green','Healthy'],[25,'yellow','Slightly over'],[30,'lightRed','Obese I'],[35,'red','Obese II'],[Infinity,'darkRed','Obese III']],
              '40-59':[[6,'caution','Very low'],[14,'purple','Elite'],[18,'blue','Fit'],[22,'green','Healthy'],[28,'yellow','Slightly over'],[33,'lightRed','Obese I'],[38,'red','Obese II'],[Infinity,'darkRed','Obese III']],
              '60-79':[[6,'caution','Very low'],[14,'purple','Elite'],[18,'blue','Fit'],[25,'green','Healthy'],[30,'yellow','Slightly over'],[35,'lightRed','Obese I'],[40,'red','Obese II'],[Infinity,'darkRed','Obese III']]}},
      bmi:{source:'WHO BMI classes',convention:null,all:[[18.5,'caution','Under'],[25,'green','Healthy'],[30,'yellow','Over'],[35,'lightRed','Obesity I'],[40,'red','Obesity II'],[Infinity,'darkRed','Obesity III']]},
      waist_to_height:{source:'NICE NG246',convention:null,all:[[0.4,'caution','Low'],[0.5,'green','Healthy'],[0.6,'yellow','Increased'],[Infinity,'red','High']]}
    },
    // Fitness age: FRIEND 2015 male medians at decade midpoints (one yardstick; no HUNT).
    fitnessAge:{anchors:[[25,48.0],[35,42.4],[45,37.8],[55,32.6],[65,28.2],[75,24.4]],min:20,max:80,source:FRIEND,tag:'V'}
  };
});
