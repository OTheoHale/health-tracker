/* EOTC calendar: the Ethiopian date, the church's fasts and feasts, pure and offline. Rules follow the
   church's own page (SOURCE); where it is silent or disagrees with common practice the choice is noted
   beside the rule. Dates are 'YYYY-MM-DD' Gregorian local calendar days; no clocks, no time zones.
   Fasts kept only by clergy and monastics: the page says about 250 fast days a year of which about 180
   bind everyone, but it names no clergy-only fast with dates (it mentions "Kweskwam" only in passing,
   without dates or who keeps it), so no required:false season is listed. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.EotcCalendar=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SOURCE=Object.freeze({title:'Religious Holidays and Calendar — Ethiopian Orthodox Tewahedo Church',url:'https://ethiopianorthodox.org/english/calendar.html',retrieved:'2026-09-24'});
  const MONTHS=Object.freeze(['Meskerem','Tikimt','Hidar','Tahsas','Tir','Yekatit','Megabit','Miyazia','Ginbot','Sene','Hamle','Nehase','Pagumen']);
  // Per-month readings from ethiopianorthodox.org/calendar.html, hrefs copied exactly (Meskerem's gitsawe
  // file really is spelled "gitaswe" there; the "gitsawe" spelling 404s).
  const READINGS_BASE='https://ethiopianorthodox.org/amharic/holybooks/readings/';
  const READINGS=Object.freeze([
    ['meskeremreading','meskeremgitaswe'],['tikemetreading','tikemetgitsawe'],['hidar','hidargitsawe'],['tahesasreading','tahesasgitsawe'],
    ['tirreading','tirgitsawe'],['yekatit','yekatitgitsawe'],['megabit','megabitgitsawe'],['miazia','miaziagitsawe'],['genbot','ginbotgitsawe'],
    ['sene','senegitsawe'],['hamlereading','hamelegitsawe'],['nehasereading','nehasegitsawe'],['pagumen','pagumengitsawe']]);
  const DAY=864e5,EPOCH=-716367;                 // Meskerem 1, year 1 (Amete Mihret) as days since 1970-01-01

  function dayNumber(ymd){
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
    if(m){const n=Date.UTC(+m[1],+m[2]-1,+m[3])/DAY;if(ymd===toYmd(n))return n;}
    throw new RangeError('Expected a real date as YYYY-MM-DD: '+String(ymd)+'.');
  }
  function toYmd(n){return new Date(n*DAY).toISOString().slice(0,10);}
  const addDays=(ymd,k)=>toYmd(dayNumber(ymd)+k);
  const weekday=ymd=>new Date(dayNumber(ymd)*DAY).getUTCDay();   // 0 Sunday … 6 Saturday
  const pagumenDays=year=>year%4===3?6:5;         // the year of Luke, which precedes the Gregorian leap year

  function ethDayNumber(year,month,day){
    if(!Number.isInteger(year)||!Number.isInteger(month)||!Number.isInteger(day)||month<1||month>13||day<1||day>(month===13?pagumenDays(year):30))
      throw new RangeError('Not an Ethiopian date: '+[year,month,day].join('-')+'.');
    return EPOCH+365*(year-1)+Math.floor(year/4)+30*(month-1)+day-1;
  }
  function fromEthiopian(year,month,day){return toYmd(ethDayNumber(year,month,day));}
  function toEthiopian(ymd){
    const n=dayNumber(ymd)-EPOCH,year=Math.floor((4*n+1463)/1461),doy=n-365*(year-1)-Math.floor(year/4),month=Math.floor(doy/30)+1;
    return {year,month,day:doy%30+1,monthName:MONTHS[month-1]};
  }

  /* Bahire Hasab, the church's computus ("the system of Ammonius" on the page): the Metqe of the year sets
     Beale Metqe in Meskerem or Tikimt; its weekday's Tewsak carries it to the Monday of Nineveh, and Easter
     is the Sunday 69 days later. Equal to the Julian Easter, which the tests check independently. */
  const TEWSAK=[7,6,5,4,3,2,8];                  // Sunday … Saturday
  function ethEaster(ec){
    const wenber=(ec+5500-1)%19,metqe=(wenber*19)%30||30;
    const bealeMetqe=fromEthiopian(ec,metqe>14?1:2,metqe),nineveh=addDays(bealeMetqe,TEWSAK[weekday(bealeMetqe)]+120);
    return addDays(nineveh,69);
  }
  function easter(gregorianYear){
    if(!Number.isInteger(gregorianYear))throw new RangeError('Expected a Gregorian year.');
    return ethEaster(gregorianYear-8);            // Easter falls in Megabit/Miyazia of the Ethiopian year G−8
  }
  /* Genna is 7 January every year: Tahsas 29, but Tahsas 28 in the Ethiopian year that follows a 6-day
     Pagumen, when Tahsas 29 would be 8 January. Timket (Tir 11) is not moved and falls on 20 January then. */
  const gennaOf=ec=>fromEthiopian(ec,4,ec%4===0?28:29);

  const season=(id,name,amharic,from,to)=>({id,name,amharic,from,to,required:true,kind:'fast'});
  const feast=(id,name,date,kind,monthly)=>monthly?{id,name,date,kind,monthly}:{id,name,date,kind};
  const MONTHLY=Object.freeze([[7,'trinity','Holy Trinity (Silassie)'],[12,'michael','St Michael'],[16,'kidanemehret','Kidane Mehret'],[21,'mary','St Mary'],[27,'medhanealem','Medhane Alem'],[29,'bealewold','Beale Wold']]);
  const cache=new Map();
  /* Every season and feast of one Ethiopian year (Meskerem 1 … Pagumen); all of them fall inside it. */
  function ethYear(ec){
    if(cache.has(ec))return cache.get(ec);
    const E=ethEaster(ec),at=(m,d)=>fromEthiopian(ec,m,d),genna=gennaOf(ec),timket=at(5,11),pentecost=addDays(E,49);
    const seasons=[
      // The page: 40 days "begins with Sibket on 15th Hedar and ends on Christmas eve" (Tahsas 28). As
      // counted that is 44 days (43 when Genna is Tahsas 28). Some calendars start it on Hidar 16; the page wins.
      season('advent','Advent — Fast of the Prophets (Tsome Nebiyat)','ጾመ ነቢያት',at(3,15),addDays(genna,-1)),
      season('gahad-genna','Gahad of Genna (Christmas eve)','ገሃድ',addDays(genna,-1),addDays(genna,-1)),
      season('gahad-timket','Gahad of Timket (Epiphany eve)','ገሃድ',addDays(timket,-1),addDays(timket,-1)),
      season('nineveh','Fast of Nineveh (Tsome Nenewe)','ጾመ ነነዌ',addDays(E,-69),addDays(E,-67)),
      // The page says 56 days; Monday 55 days before Easter to Easter eve is 55 calendar days (the count
      // most published calendars give). The dates are what the app uses.
      season('lent','Lent — Hudadi / Abiy Tsom','ዐቢይ ጾም',addDays(E,-55),addDays(E,-1)),
      season('apostles','Fast of the Apostles (Tsome Hawaryat)','ጾመ ሐዋርያት',addDays(pentecost,1),at(11,4)),
      // The page says 16 days; Nehase 1–15 is the fast (Nehase 16 is the feast that ends it).
      season('filseta','Fast of the Assumption (Tsome Filseta)','ጾመ ፍልሰታ',at(12,1),at(12,15))
    ];
    const feasts=[
      feast('enkutatash','Enkutatash (New Year)',at(1,1),'major'),
      feast('meskel','Meskel (Finding of the True Cross)',at(1,17),'major'),
      feast('genna','Genna (Christmas)',genna,'major','bealewold'),
      feast('timket','Timket (Epiphany)',timket,'major'),
      feast('kana','Kana ze Galila',at(5,12),'minor'),   // also the national St Michael day (Tir 12) on the page
      feast('kidanemehret','Kidane Mehret',at(6,16),'minor','kidanemehret'),
      feast('conception','Conception of Christ (Tsinset)',at(7,29),'major','bealewold'),  // one of the page's nine major feasts
      feast('debrezeit','Debre Zeit (Mount of Olives)',addDays(E,-28),'minor'),
      feast('hosanna','Hosanna (Palm Sunday)',addDays(E,-7),'major'),
      feast('siklet','Siklet (Good Friday)',addDays(E,-2),'major'),
      feast('fasika','Fasika (Easter)',E,'major'),
      feast('rekebekahinat','Rekebe Kahinat',addDays(E,24),'minor'),
      feast('erget','Erget (Ascension)',addDays(E,39),'major'),
      feast('paraclete','Paraclete (Pentecost)',pentecost,'major'),
      feast('apostles','Feast of the Apostles Peter and Paul',at(11,5),'minor'),
      feast('debretabor','Debre Tabor (Transfiguration)',at(12,13),'major'),
      feast('filseta','Filseta (Assumption)',at(12,16),'major')
    ];
    // Monthly feasts, skipped where the same commemoration is already that day's annual feast.
    for(let m=1;m<=12;m++)for(const [d,id,name] of MONTHLY){
      const date=at(m,d);if(!feasts.some(f=>f.date===date&&f.monthly===id))feasts.push(feast('monthly-'+id,name,date,'monthly'));
    }
    const byDate=(a,b)=>a.localeCompare(b);
    seasons.sort((a,b)=>byDate(a.from,b.from)||byDate(a.to,b.to));
    feasts.sort((a,b)=>byDate(a.date,b.date)||'major minor monthly'.indexOf(a.kind)-'major minor monthly'.indexOf(b.kind));
    const out={easter:E,pentecost,genna,timket,seasons,feasts};cache.set(ec,out);return out;
  }
  const strip=({monthly,...f})=>f;
  const copy=o=>({...o});
  // A Gregorian year touches the Ethiopian years G−8 (to September) and G−7 (from September).
  function seasonsFor(gregorianYear){
    if(!Number.isInteger(gregorianYear))throw new RangeError('Expected a Gregorian year.');
    const lo=gregorianYear+'-01-01',hi=gregorianYear+'-12-31';
    return [gregorianYear-8,gregorianYear-7].flatMap(ec=>ethYear(ec).seasons).filter(s=>s.to>=lo&&s.from<=hi).map(copy)
      .sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
  }
  function feastsFor(gregorianYear){
    if(!Number.isInteger(gregorianYear))throw new RangeError('Expected a Gregorian year.');
    const y=String(gregorianYear);
    return [gregorianYear-8,gregorianYear-7].flatMap(ec=>ethYear(ec).feasts).filter(f=>f.date.slice(0,4)===y).map(strip);
  }
  /* The page: every Wednesday and Friday is a fast, except "From Easter to Pentecost", and none "if the
     Christmas and Epiphany fall on a Wednesday or Friday"; no fasting while those feasts or the fifty days are kept. */
  function dayInfo(ymd){
    dayNumber(ymd);
    const ethiopian=toEthiopian(ymd),Y=ethYear(ethiopian.year),wd=weekday(ymd);
    const fiftyDays=ymd>=Y.easter&&ymd<=Y.pentecost,noFast=fiftyDays||ymd===Y.genna||ymd===Y.timket;
    const fasts=Y.seasons.filter(s=>ymd>=s.from&&ymd<=s.to).map(s=>({id:s.id,name:s.name,required:s.required}));
    const wedFriFast=(wd===3||wd===5)&&!noFast;
    const [reading,gitsawe]=READINGS[ethiopian.month-1];
    return {date:ymd,weekday:wd,ethiopian,fasts,feasts:Y.feasts.filter(f=>f.date===ymd).map(strip),wedFriFast,noFast,
      fasting:wedFriFast||fasts.some(f=>f.required),
      readings:{month:ethiopian.monthName,url:READINGS_BASE+reading+'.pdf',gitsaweUrl:READINGS_BASE+gitsawe+'.pdf'}};
  }
  return {SOURCE,MONTHS,toEthiopian,fromEthiopian,easter,seasonsFor,feastsFor,dayInfo,pagumenDays};
});
